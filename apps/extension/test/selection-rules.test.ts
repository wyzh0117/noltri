import { describe, expect, it } from 'vitest';
import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import {
  effectiveMinimumLength,
  shouldShowToolbarButton,
  toolbarGateReason,
  type ToolbarGateInput,
  type ToolbarGateReason,
} from '../src/capture/selection-rules';
import { computePillPosition, isRectVisible, PILL_SIZE, type PillSize, type ViewportSize } from '../src/capture/geometry';

const VALID_TEXT = 'Tuple 是不可变序列，因此可以作为字典的键使用。';

const BASE: ToolbarGateInput = {
  text: VALID_TEXT,
  isDragging: false,
  isInsideOwnUi: false,
  siteDisabled: false,
  minimumLength: MIN_CAPTURE_TEXT_LENGTH,
  autoShowEnabled: true,
};

interface GateCase {
  readonly name: string;
  readonly input: ToolbarGateInput;
  readonly expected: boolean;
  readonly reason: ToolbarGateReason;
}

/** V1 §10.1 — one row per documented gate. */
const GATE_CASES: readonly GateCase[] = [
  { name: 'valid selection shows the button', input: BASE, expected: true, reason: 'show' },
  { name: 'empty selection is rejected', input: { ...BASE, text: '' }, expected: false, reason: 'empty' },
  { name: 'whitespace-only selection is rejected', input: { ...BASE, text: '    \n\t ' }, expected: false, reason: 'whitespace_only' },
  { name: 'selection shorter than the configured minimum', input: { ...BASE, text: '这是一段中等长度的选区', minimumLength: 40 }, expected: false, reason: 'below_minimum_length' },
  { name: 'selection at exactly the configured minimum', input: { ...BASE, text: '十二个字的选区内', minimumLength: 8 }, expected: true, reason: 'show' },
  { name: 'contract floor overrides a too-low setting', input: { ...BASE, text: '只有六个字', minimumLength: 2 }, expected: false, reason: 'below_minimum_length' },
  { name: 'dragging suppresses the button', input: { ...BASE, isDragging: true }, expected: false, reason: 'dragging' },
  { name: 'selection inside our own shadow UI', input: { ...BASE, isInsideOwnUi: true }, expected: false, reason: 'inside_own_ui' },
  { name: 'domain disabled by the user', input: { ...BASE, siteDisabled: true }, expected: false, reason: 'site_disabled' },
  { name: 'auto-show turned off in settings', input: { ...BASE, autoShowEnabled: false }, expected: false, reason: 'auto_show_disabled' },
  { name: 'gate order: dragging wins over a disabled domain', input: { ...BASE, isDragging: true, siteDisabled: true }, expected: false, reason: 'dragging' },
  { name: 'gate order: length wins over dragging', input: { ...BASE, text: '短', isDragging: true }, expected: false, reason: 'below_minimum_length' },
];

describe('shouldShowToolbarButton (§10.1 selection gates)', () => {
  for (const testCase of GATE_CASES) {
    it(testCase.name, () => {
      expect(shouldShowToolbarButton(testCase.input)).toBe(testCase.expected);
      expect(toolbarGateReason(testCase.input)).toBe(testCase.reason);
    });
  }

  it('never offers a button for a payload the capture contract would reject', () => {
    expect(effectiveMinimumLength(1)).toBe(MIN_CAPTURE_TEXT_LENGTH);
    expect(effectiveMinimumLength(24)).toBe(24);
    expect(effectiveMinimumLength(Number.NaN)).toBe(MIN_CAPTURE_TEXT_LENGTH);
  });

  it('autoShow defaults to on when the caller omits it', () => {
    const { autoShowEnabled: _omitted, ...rest } = BASE;
    expect(shouldShowToolbarButton(rest)).toBe(true);
  });
});

const DESKTOP: ViewportSize = { width: 1440, height: 900 };

describe('computePillPosition (§10.2 positioning)', () => {
  it('sits above the selection when there is room', () => {
    const position = computePillPosition({ top: 300, left: 400, width: 120, height: 20 }, PILL_SIZE, DESKTOP);
    expect(position.placement).toBe('above');
    expect(position.top).toBeLessThan(300);
  });

  it('flips below when the selection is at the top of the viewport', () => {
    const position = computePillPosition({ top: 4, left: 400, width: 120, height: 20 }, PILL_SIZE, DESKTOP);
    expect(position.placement).toBe('below');
    expect(position.top).toBeGreaterThan(24);
  });

  it('stays fully inside a narrow viewport', () => {
    const small: ViewportSize = { width: 200, height: 120 };
    const pill: PillSize = { width: 118, height: 34 };
    const position = computePillPosition({ top: 2, left: 150, width: 60, height: 110 }, pill, small);
    expect(position.top).toBeGreaterThanOrEqual(0);
    expect(position.left).toBeGreaterThanOrEqual(0);
    expect(position.left + pill.width).toBeLessThanOrEqual(small.width);
    expect(position.top + pill.height).toBeLessThanOrEqual(small.height);
  });

  it('clamps horizontally for a selection touching the right edge', () => {
    const position = computePillPosition({ top: 300, left: 1420, width: 20, height: 20 }, PILL_SIZE, DESKTOP);
    expect(position.left + PILL_SIZE.width).toBeLessThanOrEqual(DESKTOP.width);
  });

  it('treats a collapsed or off-screen rect as not visible', () => {
    expect(isRectVisible({ top: 100, left: 100, width: 0, height: 0 }, DESKTOP)).toBe(false);
    expect(isRectVisible({ top: 5_000, left: 100, width: 100, height: 20 }, DESKTOP)).toBe(false);
    expect(isRectVisible({ top: 300, left: 100, width: 100, height: 20 }, DESKTOP)).toBe(true);
  });
});
