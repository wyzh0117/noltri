import { describe, expect, it } from 'vitest';
import { effectiveMinimumLength, selectionGateReason, shouldOfferCapture } from '../src/lib/gating';

const BASE = { minimumLength: 12, isDuplicate: false, appDisabled: false };

describe('desktop selection gating', () => {
  it('never drops below the frozen capture contract minimum', () => {
    expect(effectiveMinimumLength(2)).toBe(8);
    expect(effectiveMinimumLength(12)).toBe(12);
    expect(effectiveMinimumLength(Number.NaN)).toBe(8);
  });

  it('reports the exact reason vocabulary the Rust probe documents', () => {
    expect(selectionGateReason({ ...BASE, text: '' })).toBe('empty');
    expect(selectionGateReason({ ...BASE, text: '   ' })).toBe('whitespace_only');
    expect(selectionGateReason({ ...BASE, text: '太短' })).toBe('below_minimum_length');
    expect(
      selectionGateReason({ ...BASE, text: '重复的选择内容示例一二三', isDuplicate: true }),
    ).toBe('duplicate_selection');
    expect(selectionGateReason({ ...BASE, text: '这是一段正常长度的选区内容', appDisabled: true })).toBe('app_disabled');
    expect(selectionGateReason({ ...BASE, text: '这是一段正常长度的选区内容' })).toBe('show');
  });

  it('only "show" offers the pill', () => {
    expect(shouldOfferCapture({ ...BASE, text: '这是一段正常长度的选区内容' })).toBe(true);
    expect(shouldOfferCapture({ ...BASE, text: '' })).toBe(false);
    expect(shouldOfferCapture({ ...BASE, text: '短' })).toBe(false);
  });

  it('app opt-out wins over length so a disabled app never shows the pill', () => {
    const order = selectionGateReason({ ...BASE, text: '', appDisabled: true });
    expect(order).toBe('empty');
    const shortDisabled = selectionGateReason({ ...BASE, text: '短', appDisabled: true });
    expect(shortDisabled).toBe('app_disabled');
  });
});
