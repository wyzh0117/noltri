import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { commands } from '../lib/tauri';
import type { DesktopSettings, ModelProfile, ModelSettings as ModelSettingsValue } from '../lib/tauri';
import { describeError } from './api';

export function newModelProfile(): ModelProfile {
  return { id: crypto.randomUUID(), name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash' };
}

export default function ModelSettings({ settings, outsideTauri, onSaved, onDone, welcome = false }: {
  settings: DesktopSettings;
  outsideTauri: boolean;
  onSaved: (models: ModelSettingsValue, runtimeStatus: DesktopSettings['runtimeStatus']) => void;
  onDone?: () => void;
  welcome?: boolean;
}): ReactElement {
  const prefix = useId();
  const [profiles, setProfiles] = useState<ModelProfile[]>(() => settings.modelProfiles.length > 0 ? settings.modelProfiles.map((profile) => ({ ...profile })) : [newModelProfile()]);
  const [activeId, setActiveId] = useState(settings.activeModelId ?? profiles[0]?.id ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((entry) => entry.id === activeId) ?? profiles[0];

  function updateProfile(changes: Partial<ModelProfile>): void {
    setProfiles((current) => current.map((entry) => entry.id === profile?.id ? { ...entry, ...changes } : entry));
    setMessage(null);
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const models = { modelProfiles: profiles, activeModelId: profile?.id ?? null };
      const result = await commands.saveModelSettings(models);
      onSaved(models, result.runtimeStatus);
      setMessage(result.message);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }

  return (
    <section className={welcome ? 'model-settings model-settings-welcome' : 'model-settings'} aria-labelledby={`${prefix}-title`}>
      {welcome ? <div className="model-welcome-brand"><span className="brand-mark" aria-hidden="true">知</span><span>知序 · Noltri</span></div> : null}
      <div className="eyebrow">模型服务</div>
      <h1 id={`${prefix}-title`}>{welcome ? '先连接你的 AI 模型' : '模型设置'}</h1>
      <p className="dialog-intro">选择用于自动判断学科与研究方向的模型。收集后，分类与整理内容都可以继续修改。</p>
      {profile ? <form className="capture-form" onSubmit={(event) => void save(event)}>
        <fieldset className="model-fields" disabled={saving}>
          <div className="model-selector-row">
            <div className="form-field"><label htmlFor={`${prefix}-active`}>当前模型</label><select id={`${prefix}-active`} value={profile.id} onChange={(event) => { setActiveId(event.target.value); setShowKey(false); setMessage(null); setError(null); }}>{profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.model}</option>)}</select></div>
            <button type="button" className="button-soft" disabled={profiles.length >= 40} onClick={() => { const next = newModelProfile(); next.name = `新模型 ${profiles.length + 1}`; setProfiles((current) => [...current, next]); setActiveId(next.id); setMessage(null); }}>＋ 添加模型</button>
          </div>
          <div className="model-provider-card">
            <div className="form-two-column">
              <div className="form-field"><label htmlFor={`${prefix}-provider`}>服务商</label><select id={`${prefix}-provider`} value={profile.provider} onChange={(event) => { const provider = event.target.value as ModelProfile['provider']; updateProfile({ provider, ...(provider === 'deepseek' ? { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } : {}) }); }}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI 兼容服务</option></select></div>
              <div className="form-field"><label htmlFor={`${prefix}-name`}>显示名称</label><input id={`${prefix}-name`} value={profile.name} maxLength={100} required onChange={(event) => updateProfile({ name: event.target.value })} /></div>
            </div>
            <div className="form-field"><label htmlFor={`${prefix}-url`}>API 地址 <span>Base URL</span></label><input id={`${prefix}-url`} type="url" value={profile.baseUrl} required maxLength={2000} placeholder="https://api.deepseek.com" onChange={(event) => updateProfile({ baseUrl: event.target.value })} /><p className="field-hint">填写服务商提供的基础地址；OpenAI 兼容服务可包含 /v1。</p></div>
            <div className="form-field"><label htmlFor={`${prefix}-key`}>API Key</label><div className="model-key-row"><input id={`${prefix}-key`} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={profile.apiKey} required maxLength={2000} placeholder="输入你的 API Key" onChange={(event) => updateProfile({ apiKey: event.target.value })} /><button type="button" className="button-soft" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey((current) => !current)}>{showKey ? '隐藏' : '显示'}</button></div></div>
            <div className="form-field"><label htmlFor={`${prefix}-model`}>模型 <span>Model ID</span></label><input id={`${prefix}-model`} list={`${prefix}-models`} value={profile.model} maxLength={200} required placeholder="服务商提供的模型 ID" onChange={(event) => updateProfile({ model: event.target.value })} /><datalist id={`${prefix}-models`}>{(profile.provider === 'deepseek' ? ['deepseek-flash', 'deepseek-v4-pro'] : []).map((model) => <option key={model} value={model} />)}</datalist></div>
            {profiles.length > 1 ? <button type="button" className="text-action model-remove" onClick={() => { const remaining = profiles.filter((entry) => entry.id !== profile.id); setProfiles(remaining); setActiveId(remaining[0]?.id ?? ''); setMessage(null); }}>移除此模型</button> : null}
          </div>
        </fieldset>
        {outsideTauri ? <p className="field-hint">浏览器预览无法保存本机模型；请在知序桌面应用中配置。</p> : <p className="field-hint">{settings.runtimeStatus === 'external' || settings.runtimeStatus === 'dev' ? '当前服务由外部进程管理；保存配置后，需要使用此配置重启 Core 才能生效。' : '模型配置保存在此设备。保存会重启本机服务，启用当前模型。'}</p>}
        {error ? <p className="model-feedback model-feedback-error" role="alert">{error}</p> : null}
        {message ? <p className="model-feedback" role="status">{message}</p> : null}
        <div className="dialog-actions model-settings-actions">
          {onDone ? <button type="button" className="button-soft" disabled={saving} onClick={onDone}>进入知识库 →</button> : null}
          <button type="submit" className="button-primary" disabled={saving || outsideTauri}>{saving ? '正在保存并启用…' : '保存并启用'}</button>
        </div>
      </form> : null}
    </section>
  );
}
