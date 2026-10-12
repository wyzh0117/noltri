import { describe, expect, it } from 'vitest';
import type { CaptureRequest, CaptureResult } from '@noltri/schema';
import {
  QUEUE_DISABLED_MESSAGE,
  QUEUE_DUPLICATE_MESSAGE,
  QUEUE_FULL_MESSAGE,
  WAITING_FOR_CORE_MESSAGE,
  drainOutbox,
  queueCapture,
  shouldQueue,
} from '../src/outbox/drain';
import { OUTBOX_CAPACITY, OUTBOX_STORAGE_KEY, OUTBOX_TTL_MS, createOutbox, disabledOutbox, type OutboxEntry } from '../src/outbox/outbox';
import { buildExtensionCaptureRequest } from '../src/capture/build-request';
import type { CaptureOutcome } from '../src/api/client';

const DAY = 24 * 60 * 60 * 1000;

function requestOf(requestId: string): CaptureRequest {
  return buildExtensionCaptureRequest(
    { text: '知序断线重发的测试原文，至少八个字', source: { type: 'web', url: 'https://example.com/a' } },
    { deviceId: 'device-drain-test', requestId },
  );
}

function entryOf(requestId: string, queuedAtMs = Date.parse('2026-10-05T12:00:00.000Z')): OutboxEntry {
  return { id: requestId, request: requestOf(requestId), queuedAt: new Date(queuedAtMs).toISOString(), tries: 0 };
}

function stored(duplicate = false): CaptureOutcome {
  const result = {
    rawSourceId: `rs-${duplicate ? 'dup' : 'new'}`,
    requestId: 'req-drain-unused',
    stage: 'completed',
    duplicate,
    items: [],
    processingStatus: 'done',
  } as unknown as CaptureResult;
  return { ok: true, result };
}

const unreachable: CaptureOutcome = { ok: false, message: '未连接 Knowledge Core，内容未保存', retryable: true, coreUnreachable: true };
const refused: CaptureOutcome = { ok: false, message: '这段内容不符合采集要求（至少 8 个字），没有发送', retryable: false, coreUnreachable: false };
const serverFault: CaptureOutcome = { ok: false, message: 'Knowledge Core 暂时不可用（503），内容未保存', retryable: true, coreUnreachable: false };

function fakeArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
}

function outboxWith(entries: readonly OutboxEntry[]) {
  const area = fakeArea({ [OUTBOX_STORAGE_KEY]: entries });
  return { area, outbox: createOutbox(area) };
}

describe('drainOutbox resends with the key it queued', () => {
  it('walks the queue oldest-first and sends each entry its own stored requestId', async () => {
    const { outbox } = outboxWith([entryOf('req-drain-aaaa'), entryOf('req-drain-bbbb')]);
    const seen: string[] = [];
    const report = await drainOutbox({
      outbox,
      send: async (request) => {
        seen.push(request.requestId);
        return stored();
      },
    });
    expect(seen).toEqual(['req-drain-aaaa', 'req-drain-bbbb']);
    expect(report).toMatchObject({ sent: 2, kept: 0, stoppedEarly: false });
    expect((await outbox.read()).entries).toEqual([]);
  });

  it('stops at the first unreachable Core and leaves the rest queued', async () => {
    const { outbox } = outboxWith([entryOf('req-drain-0001'), entryOf('req-drain-0002'), entryOf('req-drain-0003')]);
    const seen: string[] = [];
    const report = await drainOutbox({
      outbox,
      send: async (request) => {
        seen.push(request.requestId);
        return unreachable;
      },
    });
    // One attempt is the honest cost of a dead port; a service worker must not hammer it with the rest.
    expect(seen).toEqual(['req-drain-0001']);
    expect(report).toMatchObject({ sent: 0, kept: 3, stoppedEarly: true });
  });

  it('counts a Core that already has the text as delivered, not as a resend', async () => {
    const { outbox } = outboxWith([entryOf('req-drain-dup1')]);
    const report = await drainOutbox({ outbox, send: async () => stored(true) });
    expect(report).toMatchObject({ sent: 0, alreadyStored: 1, kept: 0 });
    expect((await outbox.read()).entries).toEqual([]);
  });

  it('keeps a deliberate refusal queued but moves on to the next entry', async () => {
    const { outbox, area } = outboxWith([entryOf('req-refusal'), entryOf('req-later')]);
    const seen: string[] = [];
    const report = await drainOutbox({
      outbox,
      send: async (request) => {
        seen.push(request.requestId);
        return request.requestId === 'req-refusal' ? refused : stored();
      },
    });
    expect(seen).toEqual(['req-refusal', 'req-later']);
    expect(report.kept).toBe(1);
    const storedEntries = area.data[OUTBOX_STORAGE_KEY] as OutboxEntry[];
    expect(storedEntries.map((entry) => entry.id)).toEqual(['req-refusal']);
    expect(storedEntries[0]?.tries).toBe(1);
    expect(storedEntries[0]?.lastError).toContain('不符合采集要求');
  });

  it('treats a server fault as retryable and keeps the entry without stopping the queue', async () => {
    const { outbox } = outboxWith([entryOf('req-fault'), entryOf('req-after-fault')]);
    const report = await drainOutbox({ outbox, send: async () => serverFault });
    expect(report).toMatchObject({ kept: 2, stoppedEarly: false });
  });

  it('expires stale entries and reports how much it threw away', async () => {
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const { outbox } = outboxWith([entryOf('req-stale', now - OUTBOX_TTL_MS - DAY), entryOf('req-live', now - DAY)]);
    const report = await drainOutbox({
      outbox,
      nowMs: () => now,
      send: async () => stored(),
    });
    expect(report.expired).toBe(1);
    expect(report.sent).toBe(1);
    expect(report.kept).toBe(0);
  });

  it('counts records it could not read instead of losing them quietly', async () => {
    const area = fakeArea({ [OUTBOX_STORAGE_KEY]: [{ id: 'broken', queuedAt: 'nope' }, entryOf('req-readable')] });
    const report = await drainOutbox({
      outbox: createOutbox(area),
      send: async () => stored(),
    });
    expect(report.corrupt).toBe(1);
    expect(report.sent).toBe(1);
  });

  it('does nothing at all for a queue that is not allowed to exist', async () => {
    const report = await drainOutbox({ outbox: disabledOutbox(), send: async () => stored() });
    expect(report).toMatchObject({ sent: 0, kept: 0, expired: 0 });
  });
});

describe('shouldQueue separates a refusal from an outage', () => {
  it('queues only what resending could fix', () => {
    expect(shouldQueue(stored(), true)).toBe(false);
    expect(shouldQueue(unreachable, true)).toBe(true);
    expect(shouldQueue(serverFault, true)).toBe(true);
    expect(shouldQueue(refused, true)).toBe(false);
    // An outage with nowhere to put it must not pretend the text was kept.
    expect(shouldQueue(unreachable, false)).toBe(false);
  });
});

describe('queueCapture tells the page what actually happened', () => {
  it('promises a retry only when the entry is really in the queue', async () => {
    const outbox = createOutbox(fakeArea());
    const report = await queueCapture(outbox, entryOf('req-q-0001'));
    expect(report).toMatchObject({ accepted: true, queued: true, message: WAITING_FOR_CORE_MESSAGE });
  });

  it('says the same text is already waiting rather than doubling it', async () => {
    const outbox = createOutbox(fakeArea());
    await queueCapture(outbox, entryOf('req-q-0002'));
    const again = await queueCapture(outbox, entryOf('req-q-0002'));
    expect(again).toMatchObject({ accepted: false, rejected: 'duplicate', queued: true, message: QUEUE_DUPLICATE_MESSAGE });
    expect((await outbox.read()).entries).toHaveLength(1);
  });

  it('refuses to overflow and does not evict someone else capture', async () => {
    const seeded = Array.from({ length: OUTBOX_CAPACITY }, (_unused, index) => entryOf(`req-full-${String(index).padStart(4, '0')}`));
    const outbox = createOutbox(fakeArea({ [OUTBOX_STORAGE_KEY]: seeded }));
    const report = await queueCapture(outbox, entryOf('req-full-9999'));
    expect(report).toMatchObject({ accepted: false, rejected: 'full', queued: false, message: QUEUE_FULL_MESSAGE });
    expect((await outbox.read()).entries).toHaveLength(OUTBOX_CAPACITY);
  });

  it('is honest about incognito, where nothing is kept', async () => {
    const report = await queueCapture(disabledOutbox(), entryOf('req-incognito'));
    expect(report).toMatchObject({ accepted: false, queued: false, message: QUEUE_DISABLED_MESSAGE });
  });

  it('drops expired entries while making room', async () => {
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const outbox = createOutbox(fakeArea({ [OUTBOX_STORAGE_KEY]: [entryOf('req-expired', now - OUTBOX_TTL_MS - DAY)] }));
    const report = await queueCapture(outbox, entryOf('req-newcomer'), { nowIso: () => new Date(now).toISOString() });
    expect(report.accepted).toBe(true);
    const read = await outbox.read();
    expect(read.entries.map((entry) => entry.id)).toEqual(['req-newcomer']);
  });
});
