/**
 * Styles live as a string because they are injected into a closed shadow root: the page cannot reach
 * them and they cannot leak into the page, which is what keeps the pill visually identical everywhere.
 */
export const OVERLAY_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
.root {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #f5f7fa;
  pointer-events: none;
}
.pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: #16202b;
  color: #f5f7fa;
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(8, 15, 22, 0.28);
  transition: background 120ms ease, transform 120ms ease;
}
.pill:hover { background: #24303d; }
.pill:active { transform: translateY(1px); }
.pill[disabled] { cursor: progress; opacity: 0.72; }
.pillDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5fd0a4;
}
.toast {
  pointer-events: auto;
  max-width: 320px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  background: rgba(22, 32, 43, 0.96);
  box-shadow: 0 10px 26px rgba(8, 15, 22, 0.32);
}
.toastHead { font-weight: 700; margin-bottom: 6px; }
.toastWarning .toastHead { color: #ffd48a; }
.toastError .toastHead { color: #ff9d9d; }
.toastLine {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
  color: #cfd8e3;
}
`;
