import { useEffect, useState } from 'react';
import { MIN_CAPTURE_TEXT_LENGTH, type CaptureRequest } from '@noltri/schema';
import { buildExtensionCaptureRequest } from '../capture/build-request';
import { captureIntent, probeConnection, type CaptureOutcome, type ConnectionState } from '../api/client';
import { buildSource } from '../source/extract';
import { toastContentFromOutcome } from '../overlay/toast-content';
import { ensureDeviceId } from '../background/device-id';
import { DEFAULT_SETTINGS, loadSettings, localArea, syncArea, type ExtensionSettings } from '../settings/storage';
import { createOutbox, disabledOutbox, type Outbox } from '../outbox/outbox';
import { queueCapture, shouldQueue } from '../outbox/drain';
import { describeRestrictedPage, restrictionOf } from '../capture/restricted';
import {
  MESSAGE_CLEAR_OUTBOX,
  MESSAGE_FLUSH_OUTBOX,
  MESSAGE_OUTBOX_COUNT,
  type OutboxCountReply,
  type OutboxFlushReply,
} from '../messaging';

export interface ManualCaptureInput {
  readonly text: string;
  readonly settings: ExtensionSettings;
  readonly deviceId?: string;
}

export interface ManualCaptureResult {
  readonly request: CaptureRequest;
  readonly outcome: CaptureOutcome;
}

/**
 * The popup paste box is the capture fallback: whatever the source, the same builder and the same
 * `/api/capture` call are used, so nothing about the pipeline changes. The request comes back with the
 * outcome because a capture that failed has to be queued under the very key the Core already knows.
 */
export async function captureManualText(input: ManualCaptureInput): Promise<ManualCaptureResult> {
  const intent = { text: input.text, source: buildSource({ href: '', title: '', type: 'manual' }) };
  const request = buildExtensionCaptureRequest(intent, input.deviceId ? { deviceId: input.deviceId } : {});
  return { request, outcome: await captureIntent(input.settings, request) };
}

/** Same storage the service worker uses; a concurrent drain is harmless because the Core dedupes by key. */
function popupOutbox(): Outbox {
  return chrome.extension?.inIncognitoContext === true ? disabledOutbox() : createOutbox(localArea());
}

async function ask<T>(message: { type: string }): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return undefined;
  }
}

export function PopupView() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [connection, setConnection] = useState<ConnectionState>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome>();
  const [queue, setQueue] = useState<OutboxCountReply>({ count: 0, enabled: true });
  const [pageNotice, setPageNotice] = useState<string>();
  const [flushNotice, setFlushNotice] = useState<string>();

  const refreshQueue = (): void => {
    void ask<OutboxCountReply>({ type: MESSAGE_OUTBOX_COUNT }).then((reply) => {
      if (reply) setQueue(reply);
    });
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded = await loadSettings(syncArea());
      if (!active) return;
      setSettings(loaded);
      setConnection(await probeConnection(loaded));
      const reply = await ask<OutboxCountReply>({ type: MESSAGE_OUTBOX_COUNT });
      if (active && reply) setQueue(reply);
      // The pill will not appear here, so the popup has to say why and point at the box below it.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const restricted = restrictionOf(tabs[0]?.url ?? '');
      if (active && restricted) setPageNotice(describeRestrictedPage(restricted));
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
    const { request, outcome: sent } = await captureManualText({ text, settings, deviceId });
    const outbox = popupOutbox();
    if (!sent.ok && shouldQueue(sent, outbox.enabled)) {
      const report = await queueCapture(outbox, { id: request.requestId, request, queuedAt: new Date().toISOString(), tries: 0, lastError: sent.message });
      setOutcome({ ...sent, message: report.message, queued: report.queued });
    } else {
      setOutcome(sent);
    }
    refreshQueue();
    setBusy(false);
  }

  async function flush(): Promise<void> {
    setBusy(true);
    const report = await ask<OutboxFlushReply>({ type: MESSAGE_FLUSH_OUTBOX });
    if (report) {
      setFlushNotice(
        report.stoppedEarly
          ? `已发送 ${report.sent} 条，Noltri 仍未连接，剩余 ${report.kept} 条继续排队`
          : `已发送 ${report.sent} 条${report.alreadyStored > 0 ? `，${report.alreadyStored} 条 Noltri 里已有` : ''}${report.kept > 0 ? `，${report.kept} 条未能发送` : ''}`,
      );
    }
    refreshQueue();
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

      {pageNotice === undefined ? null : (
        <section className="card cardWarn">
          <p className="toastHead">这一页不能直接划词</p>
          <p className="detail">{pageNotice}</p>
        </section>
      )}

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
            {busy ? '处理中…' : '归纳知识点'}
          </button>
          <span className="hint">
            {trimmedLength} 字，至少 {MIN_CAPTURE_TEXT_LENGTH} 字
          </span>
        </div>
      </section>

      <section className="card">
        <p className="detail">
          待发送队列：{queue.count} 条{queue.enabled ? '' : '（无痕窗口不排队）'}
        </p>
        <div className="row">
          <button type="button" disabled={busy || queue.count === 0} onClick={() => void flush()}>
            立即发送
          </button>
          <button
            type="button"
            disabled={busy || queue.count === 0}
            onClick={() => {
              void ask({ type: MESSAGE_CLEAR_OUTBOX }).then(refreshQueue);
            }}
          >
            清空队列
          </button>
        </div>
        {flushNotice === undefined ? null : <p className="hint">{flushNotice}</p>}
        <p className="hint">队列只存在本机，超过 7 天自动清除。</p>
      </section>

      {toast === undefined ? null : (
        <section className={`card ${toast.tone === 'error' ? 'cardBad' : toast.tone === 'warning' ? 'cardWarn' : 'cardOk'}`}>
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
