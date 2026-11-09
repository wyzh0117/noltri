import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { commands } from '../lib/tauri';
import type { IntakeShortcutStatus, ShortcutBinding, ShortcutBindings } from '../lib/tauri';
import { AxSelectionOffersPanel } from './AxSelectionOffersPanel';
import { DEFAULT_SHORTCUT_BINDINGS, formatShortcutBinding, shortcutErrorMessage, shortcutValidation, validShortcutBindings } from './shortcut-bindings';
import './global-shortcuts.css';

const actions = [{ key: 'screenshot', label: '截图' }, { key: 'openIntake', label: '打开收集' }] as const;
const modifiers: Array<{ key: Exclude<keyof ShortcutBinding, 'key'>; label: string }> = [
  { key: 'control', label: 'Control' }, { key: 'alt', label: 'Option' }, { key: 'shift', label: 'Shift' }, { key: 'meta', label: 'Command' },
];
const registrationText = { registered: '已启用', conflict: '冲突', unavailable: '不可用' };
function equalBindings(left: ShortcutBindings, right: ShortcutBindings): boolean {
  return actions.every(action => formatShortcutBinding(left[action.key]) === formatShortcutBinding(right[action.key]));
}

export function GlobalShortcutsPanel({ outsideTauri, onUpdateSafetyChange }: {
  outsideTauri: boolean;
  onUpdateSafetyChange: (safe: boolean) => void;
}): ReactElement {
  const [status, setStatus] = useState<IntakeShortcutStatus | null>(null);
  const [draft, setDraft] = useState<ShortcutBindings>(DEFAULT_SHORTCUT_BINDINGS);
  const [baseline, setBaseline] = useState<ShortcutBindings>(DEFAULT_SHORTCUT_BINDINGS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);
  const validation = shortcutValidation(draft);
  const dirty = !equalBindings(draft, baseline);
  useLayoutEffect(() => { onUpdateSafetyChange(!busy && !dirty && !unconfirmed); }, [busy, dirty, unconfirmed, onUpdateSafetyChange]);

  async function load(): Promise<void> {
    if (outsideTauri || lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const next = await commands.getIntakeShortcutStatus();
      if (!mounted.current) return;
      const actual = validShortcutBindings(next.bindings) ? next.bindings : DEFAULT_SHORTCUT_BINDINGS;
      setStatus(next); setBaseline(actual);
      // A refresh confirms current registration without replacing an unsaved selection.
      if (!dirty) setDraft(actual);
      setLoaded(true); setUnconfirmed(false);
      setError(next.configurationError ? shortcutErrorMessage(next.configurationError) : '');
    } catch { if (mounted.current) setError('无法读取快捷键，请重新读取快捷键后重试。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    if (!outsideTauri) void load();
    return () => { mounted.current = false; };
  }, [outsideTauri]);

  async function save(bindings: ShortcutBindings): Promise<void> {
    if (outsideTauri || lock.current || !loaded || shortcutValidation(bindings)) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await commands.saveIntakeShortcuts(bindings);
      if (!mounted.current) return;
      if (!validShortcutBindings(next.bindings)) throw Error('invalid_status');
      setStatus(next); setBaseline(next.bindings); setDraft(next.bindings); setUnconfirmed(false);
      setMessage('快捷键已保存。');
      setError(next.configurationError ? shortcutErrorMessage(next.configurationError) : '');
    } catch (failure) {
      if (mounted.current) { setError(shortcutErrorMessage(failure)); setUnconfirmed(true); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function update(action: keyof ShortcutBindings, changes: Partial<ShortcutBinding>): void {
    setDraft(current => ({ ...current, [action]: { ...current[action], ...changes } }));
    setMessage('');
  }
  const actual = status?.bindings ?? (status?.configurationError ? null : loaded ? DEFAULT_SHORTCUT_BINDINGS : null);
  return <section className="global-shortcuts" aria-label="全局快捷键">
    <h2>全局快捷键</h2><p>选择 A–Z 字母及至少两个修饰键，保存后生效。</p>
    {outsideTauri ? <p>浏览器预览无法配置全局快捷键，请在桌面应用中操作。</p> : null}
    <div className="shortcut-current" aria-label="当前快捷键">
      <span>当前截图：{actual ? formatShortcutBinding(actual.screenshot) : '未确认'} · {status ? registrationText[status.screenshot] : '状态检查中'}</span>
      <span>当前打开收集：{actual ? formatShortcutBinding(actual.openIntake) : '未确认'} · {status ? registrationText[status.openIntake] : '状态检查中'}</span>
    </div>
    <div className="shortcut-selectors">{actions.map(action => <fieldset key={action.key} disabled={outsideTauri || busy || !loaded}>
      <legend>{action.label}</legend><label>字母 <select aria-label={`${action.label}字母`} value={draft[action.key].key} onChange={event => update(action.key, { key: event.target.value })}>
        {Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', key => <option key={key} value={key}>{key}</option>)}
      </select></label>
      <div className="shortcut-modifiers">{modifiers.map(modifier => <label key={modifier.key}><input type="checkbox" aria-label={`${action.label} ${modifier.label}`} checked={draft[action.key][modifier.key]} onChange={event => update(action.key, { [modifier.key]: event.target.checked })}/>{modifier.label}</label>)}</div>
    </fieldset>)}</div>
    {validation ? <p role="alert">{validation}</p> : null}
    {error ? <p className="model-feedback model-feedback-error" role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {dirty ? <p>有未保存的快捷键更改。</p> : null}
    <div className="shortcut-actions">
      <button type="button" className="button-primary" disabled={outsideTauri || busy || !loaded || !!validation || !dirty} onClick={() => void save(draft)}>保存快捷键</button>
      <button type="button" className="button-soft" disabled={outsideTauri || busy || !dirty} onClick={() => { setDraft(baseline); setMessage('已取消快捷键更改。'); }}>取消快捷键更改</button>
      <button type="button" className="button-soft" disabled={outsideTauri || busy || !loaded || dirty} onClick={() => void save(baseline)}>重新注册当前快捷键</button>
      <button type="button" className="text-action" disabled={outsideTauri || busy} onClick={() => void load()}>重新读取快捷键</button>
    </div>
    <AxSelectionOffersPanel outsideTauri={outsideTauri} />
  </section>;
}
