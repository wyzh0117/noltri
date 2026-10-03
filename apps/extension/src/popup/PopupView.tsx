import { useEffect, useState } from 'react';
import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import { buildExtensionCaptureRequest } from '../capture/build-request';
import { captureIntent, probeConnection, type CaptureOutcome, type ConnectionState } from '../api/client';
import { buildSource } from '../source/extract';
import { toastContentFromOutcome } from '../overlay/toast-content';
import { ensureDeviceId } from '../background/device-id';
import { DEFAULT_SETTINGS, loadSettings, localArea, syncArea, type ExtensionSettings } from '../settings/storage';

export interface ManualCaptureInput {
  readonly text: string;
  readonly settings: ExtensionSettings;
  readonly deviceId?: string;
}

/**
 * The popup paste box is the capture fallback: whatever the source, the same builder and the same
 * `/api/capture` call are used, so nothing about the pipeline changes.
 */
export async function captureManualText(input: ManualCaptureInput): Promise<CaptureOutcome> {
  const intent = { text: input.text, source: buildSource({ href: '', title: '', type: 'manual' }) };
  return captureIntent(input.settings, buildExtensionCaptureRequest(intent, input.deviceId ? { deviceId: input.deviceId } : {}));
}

export function PopupView() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [connection, setConnection] = useState<ConnectionState>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome>();

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded = await loadSettings(syncArea());
      if (!active) return;
      setSettings(loaded);
      setConnection(await probeConnection(loaded));
    })();
    return () => {
      active = false;
    };
  }, []);

  const trimmedLength = text.trim().length;
  const canSubmit = trimmedLength >= MIN_CAPTURE_TEXT_LENGTH && !busy;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setOutcome(undefined);
    const deviceId = await ensureDeviceId(localArea());
    setOutcome(await captureManualText({ text, settings, deviceId }));
    setBusy(false);
  }

  const toast = outcome === undefined ? undefined : toastContentFromOutcome(outcome);

  return (
    <main className="page">
      <header className="pageHeader">
        <h1>知序 Noltri</h1>
        <span className={connection?.connected ? 'badge badgeOk' : 'badge badgeOff'}>
          {connection === undefined ? '检测中…' : connection.connected ? '已连接' : '未连接'}
        </span>
      </header>
      <p className="detail">{connection?.detail ?? settings.apiBaseUrl}</p>

      <section className="card">
        <label className="label" htmlFor="manual-text">
          粘贴文本收纳
        </label>
        <textarea
          id="manual-text"
          className="textarea"
          rows={6}
          placeholder="复制任意文本贴在这里，归纳进知识树。"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="row">
          <button className="primary" type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? '归纳中…' : '归纳知识点'}
          </button>
          <span className="hint">
            {trimmedLength} 字，至少 {MIN_CAPTURE_TEXT_LENGTH} 字
          </span>
        </div>
      </section>

      {toast === undefined ? null : (
        <section className={`card ${toast.tone === 'error' ? 'cardBad' : 'cardOk'}`}>
          <p className="toastHead">{toast.headline}</p>
          {toast.lines.map((line, index) => (
            <p className="treeLine" key={`${index}:${line}`}>
              {line}
            </p>
          ))}
        </section>
      )}

      <button className="link" type="button" onClick={() => chrome.runtime.openOptionsPage()}>
        打开设置
      </button>
    </main>
  );
}
