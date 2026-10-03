export interface CapturePillProps {
  readonly busy: boolean;
  readonly onCapture: () => void;
}

/**
 * V1 §10.2: the pill is a label on the selection, not a dialog. Nothing here is focused automatically
 * and no page key event is intercepted, so the page keeps its own keyboard behaviour.
 */
export function CapturePill({ busy, onCapture }: CapturePillProps) {
  return (
    <div className="root">
      <button
        type="button"
        className="pill"
        aria-label="归纳知识点"
        disabled={busy}
        onMouseDown={(event) => {
          // Keeps the user's text selection alive and stops the browser from pulling focus out of the page.
          event.preventDefault();
        }}
        onClick={() => {
          if (!busy) onCapture();
        }}
      >
        <span className="pillDot" aria-hidden="true" />
        {busy ? '归纳中…' : '归纳知识点'}
      </button>
    </div>
  );
}
