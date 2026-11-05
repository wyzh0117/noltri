import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createKnowledgeCore } from '../src/core';
import { VaultService } from '../src/notes/vault';
import { readLibraryItem } from '../src/services/library';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { captureOf, ScriptedProvider, testConfig } from './fakes';
import { silentLogger } from '@noltri/shared';

const directories: string[] = [];
afterAll(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
const markdownFileCount = (files: Awaited<ReturnType<VaultService['snapshot']>>['files']) =>
  files.filter((entry) => entry.kind === 'file' && (entry.extension === 'md' || entry.extension === 'markdown')).length;

describe('library Markdown projection', () => {
  it('migrates captures once, syncs new captures and projects note edits without changing capture evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-library-notes-'));
    directories.push(directory);
    const userId = 'vault-library-user';
    const config = testConfig({ devUser: userId });
    const repository = new SqliteRepository({ file: path.join(directory, 'profile.sqlite') });
    const vault = new VaultService({
      rootPath: path.join(directory, 'vault'),
      dataDir: path.join(directory, 'data'),
      repository,
      userId,
    });
    const provider = new ScriptedProvider([], { extract: () => ({ items: [] }) });
    const core = createKnowledgeCore({ repository, provider, config, logger: silentLogger, graphNoteStore: vault, vault });
    const actor = { userId, actor: 'test' } as const;
    try {
      const discipline = await repository.createNode({ userId, title: '数学', nodeType: 'discipline' });
      const branch = await repository.createNode({ userId, title: '概率论', nodeType: 'subdiscipline', parentId: discipline.id });
      const topicA = await repository.createNode({ userId, title: '概率基础', nodeType: 'topic', parentId: branch.id });
      const topicB = await repository.createNode({ userId, title: '统计基础', nodeType: 'topic', parentId: branch.id });
      const interruptedTopicPath = path.join(directory, 'vault', '_legacy', topicA.id, 'topic.md');
      await mkdir(path.dirname(interruptedTopicPath), { recursive: true });
      await writeFile(interruptedTopicPath, `---\nnoteType: topic\ntopicId: ${topicA.id}\nchapterId: null\n---\n# User-edited legacy note\n`);

      for (let index = 0; index < 1_000; index += 1) {
        await repository.createRawSource({
          userId,
          rawText: `旧采集资料 ${String(index)}：保留原始证据。`,
          sourceType: 'manual',
          sourceTitle: `旧资料 ${String(index)}`,
          capturedAt: '2026-10-24T00:00:00.000Z',
        });
      }

      const coldStartAt = performance.now();
      const firstSnapshot = await vault.snapshot();
      const migrationMs = performance.now() - coldStartAt;
      const firstGraph = await core.selectGraph({ kind: 'discipline', disciplineId: discipline.id }, actor);
      expect(firstSnapshot.files.filter((entry) => entry.frontmatter?.noteType === 'source')).toHaveLength(1_000);
      expect(firstSnapshot.files.filter((entry) => entry.frontmatter?.noteType === 'topic')).toHaveLength(2);
      expect(firstSnapshot.files.filter((entry) => entry.frontmatter?.noteType === 'topic' && entry.frontmatter.topicId === topicA.id)).toHaveLength(1);
      expect((await vault.getFile(`_legacy/${topicA.id}/topic.md`)).content).toContain('# User-edited legacy note');
      const migratedTopic = firstGraph.nodes.find((node) => node.id === topicA.id);
      expect(migratedTopic?.notePath).toBeTruthy();
      expect(migratedTopic?.notePaths).toContain(migratedTopic?.notePath);
      const warmStartAt = performance.now();
      const warmSnapshot = await vault.snapshot();
      const warmSnapshotMs = performance.now() - warmStartAt;
      expect(warmSnapshot.files).toBe(firstSnapshot.files);

      const markdownRoot = path.join(directory, 'preseeded-markdown-vault');
      const markdownData = path.join(directory, 'preseeded-markdown-data');
      await mkdir(markdownRoot, { recursive: true });
      for (let index = 0; index < 1_000; index += 1) {
        await writeFile(path.join(markdownRoot, `Note-${String(index).padStart(4, '0')}.md`), `# Note ${index}\n\nCold-start content ${index}.\n`);
      }
      const benchmarkRepository = new SqliteRepository({ file: path.join(directory, 'benchmark.sqlite') });
      let coldVault: VaultService | null = null;
      let cachedVault: VaultService | null = null;
      let benchmarkReport: Record<string, unknown> | null = null;
      try {
        coldVault = new VaultService({ rootPath: markdownRoot, dataDir: markdownData, repository: benchmarkRepository, userId: 'markdown-startup-benchmark' });
        const noCacheStartAt = performance.now();
        const noCacheSnapshot = await coldVault.snapshot();
        const noCacheStartMs = performance.now() - noCacheStartAt;
        const noCacheDiagnostics = await coldVault.diagnostics();
        const noCacheFileCount = markdownFileCount(noCacheSnapshot.files);
        expect(noCacheFileCount).toBe(1_000);
        expect(noCacheDiagnostics.cache.loaded).toBe(false);
        expect(noCacheDiagnostics.cache.entries).toBe(1_000);
        expect(noCacheStartMs).toBeLessThan(5_000);
        await coldVault.close();
        coldVault = null;

        cachedVault = new VaultService({ rootPath: markdownRoot, dataDir: markdownData, repository: benchmarkRepository, userId: 'markdown-startup-benchmark' });
        const cacheHitStartAt = performance.now();
        const cacheHitSnapshot = await cachedVault.snapshot();
        const cacheHitStartMs = performance.now() - cacheHitStartAt;
        const cacheHitDiagnostics = await cachedVault.diagnostics();
        const cacheHitFileCount = markdownFileCount(cacheHitSnapshot.files);
        expect(cacheHitFileCount).toBe(1_000);
        expect(cacheHitDiagnostics.cache.loaded).toBe(true);
        expect(cacheHitDiagnostics.cache.entries).toBe(1_000);
        expect(cacheHitStartMs).toBeLessThan(1_000);

        const sameInstanceStartAt = performance.now();
        const sameInstanceSnapshot = await cachedVault.snapshot();
        const sameInstanceWarmMs = performance.now() - sameInstanceStartAt;
        expect(sameInstanceSnapshot.files).toBe(cacheHitSnapshot.files);
        expect(markdownFileCount(sameInstanceSnapshot.files)).toBe(1_000);

        benchmarkReport = {
          A_sqliteToMarkdownMigration: {
            elapsedMs: Math.round(migrationMs),
            markdownFiles: markdownFileCount(firstSnapshot.files),
            sourceNotes: firstSnapshot.files.filter((entry) => entry.frontmatter?.noteType === 'source').length,
          },
          B_preseededMarkdownNoMetadataCache: {
            elapsedMs: Math.round(noCacheStartMs),
            markdownFiles: noCacheFileCount,
            cacheLoaded: noCacheDiagnostics.cache.loaded,
            cacheEntriesAfterParse: noCacheDiagnostics.cache.entries,
          },
          C_preseededMarkdownPersistedCacheNewInstance: {
            elapsedMs: Math.round(cacheHitStartMs),
            markdownFiles: cacheHitFileCount,
            cacheLoaded: cacheHitDiagnostics.cache.loaded,
            cacheEntries: cacheHitDiagnostics.cache.entries,
          },
          D_sameInstanceWarmSnapshot: {
            elapsedMs: Number(sameInstanceWarmMs.toFixed(2)),
            markdownFiles: markdownFileCount(sameInstanceSnapshot.files),
          },
        };
      } finally {
        if (coldVault !== null) await coldVault.close();
        if (cachedVault !== null) await cachedVault.close();
        await benchmarkRepository.close();
      }

      const captured = await core.capture(captureOf('新的采集原文内容足够长，可以通过采集校验。', 'desktop', { title: '新采集' }), actor);
      const sourcePath = `_library/Sources/${captured.rawSourceId}.md`;
      const sourceFile = await vault.getFile(sourcePath);
      expect(sourceFile.content).toContain('新的采集原文内容足够长，可以通过采集校验。');
      expect(sourceFile.metadata?.frontmatter).toMatchObject({
        sourceIds: [captured.rawSourceId],
        noteType: 'source',
      });
      await core.assignSource(captured.rawSourceId, { nodeId: topicA.id, text: '旧卡片正文。' }, actor);
      const item = (await repository.listKnowledgeItemsForSource(captured.rawSourceId, userId))[0]!;
      const itemPath = `_library/Items/${item.id}.md`;
      const originalEvidence = (await repository.findRawSource(captured.rawSourceId, userId))!.rawText;

      const otherCapture = await core.capture(captureOf('第二条采集原文内容足够长，可以通过采集校验。', 'desktop', { title: '第二条' }), actor);
      await core.assignSource(otherCapture.rawSourceId, { nodeId: topicB.id, text: '另一条卡片正文。' }, actor);
      const otherItem = (await repository.listKnowledgeItemsForSource(otherCapture.rawSourceId, userId))[0]!;
      const otherPath = `_library/Items/${otherItem.id}.md`;
      const currentItemFile = await vault.getFile(itemPath);
      const parsedFrontmatter = parseDocument(/^---\r?\n([\s\S]*?)\r?\n---/.exec(currentItemFile.content)?.[1] ?? '').toJSON() as Record<string, unknown>;
      const editedBody = `正文已在 Markdown 中更新。\n\n[[${path.posix.basename(otherPath, '.md')}]]`;
      const editedContent = `---\n${stringifyYaml({ ...parsedFrontmatter, tags: ['live-edit'] }).trimEnd()}\n---\n${editedBody}`;
      await vault.writeFile(itemPath, editedContent, currentItemFile.etag);

      expect((await repository.findKnowledgeItem(item.id, userId))?.normalizedText).toBe(editedBody);
      expect((await repository.findRawSource(captured.rawSourceId, userId))?.rawText).toBe(originalEvidence);
      expect((await vault.getMetadata(itemPath))?.frontmatter?.tags).toEqual(['live-edit']);
      expect((await vault.getBacklinks(otherPath)).backlinks).toContainEqual(expect.objectContaining({ sourcePath: itemPath, count: 1 }));
      const updatedGraph = await core.selectGraph({ kind: 'discipline', disciplineId: discipline.id }, actor);
      expect(updatedGraph.edges).toContainEqual(expect.objectContaining({
        fromNodeId: topicA.id,
        toNodeId: topicB.id,
        relationType: 'wikilink',
      }));
      expect((await readLibraryItem(core, actor, captured.rawSourceId)).content).toBe('新的采集原文内容足够长，可以通过采集校验。');

      await vault.syncSource(captured.rawSourceId, userId);
      expect((await vault.getFile(itemPath)).content).toContain(editedBody);
      const report = {
        generatedAt: new Date().toISOString(),
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        ...benchmarkReport,
      };
      console.info(`NOLTRI_VAULT_STARTUP_BENCH ${JSON.stringify(report)}`);
      const outputPath = process.env.NOLTRI_VAULT_BENCH_JSON;
      if (outputPath !== undefined && outputPath.length > 0) {
        await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
        await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
      }
    } finally {
      await vault.close();
      await repository.close();
    }
  }, 90_000);
});
