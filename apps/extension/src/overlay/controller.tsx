import { createRoot, type Root } from 'react-dom/client';
import { OVERLAY_CSS } from './overlay-styles';
import { ensureShadowHost, removeShadowHost, type ShadowHostHandle } from './shadow-host';
import { CapturePill } from './Pill';
import { ResultToast } from './Toast';
import { TOAST_AUTO_HIDE_MS, toastContentFromOutcome, type ToastContent } from './toast-content';
import type { PillPosition } from '../capture/geometry';
import type { CaptureOutcome } from '../api/client';

export const PILL_HOST_ID = 'noltri-pill-host';
export const TOAST_HOST_ID = 'noltri-toast-host';
const TOAST_INSET = '16px';

export interface OverlayController {
  readonly showPill: (position: PillPosition) => void;
  readonly movePill: (position: PillPosition) => void;
  readonly hidePill: () => void;
  readonly isPillVisible: () => boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly showResult: (outcome: CaptureOutcome) => void;
  readonly hideToast: () => void;
  readonly isToastVisible: () => boolean;
  readonly dispose: () => void;
}

/**
 * Imperative wrapper around two React roots in closed shadow DOMs. Content scripts need an imperative
 * surface because the trigger is a DOM event, not a render, and every host box is sized to its own
 * widget so the page underneath stays clickable (§10.2 "不遮挡主要内容").
 */
export function createOverlayController(onCapture: () => void): OverlayController {
  let pillHandle: ShadowHostHandle | undefined;
  let pillRoot: Root | undefined;
  let toastHandle: ShadowHostHandle | undefined;
  let toastRoot: Root | undefined;
  let busy = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function mountPill(): ShadowHostHandle {
    if (!pillHandle) {
      pillHandle = ensureShadowHost(PILL_HOST_ID, OVERLAY_CSS);
      pillRoot = createRoot(pillHandle.container);
    }
    return pillHandle;
  }

  function renderPill(): void {
    pillRoot?.render(
      <CapturePill
        busy={busy}
        onCapture={() => {
          if (busy) return;
          setBusy(true);
          onCapture();
        }}
      />,
    );
  }

  function setBusy(next: boolean): void {
    busy = next;
    renderPill();
  }

  function applyPosition(host: HTMLElement, position: PillPosition): void {
    host.style.left = `${Math.round(position.left)}px`;
    host.style.top = `${Math.round(position.top)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function mountToast(content: ToastContent): void {
    if (!toastHandle) {
      toastHandle = ensureShadowHost(TOAST_HOST_ID, OVERLAY_CSS);
      toastRoot = createRoot(toastHandle.container);
      toastHandle.host.style.right = TOAST_INSET;
      toastHandle.host.style.bottom = TOAST_INSET;
      toastHandle.host.style.left = 'auto';
      toastHandle.host.style.top = 'auto';
    }
    toastRoot?.render(<ResultToast content={content} onDismiss={hideToast} />);
    toastHandle.host.style.display = 'block';
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_AUTO_HIDE_MS);
  }

  function hideToast(): void {
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer);
      toastTimer = undefined;
    }
    if (toastHandle) toastHandle.host.style.display = 'none';
  }

  return {
    showPill(position: PillPosition): void {
      const handle = mountPill();
      applyPosition(handle.host, position);
      renderPill();
      handle.host.style.display = 'block';
    },
    movePill(position: PillPosition): void {
      if (!pillHandle) return;
      applyPosition(pillHandle.host, position);
    },
    hidePill(): void {
      if (pillHandle) pillHandle.host.style.display = 'none';
    },
    isPillVisible(): boolean {
      return pillHandle !== undefined && pillHandle.host.style.display !== 'none';
    },
    setBusy,
    showResult(outcome: CaptureOutcome): void {
      setBusy(false);
      mountToast(toastContentFromOutcome(outcome));
    },
    hideToast,
    isToastVisible(): boolean {
      return toastHandle !== undefined && toastHandle.host.style.display !== 'none';
    },
    dispose(): void {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      pillRoot?.unmount();
      toastRoot?.unmount();
      pillRoot = undefined;
      toastRoot = undefined;
      removeShadowHost(PILL_HOST_ID);
      removeShadowHost(TOAST_HOST_ID);
      pillHandle = undefined;
      toastHandle = undefined;
    },
  };
}
