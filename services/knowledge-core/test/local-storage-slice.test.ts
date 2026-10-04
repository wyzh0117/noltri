/**
 * The P1 vertical slice: one real capture, written to a real file, then read back after the process
 * handle closed. Nothing here mocks the storage layer — it goes through `createRepository`, the same
 * factory a desktop shell will call, with no Supabase URL, no hosting runtime and no network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createOfflineProvider } from '@noltri/ai-provider';
import type { TreeNode } from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createRepository, type KnowledgeRepository } from '@noltri/storage';
import { loadCoreConfig } from '../src/config';
import { createKnowledgeCore, type KnowledgeCore } from '../src/core';
import { captureOf, CHINESE_TEXT } from './fakes';

const directories: string[] = [];
const actor = { userId: 'slice-user', actor: 'slice-test' };

/** A committed fixture rather than a script generated at runtime, so it is type-checked too. */
const crashWriter = fileURLToPath(new URL('./crash-writer.ts', import.meta.url));

interface LocalCore {
  readonly repository: KnowledgeRepository;
  readonly core: KnowledgeCore;
  close(): Promise<void>;
}

/** The env object is the whole configuration surface a local build gets: no cloud credential exists. */
function localProfile(): { file: string; env: Record<string, string> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-slice-'));
  directories.push(dir);
  const file = path.join(dir, 'noltri.sqlite');
  return {
    file,
    env: {
      STORAGE_DRIVER: 'sqlite',
      NOLTRI_SQLITE_FILE: file,
      AI_PROVIDER: 'offline',
      NOLTRI_DEV_USER_ID: actor.userId,
    },
  };
}

async function openCore(env: Record<string, string>): Promise<LocalCore> {
  const config = loadCoreConfig(env);
  const repository = await createRepository(config.storage);
  const core = createKnowledgeCore({
    repository,
    provider: createOfflineProvider({ embeddingDim: config.embeddingDim }),
    config,
    logger: silentLogger,
  });
  return {
    repository,
    core,
    close: async () => {
      const closable = repository as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
    },
  };
}

function flatten(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function isoNow(): string {
  return new Date().toISOString();
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describe('capture to a local SQLite profile and back', () => {
  it('writes one capture to disk and reads it through a freshly opened handle', async () => {
    const { file, env } = localProfile();
    const first = await openCore(env);
    expect(first.repository.driver).toBe('sqlite');

    const before = first.core.health();
    expect(before.status).toBe('ok');
    expect(before.storageDriver).toBe('sqlite');
    expect(before.storage.ok).toBe(true);
    expect(before.storage.detail['fileName']).toBe('noltri.sqlite');
    expect(before.storage.detail['fts5']).toBe(true);

    const result = await first.core.capture(captureOf(CHINESE_TEXT, 'desktop'), actor);
    expect(result.processingStatus).toBe('done');
    expect(result.items.length).toBeGreaterThan(0);

    const after = first.core.health();
    expect(after.storage.detail['rawSources']).toBe(1);
    expect(after.storage.detail['knowledgeItems']).toBe(result.items.length);
    expect(Number(after.storage.detail['vectors'])).toBeGreaterThanOrEqual(result.items.length);

    await first.close();
    expect(statSync(file).size).toBeGreaterThan(0);
    // A clean close checkpoints WAL into the main file: nothing may be left beside it.
    expect(existsSync(`${file}-wal`)).toBe(false);

    const second = await openCore(env);
    try {
      const source = await second.repository.findRawSource(result.rawSourceId, actor.userId);
      expect(source?.rawText).toBe(CHINESE_TEXT.trim());
      expect(source?.processingStatus).toBe('done');
      expect(source?.sourceType).toBe('desktop_app');

      const tree = await second.core.getTree({}, actor);
      const nodeIds = flatten(tree.nodes).map((node) => node.id);
      for (const item of result.items) {
        if (item.nodeId !== null) expect(nodeIds).toContain(item.nodeId);
      }

      const search = await second.core.search({ query: '元组 字典', mode: 'keyword', limit: 10 }, actor);
      expect(search.hits.length).toBeGreaterThan(0);

      const target = result.items[0];
      expect(target?.nodeId).not.toBeNull();
      const detail = await second.core.getNodeDetail(String(target?.nodeId), actor);
      expect(detail.items.map((entry) => entry.item.normalizedText)).toContain(String(target?.text));
      expect(detail.items[0]?.sources[0]?.rawSourceId).toBe(result.rawSourceId);
    } finally {
      await second.close();
    }
  });

  /** The rule the whole design rests on: the raw text is safe before the model is ever asked. */
  it('keeps a raw source that never reached the model readable after a reopen', async () => {
    const { file, env } = localProfile();
    const opened = await openCore(env);
    let id = '';
    try {
      const source = await opened.repository.createRawSource({
        userId: actor.userId,
        rawText: '一段只落盘、尚未加工的原文。',
        sourceType: 'manual',
        capturedAt: isoNow(),
        metadata: { client: 'desktop' },
      });
      id = source.id;
      expect(existsSync(file)).toBe(true);
    } finally {
      await opened.close();
    }

    const reopened = await openCore(env);
    try {
      const source = await reopened.repository.findRawSource(id, actor.userId);
      expect(source?.rawText).toBe('一段只落盘、尚未加工的原文。');
      expect(source?.processingStatus).toBe('pending');
      expect(await reopened.repository.listKnowledgeItemsForSource(id, actor.userId)).toEqual([]);
      expect(reopened.core.health().storage.detail['rawSources']).toBe(1);
      expect(reopened.core.health().storage.detail['knowledgeItems']).toBe(0);
    } finally {
      await reopened.close();
    }
  });

  it('resolves the profile path from the environment, not from wherever the process happens to start', async () => {
    expect(loadCoreConfig({ STORAGE_DRIVER: 'sqlite' }).sqliteFile).toBe(
      path.join(homedir(), '.noltri', 'data', 'noltri.sqlite'),
    );
    expect(loadCoreConfig({ NOLTRI_DATA_DIR: '/tmp/noltri-profile' }).sqliteFile).toBe(
      path.join('/tmp/noltri-profile', 'noltri.sqlite'),
    );
    expect(loadCoreConfig({ NOLTRI_SQLITE_FILE: '/tmp/noltri-profile/other.sqlite' }).sqliteFile).toBe(
      '/tmp/noltri-profile/other.sqlite',
    );
    // A relative path is resolved once here; it is never handed to SQLite as a working-directory guess.
    expect(loadCoreConfig({ NOLTRI_SQLITE_FILE: 'relative.sqlite' }).sqliteFile).toBe(
      path.resolve('relative.sqlite'),
    );
    await expect(createRepository({ driver: 'sqlite' })).rejects.toThrow(/sqliteFile/);
  });

  /**
   * The promise a local library lives or dies by: a write that returned success has to still be there
   * after the process is killed without cleanup. SIGKILL is deliberate — no `close()` runs and no WAL
   * checkpoint happens, so recovery depends on SQLite replaying its own log.
   */
  it('keeps a committed write readable when the writer is killed before any clean shutdown', async () => {
    const { file, env } = localProfile();
    const opened = await openCore(env);
    const source = await opened.repository.createRawSource({
      userId: actor.userId,
      rawText: '父连接写入并正常关闭的那条原文。',
      sourceType: 'manual',
      capturedAt: isoNow(),
      metadata: {},
    });
    await opened.repository.updateRawSourceProcessing(source.id, actor.userId, 'processing');
    await opened.close();

    const receipt = path.join(path.dirname(file), 'child-id.txt');
    const killed = spawnSync(
      process.execPath,
      ['--import', 'tsx', crashWriter, file, actor.userId, receipt],
      { encoding: 'utf8', timeout: 120_000, cwd: path.dirname(crashWriter) },
    );
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const childId = readFileSync(receipt, 'utf8');

    const survivor = await openCore(env);
    try {
      const before = await survivor.repository.findRawSource(source.id, actor.userId);
      expect(before?.rawText).toBe('父连接写入并正常关闭的那条原文。');
      expect(before?.processingStatus).toBe('processing');

      const crash = await survivor.repository.findRawSource(childId, actor.userId);
      expect(crash?.rawText).toBe('子进程写入后立刻被 SIGKILL，不做任何 close()。');
      expect(survivor.core.health().storage.detail['rawSources']).toBe(2);
    } finally {
      await survivor.close();
    }
    // The orphaned log was replayed into the profile, so a clean close leaves no sidecar behind.
    expect(existsSync(`${file}-wal`)).toBe(false);
  }, 120_000);

  it('lets a second handle read what a still-open handle wrote', async () => {
    const { file, env } = localProfile();
    const writer = await openCore(env);
    const reader = await openCore(env);
    try {
      const source = await writer.repository.createRawSource({
        userId: actor.userId,
        rawText: '两个连接同时打开同一个 profile。',
        sourceType: 'manual',
        capturedAt: isoNow(),
        metadata: {},
      });
      expect((await reader.repository.findRawSource(source.id, actor.userId))?.rawText).toBe(
        '两个连接同时打开同一个 profile。',
      );
    } finally {
      await reader.close();
      await writer.close();
    }
    expect(existsSync(`${file}-wal`)).toBe(false);
  });
});
