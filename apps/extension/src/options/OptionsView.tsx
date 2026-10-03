import { useEffect, useState } from 'react';
import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import { probeConnection, type ConnectionState } from '../api/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  originPermissionPattern,
  parseDomainList,
  saveSettings,
  syncArea,
  validateApiBaseUrl,
  type ExtensionSettings,
} from '../settings/storage';

interface Feedback {
  readonly tone: 'ok' | 'bad';
  readonly message: string;
}

/** `chrome.permissions.request` needs a user gesture, so this only runs from a click handler. */
export async function requestOriginPermission(baseUrl: string): Promise<boolean> {
  const pattern = originPermissionPattern(baseUrl);
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

export function OptionsView() {
  const [stored, setStored] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_SETTINGS.apiBaseUrl);
  const [tokenInput, setTokenInput] = useState('');
  const [minimumSelectionLength, setMinimumSelectionLength] = useState(MIN_CAPTURE_TEXT_LENGTH);
  const [autoShowButton, setAutoShowButton] = useState(true);
  const [disabledDomainsText, setDisabledDomainsText] = useState('');
  const [feedback, setFeedback] = useState<Feedback>();
  const [connection, setConnection] = useState<ConnectionState>();

  useEffect(() => {
    let active = true;
    void loadSettings(syncArea()).then((settings) => {
      if (!active) return;
      setStored(settings);
      setApiBaseUrl(settings.apiBaseUrl);
      setMinimumSelectionLength(settings.minimumSelectionLength);
      setAutoShowButton(settings.autoShowButton);
      setDisabledDomainsText(settings.disabledDomains.join('\n'));
    });
    return () => {
      active = false;
    };
  }, []);

  const draft: ExtensionSettings = {
    apiBaseUrl: validateApiBaseUrl(apiBaseUrl).url,
    // An empty field means "keep what is stored": the saved token is never written back into the DOM.
    accessToken: tokenInput.length > 0 ? tokenInput : stored.accessToken,
    minimumSelectionLength,
    autoShowButton,
    disabledDomains: parseDomainList(disabledDomainsText),
  };

  async function save(): Promise<void> {
    const validation = validateApiBaseUrl(apiBaseUrl);
    if (!validation.ok) {
      setFeedback({ tone: 'bad', message: validation.message });
      return;
    }
    try {
      await saveSettings(draft, syncArea());
      const granted = await requestOriginPermission(validation.url);
      setFeedback({
        tone: 'ok',
        message: granted ? '已保存' : '已保存，但浏览器未授权访问该 API 地址，采集会显示未连接',
      });
      setStored(draft);
      setTokenInput('');
    } catch (error) {
      setFeedback({ tone: 'bad', message: error instanceof Error ? error.message : '保存失败' });
    }
  }

  async function test(): Promise<void> {
    setConnection(await probeConnection(draft));
  }

  return (
    <main className="page wide">
      <h1>知序 Noltri 设置</h1>

      <section className="card">
        <label className="label" htmlFor="apiBaseUrl">
          Knowledge Core API 地址
        </label>
        <input
          id="apiBaseUrl"
          className="input"
          type="url"
          value={apiBaseUrl}
          placeholder="http://localhost:8787"
          onChange={(event) => setApiBaseUrl(event.target.value)}
        />
        <p className="hint">仅支持 http / https，例如 http://127.0.0.1:8787</p>
      </section>

      <section className="card">
        <label className="label" htmlFor="accessToken">
          访问令牌
        </label>
        <input
          id="accessToken"
          className="input"
          type="password"
          autoComplete="off"
          value={tokenInput}
          placeholder={stored.accessToken.length > 0 ? `已保存（${stored.accessToken.length} 位），留空表示不修改` : '尚未设置'}
          onChange={(event) => setTokenInput(event.target.value)}
        />
        <p className="hint">令牌只写入 chrome.storage.sync，绝不写入 local，也不回显在页面上。</p>
      </section>

      <section className="card">
        <label className="label" htmlFor="minimumSelectionLength">
          最短选区长度
        </label>
        <input
          id="minimumSelectionLength"
          className="input"
          type="number"
          min={MIN_CAPTURE_TEXT_LENGTH}
          max={500}
          value={minimumSelectionLength}
          onChange={(event) =>
            setMinimumSelectionLength(Math.max(MIN_CAPTURE_TEXT_LENGTH, Number(event.target.value) || MIN_CAPTURE_TEXT_LENGTH))
          }
        />
        <p className="hint">不低于 {MIN_CAPTURE_TEXT_LENGTH} 字，这是采集契约的下限。</p>

        <label className="label checkbox">
          <input type="checkbox" checked={autoShowButton} onChange={(event) => setAutoShowButton(event.target.checked)} />
          选中文字后自动显示“归纳知识点”
        </label>

        <label className="label" htmlFor="disabledDomains">
          禁用域名（每行一个）
        </label>
        <textarea
          id="disabledDomains"
          className="textarea"
          rows={4}
          value={disabledDomainsText}
          placeholder={'example.com\ninternal.company.cn'}
          onChange={(event) => setDisabledDomainsText(event.target.value)}
        />
      </section>

      <div className="row">
        <button className="primary" type="button" onClick={() => void save()}>
          保存
        </button>
        <button className="secondary" type="button" onClick={() => void test()}>
          测试连接
        </button>
      </div>

      {feedback === undefined ? null : <p className={feedback.tone === 'ok' ? 'feedbackOk' : 'feedbackBad'}>{feedback.message}</p>}
      {connection === undefined ? null : (
        <p className={connection.connected ? 'feedbackOk' : 'feedbackBad'}>
          {connection.connected ? '已连接' : '未连接'}：{connection.detail}
        </p>
      )}
    </main>
  );
}
