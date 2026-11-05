import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { silentLogger } from '@noltri/shared';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { createKnowledgeCore } from '../src/core';
import { VaultService } from '../src/notes/vault';
import { archiveLibraryItem, readLibraryItem } from '../src/services/library';
import { captureOf, ScriptedProvider, testConfig } from './fakes';

const directories: string[] = [];
afterAll(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function makeFixture(label: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `noltri-library-lifecycle-${label}-`));
  directories.push(directory);
  const userId = `library-lifecycle-${label}`;
  const repository = new SqliteRepository({ file: path.join(directory, 'profile.sqlite') });
  const vault = new VaultService({ rootPath: path.join(directory, 'vault'), dataDir: path.join(directory, 'data'), repository, userId });
  const provider = new ScriptedProvider([], { extract: () => ({ items: [] }) });
  const core = createKnowledgeCore({
    repository,
    provider,
    config: testConfig({ devUser: userId }),
    logger: silentLogger,
    graphNoteStore: vault,
    vault,
  });
  const actor = { userId, actor: 'test' } as const;
  const discipline = await repository.createNode({ userId, title: '验收学科', nodeType: 'discipline' });
  const subdiscipline = await repository.createNode({ userId, title: '验收方向', nodeType: 'subdiscipline', parentId: discipline.id });
  const topic = await repository.createNode({ userId, title: '迁移验收主题', nodeType: 'topic', parentId: subdiscipline.id });
  const captured = await core.capture(captureOf(`生命周期验收原文 ${label}，保留原始证据。`, 'desktop', { title: `生命周期来源 ${label}` }), actor);
  await core.assignSource(captured.rawSourceId, { nodeId: topic.id, text: `人工编辑条目正文 ${label}。` }, actor);
  const item = (await repository.listKnowledgeItemsForSource(captured.rawSourceId, userId))[0]!;
  return {
    directory,
    userId,
    repository,
    vault,
    core,
    actor,
    discipline,
    topic,
    rawSourceId: captured.rawSourceId,
    itemId: item.id,
    sourcePath: `_library/Sources/${captured.rawSourceId}.md`,
    itemPath: `_library/Items/${item.id}.md`,
    rawText: `生命周期验收原文 ${label}，保留原始证据。`,
    itemBody: `人工编辑条目正文 ${label}。`,
  };
}

describe('library Markdown lifecycle', () => {
  it('keeps moved source and item projections at their new paths through sync and archive', async () => {
    const fixture = await makeFixture('move');
    const { vault, repository, core, actor, rawSourceId, itemId, sourcePath, itemPath, userId, rawText, itemBody } = fixture;
    const movedSourcePath = `_library/Sources/reviewed-${rawSourceId}.md`;
    const movedItemPath = `_library/Items/reviewed-${itemId}.md`;
    try {
      const sourceFile = await vault.getFile(sourcePath);
      const itemFile = await vault.getFile(itemPath);
      await vault.renamePath(sourcePath, movedSourcePath, sourceFile.etag);
      await vault.renamePath(itemPath, movedItemPath, itemFile.etag);

      await vault.syncSource(rawSourceId, userId);
      expect((await readLibraryItem(core, actor, rawSourceId)).content).toBe(rawText);
      await archiveLibraryItem(core, actor, rawSourceId);

      const snapshot = await vault.snapshot();
      const sources = snapshot.files.filter((file) => file.kind === 'file' && file.frontmatter?.noteType === 'source' && (file.frontmatter.sourceIds as string[] | undefined)?.includes(rawSourceId));
      const items = snapshot.files.filter((file) => file.kind === 'file' && file.frontmatter?.noteType === 'item' && (file.frontmatter.itemIds as string[] | undefined)?.includes(itemId));
      expect(sources.map((file) => file.path)).toEqual([movedSourcePath]);
      expect(items.map((file) => file.path)).toEqual([movedItemPath]);
      expect((await vault.getFile(movedSourcePath)).content).toContain(rawText);
      expect((await vault.getFile(movedItemPath)).content).toContain(itemBody);
      await expect(vault.getFile(sourcePath)).rejects.toThrow();
      await expect(vault.getFile(itemPath)).rejects.toThrow();
      expect((await repository.findRawSource(rawSourceId, userId))?.rawText).toBe(rawText);
      expect((await repository.findKnowledgeItem(itemId, userId))?.normalizedText).toBe(itemBody);
    } finally {
      await vault.close();
      await repository.close();
    }
  });

  it('does not recreate deleted migrated source or item notes on sync, graph selection, archive, or restart', async () => {
    const fixture = await makeFixture('delete');
    const { directory, vault, repository, core, actor, discipline, rawSourceId, itemId, sourcePath, itemPath, userId, rawText } = fixture;
    let originalVaultClosed = false;
    try {
      const sourceFile = await vault.getFile(sourcePath);
      const itemFile = await vault.getFile(itemPath);
      await vault.deleteFile(itemPath, itemFile.etag, 'never');
      await vault.deleteFile(sourcePath, sourceFile.etag, 'never');

      await vault.snapshot();
      await core.selectGraph({ kind: 'discipline', disciplineId: discipline.id }, actor);
      await vault.syncSource(rawSourceId, userId);
      expect((await readLibraryItem(core, actor, rawSourceId)).content).toBe(rawText);
      await archiveLibraryItem(core, actor, rawSourceId);
      await expect(vault.getFile(itemPath)).rejects.toThrow();
      await expect(vault.getFile(sourcePath)).rejects.toThrow();

      await vault.close();
      originalVaultClosed = true;
      const restartedVault = new VaultService({ rootPath: path.join(directory, 'vault'), dataDir: path.join(directory, 'data'), repository, userId });
      const restartedCore = createKnowledgeCore({
        repository,
        provider: new ScriptedProvider([], { extract: () => ({ items: [] }) }),
        config: testConfig({ devUser: userId }),
        logger: silentLogger,
        graphNoteStore: restartedVault,
        vault: restartedVault,
      });
      try {
        const snapshot = await restartedVault.snapshot();
        await restartedCore.selectGraph({ kind: 'discipline', disciplineId: discipline.id }, actor);
        await restartedVault.syncSource(rawSourceId, userId);
        const reloaded = await restartedVault.snapshot();
        expect(reloaded.files.some((file) => file.path === sourcePath || file.path === itemPath)).toBe(false);
        await expect(restartedVault.getFile(sourcePath)).rejects.toThrow();
        await expect(restartedVault.getFile(itemPath)).rejects.toThrow();
        expect((await repository.findRawSource(rawSourceId, userId))?.rawText).toBe(rawText);
        expect((await repository.findKnowledgeItem(itemId, userId))?.rawSourceId).toBe(rawSourceId);
        expect(snapshot.files.some((file) => file.path === sourcePath || file.path === itemPath)).toBe(false);
      } finally {
        await restartedVault.close();
      }
    } finally {
      if (!originalVaultClosed) await vault.close();
      await repository.close();
    }
  });
});
