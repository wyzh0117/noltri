import { captureRequestSchema, type CaptureRequest } from '@noltri/schema';

/**
 * The queue that keeps a capture when Knowledge Core could not be reached (V1 §10.3).
 *
 * It is deliberately local-only: `chrome.storage.sync` would copy the user's selected text to a Google
 * account, and the doc's promise is that an unsent capture stays on the machine until it is acked. Every
 * function here is pure over an array so the capacity, expiry and ordering rules are testable without a
 * browser; only {@link createOutbox} touches storage.
 */

export const OUTBOX_STORAGE_KEY = 'noltri.outbox';
/** A queue that grows without bound is a file of everything the user ever read. 50 is the honest limit. */
export const OUTBOX_CAPACITY = 50;
/** A capture nobody could deliver after a week is stale; keeping it risks resurfacing text out of context. */
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxEntry {
  readonly id: string;
  readonly request: CaptureRequest;
  readonly queuedAt: string;
  readonly tries: number;
  readonly lastError?: string;
}

export type EnqueueRejection = 'duplicate' | 'full';

export interface EnqueueResult {
  readonly entries: readonly OutboxEntry[];
  readonly accepted: boolean;
  readonly rejected?: EnqueueRejection;
}

export interface OutboxRead {
  readonly entries: readonly OutboxEntry[];
  readonly dropped: number;
}

export interface Outbox {
  readonly enabled: boolean;
  read(): Promise<OutboxRead>;
  write(entries: readonly OutboxEntry[]): Promise<void>;
  clear(): Promise<void>;
}

export interface OutboxStorageArea {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function toEntry(value: unknown): OutboxEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const request = captureRequestSchema.safeParse(record.request);
  if (!request.success) return undefined;
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined;
  if (!isIsoDate(record.queuedAt)) return undefined;
  const tries = typeof record.tries === 'number' && Number.isFinite(record.tries) && record.tries >= 0 ? Math.floor(record.tries) : 0;
  return {
    id: record.id,
    request: request.data,
    queuedAt: record.queuedAt,
    tries,
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError.slice(0, 200) } : {}),
  };
}

/**
 * A tolerant reader, like the settings one: hand-edited or half-written storage must not take the popup
 * down. Anything that cannot be sent is dropped and *counted*, because silently losing rows is exactly
 * what §10.3 forbids.
 */
export function readOutboxEntries(raw: unknown): OutboxRead {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0 };
  const entries: OutboxEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    const entry = toEntry(item);
    if (entry === undefined) {
      dropped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, dropped };
}

/** Expiry is measured from the moment the capture was queued, not from the last failed attempt. */
export function pruneExpired(entries: readonly OutboxEntry[], nowMs: number, ttlMs: number = OUTBOX_TTL_MS): { entries: OutboxEntry[]; expired: number } {
  const kept = entries.filter((entry) => nowMs - Date.parse(entry.queuedAt) <= ttlMs);
  return { entries: kept, expired: entries.length - kept.length };
}

export function enqueueEntry(
  entries: readonly OutboxEntry[],
  entry: OutboxEntry,
  options: { readonly capacity?: number } = {},
): EnqueueResult {
  const capacity = options.capacity ?? OUTBOX_CAPACITY;
  // The key is the whole point of the queue: two entries with one requestId would resend the same text
  // twice the moment the Core comes back, which is the failure §7.4 exists to prevent.
  if (entries.some((existing) => existing.request.requestId === entry.request.requestId)) {
    return { entries, accepted: false, rejected: 'duplicate' };
  }
  if (entries.length >= capacity) return { entries, accepted: false, rejected: 'full' };
  return { entries: [...entries, entry], accepted: true };
}

export function removeEntry(entries: readonly OutboxEntry[], id: string): OutboxEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function bumpAttempt(entries: readonly OutboxEntry[], id: string, message: string): OutboxEntry[] {
  return entries.map((entry) =>
    entry.id !== id ? entry : { ...entry, tries: entry.tries + 1, lastError: message.slice(0, 200) },
  );
}

export function createOutbox(area: OutboxStorageArea): Outbox {
  return {
    enabled: true,
    read: async () => readOutboxEntries((await area.get(OUTBOX_STORAGE_KEY))?.[OUTBOX_STORAGE_KEY]),
    write: async (entries) => {
      await area.set({ [OUTBOX_STORAGE_KEY]: entries });
    },
    clear: async () => {
      await area.set({ [OUTBOX_STORAGE_KEY]: [] });
    },
  };
}

/**
 * Incognito gets this instead of a real queue. Chrome keeps `storage.local` on disk for a normal profile,
 * and an isolated browsing session must not leave its text there afterwards.
 */
export function disabledOutbox(): Outbox {
  return {
    enabled: false,
    read: async () => ({ entries: [], dropped: 0 }),
    write: async () => undefined,
    clear: async () => undefined,
  };
}
