import type { CaptureResult } from '@noltri/schema';
import type { CaptureIntent } from './capture/pipeline';
import type { CaptureOutcome } from './api/client';

export const MESSAGE_CAPTURE = 'noltri/capture';
export const MESSAGE_COLLECT_CONTEXT = 'noltri/collect-context';
export const MESSAGE_CAPTURE_RESULT = 'noltri/capture-result';
/** Popup -> service worker: send the queue now (the user pressed 「立即发送」). */
export const MESSAGE_FLUSH_OUTBOX = 'noltri/flush-outbox';
/** Popup -> service worker: how many captures are waiting, without touching their text. */
export const MESSAGE_OUTBOX_COUNT = 'noltri/outbox-count';
/** Popup -> service worker: throw the queue away. §10.3 requires a one-click clear, so it is one message. */
export const MESSAGE_CLEAR_OUTBOX = 'noltri/clear-outbox';

/** Content script -> service worker: the worker owns the network call, because a content-script fetch is bound by the page's CORS. */
export interface CaptureMessage {
  readonly type: typeof MESSAGE_CAPTURE;
  readonly intent: CaptureIntent;
}

/** Service worker -> content script (context-menu path): give me the text around this selection. */
export interface CollectContextMessage {
  readonly type: typeof MESSAGE_COLLECT_CONTEXT;
  readonly selectionText: string;
}

export interface CollectContextReply {
  readonly surroundingContext?: string;
}

/** Service worker -> tab: the outcome of a capture, so the page can render the toast. */
export interface CaptureResultMessage {
  readonly type: typeof MESSAGE_CAPTURE_RESULT;
  readonly ok: boolean;
  readonly result?: CaptureResult;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly coreUnreachable?: boolean;
  readonly queued?: boolean;
}

export interface OutboxCommandMessage {
  readonly type: typeof MESSAGE_FLUSH_OUTBOX | typeof MESSAGE_OUTBOX_COUNT | typeof MESSAGE_CLEAR_OUTBOX;
}

export interface OutboxCountReply {
  readonly count: number;
  readonly enabled: boolean;
}

/** What a flush actually did, so the popup can say 「还剩 3 条」 instead of a bare 「已发送」. */
export interface OutboxFlushReply {
  readonly sent: number;
  readonly alreadyStored: number;
  readonly kept: number;
  readonly expired: number;
  readonly corrupt: number;
  readonly stoppedEarly: boolean;
}

export function isCaptureMessage(value: unknown): value is CaptureMessage {
  return readType(value) === MESSAGE_CAPTURE;
}

export function isCollectContextMessage(value: unknown): value is CollectContextMessage {
  return readType(value) === MESSAGE_COLLECT_CONTEXT;
}

export function isCaptureResultMessage(value: unknown): value is CaptureResultMessage {
  return readType(value) === MESSAGE_CAPTURE_RESULT;
}

export function isOutboxCommand(value: unknown, type: OutboxCommandMessage['type']): value is OutboxCommandMessage {
  return readType(value) === type;
}

/** The broadcast half of a capture, built once so no caller hand-rolls the two booleans a queue reads. */
export function captureResultMessage(outcome: CaptureOutcome): CaptureResultMessage {
  if (outcome.ok) return { type: MESSAGE_CAPTURE_RESULT, ok: true, result: outcome.result };
  return {
    type: MESSAGE_CAPTURE_RESULT,
    ok: false,
    message: outcome.message,
    retryable: outcome.retryable,
    coreUnreachable: outcome.coreUnreachable,
    ...(outcome.queued === true ? { queued: true } : {}),
  };
}

function readType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
