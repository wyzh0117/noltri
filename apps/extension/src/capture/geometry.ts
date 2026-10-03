/** Viewport-relative box, as returned by `Range.getBoundingClientRect()`. */
export interface ViewRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface PillSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface PillPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: 'above' | 'below' | 'inside';
}

export const PILL_GAP = 8;
export const VIEWPORT_EDGE = 8;

/** Measured size of the pill in the overlay stylesheet; only used to keep it inside the viewport. */
export const PILL_SIZE: PillSize = { width: 118, height: 34 };

/**
 * Keeps the pill next to the selection and fully inside the viewport, and never on top of the
 * selected text when there is room (§10.2 "不遮挡主要内容"). Pure so the geometry is testable.
 */
export function computePillPosition(
  selection: ViewRect,
  pill: PillSize,
  viewport: ViewportSize,
  gap: number = PILL_GAP,
  edge: number = VIEWPORT_EDGE,
): PillPosition {
  const above = selection.top - gap - pill.height;
  const below = selection.top + selection.height + gap;
  let top: number;
  let placement: PillPosition['placement'];
  if (above >= edge) {
    top = above;
    placement = 'above';
  } else if (below + pill.height <= viewport.height - edge) {
    top = below;
    placement = 'below';
  } else {
    top = Math.max(edge, selection.top + gap);
    placement = 'inside';
  }
  const maxTop = Math.max(edge, viewport.height - pill.height - edge);
  const anchoredLeft = selection.left + selection.width / 2 - pill.width / 2;
  return {
    top: Math.min(top, maxTop),
    left: clamp(anchoredLeft, edge, Math.max(edge, viewport.width - pill.width - edge)),
    placement,
  };
}

/** True when any part of the selection box is on screen, so we never anchor to an invisible rect. */
export function isRectVisible(rect: ViewRect, viewport: ViewportSize): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const withinVertical = rect.top < viewport.height - VIEWPORT_EDGE && rect.top + rect.height > VIEWPORT_EDGE;
  const withinHorizontal = rect.left < viewport.width - VIEWPORT_EDGE && rect.left + rect.width > 0;
  return withinVertical && withinHorizontal;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
