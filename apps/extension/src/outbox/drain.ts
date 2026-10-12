import type { CaptureRequest } from '@noltri/schema';
import type { CaptureOutcome } from '../api/client';
import { bumpAttempt, enqueueEntry, pruneExpired, removeEntry, type Outbox, type OutboxEntry } from './outbox';

export const WAITING_FOR_CORE_MESSAGE = '等待 Noltri：内容已保留，连上后自动发送';
export const QUEUE_DISABLED_MESSAGE = '未连接 Noltri，且无痕窗口不保留待发送内容';
export const QUEUE_FULL_MESSAGE = '待发送队列已满（上限 50 条），这条没有加入队列';
export const QUEUE_DUPLICATE_MESSAGE = '这条已经在待发送队列里，等待 Noltri 连接';

/**
 * The one decision the queue is built around: a capture that the Core could not answer right now is
 * kept locally, and a capture the Core *refused* on purpose is not — retrying a rejected payload is how
 * a queue fills with text that will never be accepted.
 */
export function shouldQueue(outcome: CaptureOutcome, outboxEnabled: boolean): boolean {
  if (outcome.ok) return false;
  return outcome.retryable && outboxEnabled;
}

export function queueMessageFor(outcome: CaptureOutcome, outboxEnabled: boolean): string {
  if (outcome.ok) return '';
  if (shouldQueue(outcome, outboxEnabled)) return WAITING_FOR_CORE_MESSAGE;
  if (outcome.coreUnreachable && !outboxEnabled) return QUEUE_DISABLED_MESSAGE;
  return outcome.message;
}

export interface SendCapture {
  (request: CaptureRequest): Promise<CaptureOutcome>;
}

export interface DrainReport {
  readonly sent: number;
  readonly alreadyStored: number;
  readonly kept: number;
  readonly expired: number;
  readonly corrupt: number;
  readonly stoppedEarly: boolean;
}

export interface DrainOptions {
  readonly outbox: Outbox;
  readonly send: SendCapture;
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
}

/**
 * Sends the queue oldest-first with the requestId each entry already carries, so a resend after a
 * disconnect is one capture in the Core, not two (§10.3 「断线重试使用相同 requestId」).
 *
 * The loop stops the moment the Core is unreachable: hammering a dead server from a service worker that
 * Chrome may kill at any time achieves nothing and burns the user's battery.
 */
export async function drainOutbox(options: DrainOptions): Promise<DrainReport> {
  const now = options.nowMs?.() ?? Date.now();
  const read = await options.outbox.read();
  const { entries: alive, expired } = pruneExpired(read.entries, now, options.ttlMs);

  let entries = alive;
  let sent = 0;
  let alreadyStored = 0;
  let stoppedEarly = false;

  for (const entry of alive) {
    const outcome = await options.send(entry.request);
    if (outcome.ok) {
      entries = removeEntry(entries, entry.id);
      if (outcome.result.duplicate) alreadyStored += 1;
      else sent += 1;
      continue;
    }
    if (outcome.coreUnreachable) {
      stoppedEarly = true;
      break;
    }
    entries = bumpAttempt(entries, entry.id, outcome.message);
  }

  if (expired > 0) entries = pruneExpired(entries, now, options.ttlMs).entries;
  await options.outbox.write(entries);
  return { sent, alreadyStored, kept: entries.length, expired, corrupt: read.dropped, stoppedEarly };
}

export interface EnqueueOptions {
  readonly nowIso?: () => string;
}

export interface EnqueueReport {
  readonly accepted: boolean;
  readonly rejected?: 'duplicate' | 'full';
  /** Whether the user's text is now in the queue — including when it was already there. */
  readonly queued: boolean;
  readonly message: string;
}

/**
 * Queues a capture that could not be delivered. The failure text a page sees depends on the reason: a
 * full queue is a different promise broken than a duplicate, and both are different from 「等待 Noltri」.
 */
export async function queueCapture(
  outbox: Outbox,
  entry: OutboxEntry,
  options: EnqueueOptions = {},
): Promise<EnqueueReport> {
  if (!outbox.enabled) return { accepted: false, queued: false, message: QUEUE_DISABLED_MESSAGE };
  const read = await outbox.read();
  const pruned = pruneExpired(read.entries, Date.parse(options.nowIso?.() ?? new Date().toISOString()));
  const result = enqueueEntry(pruned.entries, entry);
  if (!result.accepted) {
    if (result.rejected === 'full') return { accepted: false, rejected: 'full', queued: false, message: QUEUE_FULL_MESSAGE };
    return { accepted: false, rejected: 'duplicate', queued: true, message: QUEUE_DUPLICATE_MESSAGE };
  }
  await outbox.write(result.entries);
  return { accepted: true, queued: true, message: WAITING_FOR_CORE_MESSAGE };
}
