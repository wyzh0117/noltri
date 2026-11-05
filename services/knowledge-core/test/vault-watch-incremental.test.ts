import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@noltri/shared';
import { createInMemoryRepository } from '@noltri/storage';
import { createKnowledgeCore } from '../src/core';
import { VaultService } from '../src/notes/vault';
import { createLibraryItem } from '../src/services/library';
import { ScriptedProvider, testConfig } from './fakes';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('incremental Vault watcher refresh', () => {
  it('indexes changed, created, and deleted files by watch path and falls back for directory changes', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'noltri-watch-incremental-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Target.md'), '# Target\n');
    await writeFile(path.join(rootPath, 'Source.md'), '# Source\n');

    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'watch-incremental-test' });
    const internals = vault as unknown as {
      refresh: (force: boolean, events?: Array<{ relativeDirectory: string; eventType: string; fileName: string | Buffer | null }>) => Promise<void>;
      scanDirectory: (...args: unknown[]) => Promise<void>;
      attachWatchers: () => void;
    };
    const originalScanDirectory = internals.scanDirectory.bind(vault);
    let scans = 0;
    try {
      internals.attachWatchers = () => {};
      await vault.initialize();
      internals.scanDirectory = async (...args: unknown[]) => {
        scans += 1;
        await originalScanDirectory(...args);
      };

      await writeFile(path.join(rootPath, 'Source.md'), '# Source\n\n[[Target]]\n');
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'change', fileName: 'Source.md' }]);
      expect(scans).toBe(0);
      expect((await vault.getBacklinks('Target.md')).backlinks).toContainEqual(expect.objectContaining({ sourcePath: 'Source.md', count: 1 }));

      await writeFile(path.join(rootPath, 'Created.md'), '# Created\n\n[[Target]]\n');
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Created.md' }]);
      expect(scans).toBe(0);
      expect((await vault.snapshot()).files.map(({ path: filePath }) => filePath)).toContain('Created.md');
      expect((await vault.getBacklinks('Target.md')).backlinks).toContainEqual(expect.objectContaining({ sourcePath: 'Created.md', count: 1 }));

      await unlink(path.join(rootPath, 'Created.md'));
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Created.md' }]);
      expect(scans).toBe(0);
      expect((await vault.snapshot()).files.map(({ path: filePath }) => filePath)).not.toContain('Created.md');
      expect((await vault.getBacklinks('Target.md')).backlinks).not.toContainEqual(expect.objectContaining({ sourcePath: 'Created.md' }));

      await writeFile(path.join(rootPath, 'Renamed From.md'), '# Renamed\n\n[[Target]]\n');
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Renamed From.md' }]);
      await rename(path.join(rootPath, 'Renamed From.md'), path.join(rootPath, 'Renamed To.md'));
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Renamed From.md' }]);
      expect(scans).toBe(0);
      expect((await vault.snapshot()).files.map(({ path: filePath }) => filePath)).toContain('Renamed To.md');
      expect((await vault.getBacklinks('Target.md')).backlinks).toContainEqual(expect.objectContaining({ sourcePath: 'Renamed To.md', count: 1 }));

      await writeFile(path.join(rootPath, 'Case From.md'), '# Case rename\n');
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Case From.md' }]);
      const scansBeforeCaseRename = scans;
      await rename(path.join(rootPath, 'Case From.md'), path.join(rootPath, 'case from.md'));
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'Case From.md' }]);
      expect(scans).toBeGreaterThan(scansBeforeCaseRename);
      expect((await vault.snapshot()).files.map(({ path: filePath }) => filePath)).toContain('case from.md');

      await mkdir(path.join(rootPath, 'New Folder'));
      await internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: 'New Folder' }]);
      expect(scans).toBeGreaterThan(0);
      expect((await vault.snapshot()).files).toContainEqual(expect.objectContaining({ path: 'New Folder', kind: 'folder' }));
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('falls back to collision validation when an external name folds onto an indexed path', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'noltri-watch-collision-'));
    roots.push(base);
    const rootPath = path.join(base, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'A B.md'), '# ASCII space\n');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId: 'watch-collision-test' });
    const internals = vault as unknown as {
      refresh: (force: boolean, events?: Array<{ relativeDirectory: string; eventType: string; fileName: string | Buffer | null }>) => Promise<void>;
      scanDirectory: (...args: unknown[]) => Promise<void>;
      attachWatchers: () => void;
    };
    const originalScanDirectory = internals.scanDirectory.bind(vault);
    let scans = 0;
    try {
      internals.attachWatchers = () => {};
      await vault.initialize();
      internals.scanDirectory = async (...args: unknown[]) => {
        scans += 1;
        await originalScanDirectory(...args);
      };
      const nbspPath = `A\u00a0B.md`;
      await writeFile(path.join(rootPath, nbspPath), '# NBSP space\n');
      await expect(internals.refresh(true, [{ relativeDirectory: '', eventType: 'rename', fileName: nbspPath }])).rejects.toThrow(/路径冲突/);
      expect(scans).toBeGreaterThan(0);
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });

  it('uses one incremental refresh for captures after the default library folders exist', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'noltri-capture-incremental-'));
    roots.push(base);
    const userId = 'capture-incremental-test';
    const rootPath = path.join(base, 'vault');
    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(base, 'data'), repository, userId });
    const internals = vault as unknown as {
      refresh: (...args: unknown[]) => Promise<void>;
      scanDirectory: (...args: unknown[]) => Promise<void>;
      attachWatchers: () => void;
    };
    const originalRefresh = internals.refresh.bind(vault);
    const originalScanDirectory = internals.scanDirectory.bind(vault);
    let refreshes = 0;
    let scans = 0;
    internals.attachWatchers = () => {};
    const core = createKnowledgeCore({
      repository,
      provider: new ScriptedProvider([], { extract: () => ({ items: [] }) }),
      config: testConfig({ devUser: userId, embeddingEnabled: false }),
      logger: silentLogger,
      graphNoteStore: vault,
      vault,
    });
    const actor = { userId, actor: 'test' } as const;
    try {
      await vault.initialize();
      internals.refresh = async (...args: unknown[]) => {
        refreshes += 1;
        await originalRefresh(...args);
      };
      internals.scanDirectory = async (...args: unknown[]) => {
        scans += 1;
        await originalScanDirectory(...args);
      };
      await createLibraryItem(core, actor, {
        content: '首条采集原文足够完整，用于创建默认来源笔记目录。',
        kind: 'knowledge',
        source: { type: 'manual', title: '首次采集' },
      });
      expect(scans).toBeGreaterThan(0); // Creating _library/Sources requires one structural full scan.

      refreshes = 0;
      scans = 0;
      const { item } = await createLibraryItem(core, actor, {
        content: '第二条采集原文足够完整，用于验证热路径只刷新对应 Markdown。',
        kind: 'knowledge',
        source: { type: 'manual', title: '增量采集' },
      });
      expect(refreshes).toBe(1);
      expect(scans).toBe(0);
      expect((await vault.snapshot()).files).toContainEqual(expect.objectContaining({
        path: `_library/Sources/${item.id}.md`,
        frontmatter: expect.objectContaining({ sourceIds: [item.id] }),
      }));
    } finally {
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });
});
