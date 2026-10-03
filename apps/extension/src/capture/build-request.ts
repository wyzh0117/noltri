import { buildCaptureRequest } from '@noltri/api-client';
import { MAX_CAPTURE_TEXT_LENGTH, MAX_SURROUNDING_CONTEXT_LENGTH, type CaptureRequest } from '@noltri/schema';
import { normalizeKnowledgeText, truncate } from '@noltri/shared';
import type { SelectionIntent } from '../source/extract';

export type CaptureIntent = SelectionIntent;

export interface CaptureRequestMeta {
  readonly deviceId?: string;
  readonly capturedAt?: string;
}

/**
 * The one and only place this extension turns an intent into a `CaptureRequest`.
 * Pill clicks, the context menu and the popup paste box all funnel here, which is what keeps
 * §2.3 true: the extension prepares data, Knowledge Core decides where it belongs.
 */
export function buildExtensionCaptureRequest(intent: CaptureIntent, meta: CaptureRequestMeta = {}): CaptureRequest {
  const text = truncate(normalizeKnowledgeText(intent.text), MAX_CAPTURE_TEXT_LENGTH);
  const context = intent.surroundingContext ? truncate(normalizeKnowledgeText(intent.surroundingContext), MAX_SURROUNDING_CONTEXT_LENGTH) : undefined;
  return buildCaptureRequest({
    text,
    ...(context && context.length > 0 ? { surroundingContext: context } : {}),
    source: intent.source,
    client: 'extension',
    ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
    ...(meta.capturedAt ? { capturedAt: meta.capturedAt } : {}),
  });
}
