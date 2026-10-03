import type { ToastContent } from './toast-content';

export interface ResultToastProps {
  readonly content: ToastContent;
  readonly onDismiss: () => void;
}

export function ResultToast({ content, onDismiss }: ResultToastProps) {
  const toneClass = content.tone === 'warning' ? ' toastWarning' : content.tone === 'error' ? ' toastError' : '';
  return (
    <div className={`root toast${toneClass}`} role="status" aria-live="polite" onClick={onDismiss}>
      <div className="toastHead">{content.headline}</div>
      {content.lines.map((line, index) => (
        <div key={`${index}:${line}`} className="toastLine">
          {line}
        </div>
      ))}
    </div>
  );
}
