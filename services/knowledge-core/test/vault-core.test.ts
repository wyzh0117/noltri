import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename as renameFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryRepository } from '@noltri/storage';
import { normalizeVaultPath, pathKey } from '../src/notes/path';
import { parseFrontmatterValue, parseMarkdown, resolveSubpath, rewriteYamlLinks } from '../src/notes/markdown';
import { fuzzyScore, searchNotes } from '../src/notes/search';
import { VaultService } from '../src/notes/vault';
import { MetadataParserWorker } from '../src/notes/parser';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('vault paths and metadata', () => {
  it.each([
    ['A\u00a0B\\C.md', 'A B/C.md'],
    ['folder/./note.md', 'folder/note.md'],
    ['cafe\u0301.md', 'café.md'],
  ])('normalizes %s', (input, expected) => expect(normalizeVaultPath(input)).toBe(expected));

  it.each(['../outside.md', '/root.md', 'C:\\root.md', 'folder/../../outside.md', 'bad\u0000name.md'])('rejects unsafe path %s', (input) => {
    expect(() => normalizeVaultPath(input)).toThrow();
  });

  it('indexes YAML links, aliases, headings, list items, blocks, footnotes and reference links', () => {
    const content = [
      '---',
      'aliases: [Quick Name]',
      'tags: [demo, "#release"]',
      'related: "[[Target#Parent#Child|Display]]"',
      '---',
      '# Parent',
      '## Child',
      '- [ ] todo item',
      'paragraph ^BlockA',
      '[^note]: footnote text',
      'See [^note]',
      '[[]]',
      '[label]: [[Target]]',
      '',
    ].join('\n');
    const parsed = parseMarkdown(content);
    expect(parsed.metadata.frontmatter).toMatchObject({ aliases: ['Quick Name'] });
    expect(parsed.metadata.tags?.map(({ tag, field }) => [tag, field])).toEqual([['#demo', 'frontmatter'], ['#release', 'frontmatter']]);
    expect(parsed.metadata.frontmatterLinks?.[0]).toMatchObject({ key: 'related', link: 'Target', displayText: 'Display' });
    expect(parsed.metadata.frontmatterLinks?.[0]?.position.start.offset).toBe(content.indexOf('[[Target#Parent#Child|Display]]'));
    expect(parsed.metadata.headings?.map(({ heading, level }) => [heading, level])).toEqual([['Parent', 1], ['Child', 2]]);
    expect(parsed.metadata.listItems?.[0]?.task).toBe('todo');
    expect(parsed.metadata.blocks?.BlockA).toBeDefined();
    expect(parsed.metadata.footnotes?.note).toBeDefined();
    expect(parsed.metadata.footnoteRefs?.map(({ id }) => id)).toContain('note');
    expect(Object.keys(parsed.metadata.referenceLinks ?? {})).toContain('label');
    expect(resolveSubpath(content, parsed.metadata, '#Parent#Child')).toEqual(parsed.metadata.headings?.[1]?.position);
    expect(resolveSubpath(content, parsed.metadata, '^blocka')).toEqual(parsed.metadata.blocks?.BlockA?.position);
    expect(resolveSubpath(content, parsed.metadata, '#Parent#Missing')).toBeNull();
    expect(rewriteYamlLinks(content, (_key, value) => value.replace('[[Target', '[[Folder/Target'))).toContain('"[[Folder/Target#Parent#Child|Display]]"');
  });

  it('decodes URI fragments once for heading paths, encoded hashes, and block IDs', () => {
    const content = ['# 中文 标题', '## Hello World', '### A#B', '#### Coverage 100%', 'paragraph ^Block-ID'].join('\n');
    const metadata = parseMarkdown(content).metadata;
    expect(resolveSubpath(content, metadata, '%E4%B8%AD%E6%96%87%20%E6%A0%87%E9%A2%98')).toEqual(metadata.headings?.[0]?.position);
    expect(resolveSubpath(content, metadata, '中文%20标题#Hello%20World')).toEqual(metadata.headings?.[1]?.position);
    expect(resolveSubpath(content, metadata, '中文%20标题#Hello%20World#A%23B')).toEqual(metadata.headings?.[2]?.position);
    expect(resolveSubpath(content, metadata, 'Coverage 100%')).toEqual(metadata.headings?.[3]?.position);
    expect(resolveSubpath(content, metadata, 'Coverage 100%25')).toEqual(metadata.headings?.[3]?.position);
    expect(resolveSubpath(content, metadata, '%5EBLOCK-ID')).toEqual(metadata.blocks?.['Block-ID']?.position);
    expect(resolveSubpath(content, metadata, 'bad%XXfragment')).toBeNull();
  });

  it('rewrites only YAML values by their nested key path and preserves comments and body text', () => {
    const content = [
      '---', '# keep this comment', 'title: Keep', 'related:', '  refs:', '    - "[[Old|Old]]"', '---', '[[Old|Old]]',
    ].join('\n');
    const visitedKeys: string[] = [];
    const rewritten = rewriteYamlLinks(content, (key, value) => {
      visitedKeys.push(key);
      return value.replace('[[Old|Old]]', '[[New|New]]');
    });
    expect(visitedKeys).toEqual(['related.refs']);
    expect(parseFrontmatterValue(rewritten)).toMatchObject({ title: 'Keep', related: { refs: ['[[New|New]]'] } });
    expect(rewritten).toContain('# keep this comment');
    expect(rewritten.endsWith('[[Old|Old]]')).toBe(true);
  });

  it.each([
    ['Café', 'Cafe\u0301'],
    ['Note.md', 'note.MD'],
    ['A B.md', 'A\u00a0B.md'],
  ])('folds equivalent path keys %s / %s', (left, right) => expect(pathKey(normalizeVaultPath(left))).toBe(pathKey(normalizeVaultPath(right))));
});

describe('vault links, file safety, and optimistic writes', () => {
  it('commits simultaneous create-only writes with an exclusive filesystem operation', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-create-race-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-create-race-test' });
    try {
      await vault.initialize();
      const internals = vault as unknown as { getFile(filePath: string): Promise<Awaited<ReturnType<VaultService['getFile']>>> };
      const originalGetFile = internals.getFile.bind(vault);
      let arrivals = 0;
      let release!: () => void;
      const bothLookedUp = new Promise<void>((resolve) => { release = resolve; });
      const lookup = vi.spyOn(internals, 'getFile').mockImplementation(async (filePath) => {
        if (filePath === 'Raced.md') {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothLookedUp;
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        }
        return await originalGetFile(filePath);
      });
      const results = await Promise.allSettled([
        vault.writeFile('Raced.md', '# first'),
        vault.writeFile('Raced.md', '# second'),
      ]);
      lookup.mockRestore();
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(['# first', '# second']).toContain((await originalGetFile('Raced.md')).content);
      expect(await readFile(path.join(rootPath, 'Raced.md'), 'utf8')).toBe((await originalGetFile('Raced.md')).content);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('serializes concurrent updates using the same etag and keeps history plus metadata on the winning version', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-update-race-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-update-race-test' });
    const original = '---\ntags: [base]\n---\n# Original\n';
    const firstContent = '---\ntags: [winner-one]\n---\n# First\n';
    const secondContent = '---\ntags: [winner-two]\n---\n# Second\n';
    try {
      await vault.initialize();
      const initial = await vault.writeFile('Note.md', original);
      const internals = vault as unknown as {
        writeFileInternal: (filePath: string, content: string, etag: string | undefined, refresh: boolean) => ReturnType<VaultService['getFile']>;
      };
      const writeInternal = internals.writeFileInternal.bind(vault);
      let arrivals = 0;
      let release!: () => void;
      let firstEntered!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      const spy = vi.spyOn(internals, 'writeFileInternal').mockImplementation(async (...args) => {
        arrivals += 1;
        if (arrivals === 1) { firstEntered(); await barrier; }
        return await writeInternal(...args);
      });
      const first = vault.writeFile('Note.md', firstContent, initial.etag);
      await firstStarted;
      const second = vault.writeFile('Note.md', secondContent, initial.etag);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const enteredBeforeRelease = arrivals;
      release();
      const outcomes = await Promise.allSettled([first, second]);
      spy.mockRestore();

      expect(enteredBeforeRelease).toBe(1);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ status: 409 });
      const winner = outcomes[0]!.status === 'fulfilled' ? outcomes[0]!.value : outcomes[1]!.status === 'fulfilled' ? outcomes[1]!.value : null;
      expect(winner).not.toBeNull();
      const current = await vault.getFile('Note.md');
      expect(current.content).toBe(firstContent);
      expect(current.etag).toBe(winner!.etag);
      expect(current.metadata?.tags?.map(({ tag }) => tag)).toEqual(['#winner-one']);
      const history = await vault.history('Note.md');
      expect(history.versions).toHaveLength(1);
      const previous = await vault.historyVersion('Note.md', history.versions[0]!.id);
      expect(previous).toMatchObject({ content: original, etag: initial.etag });
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('rejects an old-root mutation after a root switch, even when the roots contain matching paths', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-root-queue-'));
    roots.push(base);
    const rootA = path.join(base, '资料 Vault A');
    const rootB = path.join(base, '资料 Vault B');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, 'Note.md'), '# root A\n');
    await writeFile(path.join(rootB, 'Note.md'), '# root B\n');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath: rootA, dataDir: path.join(base, 'data'), repository, userId: 'vault-root-queue-test' });
    try {
      await vault.initialize();
      const rootToken = await vault.captureRootForMutation();
      const internals = vault as unknown as { persistSettings(): Promise<void> };
      const persist = internals.persistSettings.bind(vault);
      let release!: () => void;
      let switched!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const didSwitch = new Promise<void>((resolve) => { switched = resolve; });
      const spy = vi.spyOn(internals, 'persistSettings').mockImplementation(async () => {
        await persist();
        switched();
        await barrier;
      });
      const opening = vault.openVault(rootB);
      await didSwitch;
      const staleWrite = vault.writeFile('Note.md', '# stale root A request\n', undefined, rootToken);
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await opening;
      await expect(staleWrite).rejects.toMatchObject({ status: 409 });
      spy.mockRestore();
      await expect(readFile(path.join(rootB, 'Note.md'), 'utf8')).resolves.toBe('# root B\n');
      await expect(vault.getFile('Note.md')).resolves.toMatchObject({ content: '# root B\n' });
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it.each([
    ['file', false],
    ['folder', true],
  ] as const)('does not replace a destination created after the %s rename preflight', async (kind, isFolder) => {
    const base = await mkdtemp(path.join(os.tmpdir(), `noltri-vault-rename-race-${kind}-`));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    const sourcePath = isFolder ? 'SourceFolder' : 'Source.md';
    const targetPath = isFolder ? 'TargetFolder' : 'Target.md';
    if (isFolder) await mkdir(path.join(rootPath, sourcePath));
    else await writeFile(path.join(rootPath, sourcePath), '# source');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: `vault-rename-race-${kind}` });
    try {
      await vault.initialize();
      const expectedEtag = isFolder ? (await vault.deletePreview(sourcePath)).etag : (await vault.getFile(sourcePath)).etag;
      const internals = vault as unknown as { refresh(force: boolean): Promise<void> };
      const originalRefresh = internals.refresh.bind(vault);
      let inject = true;
      const refresh = vi.spyOn(internals, 'refresh').mockImplementation(async (force) => {
        await originalRefresh(force);
        if (!inject) return;
        inject = false;
        if (isFolder) await mkdir(path.join(rootPath, targetPath));
        else await writeFile(path.join(rootPath, targetPath), '# external target', { flag: 'wx' });
      });
      await expect(vault.renamePath(sourcePath, targetPath, expectedEtag)).rejects.toThrow(/目标路径已存在|already exists/i);
      refresh.mockRestore();
      if (isFolder) {
        await expect(readdir(path.join(rootPath, sourcePath))).resolves.toEqual([]);
        await expect(readdir(path.join(rootPath, targetPath))).resolves.toEqual([]);
      } else {
        await expect(readFile(path.join(rootPath, sourcePath), 'utf8')).resolves.toBe('# source');
        await expect(readFile(path.join(rootPath, targetPath), 'utf8')).resolves.toBe('# external target');
      }
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('rejects an external atomic-save source replacement after the rename etag check', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-source-race-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    const sourcePath = path.join(rootPath, 'Source.md');
    await writeFile(sourcePath, '# original');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-source-race-test' });
    try {
      await vault.initialize();
      const source = await vault.getFile('Source.md');
      const internals = vault as unknown as { refresh(force: boolean): Promise<void> };
      const originalRefresh = internals.refresh.bind(vault);
      let inject = true;
      const refresh = vi.spyOn(internals, 'refresh').mockImplementation(async (force) => {
        await originalRefresh(force);
        if (!inject) return;
        inject = false;
        const incoming = path.join(rootPath, '.external-save');
        await writeFile(incoming, '# external atomic save');
        await renameFile(incoming, sourcePath);
      });
      await expect(vault.renamePath('Source.md', 'Moved.md', source.etag)).rejects.toThrow(/源文件在重命名期间被外部修改/);
      refresh.mockRestore();
      expect(await readFile(sourcePath, 'utf8')).toBe('# external atomic save');
      await expect(readFile(path.join(rootPath, 'Moved.md'), 'utf8')).rejects.toThrow();
      expect((await readdir(rootPath)).some((name) => name.startsWith('.noltri-tmp-'))).toBe(false);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('ignores malformed history records and never prunes a traversal sentinel', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-history-sentinel-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const dataDir = path.join(base, 'data');
    const historyDir = path.join(dataDir, 'vault-history');
    const sentinelPath = path.join(base, 'sentinel.json');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Note.md'), '# current');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir, repository, userId: 'vault-history-sentinel-test' });
    try {
      await vault.initialize();
      const maliciousContent = '# forged history';
      const maliciousRecord = {
        id: '../../sentinel', path: 'Note.md', rootPath,
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        etag: createHash('sha256').update(maliciousContent).digest('hex'), content: maliciousContent,
      };
      const maliciousRecordText = JSON.stringify(maliciousRecord);
      const maliciousRecordPath = path.join(historyDir, 'untrusted.json');
      await writeFile(maliciousRecordPath, maliciousRecordText);
      await writeFile(sentinelPath, 'keep this file');
      const current = await vault.getFile('Note.md');
      await vault.writeFile('Note.md', '# updated', current.etag);
      expect((await vault.history('Note.md')).versions.map(({ id }) => id)).not.toContain('../../sentinel');
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('keep this file');
      await expect(readFile(maliciousRecordPath, 'utf8')).resolves.toBe(maliciousRecordText);
      await expect(vault.restoreHistory('Note.md', '../../sentinel')).rejects.toThrow(/id/);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('resolves path precedence, links created targets, rejects traversal/symlink escape and detects stale buffers', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-core-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const dataDir = path.join(base, 'data');
    const outside = path.join(base, 'outside.md');
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await mkdir(path.join(rootPath, 'Elsewhere'), { recursive: true });
    await mkdir(path.join(rootPath, 'deep'), { recursive: true });
    await mkdir(path.join(rootPath, 'x'), { recursive: true });
    await mkdir(path.join(rootPath, 'very', 'long', 'path'), { recursive: true });
    await writeFile(path.join(rootPath, 'Folder', 'Source.md'), '[[Note]]\n[[Quick Name]]\n[[../Elsewhere/Note]]\n[[/Elsewhere/Note.md]]\n[[]]\n[[Unique]]\n[[Shortest]]\n[[CreatedLater]]');
    await writeFile(path.join(rootPath, 'Folder', 'Note.md'), '# same-folder');
    await writeFile(path.join(rootPath, 'Elsewhere', 'Note.md'), '# other-folder');
    await writeFile(path.join(rootPath, 'Folder', 'First.md'), '---\naliases: [Unique]\n---\n# First');
    await writeFile(path.join(rootPath, 'deep', 'Longer.md'), '---\naliases: [Unique]\n---\n# Longer');
    await writeFile(path.join(rootPath, 'x', 'One.md'), '---\naliases: [Shortest]\n---\n# One');
    await writeFile(path.join(rootPath, 'very', 'long', 'path', 'Two.md'), '---\naliases: [Shortest]\n---\n# Two');
    await writeFile(path.join(rootPath, 'Folder', 'Alias.md'), '---\naliases: [Quick Name]\n---\n# Alias');
    await writeFile(outside, 'secret');
    await symlink(base, path.join(rootPath, 'escape'), 'dir');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir, repository, userId: 'vault-test' });
    try {
      await vault.initialize();
      expect(await vault.resolveLink('Note', 'Folder/Source.md')).toBe('Folder/Note.md');
      expect(await vault.resolveLink('Quick Name', 'Folder/Source.md')).toBe('Folder/Alias.md');
      expect(await vault.resolveLink('../Elsewhere/Note', 'Folder/Source.md')).toBe('Elsewhere/Note.md');
      expect(await vault.resolveLink('/Elsewhere/Note.md', 'Folder/Source.md')).toBe('Elsewhere/Note.md');
      expect(await vault.resolveLink('', 'Folder/Source.md')).toBe('Folder/Source.md');
      expect(await vault.resolveLink('Unique', 'Folder/Source.md')).toBe('Folder/First.md');
      expect(await vault.resolveLink('Shortest', 'Folder/Source.md')).toBe('x/One.md');
      expect((await vault.getLinks()).unresolvedLinks['Folder/Source.md']?.CreatedLater).toBe(1);
      await expect(vault.getFile('../outside.md')).rejects.toThrow();
      await expect(vault.getFile('escape/outside.md')).rejects.toThrow();
      await expect(vault.createFolder('escape/new')).rejects.toThrow();

      const created = await vault.writeFile('CreatedLater.md', '# created');
      expect(created.etag).toBeTruthy();
      expect((await vault.getLinks()).resolvedLinks['Folder/Source.md']?.['CreatedLater.md']).toBe(1);
      const updated = await vault.writeFile('CreatedLater.md', '# updated', created.etag);
      await expect(vault.writeFile('CreatedLater.md', '# stale', created.etag)).rejects.toThrow(/其他编辑/);
      await writeFile(path.join(rootPath, 'CreatedLater.md'), '# external');
      expect((await vault.getFile('CreatedLater.md')).content).toBe('# external');
      expect(updated.etag).not.toBe(created.etag);
    } finally {
      await vault.close();
      const closable = repository as { close?: () => Promise<void> };
      await closable.close?.();
    }
  });

  it.each([
    ['same path', 'Note.md'],
    ['case-folded path', 'note.MD'],
    ['NFC-equivalent path', 'Cafe\u0301.md'],
  ])('treats a no-etag write as create-only for %s and preserves the existing bytes', async (_label, attemptedPath) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-create-only-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Note.md'), '# original');
    await writeFile(path.join(rootPath, 'Café.md'), '# accent');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-create-only-test' });
    try {
      await vault.initialize();
      const expectedOriginal = attemptedPath.startsWith('Cafe') ? '# accent' : '# original';
      await expect(vault.writeFile(attemptedPath, '# overwrite')).rejects.toThrow(/存在|冲突/);
      const actual = attemptedPath.startsWith('Cafe') ? 'Café.md' : 'Note.md';
      expect(await readFile(path.join(rootPath, actual), 'utf8')).toBe(expectedOriginal);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('rejects case-folded parent components before create or move and reuses NFC-equivalent filesystem spelling', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-parent-collision-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const decomposedFolder = 'Cafe\u0301';
    const nbspFolder = 'Space\u00a0Dir';
    const nbspFileName = 'Existing\u00a0File.md';
    await mkdir(path.join(rootPath, decomposedFolder), { recursive: true });
    await mkdir(path.join(rootPath, nbspFolder), { recursive: true });
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await writeFile(path.join(rootPath, 'Source.md'), '# source');
    await writeFile(path.join(rootPath, nbspFileName), '# existing NBSP file');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-parent-collision-test' });
    try {
      await vault.initialize();
      const unicodeFile = await vault.writeFile('Café/Unicode.md', '# reused physical folder');
      expect(unicodeFile.path).toBe('Café/Unicode.md');
      await expect(readFile(path.join(rootPath, decomposedFolder, 'Unicode.md'), 'utf8')).resolves.toBe('# reused physical folder');
      const nbspFile = await vault.writeFile('Space Dir/Access.md', '# reused NBSP folder');
      expect(nbspFile.path).toBe('Space Dir/Access.md');
      expect((await vault.getFile('Space\u00a0Dir/Access.md')).content).toBe('# reused NBSP folder');
      expect((await vault.getFile(nbspFileName)).content).toBe('# existing NBSP file');
      await expect(vault.writeFile('Existing File.md', '# must not replace NBSP file')).rejects.toThrow(/已经存在/);
      await expect(readFile(path.join(rootPath, nbspFileName), 'utf8')).resolves.toBe('# existing NBSP file');

      await expect(vault.writeFile('folder/New.md', '# must not write')).rejects.toThrow(/大小写/);
      await expect(vault.createFolder('folder/Sub')).rejects.toThrow(/大小写/);
      await expect(vault.writeFile('space Dir/Rejected.md', '# must not write')).rejects.toThrow(/大小写/);
      const source = await vault.getFile('Source.md');
      await expect(vault.renamePath('Source.md', 'folder/Moved.md', source.etag)).rejects.toThrow(/大小写/);
      await expect(readFile(path.join(rootPath, 'Source.md'), 'utf8')).resolves.toBe('# source');
      await expect(readFile(path.join(rootPath, 'folder', 'New.md'))).rejects.toThrow();
      await expect(readFile(path.join(rootPath, 'folder', 'Sub'))).rejects.toThrow();
      await expect(readFile(path.join(rootPath, 'Space Dir', 'Rejected.md'))).rejects.toThrow();
      expect(await readdir(rootPath)).not.toContain('folder');
      expect(await readdir(rootPath)).not.toContain('space Dir');
      expect((await vault.snapshot()).files.map(({ path: filePath }) => filePath)).toContain('Café/Unicode.md');
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it.each([
    ['shortest', '[[New#part|New]]', '[shown](New.md)'],
    ['relative', '[[./New#part|New]]', '[shown](./New.md)'],
    ['absolute', '[[/Folder/New#part|New]]', '[shown](/Folder/New.md)'],
  ] as const)('rewrites links using the persisted %s format without losing aliases or display text', async (newLinkFormat, expectedWiki, expectedMarkdown) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-link-format-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await writeFile(path.join(rootPath, 'Folder', 'Source.md'), '---\n# keep this yaml comment\ntitle: Source\nrelated:\n  link: "[[Old#part|Old]]"\n---\n[[Old#part|Old]]\n[shown](Old.md)\n');
    await writeFile(path.join(rootPath, 'Folder', 'Old.md'), '# Old');
    const repository = createInMemoryRepository();
    const options = { rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-link-format-test' };
    const vault = new VaultService(options);
    await vault.initialize();
    await vault.updateSettings({ newLinkFormat });
    await vault.renamePath('Folder/Old.md', 'Folder/New.md', (await vault.getFile('Folder/Old.md')).etag);
    const rewrittenSource = (await vault.getFile('Folder/Source.md')).content;
    expect(rewrittenSource).toContain(expectedWiki);
    expect(rewrittenSource).toContain(expectedMarkdown);
    expect(parseFrontmatterValue(rewrittenSource)).toMatchObject({ title: 'Source', related: { link: expectedWiki } });
    expect(rewrittenSource).toContain('# keep this yaml comment');
    await vault.close();
    const reopened = new VaultService(options);
    try {
      await reopened.initialize();
      expect(await reopened.getSettings()).toEqual({ newLinkFormat });
    } finally {
      await reopened.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('preserves CRLF frontmatter and body when renaming a YAML wikilink target', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-crlf-rename-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Source.md'), '---\r\nrelated: "[[Target|Target]]"\r\ntitle: Keep\r\n---\r\n# Body\r\n');
    await writeFile(path.join(rootPath, 'Target.md'), '# target\r\n');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-crlf-rename-test' });
    try {
      await vault.initialize();
      await vault.renamePath('Target.md', 'Renamed.md', (await vault.getFile('Target.md')).etag);
      const rewritten = await readFile(path.join(rootPath, 'Source.md'), 'utf8');
      expect(rewritten).toContain('related: "[[Renamed|Renamed]]"\r\n');
      expect(rewritten.match(/(?<!\r)\n/g)).toBeNull();
      expect(rewritten.endsWith('# Body\r\n')).toBe(true);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('keeps new-link format scoped to each Vault across switches and restarts', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-settings-scope-'));
    roots.push(base);
    const rootA = path.join(base, 'vault-a');
    const rootB = path.join(base, 'vault-b');
    const dataDir = path.join(base, 'data');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    const repository = createInMemoryRepository();
    const options = { rootPath: rootA, dataDir, repository, userId: 'vault-settings-scope-test' };
    const vault = new VaultService(options);
    await vault.initialize();
    await vault.updateSettings({ newLinkFormat: 'relative' });
    await vault.openVault(rootB);
    expect(await vault.getSettings()).toEqual({ newLinkFormat: 'shortest' });
    await vault.updateSettings({ newLinkFormat: 'absolute' });
    await vault.openVault(rootA);
    expect(await vault.getSettings()).toEqual({ newLinkFormat: 'relative' });
    await vault.close();

    const reopened = new VaultService(options);
    try {
      await reopened.initialize();
      expect(await reopened.getSettings()).toEqual({ newLinkFormat: 'relative' });
      await reopened.openVault(rootB);
      expect(await reopened.getSettings()).toEqual({ newLinkFormat: 'absolute' });
    } finally {
      await reopened.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

});

describe('vault search grammar', () => {
  const content = [
    '---', 'rating: 5', '---', '# Section', 'needle and phrase', '#tag', '- [ ] todo needle', '- [x] done needle', 'block text ^block1', '',
  ].join('\n');
  const file = { path: 'Folder/Fixture.md', title: 'Fixture', content, metadata: parseMarkdown(content).metadata };
  const queries = [
    ['needle phrase', true], ['needle OR absent', true], ['needle -absent', true], ['[rating>=3]', true],
    ['[rating>4]', true], ['[rating<6]', true], ['[rating<=5]', true], ['[rating!=4]', true], ['[rating=5]', true],
    ['[rating!=5]', false], ['[rating>=6]', false],
    ['/needl[e]/', true], ['tag:tag', true], ['line:todo', true], ['task-todo:todo', true], ['task-done:done', true],
    ['block:block1', true], ['section:Section', true], ['path:Folder', true], ['file:Fixture', true], ['"needle and phrase"', true],
  ] as const;
  it.each(queries)('evaluates %s', (query, expected) => expect(searchNotes(query, [file]).length > 0).toBe(expected));

  it('reports which field owns offsets and keeps fuzzy ranking deterministic', () => {
    const pathHit = searchNotes('file:Fixture', [file])[0];
    expect(pathHit?.matches[0]?.field).toBe('path');
    const propertyHit = searchNotes('[rating=5]', [file])[0];
    expect(propertyHit?.matches[0]?.field).toBe('frontmatter');
    expect(fuzzyScore('abc', 'abc')).toBeGreaterThan(fuzzyScore('abc', 'a--b--c') ?? -Infinity);
  });

  it('returns exact title and excerpt ranges from the query evaluation', () => {
    const contentHit = searchNotes('needle', [file])[0]!;
    expect(contentHit.snippet.slice(contentHit.snippetMatches[0]!.start, contentHit.snippetMatches[0]!.end)).toBe('needle');
    const titleHit = searchNotes('Fixture', [file])[0]!;
    expect(titleHit.title.slice(titleHit.titleMatches[0]!.start, titleHit.titleMatches[0]!.end)).toBe('Fixture');
    const propertyHit = searchNotes('[rating=5]', [file])[0]!;
    expect(propertyHit.snippet.slice(propertyHit.snippetMatches[0]!.start, propertyHit.snippetMatches[0]!.end)).toBe('5');
    const tagHit = searchNotes('tag:tag', [file])[0]!;
    expect(tagHit.titleMatches).toEqual([]);
  });

  it('applies case modifiers, NOT, and exclusive operator validation', () => {
    const mixed = { ...file, content: 'Only Needle', metadata: parseMarkdown('Only Needle').metadata };
    expect(searchNotes('match-case: Needle', [mixed])).toHaveLength(1);
    expect(searchNotes('match-case: needle', [mixed])).toHaveLength(0);
    expect(searchNotes('ignore-case: NEEDLE', [mixed])).toHaveLength(1);
    expect(searchNotes('NOT absent', [mixed])).toHaveLength(1);
    expect(() => searchNotes('file:content:needle', [mixed])).toThrow(/不可嵌套/);
    const exclusive = ['path', 'file', 'content', 'line', 'block', 'section', 'task', 'task-todo', 'task-done'];
    for (const outer of exclusive) {
      for (const inner of exclusive) {
        const query = `${outer}:${inner}:needle`;
        expect(() => searchNotes(query, [mixed]), query).toThrow(/不可嵌套/);
      }
    }
    expect(() => searchNotes('file:(content:needle)', [mixed])).toThrow(/不可嵌套/);
    expect(searchNotes('file:Fixture OR content:needle', [mixed])).toHaveLength(1);
  });

  it('caches regex compilers by TTL/LRU and keeps fuzzy scores aligned with the documented formula for camelCase and CJK', () => {
    expect(searchNotes('/Needle/i', [file])).toHaveLength(1);
    expect(searchNotes('/Needle/i', [file])[0]?.matches[0]?.field).toBe('content');
    expect(() => searchNotes('/[/i', [file])).toThrow(/正则表达式无效/);
    expect(fuzzyScore('fb', 'fooBar')).toBeCloseTo(-1.1206, 4);
    expect(fuzzyScore('中记', '中文笔记')).toBeCloseTo(-1.0204, 4);
    expect(fuzzyScore('foo bar', 'fooBar')).not.toBeNull();
    expect(fuzzyScore('中文', '中文笔记')).toBeCloseTo(-0.0004, 4);
    expect(fuzzyScore('non', '中文笔记')).toBeNull();
  });

  it('expires cached regexes after 60 seconds and evicts the least-recently-used entry at capacity', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'RegExp');
    const query = '/noltri-ttl-marker/';
    try {
      searchNotes(query, [file]);
      const firstCount = spy.mock.calls.length;
      searchNotes(query, [file]);
      expect(spy.mock.calls.length).toBe(firstCount);
      vi.advanceTimersByTime(60_001);
      searchNotes(query, [file]);
      const afterExpiry = spy.mock.calls.length;
      expect(afterExpiry).toBe(firstCount + 1);
      for (let index = 0; index < 256; index += 1) searchNotes(`/noltri-lru-${index}/`, [file]);
      searchNotes(query, [file]);
      expect(spy.mock.calls.length).toBeGreaterThan(afterExpiry + 1);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('vault cache, block renames, and safe deletion', () => {
  it('drains an active refresh before closing its filesystem watchers', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-close-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Note.md'), '# Note');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-close-test' });
    await vault.initialize();
    const activeRefresh = (vault as unknown as { refresh(force: boolean): Promise<void> }).refresh(true);
    await vault.close();
    await activeRefresh;
    expect((vault as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0);
    await (repository as { close?: () => Promise<void> }).close?.();
  });

  it('restarts a timed-out parser and continues with queued files', async () => {
    const parser = new MetadataParserWorker(new URL('../src/notes/parser.ts', import.meta.url).href);
    try {
      const slow = parser.parse('# time out', 0);
      const next = parser.parse('# still parsed', 5_000);
      await expect(slow).rejects.toThrow(/exceeded 0ms/);
      expect((await next).metadata.headings?.[0]?.heading).toBe('still parsed');
      expect(parser.timeouts).toBe(1);
      expect(parser.restarts).toBe(1);
    } finally { await parser.close(); }
  });

  it('persists root-scoped metadata hashes and renames only exact block references', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-cache-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const dataDir = path.join(base, 'data');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Target.md'), '# target\nline ^old\n');
    await writeFile(path.join(rootPath, 'Source.md'), '[[Target#^old|display]]\n[[Target#Target]]\n');
    const repository = createInMemoryRepository();
    const first = new VaultService({ rootPath, dataDir, repository, userId: 'vault-cache-test' });
    await first.initialize();
    const target = await first.getFile('Target.md');
    const result = await first.renameBlock('Target.md', 'old', 'new', target.etag);
    expect(result.file.content).toContain('line ^new');
    expect((await first.getFile('Source.md')).content).toContain('[[Target#^new|display]]');
    expect((await first.getFile('Source.md')).content).toContain('[[Target#Target]]');
    expect((await first.diagnostics()).cache.persisted).toBe(true);
    await first.close();

    const second = new VaultService({ rootPath, dataDir, repository, userId: 'vault-cache-test' });
    try {
      await second.initialize();
      expect((await second.diagnostics()).cache.loaded).toBe(true);
      expect((await second.getMetadata('Target.md'))?.blocks?.new).toBeDefined();
    } finally {
      await second.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('snapshots external edits and deletions before replacing the indexed bytes, without startup duplicates', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-external-history-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const dataDir = path.join(base, 'data');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'External.md'), '# version one');
    const repository = createInMemoryRepository();
    const options = { rootPath, dataDir, repository, userId: 'vault-external-history-test' };
    const first = new VaultService(options);
    await first.initialize();
    try {
      await writeFile(path.join(rootPath, 'External.md'), '# version two');
      await (first as unknown as { refresh(force: boolean): Promise<void> }).refresh(true);
      const afterEdit = await first.history('External.md');
      expect(afterEdit.versions).toHaveLength(1);
      expect((await first.historyVersion('External.md', afterEdit.versions[0]!.id)).content).toBe('# version one');

      await rm(path.join(rootPath, 'External.md'));
      await (first as unknown as { refresh(force: boolean): Promise<void> }).refresh(true);
      const afterDelete = await first.history('External.md');
      expect(afterDelete.versions).toHaveLength(2);
      expect((await first.historyVersion('External.md', afterDelete.versions[0]!.id)).content).toBe('# version two');
      const restored = await first.restoreHistory('External.md', afterDelete.versions[0]!.id);
      expect(restored.content).toBe('# version two');
    } finally { await first.close(); }

    const restarted = new VaultService(options);
    try {
      await restarted.initialize();
      expect((await restarted.history('External.md')).versions).toHaveLength(2);
    } finally {
      await restarted.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('force-snapshots the current note before restoring an older text version', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-restore-history-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Note.md'), '# one');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-restore-history-test' });
    try {
      await vault.initialize();
      const original = await vault.getFile('Note.md');
      await vault.writeFile('Note.md', '# two', original.etag);
      const originalVersion = (await vault.history('Note.md')).versions[0]!;
      const latest = await vault.getFile('Note.md');
      await vault.writeFile('Note.md', '# three', latest.etag);
      await vault.restoreHistory('Note.md', originalVersion.id, (await vault.getFile('Note.md')).etag);
      const versions = await vault.history('Note.md');
      expect(versions.versions).toHaveLength(2);
      expect((await vault.historyVersion('Note.md', versions.versions[0]!.id)).content).toBe('# three');
      expect((await vault.getFile('Note.md')).content).toBe('# one');
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('keeps shared history isolated by exact Vault root and refuses rootless legacy snapshots', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-history-root-'));
    roots.push(base);
    const rootA = path.join(base, 'vault-a');
    const rootB = path.join(base, 'vault-b');
    const dataDir = path.join(base, 'data');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, 'Note.md'), '# root A');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath: rootA, dataDir, repository, userId: 'vault-history-root-test' });
    try {
      await vault.initialize();
      const original = await vault.getFile('Note.md');
      await vault.writeFile('Note.md', '# updated in root A', original.etag);
      const rootAHistory = await vault.history('Note.md');
      const rootAId = rootAHistory.versions[0]!.id;
      await vault.openVault(rootB);
      expect((await vault.history('Note.md')).versions).toHaveLength(0);
      await expect(vault.restoreHistory('Note.md', rootAId)).rejects.toThrow(/不存在/);
      await expect(readFile(path.join(rootB, 'Note.md'))).rejects.toThrow();

      await writeFile(path.join(base, 'data', 'vault-history', 'legacy-rootless.json'), JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111', path: 'Note.md', createdAt: new Date().toISOString(), etag: 'old', content: '# ambiguous',
      }));
      await vault.close();
      const reopened = new VaultService({ rootPath: rootB, dataDir, repository, userId: 'vault-history-root-test' });
      try {
        await reopened.initialize();
        expect((await reopened.history('Note.md')).versions).toHaveLength(0);
        await expect(reopened.restoreHistory('Note.md', '11111111-1111-4111-8111-111111111111')).rejects.toThrow(/不存在/);
      } finally { await reopened.close(); }
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('watches only the currently open Vault after switching roots', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-switch-watch-'));
    roots.push(base);
    const rootA = path.join(base, 'vault-a');
    const rootB = path.join(base, 'vault-b');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath: rootA, dataDir: path.join(base, 'data'), repository, userId: 'vault-switch-watch-test' });
    try {
      await vault.initialize();
      const afterSwitch = (await vault.openVault(rootB)).revision;
      await writeFile(path.join(rootA, 'OldRoot.md'), '# old root');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await vault.changesAfter(afterSwitch)).events.map(({ path: itemPath }) => itemPath)).not.toContain('OldRoot.md');

      await writeFile(path.join(rootB, 'CurrentRoot.md'), '# current root');
      let currentRootObserved = false;
      for (let attempt = 0; attempt < 20 && !currentRootObserved; attempt += 1) {
        currentRootObserved = (await vault.changesAfter(afterSwitch)).events.some(({ path: itemPath }) => itemPath === 'CurrentRoot.md');
        if (!currentRootObserved) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(currentRootObserved).toBe(true);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('keeps migrated deletions as root-scoped tombstones across restarts and offers explicit restore', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-migration-'));
    roots.push(base);
    const rootA = path.join(base, 'vault-a');
    const rootB = path.join(base, 'vault-b');
    const dataDir = path.join(base, 'data');
    const repository = createInMemoryRepository();
    const userId = 'vault-migration-test';
    const topic = await repository.createNode({ userId, title: 'Topic', nodeType: 'topic' });
    const chapter = await repository.createNode({ userId, title: 'Chapter', nodeType: 'chapter' });
    await repository.saveKnowledgeNote({ userId, topicId: topic.id, chapterId: null, content: '# Archived overview' });
    await repository.saveKnowledgeNote({ userId, topicId: topic.id, chapterId: chapter.id, content: '# Archived chapter' });
    const ids = [{ topicId: topic.id, chapterId: null }, { topicId: topic.id, chapterId: chapter.id }];
    const first = new VaultService({ rootPath: rootA, dataDir, repository, userId });
    await first.initialize();
    const movedPaths: string[] = [];
    for (const id of ids) {
      const original = await first.legacyPath(id.topicId, id.chapterId);
      expect(original.exists).toBe(true);
      const moved = `moved/${path.posix.basename(original.path)}`;
      await first.renamePath(original.path, moved, (await first.getFile(original.path)).etag);
      const file = await first.getFile(moved);
      await first.deleteFile(moved, file.etag, 'never');
      movedPaths.push(moved);
    }
    await first.close();

    const restarted = new VaultService({ rootPath: rootA, dataDir, repository, userId });
    try {
      await restarted.initialize();
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]!;
        const state = await restarted.legacyPath(id.topicId, id.chapterId);
        expect(state).toEqual({ path: movedPaths[index], exists: false });
        expect((await restarted.getLegacyNote(id.topicId, id.chapterId)).content).toBe('');
        await expect(restarted.getFile(movedPaths[index]!)).rejects.toThrow();
      }
      const restored = await restarted.restoreLegacyNote(topic.id, null);
      expect(restored.path).toBe(movedPaths[0]);
      expect(restored.content).toBe('# Archived overview');
      await expect(restarted.restoreLegacyNote(topic.id, null)).rejects.toThrow(/不会覆盖/);

      const snapshot = await restarted.openVault(rootB);
      expect(snapshot.rootPath).toBe(await realpath(rootB));
      for (const id of ids) {
        const mapped = await restarted.legacyPath(id.topicId, id.chapterId);
        expect(mapped.exists).toBe(true);
        expect(mapped.path).not.toMatch(/^moved\//);
      }
    } finally {
      await restarted.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('previews orphan assets, requires an explicit choice, and restores deleted binary bytes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-delete-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Note.md'), '![orphan](orphan.bin)\n[[Other]]');
    await writeFile(path.join(rootPath, 'Other.md'), '[[Note]]\n![shared](shared.bin)');
    await writeFile(path.join(rootPath, 'orphan.bin'), Buffer.from([0, 255, 17, 0]));
    await writeFile(path.join(rootPath, 'shared.bin'), Buffer.from([9, 8, 7]));
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-delete-test' });
    try {
      await vault.initialize();
      const preview = await vault.deletePreview('Note.md');
      expect(preview.backlinkCount).toBe(1);
      expect(preview.orphanAttachments.map(({ path: item }) => item)).toEqual(['orphan.bin']);
      await expect(vault.deleteFile('Note.md', preview.etag, 'ask')).rejects.toThrow(/孤儿附件/);
      await vault.deleteFile('Note.md', preview.etag, 'always');
      await expect(readFile(path.join(rootPath, 'Note.md'))).rejects.toThrow();
      await expect(readFile(path.join(rootPath, 'orphan.bin'))).rejects.toThrow();
      expect(await readFile(path.join(rootPath, 'shared.bin'))).toEqual(Buffer.from([9, 8, 7]));
      const history = await vault.history('orphan.bin');
      expect(history.versions).toHaveLength(1);
      await vault.restoreHistory('orphan.bin', history.versions[0]!.id);
      expect(await readFile(path.join(rootPath, 'orphan.bin'))).toEqual(Buffer.from([0, 255, 17, 0]));
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('finds mixed CJK/English mentions while excluding frontmatter, fenced code and existing references', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-mentions-cjk-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, '目标Noltri.md'), '---\naliases: [另一个名称]\n---\n# Target');
    const sourceContent = [
      '---', 'description: "目标Noltri"', '---', '请阅读 目标Noltri 的说明。', '[[目标Noltri]]',
      '`目标Noltri`', '```md', '目标Noltri', '```', '[reference]: [[目标Noltri]]',
    ].join('\n');
    await writeFile(path.join(rootPath, 'Source.md'), sourceContent);
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-cjk-mentions-test' });
    try {
      await vault.initialize();
      const result = await vault.mentions('目标Noltri.md');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0]?.sourcePath).toBe('Source.md');
      expect(result.mentions[0]?.positions.map(({ start, end }) => [start.offset, end.offset])).toEqual([
        [sourceContent.indexOf('目标Noltri', sourceContent.indexOf('---', 4) + 3), sourceContent.indexOf('目标Noltri', sourceContent.indexOf('---', 4) + 3) + '目标Noltri'.length],
      ]);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('previews folder contents and external backlinks, rejects stale tree etags, and restores nested binary bytes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-folder-delete-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Pack', 'nested', 'empty'), { recursive: true });
    await writeFile(path.join(rootPath, 'Pack', 'One.md'), '![inside](nested/inside.bin)\n![orphan](../shared.bin)');
    await writeFile(path.join(rootPath, 'Pack', 'nested', 'inside.bin'), Buffer.from([0, 255, 17]));
    await writeFile(path.join(rootPath, 'Outside.md'), '[[Pack/One]]');
    await writeFile(path.join(rootPath, 'shared.bin'), Buffer.from([8, 7, 6]));
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-folder-delete-test' });
    try {
      await vault.initialize();
      const preview = await vault.deletePreview('Pack');
      expect(preview).toMatchObject({ kind: 'folder', descendantCount: 2, backlinkCount: 1 });
      expect(preview.orphanAttachments.map(({ path: item }) => item)).toEqual(['shared.bin']);

      await writeFile(path.join(rootPath, 'Pack', 'One.md'), '![inside](nested/inside.bin)\n![orphan](../shared.bin)\n# externally changed');
      await expect(vault.deleteFile('Pack', preview.etag, 'never')).rejects.toThrow(/etg|etag|变化|修改/);
      expect(await readFile(path.join(rootPath, 'Pack', 'One.md'), 'utf8')).toContain('# externally changed');

      const fresh = await vault.deletePreview('Pack');
      await expect(vault.deleteFile('Pack', fresh.etag, 'ask')).rejects.toThrow(/孤儿附件/);
      await vault.deleteFile('Pack', fresh.etag, 'never');
      await expect(readFile(path.join(rootPath, 'Pack', 'One.md'))).rejects.toThrow();
      expect(await readFile(path.join(rootPath, 'shared.bin'))).toEqual(Buffer.from([8, 7, 6]));
      const history = await vault.history('Pack/nested/inside.bin');
      expect(history.versions).toHaveLength(1);
      await vault.restoreHistory('Pack/nested/inside.bin', history.versions[0]!.id);
      expect(await readFile(path.join(rootPath, 'Pack', 'nested', 'inside.bin'))).toEqual(Buffer.from([0, 255, 17]));
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('requires the complete current folder etag before rename and refuses file/directory target collisions', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-folder-rename-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Pack'), { recursive: true });
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await writeFile(path.join(rootPath, 'Pack', 'One.md'), '# one');
    await writeFile(path.join(rootPath, 'Outside.md'), '[[Pack/One]]');
    await writeFile(path.join(rootPath, 'Blocker'), 'file, not a folder');
    await writeFile(path.join(rootPath, 'Other.md'), '# other');
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-folder-rename-test' });
    try {
      await vault.initialize();
      const stale = await vault.deletePreview('Pack');
      await writeFile(path.join(rootPath, 'Pack', 'Added.md'), '# external addition');
      await expect(vault.renamePath('Pack', 'Moved', stale.etag)).rejects.toThrow(/etg|etag|变化|修改/);
      await expect(readFile(path.join(rootPath, 'Pack', 'One.md'), 'utf8')).resolves.toBe('# one');
      await expect(readFile(path.join(rootPath, 'Moved', 'One.md'))).rejects.toThrow();

      const fresh = await vault.deletePreview('Pack');
      await vault.renamePath('Pack', 'Moved', fresh.etag);
      await expect(readFile(path.join(rootPath, 'Moved', 'One.md'), 'utf8')).resolves.toBe('# one');
      await expect(vault.resolveLink('Moved/One', 'Outside.md')).resolves.toBe('Moved/One.md');

      const other = await vault.getFile('Other.md');
      await expect(vault.renamePath('Other.md', 'Blocker/Other.md', other.etag)).rejects.toThrow();
      await expect(readFile(path.join(rootPath, 'Other.md'), 'utf8')).resolves.toBe('# other');
      const folder = await vault.deletePreview('Folder');
      await expect(vault.renamePath('Folder', 'Blocker/Folder', folder.etag)).rejects.toThrow();
      await expect(vault.deletePreview('Folder')).resolves.toMatchObject({ kind: 'folder' });
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('rebases moved source outlinks and preserves self-link aliases and subpaths', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-move-links-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Folder', 'Sub'), { recursive: true });
    await writeFile(path.join(rootPath, 'RootTarget.md'), '# A\n## B\n');
    await writeFile(path.join(rootPath, 'Folder', 'Sub', 'Source.md'), [
      '# A', '## B', 'paragraph ^source-block',
      '[[../../RootTarget#A#B|RootTarget]]',
      '[[Source#A#B|Source]]',
      '[[Source#^source-block|Source]]',
      '[[Source#A#B|Custom]]',
      '[shown](Source.md#A#B)',
      '[titled](Source.md?mode=1#A#B "Tip")',
      '[encoded](Encoded%20Target.md?mode=1#A#B "Encoded title")',
      '[[LocalTarget#Section|LocalTarget]]',
    ].join('\n'));
    await writeFile(path.join(rootPath, 'Folder', 'Sub', 'Encoded Target.md'), '# Target');
    await writeFile(path.join(rootPath, 'Folder', 'Sub', 'LocalTarget.md'), '# Section\n[[Source#A#B|Source]]');
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-move-links-test' });
    try {
      await vault.initialize();
      const folder = await vault.deletePreview('Folder/Sub');
      await vault.renamePath('Folder/Sub', 'Moved', folder.etag);
      const movedSource = await vault.getFile('Moved/Source.md');
      expect(movedSource.content).toContain('[[RootTarget#A#B|RootTarget]]');
      expect(await vault.resolveLink('RootTarget', 'Moved/Source.md')).toBe('RootTarget.md');

      const encodedTarget = await vault.getFile('Moved/Encoded Target.md');
      await vault.renamePath(encodedTarget.path, 'Moved/Renamed Target.md', encodedTarget.etag);
      const updatedSource = await vault.getFile('Moved/Source.md');
      expect(updatedSource.content).toContain('[encoded](Renamed%20Target.md?mode=1#A#B "Encoded title")');

      await vault.renamePath('Moved/Source.md', 'Moved/Changed.md', updatedSource.etag);
      const changed = await vault.getFile('Moved/Changed.md');
      expect(changed.content).toContain('[[Changed#A#B|Changed]]');
      expect(changed.content).toContain('[[Changed#^source-block|Changed]]');
      expect(changed.content).toContain('[[Changed#A#B|Custom]]');
      expect(changed.content).toContain('[shown](Changed.md#A#B)');
      expect(changed.content).toContain('[titled](Changed.md?mode=1#A#B "Tip")');
      expect(changed.content).toContain('[encoded](Renamed%20Target.md?mode=1#A#B "Encoded title")');
      expect(changed.content).toContain('[[LocalTarget#Section|LocalTarget]]');
      expect(await vault.resolveLink('Changed', changed.path)).toBe('Moved/Changed.md');
      expect(await vault.resolveLink('LocalTarget', changed.path)).toBe('Moved/LocalTarget.md');
      expect((await vault.getFile('Moved/LocalTarget.md')).content).toContain('[[Changed#A#B|Changed]]');
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('uses Markdown URL paths relative to the source and does not resolve wiki aliases', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-markdown-paths-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await writeFile(path.join(rootPath, 'Alias.md'), '---\naliases: [Friendly]\n---\n# Alias');
    await writeFile(path.join(rootPath, 'Target.md'), '# Root target');
    await writeFile(path.join(rootPath, 'Folder', 'Target.md'), '# Local target');
    await writeFile(path.join(rootPath, 'Folder', 'Source.md'), '[local](Target.md)\n[ordinary](Friendly)\n[[Friendly]]');
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-markdown-paths-test' });
    try {
      await vault.initialize();
      const local = await vault.getFile('Folder/Target.md');
      await vault.renamePath(local.path, 'Folder/Renamed.md', local.etag);
      const source = await vault.getFile('Folder/Source.md');
      expect(source.content).toContain('[local](Renamed.md)');
      expect(source.content).toContain('[ordinary](Friendly)');
      expect(source.content).toContain('[[Friendly]]');

      const alias = await vault.getFile('Alias.md');
      await vault.renamePath(alias.path, 'Changed Alias.md', alias.etag);
      expect((await vault.getFile('Folder/Source.md')).content).toContain('[[Changed Alias]]');
      expect((await vault.getFile('Folder/Source.md')).content).toContain('[ordinary](Friendly)');
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('keeps Markdown metadata, backlinks, and typed URL resolution on the same target', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-typed-link-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Nested'), { recursive: true });
    await writeFile(path.join(rootPath, 'Target.md'), '# root');
    await writeFile(path.join(rootPath, 'Nested', 'Target.md'), '# nested');
    await writeFile(path.join(rootPath, 'Friendly Target.md'), '---\naliases: [Friendly]\n---\n# friendly');
    await writeFile(path.join(rootPath, 'Nested', 'Source.md'), [
      '[local](Target.md?mode=1#A#B)',
      '[root](../Target.md)',
      '[alias bait](Friendly)',
      '[[Friendly]]',
    ].join('\n'));
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-typed-link-test' });
    try {
      await vault.initialize();
      const source = await vault.getMetadata('Nested/Source.md');
      const markdownLinks = source?.links?.filter((link) => link.kind === 'markdown') ?? [];
      expect(markdownLinks).toHaveLength(3);
      expect(await vault.resolveLink(markdownLinks[0]!.link, 'Nested/Source.md', 'markdown')).toBe('Nested/Target.md');
      expect(await vault.resolveLink(markdownLinks[1]!.link, 'Nested/Source.md', 'markdown')).toBe('Target.md');
      expect(await vault.resolveLink(markdownLinks[2]!.link, 'Nested/Source.md', 'markdown')).toBeNull();
      expect(await vault.resolveLink('Friendly', 'Nested/Source.md')).toBe('Friendly Target.md');
      expect(await vault.resolveLink('#A#B', 'Nested/Source.md', 'markdown')).toBe('Nested/Source.md');
      expect(await vault.resolveLink('../../../outside.md', 'Nested/Source.md', 'markdown')).toBeNull();

      const links = await vault.getLinks();
      expect(links.resolvedLinks['Nested/Source.md']).toMatchObject({ 'Nested/Target.md': 1, 'Target.md': 1, 'Friendly Target.md': 1 });
      expect(links.unresolvedLinks['Nested/Source.md']).toMatchObject({ Friendly: 1 });
      expect((await vault.getBacklinks('Nested/Target.md')).backlinks).toMatchObject([{ sourcePath: 'Nested/Source.md', count: 1 }]);
      expect((await vault.getBacklinks('Target.md')).backlinks).toMatchObject([{ sourcePath: 'Nested/Source.md', count: 1 }]);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('chooses a Markdown shortest path that does not depend on wiki aliases', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-markdown-shortest-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(path.join(rootPath, 'Folder'), { recursive: true });
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Source.md'), '[link](Folder/Real.md)');
    await writeFile(path.join(rootPath, 'Folder', 'Real.md'), '# real');
    await writeFile(path.join(rootPath, 'Trap.md'), '---\naliases: [Real]\n---\n# trap');
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-markdown-shortest-test' });
    try {
      await vault.initialize();
      const source = await vault.getFile('Source.md');
      await vault.renamePath(source.path, 'Moved/Source.md', source.etag);
      const movedSource = await vault.getFile('Moved/Source.md');
      expect(movedSource.content).toBe('[link](/Folder/Real.md)');
      const link = (await vault.getMetadata(movedSource.path))?.links?.[0];
      expect(link?.kind).toBe('markdown');
      expect(await vault.resolveLink(link!.link, movedSource.path, 'markdown')).toBe('Folder/Real.md');
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('returns exact tag predicate matches and attachment filename paths for graph filters', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'noltri-vault-match-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Science.md'), '---\ntags: [science/math, biology]\n---\nScience body');
    await writeFile(path.join(rootPath, 'Math.md'), '---\ntags: [math]\n---\nMath body');
    await writeFile(path.join(rootPath, 'science-image.png'), Buffer.from([1, 2, 3]));
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'vault-match-test' });
    try {
      await vault.initialize();
      const tag = await vault.matchPaths('tag:science');
      expect(tag.paths).toEqual(['Science.md']);
      expect(tag.matchingTags).toEqual(['#science/math']);
      expect(tag.attachmentPaths).toEqual([]);
      const mixed = await vault.matchPaths('tag:science OR file:science-image');
      expect(mixed.paths).toEqual(expect.arrayContaining(['Science.md', 'science-image.png']));
      expect(mixed.matchingTags).toEqual(['#science/math']);
      expect(mixed.attachmentPaths).toEqual(['science-image.png']);
      const negative = await vault.matchPaths('NOT tag:science');
      expect(negative.matchingTags).toEqual(['#biology', '#math']);
      expect(negative.paths).not.toContain('Science.md');
      expect((await vault.matchPaths('tag:biology OR tag:math')).matchingTags).toEqual(['#biology', '#math']);
      expect((await vault.matchPaths('tag:science tag:math')).matchingTags).toEqual([]);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });
});
