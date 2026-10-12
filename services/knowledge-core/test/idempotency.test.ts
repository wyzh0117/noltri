/**
 * P3 本地接入 — the capture transaction contract (V1_Local_Desktop §7.4, §10.3).
 *
 * Every entry point reduces to the same request shape, the server dedupes on (clientId, requestId), and
 * the reply names the stage the capture actually reached — 已落盘 / 待归纳 / 归纳成功 / 需要复核 — instead of
 * a vague success flag. A replay must never re-call the model, never write a second source row, and never
 * lose the original text.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRequest } from '@noltri/schema';
import { nowIso } from '@noltri/shared';
import {
  aiCalls,
  captureOf,
  CHINESE_TEXT,
  makeHarness,
  repoCalls,
  testConfig,
  thresholdsOf,
  type Harness,
  type Script,
} from './fakes';

const KEY = 'req-p3-idempotency-0001';
const OTHER_KEY = 'req-p3-idempotency-0002';

/**
 * A pinned classification answer keeps the fresh-capture stage deterministic. The offline provider answers
 * `create` with confidence 0.2 against an empty tree, which is a property of the stub rather than of the
 * pipeline, so the stage tests below state the decision they want instead of inheriting it.
 */
const CONFIDENT: Script = {
  classify: () => ({
    action: 'create',
    newNodePath: ['编程语言', '数据结构'],
    confidence: 0.9,
    reason: '知识库中没有更合适的节点',
  }),
};

const UNSURE: Script = {
  classify: () => ({
    action: 'create',
    newNodePath: ['编程语言', '数据结构'],
    confidence: 0.4,
    reason: '知识库中没有可归档的节点',
  }),
};

function keyed(client: CaptureRequest['capture']['client'] = 'extension', requestId = KEY): CaptureRequest {
  return captureOf(CHINESE_TEXT, client, {}, requestId);
}

function confidentHarness(options: { script?: Script; lowMediumBar?: boolean } = {}): Harness {
  const script = options.script ?? CONFIDENT;
  return makeHarness({
    ...(options.lowMediumBar === true ? { config: testConfig({ thresholds: thresholdsOf({ mediumConfidence: 0.9 }) }) } : {}),
    script,
  });
}

async function sourceCount(harness: Harness): Promise<number> {
  return (await harness.repository.listInbox({ userId: harness.actor.userId })).length;
}

describe('capture request contract', () => {
  it('refuses a capture that carries no request id, before writing anything', async () => {
    const harness = makeHarness();
    const unsigned = {
      text: CHINESE_TEXT,
      source: { type: 'web' },
      capture: { capturedAt: nowIso(), client: 'extension' },
    } as CaptureRequest;

    await expect(harness.core.capture(unsigned, harness.actor)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await sourceCount(harness)).toBe(0);
    expect(aiCalls(harness.timeline)).toEqual([]);
  });

  it('replays the same (clientId, requestId) without a second source or a second model call', async () => {
    const harness = confidentHarness();
    const first = await harness.core.capture(keyed(), harness.actor);
    const second = await harness.core.capture(keyed(), harness.actor);

    expect(first.requestId).toBe(KEY);
    expect(first.duplicate).toBe(false);
    expect(first.stage).toBe('completed');

    expect(second.duplicate).toBe(true);
    expect(second.rawSourceId).toBe(first.rawSourceId);
    expect(second.requestId).toBe(KEY);
    expect(second.processingStatus).toBe('done');
    expect(second.stage).toBe('completed');
    // Rebuilding the per-item decisions from stored rows would invent numbers the model never gave,
    // so a replay states the outcome and points at the source instead of echoing items.
    expect(second.items).toEqual([]);

    expect(await sourceCount(harness)).toBe(1);
    expect(aiCalls(harness.timeline).filter((call) => call === 'extract')).toHaveLength(1);
    expect(repoCalls(harness.timeline).filter((call) => call === 'createRawSource')).toHaveLength(1);
  });

  it('scopes the key to one user: the same requestId from another owner is a different capture', async () => {
    const harness = confidentHarness();
    const first = await harness.core.capture(keyed(), harness.actor);
    const intruder = await harness.core.capture(keyed(), { userId: 'someone-else', actor: 'extension' });

    expect(intruder.duplicate).toBe(false);
    expect(intruder.rawSourceId).not.toBe(first.rawSourceId);
  });

  it('treats another entry point with the same requestId as its own capture', async () => {
    const harness = confidentHarness();
    const fromExtension = await harness.core.capture(keyed('extension'), harness.actor);
    const fromDesktop = await harness.core.capture(keyed('desktop'), harness.actor);

    expect(fromDesktop.duplicate).toBe(false);
    expect(fromDesktop.rawSourceId).not.toBe(fromExtension.rawSourceId);
    expect(await sourceCount(harness)).toBe(2);
  });

  it('keeps both sources when the same text arrives under different request ids', async () => {
    const harness = confidentHarness();
    const first = await harness.core.capture(keyed(), harness.actor);
    const second = await harness.core.capture(keyed('extension', OTHER_KEY), harness.actor);

    // Identical content from a different submission is a different provenance, never a dropped request.
    expect(second.duplicate).toBe(false);
    expect(second.rawSourceId).not.toBe(first.rawSourceId);
    expect(await sourceCount(harness)).toBe(2);
  });
});

describe('capture stages', () => {
  it('answers 已落盘 when the stored source has not been compiled yet', async () => {
    const harness = makeHarness();
    const stored = await harness.repository.createRawSource({
      userId: harness.actor.userId,
      rawText: CHINESE_TEXT,
      sourceType: 'web',
      capturedAt: nowIso(),
      requestId: KEY,
      clientId: 'extension',
    });

    const replay = await harness.core.capture(keyed(), harness.actor);

    expect(replay.duplicate).toBe(true);
    expect(replay.stage).toBe('saved');
    expect(replay.rawSourceId).toBe(stored.id);
    expect(replay.items).toEqual([]);
    // A row that exists but was never compiled is the inbox's job, not a replay's.
    expect(aiCalls(harness.timeline)).toEqual([]);
  });

  it('answers 待归纳 while the original request is still being processed', async () => {
    const harness = confidentHarness();
    const stored = await harness.core.capture(keyed(), harness.actor);
    await harness.repository.updateRawSourceProcessing(stored.rawSourceId, harness.actor.userId, 'processing');

    const replay = await harness.core.capture(keyed(), harness.actor);
    expect(replay.duplicate).toBe(true);
    expect(replay.stage).toBe('processing');
    expect(aiCalls(harness.timeline).filter((call) => call === 'extract')).toHaveLength(1);
  });

  it('answers 需要复核 when a filed link falls below the medium bar', async () => {
    const harness = confidentHarness({ script: UNSURE, lowMediumBar: true });
    const result = await harness.core.capture(keyed(), harness.actor);

    expect(result.stage).toBe('needs_review');
    expect(result.processingStatus).toBe('done');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.confidenceTier === 'low')).toBe(true);
  });

  it('answers 归纳成功 when every filed link clears the medium bar', async () => {
    const harness = confidentHarness();
    const result = await harness.core.capture(keyed(), harness.actor);
    expect(result.stage).toBe('completed');
    expect(result.items.every((item) => item.confidenceTier !== 'low')).toBe(true);
  });

  it('reports a replay of a done source with the stage its stored links imply', async () => {
    const harness = confidentHarness({ script: UNSURE, lowMediumBar: true });
    const first = await harness.core.capture(keyed(), harness.actor);
    expect(first.stage).toBe('needs_review');

    const replay = await harness.core.capture(keyed(), harness.actor);
    expect(replay.duplicate).toBe(true);
    expect(replay.stage).toBe('needs_review');
  });

  it('re-runs the pipeline on the same row when a replay finds a failed source', async () => {
    const broken = confidentHarness({ script: { ...CONFIDENT, fail: ['extract'] } });
    const failed = await broken.core.capture(keyed(), broken.actor);
    expect(failed.stage).toBe('failed');
    expect(failed.duplicate).toBe(false);
    expect(failed.items).toEqual([]);
    expect(failed.errorReason).toBeTruthy();

    // The same submission arrives again after the outage: it reuses the row and never writes a second one.
    const repaired = makeHarness({ repository: broken.repository, script: CONFIDENT });
    const recovered = await repaired.core.capture(keyed(), broken.actor);

    expect(recovered.duplicate).toBe(true);
    expect(recovered.rawSourceId).toBe(failed.rawSourceId);
    expect(recovered.stage).toBe('completed');
    expect(await sourceCount(broken)).toBe(1);
  });

  it('keeps the original text when the provider fails, and retry keeps the key', async () => {
    const harness = confidentHarness({ script: { ...CONFIDENT, fail: ['embed'] } });
    const result = await harness.core.capture(keyed(), harness.actor);
    expect(result.stage).toBe('failed');
    expect(result.processingStatus).toBe('failed');

    const stored = await harness.repository.findRawSource(result.rawSourceId, harness.actor.userId);
    expect(stored?.rawText).toBe(CHINESE_TEXT);
    expect(stored?.requestId).toBe(KEY);
    expect(stored?.clientId).toBe('extension');

    const retried = await makeHarness({ repository: harness.repository, script: CONFIDENT }).core.retryCapture(
      result.rawSourceId,
      harness.actor,
    );
    expect(retried.requestId).toBe(KEY);
    expect(retried.rawSourceId).toBe(result.rawSourceId);
    expect(retried.stage).toBe('completed');
    expect(await sourceCount(harness)).toBe(1);
  });
});
