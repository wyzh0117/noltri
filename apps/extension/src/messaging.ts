import type { CaptureResult } from '@noltri/schema';
import type { CaptureIntent } from './capture/pipeline';

export const MESSAGE_CAPTURE = 'noltri/capture';
export const MESSAGE_COLLECT_CONTEXT = 'noltri/collect-context';
export const MESSAGE_CAPTURE_RESULT = 'noltri/capture-result';

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

function readType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
