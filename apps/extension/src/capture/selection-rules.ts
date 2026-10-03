import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';

/**
 * V1 §10.1 gates, expressed as data in / boolean out. No DOM, no chrome API: this is the rule set the
 * tests pin down, and the content script only feeds it measurements.
 */
export interface ToolbarGateInput {
  readonly text: string;
  readonly isDragging: boolean;
  readonly isInsideOwnUi: boolean;
  readonly siteDisabled: boolean;
  readonly minimumLength: number;
  readonly autoShowEnabled?: boolean;
}

export type ToolbarGateReason =
  | 'show'
  | 'empty'
  | 'whitespace_only'
  | 'below_minimum_length'
  | 'dragging'
  | 'inside_own_ui'
  | 'site_disabled'
  | 'auto_show_disabled';

export function effectiveMinimumLength(configured: number): number {
  const rounded = Number.isFinite(configured) ? Math.round(configured) : MIN_CAPTURE_TEXT_LENGTH;
  // The frozen capture contract rejects shorter text, so a smaller user setting would only
  // produce guaranteed failures; the floor keeps the pill honest.
  return Math.max(MIN_CAPTURE_TEXT_LENGTH, rounded);
}

export function toolbarGateReason(input: ToolbarGateInput): ToolbarGateReason {
  const trimmed = input.text.trim();
  if (trimmed.length === 0) return input.text.length === 0 ? 'empty' : 'whitespace_only';
  if (trimmed.length < effectiveMinimumLength(input.minimumLength)) return 'below_minimum_length';
  if (input.isDragging) return 'dragging';
  if (input.isInsideOwnUi) return 'inside_own_ui';
  if (input.siteDisabled) return 'site_disabled';
  if (input.autoShowEnabled === false) return 'auto_show_disabled';
  return 'show';
}

export function shouldShowToolbarButton(input: ToolbarGateInput): boolean {
  return toolbarGateReason(input) === 'show';
}

export function hostnameFromHref(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
}
