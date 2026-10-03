/**
 * Paste fallback (V1 §11.4 level two): the user already copied or will paste the material here.
 * Independent of Accessibility entirely — this path always works.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import type { ReactElement } from 'react';
import { commands } from './lib/tauri';
import { runCaptureFlow, type CaptureFlowOutcome } from './lib/capture-flow';
import { MIN_CAPTURE_TEXT_LENGTH, MAX_CAPTURE_TEXT_LENGTH } from '@noltri/schema';

function PasteWindow(): ReactElement {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<CaptureFlowOutcome | null>(null);

  const tooShort = text.trim().length > 0 && text.trim().length < MIN_CAPTURE_TEXT_LENGTH;

  async function submit(): Promise<void> {
    if (text.trim().length === 0 || sending) return;
    setSending(true);
    setOutcome(null);
    let appName = '本机粘贴';
    let apiBaseUrl = 'http://localhost:8787';
    let apiToken = '';
    try {
      // paste_selection registers the sample natively (id, preview, recent list) before we send it.
      const sample = (await commands.pasteSelection({ text, appName })) as { app_name?: string };
      if (typeof sample?.app_name === 'string' && sample.app_name.length > 0) appName = sample.app_name;
    } catch {
      // Registration is not required for capture; continue with the raw text.
    }
    try {
      const settings = await commands.getSettings();
      apiBaseUrl = settings.apiBaseUrl;
      apiToken = settings.apiToken;
    } catch {
      // Defaults hold when settings cannot be read.
    }
    const result = await runCaptureFlow(
      { apiBaseUrl, apiToken },
      { text, appName, via: 'paste' },
    );
    setOutcome(result);
    setSending(false);
  }

  return (
    <main className="paste">
      <h1>粘贴收纳</h1>
      <p className="paste-hint">把内容粘贴到下面（{String(MIN_CAPTURE_TEXT_LENGTH)}–{String(MAX_CAPTURE_TEXT_LENGTH)} 字符），原文会先被完整保存。</p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="粘贴想要收纳的内容…"
        rows={10}
      />
      <div className="paste-actions">
        <button type="button" disabled={text.trim().length === 0 || tooShort || sending} onClick={() => void submit()}>
          {sending ? '归纳中…' : '归纳知识点'}
        </button>
        <button type="button" className="secondary" onClick={() => void commands.hideWindow('paste')}>
          关闭
        </button>
      </div>
      {tooShort && <p className="paste-error">内容太短，至少 {String(MIN_CAPTURE_TEXT_LENGTH)} 个字符。</p>}
      {outcome !== null && <p className={outcome.ok ? 'paste-ok' : 'paste-error'}>{outcome.message}</p>}
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<PasteWindow />);
