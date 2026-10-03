import { readSelectionIntent, type SelectionIntent } from '../source/extract';
import { isInsideOwnUi, ownUiHosts } from '../overlay/shadow-host';
import { hostnameFromHref, shouldShowToolbarButton } from './selection-rules';
import { computePillPosition, isRectVisible, PILL_SIZE, type PillPosition, type ViewRect, type ViewportSize } from './geometry';

export interface ObserverRules {
  minimumLength: number;
  autoShow: boolean;
  isDomainDisabled: (hostname: string) => boolean;
}

export interface ObserverHandlers {
  onShow: (position: PillPosition) => void;
  onMove: (position: PillPosition) => void;
  onHide: () => void;
}

export interface SelectionObserver {
  readonly refresh: () => void;
  readonly freeze: () => void;
  readonly unfreeze: () => void;
  readonly currentIntent: () => SelectionIntent | undefined;
  readonly setRules: (rules: ObserverRules) => void;
  readonly dispose: () => void;
}

function toViewRect(rect: DOMRect): ViewRect {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function viewport(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Selection watching for §10.1/§10.2. The rules themselves are the pure `shouldShowToolbarButton`,
 * this file only measures the page and moves the pill, and it never cancels or rewrites page events.
 */
export function createSelectionObserver(handlers: ObserverHandlers, initialRules: ObserverRules): SelectionObserver {
  let rules = initialRules;
  let visible = false;
  let frozen = false;
  let pointerDown = false;
  let nativeDragging = false;
  let lastIntent: SelectionIntent | undefined;
  let frame = 0;

  function evaluate(): void {
    if (frozen) return;
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    const rect = selection && selection.rangeCount > 0 ? toViewRect(selection.getRangeAt(0).getBoundingClientRect()) : null;
    const allowed = shouldShowToolbarButton({
      text,
      isDragging: pointerDown || nativeDragging,
      isInsideOwnUi: isInsideOwnUi(selection?.anchorNode ?? null, ownUiHosts()),
      siteDisabled: rules.isDomainDisabled(hostnameFromHref(location.href)),
      minimumLength: rules.minimumLength,
      autoShowEnabled: rules.autoShow,
    });

    if (!allowed || !rect || !isRectVisible(rect, viewport())) {
      hide();
      return;
    }

    // Snapshot the intent while the selection is alive: by the time the pill is clicked the user may
    // have clicked away, and a late read would capture the wrong text.
    const intent = readSelectionIntent();
    if (!intent) {
      hide();
      return;
    }
    lastIntent = intent;
    const position = computePillPosition(rect, PILL_SIZE, viewport());
    if (visible) handlers.onMove(position);
    else {
      visible = true;
      handlers.onShow(position);
    }
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    handlers.onHide();
  }

  function schedule(): void {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      evaluate();
    });
  }

  const onPointerDown = (event: MouseEvent) => {
    pointerDown = true;
    if (visible && !isInsideOwnUi(event.target, ownUiHosts())) hide();
  };
  const onPointerUp = () => {
    pointerDown = false;
    schedule();
  };
  const onDragStart = () => {
    nativeDragging = true;
    hide();
  };
  const onDragEnd = () => {
    nativeDragging = false;
    schedule();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Observation only: the page keeps its own key handling, nothing is prevented or retargeted.
    if (event.key === 'Escape') hide();
  };
  const onSelectionChange = schedule;

  window.addEventListener('mousedown', onPointerDown, true);
  window.addEventListener('mouseup', onPointerUp, true);
  window.addEventListener('dragstart', onDragStart, true);
  window.addEventListener('dragend', onDragEnd, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('selectionchange', onSelectionChange);

  return {
    refresh: evaluate,
    freeze(): void {
      frozen = true;
    },
    unfreeze(): void {
      frozen = false;
    },
    currentIntent: () => lastIntent,
    setRules: (next: ObserverRules) => {
      rules = next;
      schedule();
    },
    dispose(): void {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('mouseup', onPointerUp, true);
      window.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      document.removeEventListener('selectionchange', onSelectionChange);
      lastIntent = undefined;
      visible = false;
    },
  };
}
