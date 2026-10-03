import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';

/**
 * Desktop-side selection gating, expressed as pure data-in/decision-out so the observer loop, the
 * Setup Manager probe and the tests all share one vocabulary (the Rust `SelectionProbeOut::reason`
 * strings are documented to match these values).
 */
export interface SelectionGateInput {
  readonly text: string;
  readonly minimumLength: number;
  /** True when the observed selection is byte-identical to the last accepted sample. */
  readonly isDuplicate: boolean;
  /** True when the app is on the per-app opt-out list. */
  readonly appDisabled: boolean;
}

export type SelectionGateReason =
  | 'show'
  | 'empty'
  | 'whitespace_only'
  | 'below_minimum_length'
  | 'duplicate_selection'
  | 'app_disabled';

/** The frozen capture contract rejects shorter text; the setting may only raise the bar. */
export function effectiveMinimumLength(configured: number): number {
  const rounded = Number.isFinite(configured) ? Math.round(configured) : MIN_CAPTURE_TEXT_LENGTH;
  return Math.max(MIN_CAPTURE_TEXT_LENGTH, rounded);
}

export function selectionGateReason(input: SelectionGateInput): SelectionGateReason {
  const trimmed = input.text.trim();
  if (trimmed.length === 0) return input.text.length === 0 ? 'empty' : 'whitespace_only';
  if (input.appDisabled) return 'app_disabled';
  if (trimmed.length < effectiveMinimumLength(input.minimumLength)) return 'below_minimum_length';
  if (input.isDuplicate) return 'duplicate_selection';
  return 'show';
}

export function shouldOfferCapture(input: SelectionGateInput): boolean {
  return selectionGateReason(input) === 'show';
}
