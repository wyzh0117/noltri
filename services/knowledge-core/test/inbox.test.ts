/**
 * 收件箱 (V1 §8 P2): the capture feed a person triages by hand.
 *
 * Two rules hold throughout. The feed is a *view over stored RawSource rows* — it never invents a
 * second table — and 人工归档 must work with no AI at all, because a desktop install has no model
 * key on first launch (§15, acceptance L03/R05).
 */
import { describe, expect, it } from 'vitest';
import { isKnowledgeError, type KnowledgeError } from '@noltri/shared';
import type { ProcessingStatus } from '@noltri/schema';
import { createNodeRecord, aiCalls, makeHarness, type Harness } from './fakes';

async function rejection(work: Promise<unknown>): Promise<KnowledgeError> {
  try {
    await work;
  } catch (cause: unknown) {
    expect(isKnowledgeError(cause)).toBe(true);
    return cause as KnowledgeError;
  }
  throw new Error('expected the call to reject');
}

async function seedSource(
  harness: Harness,
  rawText: string,
  options: { status?: ProcessingStatus; errorReason?: string; userId?: string; title?: string } = {},
): Promise<string> {
  const source = await harness.repository.createRawSource({
    userId: options.userId ?? harness.actor.userId,
    rawText,
    sourceType: 'manual',
    sourceTitle: options.title ?? null,
    capturedAt: new Date().toISOString(),
    metadata: { origin: 'inbox-test' },
  });
  if (options.status !== undefined) {
    await harness.repository.updateRawSourceProcessing(source.id, source.userId, options.status, options.errorReason ?? null);
  }
  return source.id;
}

describe('inbox service', () => {
  it('lists the newest captures first with whole-library counts and preview text', async () => {
    const harness = makeHarness();
    const oldest = await seedSource(harness, '最早的一条原文。', { title: '第一条' });
    const failed = await seedSource(harness, '这一条归纳失败了。', { status: 'failed', errorReason: '模型超时' });
    const newest = await seedSource(harness, '最新的一条原文。');
    await seedSource(harness, '别人库里的原文。', { userId: 'another-owner' });

    const inbox = await harness.core.listInbox({}, harness.actor);

    expect(inbox.entries.map((entry) => entry.id)).toEqual([newest, failed, oldest]);
    expect(inbox.counts).toEqual({ pending: 2, processing: 0, done: 0, failed: 1 });
    const failedEntry = inbox.entries.find((entry) => entry.id === failed);
    expect(failedEntry?.errorReason).toBe('模型超时');
    expect(failedEntry?.sourceTitle).toBeNull();
    expect(failedEntry?.textPreview).toBe('这一条归纳失败了。');
    expect(failedEntry?.rawTextLength).toBe('这一条归纳失败了。'.length);
  });

  it('truncates a long preview and reports the real length', async () => {
    const harness = makeHarness();
    const long = '知序'.repeat(300);
    await seedSource(harness, long);

    const [entry] = (await harness.core.listInbox({}, harness.actor)).entries;
    expect(entry?.textPreview.length).toBeLessThanOrEqual(161);
    expect(entry?.textPreview.endsWith('…')).toBe(true);
    expect(entry?.rawTextLength).toBe(long.length);
  });

  it('filters by status and pages while the counts stay whole-library', async () => {
    const harness = makeHarness();
    const first = await seedSource(harness, '第一条待整理');
    const second = await seedSource(harness, '第二条待整理');
    const third = await seedSource(harness, '第三条待整理');
    await harness.repository.updateRawSourceProcessing(second, harness.actor.userId, 'done');

    const pending = await harness.core.listInbox({ status: 'pending' }, harness.actor);
    expect(pending.entries.map((entry) => entry.id)).toEqual([third, first]);
    expect(pending.counts.done).toBe(1);

    const page = await harness.core.listInbox({ limit: 1, offset: 1 }, harness.actor);
    expect(page.entries.map((entry) => entry.id)).toEqual([second]);
    expect(page).toMatchObject({ limit: 1, offset: 1 });

    const both = await harness.core.listInbox({ status: 'pending,failed' }, harness.actor);
    expect(both.entries.map((entry) => entry.id)).toEqual([third, first]);
  });

  it('rejects an unknown status token instead of quietly returning everything', async () => {
    const harness = makeHarness();
    await seedSource(harness, '一条原文');
    const error = await rejection(harness.core.listInbox({ status: 'pending,purpose' }, harness.actor));
    expect(error.code).toBe('invalid_request');
  });

  it('reads one source back in full for manual triage, scoped to its owner', async () => {
    const harness = makeHarness();
    const text = '完整原文，人工处理时要能读到底。'.repeat(20);
    const id = await seedSource(harness, text);

    const full = await harness.core.readRawSource(id, harness.actor);
    expect(full?.rawText).toBe(text);
    expect(full?.metadata).toEqual({ origin: 'inbox-test' });
    expect(await harness.core.readRawSource(id, { userId: 'another-owner', actor: 'test' })).toBeNull();
    expect(await harness.core.readRawSource('absent-id', harness.actor)).toBeNull();
  });

  it('files a capture into a node with no AI call at all', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, '数据结构');
    const sourceId = await seedSource(harness, '  元组一旦创建就不能修改。  ');

    const result = await harness.core.assignSource(sourceId, { nodeId }, harness.actor);

    expect(result.item.normalizedText).toBe('元组一旦创建就不能修改。');
    expect(result.item.isAiDerived).toBe(false);
    expect(result.item.rawSourceId).toBe(sourceId);
    expect(result.path.map((segment) => segment.title)).toEqual(['数据结构']);
    const stored = await harness.repository.listKnowledgeItemsForNode(nodeId, harness.actor.userId);
    expect(stored.map((item) => item.id)).toContain(result.item.id);
    expect((await harness.repository.findRawSource(sourceId, harness.actor.userId))?.processingStatus).toBe('done');
    expect(aiCalls(harness.timeline)).toEqual([]);
  });

  it('files the human-edited excerpt when one is given', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, '要点');
    const sourceId = await seedSource(harness, '原文前半段是有用的结论，后半段只是随口补充的背景。');

    const result = await harness.core.assignSource(
      sourceId,
      { nodeId, text: '有用的结论部分。' },
      harness.actor,
    );
    expect(result.item.normalizedText).toBe('有用的结论部分。');
  });

  it('refuses to file the same text into the same node twice', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, '重复检查');
    const sourceId = await seedSource(harness, '同一条知识点不应该出现两次。');
    await harness.core.assignSource(sourceId, { nodeId }, harness.actor);

    const error = await rejection(harness.core.assignSource(sourceId, { nodeId }, harness.actor));
    expect(error.code).toBe('conflict');
    // The first filing still stands; a rejected retry must not leave a second row or clear the flag.
    expect((await harness.repository.listKnowledgeItemsForNode(nodeId, harness.actor.userId)).length).toBe(1);
  });

  it('refuses a node the caller does not own and a source that does not exist', async () => {
    const harness = makeHarness();
    const foreign = makeHarness();
    const foreignNodeId = await createNodeRecord(foreign, '别人的节点');
    const sourceId = await seedSource(harness, '一条自己的原文');

    const wrongNode = await rejection(harness.core.assignSource(sourceId, { nodeId: foreignNodeId }, harness.actor));
    expect(wrongNode.code).toBe('not_found');
    const missingSource = await rejection(
      harness.core.assignSource('absent-source', { nodeId: foreignNodeId }, harness.actor),
    );
    expect(missingSource.code).toBe('not_found');
  });
});
