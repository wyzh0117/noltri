/**
 * V1 §9 / §20 "Core" proof: the six-step capture pipeline, with the RawSource written first.
 */
import { describe, expect, it } from 'vitest';
import { captureResultSchema, type CaptureRequest } from '@noltri/schema';
import { captureOf, CHINESE_TEXT, indexOfCall, makeHarness, repoCalls, ScriptedProvider } from './fakes';

const THREE_SENTENCES =
  '知识图谱用节点表达概念。边描述概念之间的关系。树形视图只是这些关系的一个投影。';

describe('capture pipeline', () => {
  it('writes the RawSource before the provider is ever called', async () => {
    const harness = makeHarness();
    const result = await harness.core.capture(captureOf(CHINESE_TEXT), harness.actor);

    expect(result.processingStatus).toBe('done');
    expect(repoCalls(harness.timeline)[0]).toBe('createRawSource');

    const rawSourceWrite = indexOfCall(harness.timeline, 'repo', 'createRawSource');
    const firstProviderCall = harness.timeline.findIndex((entry) => entry.kind === 'ai');
    expect(firstProviderCall).toBeGreaterThan(rawSourceWrite);

    // …and the status bookkeeping sits between them.
    expect(harness.timeline.slice(rawSourceWrite, firstProviderCall).map((entry) => entry.call)).toEqual([
      'createRawSource',
      'updateRawSourceProcessing',
    ]);

    const stored = await harness.repository.findRawSource(result.rawSourceId, harness.actor.userId);
    expect(stored?.rawText).toBe(CHINESE_TEXT);
    expect(stored?.processingStatus).toBe('done');
    expect(stored?.metadata.client).toBe('web_app');
  });

  it('keeps the RawSource and reports failure when the provider throws on extraction', async () => {
    const harness = makeHarness({ script: { fail: ['extract'] } });
    const result = await harness.core.capture(captureOf(CHINESE_TEXT), harness.actor);

    // A failed AI run is still a successful HTTP 200-style answer, never a lost selection.
    expect(captureResultSchema.parse(result)).toMatchObject({ processingStatus: 'failed', items: [] });
    expect(result.rawSourceId).toHaveLength(36);
    expect(result.errorReason).toContain('extractKnowledge');

    const stored = await harness.repository.findRawSource(result.rawSourceId, harness.actor.userId);
    expect(stored?.rawText).toBe(CHINESE_TEXT);
    expect(stored?.processingStatus).toBe('failed');
    const reason = stored?.errorReason ?? '';
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toMatch(/\n|at\s+\w+/);

    expect(await harness.repository.listKnowledgeItemsForSource(result.rawSourceId, harness.actor.userId)).toEqual([]);
  });

  it('retryCapture re-runs extraction from the stored text and flips the status to done', async () => {
    const harness = makeHarness({ script: { fail: ['extract'] } });
    const failed = await harness.core.capture(captureOf(CHINESE_TEXT), harness.actor);
    expect(failed.processingStatus).toBe('failed');

    harness.provider.fail.clear();
    const retried = await harness.core.retryCapture(failed.rawSourceId, harness.actor);

    expect(retried.processingStatus).toBe('done');
    expect(retried.rawSourceId).toBe(failed.rawSourceId);
    expect(retried.items.length).toBeGreaterThan(0);

    const stored = await harness.repository.findRawSource(failed.rawSourceId, harness.actor.userId);
    expect(stored?.processingStatus).toBe('done');
    expect(stored?.errorReason).toBeNull();
    // The retry writes no second copy of the material.
    expect(repoCalls(harness.timeline).filter((call) => call === 'createRawSource')).toHaveLength(1);
    expect(await harness.repository.listKnowledgeItemsForSource(failed.rawSourceId, harness.actor.userId)).toHaveLength(
      retried.items.length,
    );
  });

  it('rejects an invalid capture before anything is written', async () => {
    const harness = makeHarness();
    const broken = { text: '太短', source: { type: 'web' }, capture: { capturedAt: 'now', client: 'web_app' } };
    await expect(harness.core.capture(broken as CaptureRequest, harness.actor)).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
    expect(harness.timeline).toEqual([]);
  });

  it('creates one item per extracted point, each linked to a node', async () => {
    const harness = makeHarness();
    const result = await harness.core.capture(captureOf(THREE_SENTENCES, 'extension'), harness.actor);

    expect(result.items.length).toBe(3);
    const items = await harness.repository.listKnowledgeItemsForSource(result.rawSourceId, harness.actor.userId);
    expect(items).toHaveLength(result.items.length);

    for (const entry of result.items) {
      expect(['high', 'medium', 'low']).toContain(entry.confidenceTier);
      const node = await harness.repository.findNode(entry.nodeId, harness.actor.userId);
      expect(node).not.toBeNull();

      const links = await harness.repository.listLinksForItem(entry.knowledgeItemId, harness.actor.userId);
      expect(links.map((link) => link.nodeId)).toContain(entry.nodeId);

      // Every reported path really resolves in the repository.
      const path = await harness.repository.nodePath(harness.actor.userId, entry.nodeId);
      expect(path.map((segment) => segment.title)).toEqual(entry.nodePath);
      expect(entry.nodePath.at(-1)).toBe(node?.title);
    }

    // Exactly one batched embed call for the whole capture.
    expect(harness.provider.embedInputs).toHaveLength(1);
    expect(harness.provider.embedInputs[0]).toHaveLength(result.items.length);
  });

  it('records a create VersionRecord for every node the pipeline created', async () => {
    const harness = makeHarness();
    const result = await harness.core.capture(captureOf(THREE_SENTENCES), harness.actor);
    const versions = await harness.repository.listVersionRecords(harness.actor.userId);
    const landedNodeIds = new Set(result.items.map((entry) => entry.nodeId));

    const createRecords = versions.filter(
      (record) => record.operation === 'create' && record.entityType === 'knowledge_node',
    );
    expect(createRecords.length).toBeGreaterThanOrEqual(1);
    for (const record of createRecords) expect(landedNodeIds.has(record.entityId)).toBe(true);
  });

  it('marks a source done even when extraction finds no atomic knowledge', async () => {
    const harness = makeHarness({ script: ScriptedProvider.extracted([]) });
    const result = await harness.core.capture(captureOf(CHINESE_TEXT), harness.actor);

    expect(result.items).toEqual([]);
    expect(result.processingStatus).toBe('done');
    const stored = await harness.repository.findRawSource(result.rawSourceId, harness.actor.userId);
    expect(stored?.processingStatus).toBe('done');
  });
});
