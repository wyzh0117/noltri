import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { commands } from '../lib/tauri';
import type { DesktopSettings, FetchAvailableModelsInput, ProviderDraft, ProviderModel, ProviderProtocol, ProviderView } from '../lib/tauri';
import { describeError } from './api';

type PresetId = 'deepseek' | 'openai' | 'anthropic';
type Preset = { id: PresetId; name: string; protocol: ProviderProtocol; baseUrl: string; description: string };
type AddMode = 'third-party' | 'custom-api';
type AddModeDraft = { draft: ProviderDraft; initial: ProviderDraft; presetId: PresetId | null };
type AddModeDrafts = Partial<Record<AddMode, AddModeDraft>>;

const PRESETS: Preset[] = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai-completions', baseUrl: 'https://api.deepseek.com', description: 'OpenAI Chat Completions' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', description: 'OpenAI Responses' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', description: 'Anthropic Messages' },
];

const PROTOCOLS: { id: ProviderProtocol; label: string }[] = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

function emptyModel(): ProviderModel {
  return { id: '', name: '', contextWindow: null, maxTokens: null, input: { text: true, image: false } };
}

function newProvider(preset: Preset | null, providers: ProviderView[]): ProviderDraft {
  const baseId = preset?.id ?? 'custom-provider';
  let id = baseId;
  for (let suffix = 2; providers.some((provider) => provider.id === id); suffix += 1) id = `${baseId}-${suffix}`;
  return {
    id,
    name: preset?.name ?? '自定义服务商',
    protocol: preset?.protocol ?? 'openai-completions',
    baseUrl: preset?.baseUrl ?? '',
    models: [],
    apiKey: '',
  };
}

function asDraft(provider: ProviderView): ProviderDraft {
  return { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, models: provider.models.map((model) => ({ ...model, input: { ...model.input } })), apiKey: '', clearApiKey: false };
}

function asView(draft: ProviderDraft, previous?: ProviderView): ProviderView {
  return {
    id: draft.id,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    hasApiKey: draft.clearApiKey ? false : Boolean(draft.apiKey) || Boolean(previous?.hasApiKey),
    models: draft.models.map((model) => ({ ...model, input: { ...model.input } })),
  };
}

function cloneDraft(draft: ProviderDraft): ProviderDraft {
  return { ...draft, models: draft.models.map((model) => ({ ...model, input: { ...model.input } })) };
}

function isSameDraft(left: ProviderDraft, right: ProviderDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasProviderIdConflict(candidateId: string, existing: Pick<ProviderView, 'id'>[], creating: boolean): boolean {
  return creating && existing.some((provider) => provider.id === candidateId);
}

export function createFetchModelsInput(draft: ProviderDraft, isNew: boolean): FetchAvailableModelsInput {
  return {
    ...(isNew || draft.clearApiKey ? {} : { providerId: draft.id }),
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    ...(!draft.clearApiKey && draft.apiKey ? { apiKey: draft.apiKey } : {}),
  };
}

export default function ModelSettings({ settings, outsideTauri, onSaved, onDone, welcome = false }: {
  settings: DesktopSettings;
  outsideTauri: boolean;
  onSaved: (models: Pick<DesktopSettings, 'providers' | 'activeProviderId' | 'activeModelId'>, runtimeStatus: DesktopSettings['runtimeStatus']) => void;
  onDone?: () => void;
  welcome?: boolean;
}): ReactElement {
  const prefix = useId();
  const [providers, setProviders] = useState<ProviderView[]>(() => settings.providers.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model, input: { ...model.input } })) })));
  const [activeProviderId, setActiveProviderId] = useState(settings.activeProviderId);
  const [activeModelId, setActiveModelId] = useState(settings.activeModelId);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [initialDraft, setInitialDraft] = useState<ProviderDraft | null>(null);
  const [addChoices, setAddChoices] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('third-party');
  const [addModeDrafts, setAddModeDrafts] = useState<AddModeDrafts>({});
  const [isNew, setIsNew] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [candidates, setCandidates] = useState<ProviderModel[] | null>(null);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  const canUseModel = settings.runtimeStatus !== 'external' && settings.runtimeStatus !== 'dev';
  const useModelUnavailableReason = '当前外部或开发服务无法从此处应用模型；请启动随包服务后再选择。';
  const editorIsDirty = Boolean(draft && initialDraft && !isSameDraft(draft, initialDraft));
  const inactiveAddDraftIsDirty = Object.entries(addModeDrafts).some(([mode, saved]) => mode !== addMode && saved && !isSameDraft(saved.draft, saved.initial));
  const visibleCandidates = (candidates ?? []).filter((model) => `${model.id} ${model.name}`.toLocaleLowerCase().includes(candidateQuery.trim().toLocaleLowerCase()));

  function clearFeedback(): void { setMessage(null); setError(null); }

  function closeEditor(force = false): void {
    if (!force && (editorIsDirty || inactiveAddDraftIsDirty) && !window.confirm('放弃尚未保存的更改？')) return;
    setEditorId(null);
    setDraft(null);
    setInitialDraft(null);
    setIsNew(false);
    setShowKey(false);
    setCandidates(null);
    setSelectedCandidates(new Set());
    setAddChoices(false);
    setAddMode('third-party');
    setAddModeDrafts({});
    clearFeedback();
  }

  function finishAdding(): void {
    setEditorId(null);
    setDraft(null);
    setInitialDraft(null);
    setIsNew(false);
    setAddChoices(false);
    setAddMode('third-party');
    setAddModeDrafts({});
    setShowKey(false);
    setCandidates(null);
    setSelectedCandidates(new Set());
  }

  function openNew(preset: Preset | null): void {
    const next = newProvider(preset, providers);
    setEditorId(next.id);
    setDraft(next);
    setInitialDraft(cloneDraft(next));
    setIsNew(true);
    setAddChoices(true);
    setAddMode('third-party');
    setAddModeDrafts((current) => ({ ...current, 'third-party': { draft: cloneDraft(next), initial: cloneDraft(next), presetId: preset?.id ?? null } }));
    setShowKey(false);
    setCandidates(null);
    setDeleteId(null);
    clearFeedback();
  }

  function openExisting(provider: ProviderView): void {
    if (editorIsDirty && !window.confirm('放弃当前 Provider 尚未保存的更改并切换吗？')) return;
    const next = asDraft(provider);
    setEditorId(provider.id);
    setDraft(next);
    setInitialDraft(cloneDraft(next));
    setIsNew(false);
    setAddChoices(false);
    setAddModeDrafts({});
    setShowKey(false);
    setCandidates(null);
    setDeleteId(null);
    clearFeedback();
  }

  function switchAddMode(nextMode: AddMode): void {
    if (nextMode === addMode || saving || fetching || outsideTauri) return;
    const nextDrafts: AddModeDrafts = { ...addModeDrafts };
    if (draft && isNew) {
      nextDrafts[addMode] = { draft: cloneDraft(draft), initial: cloneDraft(initialDraft ?? draft), presetId: addModeDrafts[addMode]?.presetId ?? null };
    }
    setAddModeDrafts(nextDrafts);
    setAddMode(nextMode);
    setShowKey(false);
    setCandidates(null);
    setCandidateQuery('');
    setSelectedCandidates(new Set());
    setDeleteId(null);
    clearFeedback();

    const saved = nextDrafts[nextMode];
    if (saved) {
      setEditorId(saved.draft.id);
      setDraft(cloneDraft(saved.draft));
      setInitialDraft(cloneDraft(saved.initial));
      setIsNew(true);
      return;
    }
    if (nextMode === 'custom-api') {
      const next = newProvider(null, providers);
      const initial = cloneDraft(next);
      nextDrafts[nextMode] = { draft: cloneDraft(next), initial: cloneDraft(initial), presetId: null };
      setAddModeDrafts(nextDrafts);
      setEditorId(next.id);
      setDraft(next);
      setInitialDraft(initial);
      setIsNew(true);
      return;
    }
    setEditorId(null);
    setDraft(null);
    setInitialDraft(null);
    setIsNew(true);
  }

  function updateDraft(changes: Partial<ProviderDraft>): void {
    setDraft((current) => current ? { ...current, ...changes } : current);
    clearFeedback();
  }

  function updateModel(index: number, changes: Partial<ProviderModel>): void {
    setDraft((current) => current ? { ...current, models: current.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...changes } : model) } : current);
    clearFeedback();
  }

  function removeModel(index: number): void {
    setDraft((current) => current ? { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) } : current);
    clearFeedback();
  }

  function validateDraft(value: ProviderDraft, creating = isNew): string | null {
    if (!value.name.trim()) return '请填写服务商名称。';
    if (!/^[a-z][a-z0-9-]*$/.test(value.id)) return 'Provider ID 需以小写字母开头，只能包含小写字母、数字和连字符。';
    if (hasProviderIdConflict(value.id, providers, creating)) return '这个 Provider ID 已经存在。';
    if (!value.baseUrl.trim()) return '请填写 API Base URL。';
    try {
      const url = new URL(value.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return 'Base URL 必须使用 HTTP 或 HTTPS。';
    } catch { return '请填写有效的 Base URL。'; }
    if (value.models.length === 0) return '请至少添加一个模型。';
    const seen = new Set<string>();
    for (const model of value.models) {
      if (!model.id.trim()) return '每个模型都需要填写 Model ID。';
      if (seen.has(model.id.trim())) return `Model ID “${model.id}”重复了。`;
      seen.add(model.id.trim());
      if (!model.input.text && !model.input.image) return `模型 “${model.id}”至少要支持一种输入类型。`;
      if ((model.contextWindow != null && (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0)) || (model.maxTokens != null && (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0))) return `模型 “${model.id}”的上下文或输出上限必须是正数。`;
    }
    return null;
  }

  function normalizedDraft(value: ProviderDraft): ProviderDraft {
    return {
      ...value,
      name: value.name.trim(),
      baseUrl: value.baseUrl.trim(),
      models: value.models.map((model) => ({ ...model, id: model.id.trim(), name: model.name.trim() || model.id.trim() })),
    };
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft || pending.current) return;
    const creating = isNew;
    const validation = validateDraft(draft);
    if (validation) { setError(validation); return; }
    const normalized = normalizedDraft(draft);
    const clearActive = normalized.id === activeProviderId && activeModelId !== null && !normalized.models.some((model) => model.id === activeModelId);
    if (clearActive && !window.confirm('你正在移除当前使用的模型。继续后会清除当前模型，知序的 AI 整理将暂停，直到你再次选择“使用此模型”。')) return;
    pending.current = true;
    setSaving(true);
    clearFeedback();
    let mutationSaved = false;
    try {
      const nextProviders = isNew ? [...providers, asView(normalized)] : providers.map((provider) => provider.id === draft.id ? asView(normalized, provider) : provider);
      const result = await commands.saveModelSettings({ providers: nextProviders.map((provider) => {
        const edited = provider.id === normalized.id ? normalized : asDraft(provider);
        return edited;
      }), ...(clearActive ? { clearActive: true } : {}) });
      mutationSaved = true;
      const redactedDraft = { ...normalized, apiKey: '', clearApiKey: false };
      setDraft(redactedDraft);
      setInitialDraft(cloneDraft(redactedDraft));
      const refreshed = await commands.getSettings();
      setProviders(refreshed.providers);
      setActiveProviderId(refreshed.activeProviderId);
      setActiveModelId(refreshed.activeModelId);
      onSaved({ providers: refreshed.providers, activeProviderId: refreshed.activeProviderId, activeModelId: refreshed.activeModelId }, refreshed.runtimeStatus);
      setMessage(clearActive ? `${result.message} 当前模型已清除，请重新选择“使用此模型”以启用 AI 整理。` : result.message);
      if (creating) finishAdding();
      else {
        const redactedProvider = refreshed.providers.find((provider) => provider.id === normalized.id);
        const redacted = redactedProvider ? asDraft(redactedProvider) : { ...normalized, apiKey: '', clearApiKey: false };
        setDraft(redacted);
        setInitialDraft(cloneDraft(redacted));
      }
    } catch (failure) {
      setError(mutationSaved ? `配置已保存，但无法读取最新设置：${describeError(failure)}。请重新打开 Provider 管理确认状态。` : describeError(failure));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function deleteProvider(provider: ProviderView): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    clearFeedback();
    let mutationSaved = false;
    try {
      const nextProviders = providers.filter((entry) => entry.id !== provider.id);
      const clearActive = provider.id === activeProviderId;
      const result = await commands.saveModelSettings({ providers: nextProviders.map(asDraft), ...(clearActive ? { clearActive: true } : {}) });
      mutationSaved = true;
      const refreshed = await commands.getSettings();
      setProviders(refreshed.providers);
      setActiveProviderId(refreshed.activeProviderId);
      setActiveModelId(refreshed.activeModelId);
      onSaved({ providers: refreshed.providers, activeProviderId: refreshed.activeProviderId, activeModelId: refreshed.activeModelId }, refreshed.runtimeStatus);
      setDeleteId(null);
      setMessage(result.message);
    } catch (failure) {
      setError(mutationSaved ? `Provider 已删除，但无法读取最新设置：${describeError(failure)}。请重新打开 Provider 管理确认状态。` : describeError(failure));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function useModel(providerDraft: ProviderDraft, modelId: string, addNew = isNew): Promise<void> {
    if (pending.current) return;
    if (!canUseModel) { setError(useModelUnavailableReason); return; }
    const creating = addNew;
    const validation = validateDraft(providerDraft, addNew);
    if (validation) { setError(validation); return; }
    const normalized = normalizedDraft(providerDraft);
    pending.current = true;
    setSaving(true);
    clearFeedback();
    let mutationApplied = false;
    try {
      const nextProviders = addNew ? [...providers, asView(normalized)] : providers.map((provider) => provider.id === normalized.id ? asView(normalized, provider) : provider);
      const activeView = nextProviders.find((provider) => provider.id === normalized.id);
      if (!activeView?.models.some((model) => model.id === modelId && model.input.text)) throw new Error('所选模型不存在或不支持文本输入。');
      const result = await commands.useModel({ providers: nextProviders.map((provider) => provider.id === normalized.id ? normalized : asDraft(provider)), providerId: normalized.id, modelId });
      mutationApplied = true;
      const redactedDraft = { ...normalized, apiKey: '', clearApiKey: false };
      setDraft(redactedDraft);
      setInitialDraft(cloneDraft(redactedDraft));
      const refreshed = await commands.getSettings();
      setProviders(refreshed.providers);
      setActiveProviderId(refreshed.activeProviderId);
      setActiveModelId(refreshed.activeModelId);
      onSaved({ providers: refreshed.providers, activeProviderId: refreshed.activeProviderId, activeModelId: refreshed.activeModelId }, refreshed.runtimeStatus);
      setMessage(result.message);
      if (creating) finishAdding();
      else {
        const redactedProvider = refreshed.providers.find((provider) => provider.id === normalized.id);
        const redacted = redactedProvider ? asDraft(redactedProvider) : { ...normalized, apiKey: '', clearApiKey: false };
        setDraft(redacted);
        setInitialDraft(cloneDraft(redacted));
      }
    } catch (failure) {
      setError(mutationApplied ? `模型已应用，但无法读取最新设置：${describeError(failure)}。请重新打开 Provider 管理确认状态。` : describeError(failure));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function fetchModels(): Promise<void> {
    if (!draft || fetching || saving || outsideTauri) return;
    setCandidates(null);
    setSelectedCandidates(new Set());
    setFetching(true);
    clearFeedback();
    try {
      const found = await commands.fetchAvailableModels(createFetchModelsInput(draft, isNew));
      setCandidates(found);
      setCandidateQuery('');
      setSelectedCandidates(new Set());
      if (found.length === 0) setMessage('没有发现可用模型；你也可以手动添加 Model ID。');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setFetching(false);
    }
  }

  function addSelectedModels(): void {
    if (!draft) return;
    const selected = (candidates ?? []).filter((model) => selectedCandidates.has(model.id));
    const byId = new Map(draft.models.map((model) => [model.id, model]));
    for (const model of selected) if (!byId.has(model.id)) byId.set(model.id, { ...model, input: { ...model.input } });
    updateDraft({ models: [...byId.values()] });
    setCandidates(null);
    setSelectedCandidates(new Set());
    setMessage(`已将 ${selected.length} 个模型加入当前草稿；保存后生效。`);
  }

  function selectVisible(checked: boolean): void {
    setSelectedCandidates((current) => {
      const next = new Set(current);
      for (const model of visibleCandidates) checked ? next.add(model.id) : next.delete(model.id);
      return next;
    });
  }

  function renderModelRows(editable: ProviderDraft, allowUse: boolean): ReactElement {
    return <div className="model-config-list">
      {editable.models.length === 0 ? <p className="model-empty-note">还没有添加模型。可以获取服务商模型列表，或手动添加。</p> : null}
      {editable.models.map((model, index) => <article className="model-config-row" key={`${model.id}-${index}`}>
        <div className="model-config-heading"><strong>{model.name || model.id || '新模型'}</strong><code>{model.id || 'Model ID 待填写'}</code></div>
        <div className="model-config-fields">
          <div className="form-field"><label htmlFor={`${prefix}-model-id-${index}`}>Model ID</label><input id={`${prefix}-model-id-${index}`} value={model.id} maxLength={200} required onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="例如 deepseek-chat" /></div>
          <div className="form-field"><label htmlFor={`${prefix}-model-name-${index}`}>显示名称</label><input id={`${prefix}-model-name-${index}`} value={model.name} maxLength={200} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="可选，默认显示 Model ID" /></div>
        </div>
        <details className="model-options">
          <summary>模型选项</summary>
          <div className="model-capacity-row">
            <div className="form-field"><label htmlFor={`${prefix}-context-${index}`}>上下文长度</label><input id={`${prefix}-context-${index}`} type="number" min="1" step="1" value={model.contextWindow ?? ''} onChange={(event) => updateModel(index, { contextWindow: event.target.value === '' ? null : Number(event.target.value) })} placeholder="留空使用默认值" /></div>
            <div className="form-field"><label htmlFor={`${prefix}-max-tokens-${index}`}>最大输出 tokens</label><input id={`${prefix}-max-tokens-${index}`} type="number" min="1" step="1" value={model.maxTokens ?? ''} onChange={(event) => updateModel(index, { maxTokens: event.target.value === '' ? null : Number(event.target.value) })} placeholder="留空使用默认值" /></div>
          </div>
          <fieldset className="model-input-types"><legend>输入类型</legend>
            <label><input type="checkbox" checked={model.input.text} disabled={model.input.text && !model.input.image} onChange={(event) => updateModel(index, { input: { ...model.input, text: event.target.checked } })} /> 文本</label>
            <label><input type="checkbox" checked={model.input.image} disabled={model.input.image && !model.input.text} onChange={(event) => updateModel(index, { input: { ...model.input, image: event.target.checked } })} /> 图片</label>
          </fieldset>
        </details>
        <div className="model-config-actions">
          {allowUse ? <button type="button" className="button-soft" disabled={saving || fetching || outsideTauri || !canUseModel || !model.id.trim() || !model.input.text} title={!canUseModel ? useModelUnavailableReason : !model.input.text ? '此应用的 AI 整理需要文本输入模型' : undefined} onClick={() => void useModel(draft ?? editable, model.id)}>使用此模型</button> : null}
          <button type="button" className="text-action model-remove" disabled={saving || fetching} onClick={() => removeModel(index)}>移除模型</button>
        </div>
      </article>)}
      <div className="model-add-actions">
        <button type="button" className="button-soft" disabled={saving || fetching || outsideTauri} onClick={() => { setDraft((current) => current ? { ...current, models: [...current.models, emptyModel()] } : current); clearFeedback(); }}>＋ 手动添加模型</button>
        <button type="button" className="button-soft" disabled={saving || fetching || outsideTauri} onClick={() => void fetchModels()}>{fetching ? '正在获取…' : '获取可用模型'}</button>
      </div>
      {candidates ? <section className="model-candidate-panel" aria-label="可用模型候选列表">
        <div className="model-candidate-header"><div><strong>可用模型</strong><span>{candidates.length} 个候选项</span></div><button type="button" className="text-action" onClick={() => setCandidates(null)}>关闭</button></div>
        <input className="model-candidate-search" type="search" aria-label="搜索候选模型" placeholder="搜索模型 ID 或名称" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} />
        <div className="model-candidate-selection"><span>已选 {selectedCandidates.size} 个</span><div><button type="button" className="text-action" onClick={() => selectVisible(true)}>全选当前结果</button><button type="button" className="text-action" onClick={() => setSelectedCandidates(new Set())}>清空已选</button></div></div>
        {visibleCandidates.length === 0 ? <p className="model-empty-note">没有匹配的候选模型。</p> : <div className="model-candidate-list">{visibleCandidates.map((candidate) => <label className="model-candidate" key={candidate.id}>
          <input type="checkbox" checked={selectedCandidates.has(candidate.id)} onChange={(event) => setSelectedCandidates((current) => { const next = new Set(current); event.target.checked ? next.add(candidate.id) : next.delete(candidate.id); return next; })} />
          <span><strong>{candidate.name || candidate.id}</strong><code>{candidate.id}</code></span>
        </label>)}</div>}
        <button type="button" className="button-primary" disabled={selectedCandidates.size === 0} onClick={addSelectedModels}>添加已选模型</button>
      </section> : null}
    </div>;
  }

  return <section className={welcome ? 'model-settings model-settings-welcome' : 'model-settings'} aria-labelledby={`${prefix}-title`}>
    {welcome ? <div className="model-welcome-brand"><span className="brand-mark" aria-hidden="true">知</span><span>知序 · Noltri</span></div> : null}
    <div className="eyebrow">模型服务</div>
    <h1 id={`${prefix}-title`}>{welcome ? '先连接你的 AI 模型' : 'Provider 管理'}</h1>
    <p className="dialog-intro">先配置服务商和模型，再选择“使用此模型”作为知序处理资料时的默认模型。</p>

    <div className="provider-management">
      <div className="provider-management-heading"><div><h2>Provider 管理</h2><p>管理 API 连接与可用模型。密钥保存在本机，不会回显。</p></div><span>{providers.length} 个</span></div>
      {providers.length === 0 ? <div className="provider-empty"><strong>还没有配置 Provider</strong><p>添加常见服务商或自定义 API，再选定一个模型供知序使用。</p></div> : <div className="provider-list">
        {providers.map((provider) => <article className={`provider-list-row${provider.id === activeProviderId ? ' is-active' : ''}`} key={provider.id}>
          <div className="provider-list-main"><span className="provider-status-dot" aria-hidden="true" /><div><strong>{provider.name}</strong><span>{provider.models.length} 个模型 · {provider.hasApiKey ? 'API Key 已保存' : '未保存 API Key'}</span></div>{provider.id === activeProviderId ? <em>当前使用</em> : null}</div>
          <div className="provider-list-actions"><button type="button" className="text-action" disabled={saving || fetching || editorId !== null || addChoices} onClick={() => openExisting(provider)}>编辑</button><button type="button" className="text-action model-remove" disabled={saving || fetching || editorId !== null || addChoices} onClick={() => { setDeleteId(provider.id); clearFeedback(); }}>删除</button></div>
          {deleteId === provider.id ? <div className="provider-delete-confirm" role="alertdialog" aria-label={`确认删除 ${provider.name}`}><p>确定删除 <strong>{provider.name}</strong> 及其模型吗？{provider.id === activeProviderId ? ' 这会同时清除当前使用的模型。' : ''}</p><button type="button" className="button-soft" disabled={saving} onClick={() => setDeleteId(null)}>取消</button><button type="button" className="button-danger" disabled={saving} onClick={() => void deleteProvider(provider)}>{saving ? '正在删除…' : '确认删除'}</button></div> : null}
          {provider.models.map((model) => <div className="provider-model-row" key={model.id}><div><strong>{model.name || model.id}</strong><code>{model.id}</code>{!model.input.text ? <span className="model-use-hint">此应用需文本输入模型</span> : null}</div>{provider.id === activeProviderId && model.id === activeModelId ? <span className="model-active-label">当前模型</span> : <button type="button" className="button-soft" disabled={saving || fetching || outsideTauri || editorId !== null || addChoices || !canUseModel || !model.input.text} title={!canUseModel ? useModelUnavailableReason : !model.input.text ? '此应用的 AI 整理需要文本输入模型' : undefined} onClick={() => void useModel(asDraft(provider), model.id, false)}>使用此模型</button>}</div>)}
        </article>)}
      </div>}

      {addChoices ? <div className="provider-add-choices">
        <div className="provider-add-heading"><div><strong>添加 Provider</strong><p>先选择接入类型，再配置服务商和模型。</p></div><button type="button" className="text-action" disabled={saving || fetching} onClick={() => closeEditor()}>取消添加</button></div>
        <div className="provider-mode-switch" role="group" aria-label="Provider 接入类型">
          <button type="button" aria-pressed={addMode === 'third-party'} disabled={saving || fetching || outsideTauri} onClick={() => switchAddMode('third-party')}>Third-party model provider</button>
          <button type="button" aria-pressed={addMode === 'custom-api'} disabled={saving || fetching || outsideTauri} onClick={() => switchAddMode('custom-api')}>Custom model API</button>
        </div>
        {addMode === 'third-party' ? <>
          <p className="provider-mode-description">选择常见服务商，或在表单中调整 API 协议与地址。</p>
          {!draft || !isNew ? <div className="provider-preset-grid">{PRESETS.map((preset) => <button type="button" className="provider-preset" key={preset.id} disabled={saving || fetching || outsideTauri} onClick={() => openNew(preset)}><strong>{preset.name}</strong><span>{preset.description}</span></button>)}</div> : <p className="provider-mode-description">正在配置 {PRESETS.find((preset) => preset.id === addModeDrafts['third-party']?.presetId)?.name ?? '第三方服务商'}；切换到自定义 API 时，此草稿会保留。</p>}
        </> : <p className="provider-mode-description">配置兼容 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 的 API。</p>}
      </div> : null}

      {editorId !== null && draft ? <form className="provider-editor" onSubmit={(event) => void saveDraft(event)}>
        <div className="provider-editor-heading"><div><span className="eyebrow">{isNew ? '添加 Provider' : '编辑 Provider'}</span><h2>{isNew ? draft.name : providers.find((provider) => provider.id === editorId)?.name}</h2></div>{!isNew || !addChoices ? <button type="button" className="text-action" disabled={saving || fetching} onClick={() => closeEditor()}>取消</button> : null}</div>
        <fieldset className="provider-editor-fields" disabled={saving || fetching || outsideTauri}>
          <div className="form-two-column">
            <div className="form-field"><label htmlFor={`${prefix}-provider-name`}>显示名称</label><input id={`${prefix}-provider-name`} value={draft.name} maxLength={100} required onChange={(event) => updateDraft({ name: event.target.value })} /></div>
            <div className="form-field"><label htmlFor={`${prefix}-provider-id`}>Provider ID</label><input id={`${prefix}-provider-id`} value={draft.id} maxLength={80} disabled={!isNew} required onChange={(event) => updateDraft({ id: event.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /><p className="field-hint">保存后 ID 固定，用于关联服务商配置。</p></div>
          </div>
          <div className="form-field"><label htmlFor={`${prefix}-provider-url`}>API 地址 <span>Base URL</span></label><input id={`${prefix}-provider-url`} type="url" value={draft.baseUrl} maxLength={2000} required placeholder="https://api.example.com/v1" onChange={(event) => updateDraft({ baseUrl: event.target.value })} /><p className="field-hint">OpenAI 协议通常使用 /v1；Anthropic Messages 使用服务商提供的 API 根地址。</p></div>
          <div className="form-field"><label htmlFor={`${prefix}-provider-protocol`}>API 协议</label><select id={`${prefix}-provider-protocol`} value={draft.protocol} onChange={(event) => updateDraft({ protocol: event.target.value as ProviderProtocol })}>{PROTOCOLS.map((protocol) => <option value={protocol.id} key={protocol.id}>{protocol.label}</option>)}</select></div>
          <div className="form-field"><label htmlFor={`${prefix}-provider-key`}>API Key</label><div className="model-key-row"><input id={`${prefix}-provider-key`} type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={draft.apiKey ?? ''} maxLength={2000} placeholder={providers.find((provider) => provider.id === draft.id)?.hasApiKey && !draft.clearApiKey ? '留空以保留已保存的密钥' : '输入 API Key（本地或无需鉴权的 API 可留空）'} onChange={(event) => { setShowKey(false); updateDraft({ apiKey: event.target.value, clearApiKey: false }); }} /><button type="button" className="button-soft" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey((current) => !current)}>{showKey ? '隐藏' : '显示'}</button></div>
            {!isNew && providers.find((provider) => provider.id === draft.id)?.hasApiKey ? <label className="model-clear-key"><input type="checkbox" checked={Boolean(draft.clearApiKey)} onChange={(event) => updateDraft({ clearApiKey: event.target.checked, apiKey: '' })} /> 清除已保存的 API Key</label> : null}
          </div>
        </fieldset>
        <fieldset className="provider-model-editor-fields" disabled={saving || fetching || outsideTauri}><div className="provider-model-editor"><div className="provider-model-editor-heading"><div><h3>模型目录</h3><p>可从 API 获取模型，也可以手动添加 Model ID。</p></div></div>{renderModelRows(draft, true)}</div></fieldset>
        {outsideTauri ? <p className="field-hint">浏览器预览无法保存本机模型设置；请在知序桌面应用中配置。</p> : null}
        {error ? <p className="model-feedback model-feedback-error" role="alert">{error}</p> : null}
        {message ? <p className="model-feedback" role="status">{message}</p> : null}
        <div className="dialog-actions model-settings-actions">{!isNew || !addChoices ? <button type="button" className="button-soft" disabled={saving || fetching} onClick={() => closeEditor()}>取消</button> : null}<button type="submit" className="button-primary" disabled={saving || fetching || outsideTauri}>{saving ? '正在保存…' : '保存 Provider'}</button></div>
      </form> : null}

      {editorId === null && !addChoices ? <button type="button" className="provider-add-button button-soft" disabled={saving || fetching || outsideTauri} onClick={() => { setAddChoices(true); setAddMode('third-party'); setAddModeDrafts({}); setIsNew(false); setDeleteId(null); clearFeedback(); }}>＋ 添加 Provider</button> : null}
      {error && editorId === null ? <p className="model-feedback model-feedback-error" role="alert">{error}</p> : null}
      {message && editorId === null ? <p className="model-feedback" role="status">{message}</p> : null}
    </div>

    <p className="field-hint model-runtime-note">{canUseModel ? '配置与 API 密钥保存在此设备。“使用此模型”会保存配置并应用到本机服务。' : useModelUnavailableReason}</p>
    <div className="dialog-actions model-settings-actions">{onDone ? <button type="button" className="button-soft" disabled={saving || fetching} onClick={onDone}>进入知识库 →</button> : null}</div>
  </section>;
}
