import { describe, expect, it } from 'vitest';
import type { CaptureRequest } from '@noltri/schema';
import { buildExtensionCaptureRequest } from '../src/capture/build-request';
import {
  OUTBOX_CAPACITY,
  OUTBOX_STORAGE_KEY,
  OUTBOX_TTL_MS,
  bumpAttempt,
  createOutbox,
  disabledOutbox,
  enqueueEntry,
  pruneExpired,
  readOutboxEntries,
  removeEntry,
  type OutboxEntry,
} from '../src/outbox/outbox';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

function requestOf(requestId: string, text = '知序待发送队列的测试原文，至少八个字'): CaptureRequest {
  return buildExtensionCaptureRequest(
    { text, source: { type: 'web', url: 'https://example.com/a', title: '测试页' } },
    { deviceId: 'device-outbox-test', requestId },
  );
}

function entryOf(requestId: string, queuedAtMs = NOW): OutboxEntry {
  return { id: requestId, request: requestOf(requestId), queuedAt: new Date(queuedAtMs).toISOString(), tries: 0 };
}

function entriesOf(count: number, start = 0): OutboxEntry[] {
  return Array.from({ length: count }, (_unused, index) => entryOf(`req-outbox-${String(start + index).padStart(4, '0')}`));
}

function fakeArea(initial: Record<string, unknown> = {}): {
  data: Record<string, unknown>;
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
}

describe('the outbox keeps at most its promise', () => {
  it('fills to the capacity and then refuses instead of dropping the oldest', () => {
    let entries: readonly OutboxEntry[] = [];
    for (const candidate of entriesOf(OUTBOX_CAPACITY)) {
      const result = enqueueEntry(entries, candidate);
      expect(result.accepted).toBe(true);
      entries = result.entries;
    }
    expect(entries).toHaveLength(OUTBOX_CAPACITY);
    const overflow = enqueueEntry(entries, entryOf('req-outbox-overflow'));
    expect(overflow.accepted).toBe(false);
    expect(overflow.rejected).toBe('full');
    // The text that could not be queued is still the user's; the queue must not evict someone else's.
    expect(overflow.entries).toHaveLength(OUTBOX_CAPACITY);
    expect(overflow.entries.map((entry) => entry.id)).not.toContain('req-outbox-overflow');
  });

  it('refuses a second copy of the same requestId, because a queue resends with one key', () => {
    const first = enqueueEntry([], entryOf('req-outbox-dup'));
    const second = enqueueEntry(first.entries, entryOf('req-outbox-dup'));
    expect(second.accepted).toBe(false);
    expect(second.rejected).toBe('duplicate');
    expect(second.entries).toHaveLength(1);
  });

  it('keeps two captures of identical text that arrived under different keys', () => {
    const one = enqueueEntry([], entryOf('req-outbox-key-a'));
    const two = enqueueEntry(one.entries, entryOf('req-outbox-key-b'));
    expect(two.accepted).toBe(true);
    expect(two.entries).toHaveLength(2);
  });

  it('appends oldest first and never mutates the array it was given', () => {
    const source = entriesOf(1, 0);
    const snapshot = JSON.parse(JSON.stringify(source)) as OutboxEntry[];
    const result = enqueueEntry(source, entryOf('req-outbox-0009'));
    expect(source).toEqual(snapshot);
    expect(result.entries.map((entry) => entry.id)).toEqual([source[0]?.id, 'req-outbox-0009']);
  });

  it('expires by the moment the capture was queued', () => {
    const fresh = entryOf('req-outbox-fresh', NOW - DAY);
    const stale = entryOf('req-outbox-stale', NOW - OUTBOX_TTL_MS - 1);
    const pruned = pruneExpired([fresh, stale], NOW);
    expect(pruned.entries.map((entry) => entry.id)).toEqual(['req-outbox-fresh']);
    expect(pruned.expired).toBe(1);
  });

  it('removes by id and records an attempt without inventing fields', () => {
    const seeded = entriesOf(2);
    expect(removeEntry(seeded, seeded[0]?.id ?? '')).toHaveLength(1);
    const bumped = bumpAttempt(seeded, seeded[1]?.id ?? '', '未连接 Knowledge Core，内容未保存');
    expect(bumped[1]?.tries).toBe(1);
    expect(bumped[1]?.lastError).toBe('未连接 Knowledge Core，内容未保存');
    expect(bumped[0]?.tries).toBe(0);
  });
});

describe('the outbox reader is tolerant but never silent', () => {
  it('drops records that cannot be sent and counts them', () => {
    const read = readOutboxEntries([
      entryOf('req-outbox-good'),
      { id: 'req-outbox-broken', request: { text: 'nope' }, queuedAt: new Date(NOW).toISOString() },
      null,
      'not an object',
      { request: requestOf('req-outbox-no-date'), queuedAt: 'yesterday' },
    ]);
    expect(read.entries.map((entry) => entry.id)).toEqual(['req-outbox-good']);
    expect(read.dropped).toBe(4);
  });

  it('reads an empty or foreign record as an empty queue', () => {
    for (const raw of [undefined, null, {}, 'x', 42]) {
      expect(readOutboxEntries(raw)).toEqual({ entries: [], dropped: 0 });
    }
  });

  it('keeps the resend key with the entry, which is the whole point of the queue', () => {
    const read = readOutboxEntries([entryOf('req-outbox-key')]);
    expect(read.entries[0]?.request.requestId).toBe('req-outbox-key');
  });

  it('caps a stored error string so a hostile server message cannot bloat the page', () => {
    const huge = 'x'.repeat(4_000);
    const read = readOutboxEntries([{ ...entryOf('req-outbox-long'), lastError: huge }]);
    expect(read.entries[0]?.lastError).toHaveLength(200);
  });
});

describe('the outbox storage surface', () => {
  it('round-trips through one local key', async () => {
    const area = fakeArea();
    const outbox = createOutbox(area);
    expect(outbox.enabled).toBe(true);
    await outbox.write(entriesOf(2));
    expect(Object.keys(area.data)).toEqual([OUTBOX_STORAGE_KEY]);
    const read = await outbox.read();
    expect(read.entries).toHaveLength(2);
    expect(read.dropped).toBe(0);
    await outbox.clear();
    expect((await outbox.read()).entries).toHaveLength(0);
  });

  it('gives incognito a queue that cannot persist anything', async () => {
    const area = fakeArea();
    const outbox = disabledOutbox();
    expect(outbox.enabled).toBe(false);
    await outbox.write(entriesOf(3));
    expect(area.data[OUTBOX_STORAGE_KEY]).toBeUndefined();
    expect((await outbox.read()).entries).toHaveLength(0);
  });
});
