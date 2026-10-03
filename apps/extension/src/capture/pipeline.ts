import type { CaptureRequest } from '@noltri/schema';
import { buildExtensionCaptureRequest, type CaptureIntent, type CaptureRequestMeta } from './build-request';
import { buildSource } from '../source/extract';

export type { CaptureIntent, CaptureRequestMeta };

export interface MenuSelectionInput {
  readonly selectionText: string;
  readonly pageHref: string;
  readonly pageTitle: string;
  readonly surroundingContext?: string;
}

/** Entry 1 — the floating pill: the content script already measured the page. */
export function requestFromPillSelection(intent: CaptureIntent, meta: CaptureRequestMeta): CaptureRequest {
  return buildExtensionCaptureRequest(intent, meta);
}

/**
 * Entry 2 — the context menu: Chrome only hands over `selectionText` plus tab metadata, so the intent
 * is rebuilt here with the same source builder. Both entries converge on `buildExtensionCaptureRequest`,
 * which is what makes the two paths send byte-identical payloads.
 */
export function requestFromMenuSelection(input: MenuSelectionInput, meta: CaptureRequestMeta): CaptureRequest {
  return buildExtensionCaptureRequest(intentFromMenuSelection(input), meta);
}

export function intentFromMenuSelection(input: MenuSelectionInput): CaptureIntent {
  return {
    text: input.selectionText,
    source: buildSource({ href: input.pageHref, title: input.pageTitle }),
    ...(input.surroundingContext ? { surroundingContext: input.surroundingContext } : {}),
  };
}
