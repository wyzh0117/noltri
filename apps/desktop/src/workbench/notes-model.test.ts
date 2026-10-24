import { describe, expect, it, vi } from 'vitest';
import type { NoteFile } from '@noltri/schema';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import {
  parseWikiLink,
  classifyVaultDraftRecovery,
  remapVaultPath,
  movedMarkdownHistoryPaths,
  vaultPathContextMatches,
  vaultContextMatches,
  vaultPathContains,
  classifyNoteChange,
  createVaultDraftWriteQueue,
  decodeVaultDraftRecord,
  encodeVaultDraftRecord,
  rangeIntersectsToken,
  extractSubpath,
  fuzzyMatchRanges,
  normalizeTextRanges,
  historyDiffLines,
  markdownBlockRanges,
  markdownBlocks,
  groupMarkdownTokens,
  markdownReaderTarget,
  markdownSectionIndex,
  replaceMentionAt,
  safeNoteHref,
  saveLatestNoteWithEtag,
  drainNoteFlush,
  saveWithEtag,
  safeDecodeVaultFragment,
  setFrontmatterProperty,
  shouldRevealSource,
  vaultLinkPathCandidates,
  writeVaultDraftRecord,
} from './notes-model';

describe('Notes editor model', () => {
  it('bounds draft writes while preserving the latest transition draft and clearing accepted saves', () => {
    vi.useFakeTimers();
    try {
      const writes: Array<[string, string, string | null]> = [];
      const drafts = createVaultDraftWriteQueue((root, path, value) => writes.push([root, path, value]));
      drafts.schedule('/vault', 'note.md', 'first edit');
      vi.advanceTimersByTime(400);
      drafts.schedule('/vault', 'note.md', 'latest edit');
      expect(writes).toEqual([]);
      vi.advanceTimersByTime(350);
      expect(writes).toEqual([['/vault', 'note.md', 'latest edit']]);

      drafts.schedule('/vault', 'note.md', 'pending edit');
      drafts.flush('/vault', 'note.md', 'latest before transition');
      vi.advanceTimersByTime(1_000);
      expect(writes.at(-1)).toEqual(['/vault', 'note.md', 'latest before transition']);
      expect(writes).toHaveLength(2);

      drafts.schedule('/vault', 'note.md', 'already saved');
      drafts.clear('/vault', 'note.md');
      vi.advanceTimersByTime(1_000);
      expect(writes.at(-1)).toEqual(['/vault', 'note.md', null]);
      expect(writes).toHaveLength(3);

      drafts.schedule('/vault-a', 'same.md', 'vault A');
      drafts.schedule('/vault-b', 'same.md', 'vault B');
      expect(writes.at(-1)).toEqual(['/vault-a', 'same.md', 'vault A']);
      vi.advanceTimersByTime(750);
      expect(writes.slice(-2)).toEqual([
        ['/vault-a', 'same.md', 'vault A'],
        ['/vault-b', 'same.md', 'vault B'],
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('only auto-resumes a recovered draft against its original etag', () => {
    const current = { content: 'external', etag: 'etag-2' };
    expect(classifyVaultDraftRecovery('local edit', { baseEtag: 'etag-2', conflict: false }, current)).toBe('restore');
    expect(classifyVaultDraftRecovery('local edit', { baseEtag: 'etag-1', conflict: false }, current)).toBe('conflict');
    expect(classifyVaultDraftRecovery('local edit', { baseEtag: 'etag-2', conflict: true }, current)).toBe('conflict');
    expect(classifyVaultDraftRecovery('local edit', null, current)).toBe('conflict');
    expect(classifyVaultDraftRecovery('external', { baseEtag: 'etag-1', conflict: true }, current)).toBe('discard');
  });

  it('rejects late results from a previous epoch even when the same Vault path is reopened', () => {
    const request = { rootPath: '/vault/知识 库', epoch: 4 };
    expect(vaultContextMatches(request, '/vault/知识 库', 4)).toBe(true);
    expect(vaultContextMatches(request, '/vault/other', 4)).toBe(false);
    expect(vaultContextMatches(request, '/vault/知识 库', 5)).toBe(false);
  });

  it('stores content and recovery etag in one versioned record and treats old text as untrusted', () => {
    const metadata = { baseEtag: 'etag-1', conflict: true };
    const content = '# Draft\n\nPlain markdown stays intact. \\[[Target]]';
    expect(decodeVaultDraftRecord(encodeVaultDraftRecord(content, metadata))).toEqual({ content, metadata });
    expect(decodeVaultDraftRecord('legacy plain-text draft')).toEqual({ content: 'legacy plain-text draft', metadata: null });
    expect(decodeVaultDraftRecord('\u0000noltri-vault-draft-v1\nnot-json')).toEqual({ content: '\u0000noltri-vault-draft-v1\nnot-json', metadata: null });
  });

  it('keeps the draft base etag and conflict marker through delayed writes', () => {
    vi.useFakeTimers();
    try {
      const writes: Array<{ root: string; path: string; content: string | null; baseEtag?: string | null; conflict?: boolean }> = [];
      const drafts = createVaultDraftWriteQueue((root, path, content, metadata) => writes.push({ root, path, content, ...(metadata ?? {}) }));
      drafts.schedule('/vault', 'note.md', 'first', { baseEtag: 'old-etag', conflict: false });
      drafts.schedule('/vault', 'note.md', 'latest', { baseEtag: 'current-etag', conflict: false });
      vi.advanceTimersByTime(750);
      expect(writes).toEqual([{ root: '/vault', path: 'note.md', content: 'latest', baseEtag: 'current-etag', conflict: false }]);
      drafts.flush('/vault', 'note.md', 'conflicted edit', { baseEtag: 'old-etag', conflict: true });
      expect(writes.at(-1)).toEqual({ root: '/vault', path: 'note.md', content: 'conflicted edit', baseEtag: 'old-etag', conflict: true });
    } finally { vi.useRealTimers(); }
  });

  it('reports storage failures without replacing the last complete draft', () => {
    const key = 'draft-key';
    const original = encodeVaultDraftRecord('last complete draft', { baseEtag: 'e1', conflict: true });
    let persisted: string | null = original;
    let failWrites = true;
    const storage: Pick<Storage, 'setItem' | 'removeItem'> = {
      setItem: (_target, value) => { if (failWrites) throw new Error('quota exceeded'); persisted = value; },
      removeItem: () => { if (failWrites) throw new Error('storage denied'); persisted = null; },
    };
    expect(writeVaultDraftRecord(storage, key, 'new draft', { baseEtag: 'e2', conflict: false })).toBe(false);
    expect(persisted).toBe(original);

    const failures: Array<{ root: string; path: string; metadata?: { baseEtag: string | null; conflict: boolean } }> = [];
    const queue = createVaultDraftWriteQueue(
      (root, path, content, metadata) => writeVaultDraftRecord(storage, `${root}:${path}`, content, metadata),
      750,
      (root, path, metadata) => failures.push({ root, path, metadata }),
    );
    expect(queue.clear('/vault', 'note.md')).toBe(false);
    queue.flush('/vault', 'note.md', 'conflicted local draft', { baseEtag: 'e1', conflict: true });
    expect(failures).toEqual([
      { root: '/vault', path: 'note.md', metadata: undefined },
      { root: '/vault', path: 'note.md', metadata: { baseEtag: 'e1', conflict: true } },
    ]);
  });

  it('sorts, clamps, and merges exact search highlight ranges', () => {
    expect(normalizeTextRanges([{ start: 8, end: 12 }, { start: -2, end: 2 }, { start: 1, end: 5 }, { start: 15, end: 30 }], 18))
      .toEqual([{ start: 0, end: 5 }, { start: 8, end: 12 }, { start: 15, end: 18 }]);
  });

  it('matches and remaps only a file path or its slash-delimited descendants', () => {
    expect(vaultPathContains('Projects/A.md', 'Projects')).toBe(true);
    expect(vaultPathContains('Projects', 'Projects')).toBe(true);
    expect(vaultPathContains('Projects-Old/A.md', 'Projects')).toBe(false);
    expect(remapVaultPath('Projects/A.md', 'Projects', 'Archive/Projects')).toBe('Archive/Projects/A.md');
    expect(remapVaultPath('Projects-Old/A.md', 'Projects', 'Archive/Projects')).toBe('Projects-Old/A.md');
  });

  it('keeps moved Markdown history under its original path for recovery', () => {
    const entries = [
      { path: 'Folder/A.md', name: 'A.md', kind: 'file' as const, extension: 'md' },
      { path: 'Folder/sub/B.MD', name: 'B.MD', kind: 'file' as const, extension: 'MD' },
      { path: 'Folder/image.png', name: 'image.png', kind: 'file' as const, extension: 'png' },
      { path: 'Folder/sub', name: 'sub', kind: 'folder' as const },
      { path: 'Folder-old/C.md', name: 'C.md', kind: 'file' as const, extension: 'md' },
    ];
    expect(movedMarkdownHistoryPaths(entries, 'Folder')).toEqual(['Folder/A.md', 'Folder/sub/B.MD']);
    expect(movedMarkdownHistoryPaths(entries, 'Folder/A.md')).toEqual(['Folder/A.md']);
  });

  it('does not reuse a stale same-path mention after switching vault roots', () => {
    expect(vaultPathContextMatches('/vault-a', '/vault-a', 'Inbox/Target.md', 'Inbox/Target.md', 'Inbox/Target.md')).toBe(true);
    expect(vaultPathContextMatches('/vault-a', '/vault-b', 'Inbox/Target.md', 'Inbox/Target.md', 'Inbox/Target.md')).toBe(false);
  });

  it('reveals syntax when the caret, selection, or search match intersects a token', () => {
    const token = { start: 10, end: 18 };
    expect(rangeIntersectsToken(token, { start: 14, end: 14 })).toBe(true);
    expect(shouldRevealSource(token, [{ start: 17, end: 22 }], [])).toBe(true);
    expect(shouldRevealSource(token, [], [{ start: 2, end: 12 }])).toBe(true);
    expect(shouldRevealSource(token, [{ start: 2, end: 9 }], [])).toBe(false);
  });

  it('maps fuzzy switcher hits back to UTF-16 ranges for highlighting', () => {
    expect(fuzzyMatchRanges('nt', 'Noltri Note')).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
    expect(fuzzyMatchRanges('知序', '知序笔记')).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
    expect(fuzzyMatchRanges('z', 'Noltri')).toEqual([]);
  });

  it('shows a bounded contextual history diff for insertions and replacements', () => {
    expect(historyDiffLines('before\nnew line\nafter', 'before\nold line\nafter')).toEqual([
      { kind: 'context', text: 'before' },
      { kind: 'removed', text: 'old line' },
      { kind: 'added', text: 'new line' },
      { kind: 'context', text: 'after' },
    ]);
    expect(historyDiffLines('x\n'.repeat(10_001), 'y')).toHaveLength(1);
  });

  it('keeps fenced code and table sections intact while mapping subpaths to lazy reader sections', () => {
    const blocks = markdownBlocks(['# Top', '', '```ts', 'const a = 1;', '', 'const b = 2;', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '| 3 | 4 |', '', '## Deep', '', 'Body. ^deep-block'].join('\n'));
    expect(blocks.some((block) => block.includes('const a = 1;') && block.includes('const b = 2;'))).toBe(true);
    expect(blocks.some((block) => block.includes('| 1 | 2 |') && block.includes('| 3 | 4 |'))).toBe(true);
    expect(markdownSectionIndex(blocks, 'Deep')).toBe(blocks.findIndex((block) => block.startsWith('## Deep')));
    expect(markdownSectionIndex(blocks, '^deep-block')).toBe(blocks.findIndex((block) => block.includes('^deep-block')));
  });

  it('maps Core source offsets to the exact lazy reader section and heading line', () => {
    const content = [
      '---', 'title: Repeated', '---',
      '# A', '', '## B', '',
      '```md', '## B', '```', '',
      '# A', '', '## B', '',
      '### Same', '### Same',
    ].join('\n');
    const repeatedHeading = content.lastIndexOf('### Same');
    const target = markdownReaderTarget(content, repeatedHeading);
    expect(target).not.toBeNull();
    expect(target?.sourceLine).toBe(1);
    const blocks = markdownBlockRanges(content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, ''));
    expect(blocks[target!.sectionIndex]?.source).toContain('### Same');
    expect(blocks[target!.sectionIndex]?.source).toContain('### Same\n### Same');
    expect(markdownSectionIndex(markdownBlocks(content), 'A#B')).toBe(markdownBlocks(content).findIndex((block) => block === '## B'));
    expect(markdownReaderTarget(content, content.indexOf('## B', content.lastIndexOf('# A')))?.sectionIndex)
      .toBe(blocks.map((block) => block.source).lastIndexOf('## B'));
  });

  it('resolves nested heading paths, duplicate heading sections, and block ids case insensitively', () => {
    const blocks = markdownBlocks(['# A', '', '## B', '', '```md', '## B', '```', '', '# A', '', '## B', '', 'Body. ^Foo'].join('\n'));
    expect(markdownSectionIndex(blocks, 'A#B')).toBe(1);
    expect(markdownSectionIndex(blocks, '^foo')).toBe(blocks.findIndex((block) => block.includes('^Foo')));
    expect(markdownSectionIndex(blocks, 'missing')).toBe(-1);
  });

  it('keeps parsed container blocks together and separates the shared footnote tail', () => {
    const tokens = [
      { type: 'heading_open', level: 0, nesting: 1, map: [0, 1] },
      { type: 'inline', level: 1, nesting: 0 },
      { type: 'heading_close', level: 0, nesting: -1 },
      { type: 'bullet_list_open', level: 0, nesting: 1, map: [2, 5] },
      { type: 'list_item_open', level: 1, nesting: 1, map: [2, 3] },
      { type: 'paragraph_open', level: 2, nesting: 1, map: [2, 3] },
      { type: 'inline', level: 3, nesting: 0 },
      { type: 'paragraph_close', level: 2, nesting: -1 },
      { type: 'list_item_close', level: 1, nesting: -1 },
      { type: 'bullet_list_close', level: 0, nesting: -1 },
      { type: 'footnote_block_open', level: 0, nesting: 1 },
      { type: 'footnote_open', level: 1, nesting: 1 },
      { type: 'inline', level: 2, nesting: 0 },
      { type: 'footnote_close', level: 1, nesting: -1 },
      { type: 'footnote_block_close', level: 0, nesting: -1 },
    ];
    const groups = groupMarkdownTokens(tokens);
    expect(groups.map((group) => [group.startLine, group.endLine, group.footnotes])).toEqual([
      [0, 1, false], [2, 5, false], [null, null, true],
    ]);
    expect(groups[1]?.tokens).toHaveLength(7);
    expect(groups[2]?.tokens.at(-1)?.type).toBe('footnote_block_close');
  });

  it('shares references and CJK definitions across lazy sections with isolated backrefs', () => {
    const source = '第一段[^注释]\n\n普通段落。\n\n第二段[^注释]\n\n[^注释]: 这是中文脚注。';
    const md = new MarkdownIt().use(footnote);
    const env = { docId: 'reader-test' };
    const sections = groupMarkdownTokens(md.parse(source, env));
    expect(sections.map((section) => section.footnotes)).toEqual([false, false, false, true]);
    const rendered = sections.map((section) => md.renderer.render(section.tokens, md.options, env));
    expect(rendered[0]).toContain('href="#fn-reader-test-1"');
    expect(rendered[2]).toContain('id="fnref-reader-test-1:1"');
    expect(rendered[3]).toContain('这是中文脚注');
    expect(rendered[3]).toContain('href="#fnref-reader-test-1"');
    expect(rendered[3]).toContain('href="#fnref-reader-test-1:1"');
  });

  it('decodes a Reader block fragment once and rejects malformed percent encoding', () => {
    expect(safeDecodeVaultFragment('^Block%20ID')).toBe('^Block ID');
    expect(safeDecodeVaultFragment('%E4%B8%AD%E6%96%87')).toBe('中文');
    expect(safeDecodeVaultFragment('A%23B')).toBe('A#B');
    expect(safeDecodeVaultFragment('bad%XX')).toBeNull();
  });

  it('parses wikilink aliases and embeds without losing subpaths', () => {
    expect(parseWikiLink('[[Folder/Note#Heading|显示名]]')).toEqual({
      embed: false,
      target: 'Folder/Note#Heading',
      alias: '显示名',
    });
    expect(parseWikiLink('![[image.png|图像]]')).toEqual({ embed: true, target: 'image.png', alias: '图像' });
    expect(parseWikiLink('not a wikilink')).toBeNull();
  });

  it('builds shortest, relative, and vault-absolute link candidates', () => {
    expect(vaultLinkPathCandidates('Projects/Target.md', 'Projects/Source.md')).toEqual({
      shortest: ['Target', './Target', '/Projects/Target'],
      relative: './Target',
      absolute: '/Projects/Target',
    });
    expect(vaultLinkPathCandidates('Areas/Target.md', 'Projects/Source.md').relative).toBe('../Areas/Target');
  });

  it('extracts heading and block subpaths, returning null for a missing target', () => {
    const note = '---\ntitle: Example\n---\n# Start\n\nIntro.\n\n## Details\n\nBody paragraph. ^body\n\n## Next\n\nOther';
    expect(extractSubpath(note, 'Details')).toContain('## Details');
    expect(extractSubpath(note, 'Details')).not.toContain('## Next');
    expect(extractSubpath(note, '^body')).toBe('Body paragraph.');
    expect(extractSubpath(note, 'missing')).toBeNull();
  });

  it('blocks unsafe protocols while permitting normal local and web links', () => {
    expect(safeNoteHref(' javascript:alert(1) ')).toBeNull();
    expect(safeNoteHref('data:text/html,boom')).toBeNull();
    expect(safeNoteHref('https://example.test')).toBe('https://example.test');
    expect(safeNoteHref('../notes/target.md')).toBe('../notes/target.md');
  });

  it('preserves surrounding YAML comments and existing property order', () => {
    const content = '---\n# keep this note\ntitle: Note\ntags:\n  - old\n---\nBody\n';
    const next = setFrontmatterProperty(content, 'title', 'Renamed');
    expect(next).toContain('# keep this note');
    expect(next.indexOf('title: Renamed')).toBeLessThan(next.indexOf('tags:'));
    expect(next).toContain('Body\n');
    expect(setFrontmatterProperty(next, 'draft', true)).toContain('draft: true');
  });

  it('preserves CRLF in frontmatter property updates with CJK values', () => {
    const content = ['---', '# 保留注释', 'title: 旧标题', '---', '# 正文', '中文内容'].join('\r\n');
    const next = setFrontmatterProperty(content, 'title', '新标题');
    expect(next).toContain('title: 新标题');
    expect(next.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(next).toContain('# 正文\r\n中文内容');
  });

  it('converts an exact fresh mention span and rejects a stale span', () => {
    const content = 'Read Noltri today.';
    expect(replaceMentionAt(content, 5, 11, 'Noltri', 'Products/Noltri.md')).toBe('Read [[Products/Noltri.md]] today.');
    expect(replaceMentionAt(content, 5, 11, 'Other', 'Products/Noltri.md')).toBeNull();
  });

  it('returns a conflict on HTTP 409 without retrying a write over the current file', async () => {
    const save = vi.fn(async (): Promise<NoteFile> => { throw Object.assign(new Error('stale etag'), { status: 409 }); });
    const result = await saveWithEtag(save, { path: 'note.md', content: 'draft', expectedEtag: 'old' });
    expect(result).toEqual({ kind: 'conflict' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reads the latest same-file etag when queued edits reach the serialized writer', async () => {
    let current: NoteFile = { path: 'note.md', content: 'base', etag: 'e0', mtime: 0, size: 4 };
    let latestContent = '';
    let releaseFirst = (): void => undefined;
    let firstStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const save = vi.fn(async (request: { path: string; content: string; expectedEtag?: string }): Promise<NoteFile> => {
      if (request.content === 'first') {
        firstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      current = { ...current, content: request.content, etag: request.content === 'first' ? 'e1' : 'e2', size: request.content.length };
      return current;
    });
    let chain = Promise.resolve();
    const enqueue = (content: string): Promise<unknown> => {
      latestContent = content;
      const operation = chain.then(() => saveLatestNoteWithEtag(save, 'note.md', () => current, () => latestContent));
      chain = operation.then(() => undefined);
      return operation;
    };

    const first = enqueue('first');
    await started;
    const second = enqueue('second');
    releaseFirst();
    await Promise.all([first, second]);
    expect(save.mock.calls.map(([request]) => [request.content, request.expectedEtag])).toEqual([
      ['first', 'e0'],
      ['second', 'e1'],
    ]);
  });

  it('defers self-write events and still distinguishes external changes from dirty drafts', () => {
    const oldFile: NoteFile = { path: 'note.md', content: 'saved', etag: 'e0', mtime: 0, size: 5 };
    const ownWrite: NoteFile = { ...oldFile, content: 'draft', etag: 'e1', size: 5 };
    expect(classifyNoteChange(1, oldFile, ownWrite, 'draft')).toBe('defer');
    expect(classifyNoteChange(0, ownWrite, ownWrite, 'draft')).toBe('ignore');
    const external: NoteFile = { ...oldFile, content: 'external', etag: 'e2', size: 8 };
    expect(classifyNoteChange(0, oldFile, external, 'unsaved draft')).toBe('conflict');
    expect(classifyNoteChange(0, oldFile, external, 'saved')).toBe('reload');
    expect(classifyNoteChange(0, { ...oldFile, path: 'other.md' }, external, 'saved')).toBe('ignore');
  });

  it('does not apply a queued save after the active note identity changes', async () => {
    const save = vi.fn(async (): Promise<NoteFile> => { throw new Error('should not be called'); });
    const outcome = await saveLatestNoteWithEtag(save, 'first.md', () => ({ path: 'second.md', content: 'other', etag: 'e2', mtime: 0, size: 5 }), () => 'draft');
    expect(outcome).toEqual({ kind: 'missing' });
    expect(save).not.toHaveBeenCalled();
  });

  it('drains a second edit made while the first save request is in flight', async () => {
    let content = 'first edit';
    let saved = 'base';
    let pending = 0;
    let releaseFirst = (): void => undefined;
    let firstStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const calls: string[] = [];
    const flush = drainNoteFlush(
      () => ({ valid: true, content, saved, pending }),
      async () => undefined,
      async () => {
        const requestContent = content;
        calls.push(requestContent);
        pending += 1;
        if (calls.length === 1) {
          firstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        saved = requestContent;
        pending -= 1;
        return true;
      },
    );

    await started;
    content = 'second edit';
    releaseFirst();
    await expect(flush).resolves.toBe(true);
    expect(calls).toEqual(['first edit', 'second edit']);
    expect(saved).toBe('second edit');
  });

  it('stops draining when a save reports an etag conflict', async () => {
    const saveOnce = vi.fn(async () => false);
    await expect(drainNoteFlush(
      () => ({ valid: true, content: 'draft', saved: 'disk', pending: 0 }),
      async () => undefined,
      saveOnce,
    )).resolves.toBe(false);
    expect(saveOnce).toHaveBeenCalledTimes(1);
  });
});
