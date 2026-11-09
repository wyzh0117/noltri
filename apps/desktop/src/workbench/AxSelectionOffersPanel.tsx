import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { commands } from '../lib/tauri';
import type { AxSelectionOfferStatus } from '../lib/tauri';

const DEFAULT_STATUS: AxSelectionOfferStatus = { enabled: false, permission: 'not_checked' };

export function AxSelectionOffersPanel({ outsideTauri }: { outsideTauri: boolean }): ReactElement {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (outsideTauri) return;
    let active = true;
    void commands.getAxSelectionOfferStatus().then((next) => {
      if (active) setStatus(next);
    }).catch(() => {
      if (active) setMessage('无法读取选区浮层设置，请重试。');
    });
    return () => { active = false; };
  }, [outsideTauri]);

  async function setEnabled(enabled: boolean): Promise<void> {
    if (outsideTauri || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await commands.setAxSelectionOffersEnabled(enabled);
      setStatus(next);
      setMessage(next.permission === 'denied'
        ? '未获得辅助功能权限。请在“系统设置 > 隐私与安全性 > 辅助功能”允许知序后，再重新开启。'
        : enabled ? '选区浮层已启用。' : '选区浮层已关闭。');
    } catch {
      setMessage('无法保存选区浮层设置，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const unsupported = status.permission === 'unsupported' || status.permission === 'unavailable';
  return <section className="ax-selection-preference" aria-label="选区浮层设置">
    <h3>选中文字浮层</h3>
    <p>默认关闭。启用后，仅观察当前前台的 TextEdit 和备忘录；选区稳定时显示不抢焦点的收集按钮。只有点击“收集”才会把选中文字交给知序。浏览器不由此浮层监测。</p>
    <label className="ax-selection-toggle">
      <input
        type="checkbox"
        aria-label="启用选区浮层"
        checked={status.enabled}
        disabled={outsideTauri || busy || unsupported}
        onChange={(event) => void setEnabled(event.currentTarget.checked)}
      />
      启用选区浮层
    </label>
    {status.permission === 'denied' ? <p className="ax-selection-permission">辅助功能权限当前不可用；不会读取选区，也不会弹出系统授权提示。{status.enabled ? '启用偏好仍已保存，但选区读取受权限阻止；授权后请先关闭再重新开启此开关，以确保观察器恢复。' : ''}</p> : null}
    {outsideTauri ? <p className="field-hint">浏览器预览无法设置本机选区浮层，请在知序桌面应用中操作。</p> : null}
    {message ? <p role={status.permission === 'denied' ? 'alert' : 'status'}>{message}</p> : null}
  </section>;
}
