import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { processingRulesSchema } from '@noltri/schema';
import type { ProcessingRecord, ProcessingRules, ProcessingRulesDraft, ProcessingRulesSnapshot, Thresholds } from '@noltri/schema';
import type { RuntimeDiagnostics } from '../lib/tauri';
import './processing-console.css';

export interface ProcessingConsoleApi {
  processingRules(): Promise<{ draft: ProcessingRulesDraft; applied: ProcessingRulesSnapshot; versions: ProcessingRulesSnapshot[] }>;
  saveProcessingRulesDraft(request: { rules: ProcessingRules; expectedRevision: number }): Promise<ProcessingRulesDraft>;
  applyProcessingRules(request: { expectedRevision: number }): Promise<{ draft: ProcessingRulesDraft; applied: ProcessingRulesSnapshot }>;
  rollbackProcessingRules(request: { versionId: string; expectedRevision: number }): Promise<{ draft: ProcessingRulesDraft; applied: ProcessingRulesSnapshot }>;
  processingRecords(): Promise<{ records: ProcessingRecord[] }>;
}
type RuleState = Awaited<ReturnType<ProcessingConsoleApi['processingRules']>>;
type Editor = { thresholds: Record<keyof Thresholds, string>; extractionInstructions: string; classificationInstructions: string };
const fields: { key: keyof Thresholds; label: string; min: number; max: number; step: number }[] = [
  { key: 'highConfidence', label: '高置信阈值', min: 0, max: 1, step: .01 },
  { key: 'mediumConfidence', label: '中置信阈值', min: 0, max: 1, step: .01 },
  { key: 'similarityAttachThreshold', label: '相似归入阈值', min: 0, max: 1, step: .01 },
  { key: 'similaritySearchLimit', label: '相似结果数量', min: 1, max: 50, step: 1 },
  { key: 'candidateNodeLimit', label: '候选节点数量', min: 1, max: 200, step: 1 },
  { key: 'minNewNodeItemCount', label: '新节点最少条目数', min: 1, max: 20, step: 1 },
];
function editorFor(rules: ProcessingRules | ProcessingRulesSnapshot['rules']): Editor {
  return { thresholds: Object.fromEntries(fields.map(f => [f.key, String(rules.thresholds[f.key])])) as Editor['thresholds'], extractionInstructions: rules.extractionInstructions, classificationInstructions: rules.classificationInstructions };
}
function validated(editor: Editor): ProcessingRules | null {
  if (fields.some(f => editor.thresholds[f.key].trim() === '')) return null;
  const parsed = processingRulesSchema.safeParse({ ...editor, thresholds: Object.fromEntries(fields.map(f => [f.key, Number(editor.thresholds[f.key])])) });
  return parsed.success ? parsed.data : null;
}
function rulesEqual(a: ProcessingRules, b: ProcessingRulesSnapshot['rules']): boolean {
  return fields.every(f => a.thresholds[f.key] === b.thresholds[f.key]) && a.extractionInstructions === b.extractionInstructions && a.classificationInstructions === b.classificationInstructions;
}
function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.status === 409 || (typeof value.code === 'string' && value.code.includes('revision_conflict'));
}
function RuleSummary({ rules }: { rules: ProcessingRulesSnapshot['rules'] }): ReactElement {
  return <div className="processing-rule-summary"><dl>{fields.map(f => <div key={f.key}><dt>{f.label}{f.key === 'minNewNodeItemCount' ? '（保留配置，当前不参与处理决策）' : ''}</dt><dd>{rules.thresholds[f.key]}</dd></div>)}</dl><h4>提取指令</h4><pre>{rules.extractionInstructions || '（空）'}</pre><h4>分类指令</h4><pre>{rules.classificationInstructions || '（空）'}</pre></div>;
}

function diagnosticEnum(value: unknown, labels: Record<string, string>): string {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value]! : '未知';
}
function diagnosticNumber(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '未知';
}
function RuntimeMetadata({ diagnostics }: { diagnostics: RuntimeDiagnostics }): ReactElement {
  const children = Array.isArray(diagnostics.children) ? diagnostics.children.slice(0, 16) : [];
  return <div>
    <dl className="runtime-diagnostics-summary">
      <div><dt>应用 PID</dt><dd>{diagnosticNumber(diagnostics.appPid)}</dd></div>
      <div><dt>运行代次</dt><dd>{diagnosticNumber(diagnostics.generation)}</dd></div>
      <div><dt>运行模式</dt><dd>{diagnosticEnum(diagnostics.mode, { unresolved: '未确定', managed: '随包服务 managed', external: '外部服务 external', devManual: '开发服务 devManual' })}</dd></div>
      <div><dt>运行状态</dt><dd>{diagnosticEnum(diagnostics.status, { starting: '启动中', managed: '随包服务运行中', external: '使用外部服务', devManual: '使用开发服务', stopping: '停止中', stopped: '已停止', failed: '失败' })}</dd></div>
      <div><dt>停止确认</dt><dd>{diagnostics.shutdownConfirmed === true ? '已确认停止' : diagnostics.shutdownConfirmed === false ? '尚未确认停止' : '未知'}</dd></div>
    </dl>
    {children.length === 0 ? <p>无自有子进程。</p> : <div className="processing-table-scroll"><table><caption>本应用持有的子进程记录</caption><thead><tr>{['角色', 'PID', '代次', '状态', '退出码', '退出信号', '终止请求'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{children.map((child, index) => <tr key={index}>
      <td>{diagnosticEnum(child?.role, { core: 'Core', mcp: 'MCP' })}</td><td>{diagnosticNumber(child?.pid)}</td><td>{diagnosticNumber(child?.generation)}</td>
      <td>{diagnosticEnum(child?.state, { running: '运行中 running', stopRequested: '已请求停止', killFailed: '终止请求失败', observationFailed: '无法确认退出', terminated: '已退出' })}</td>
      <td>{child?.exitCode == null ? '—' : diagnosticNumber(child.exitCode)}</td><td>{child?.exitSignal == null ? '—' : diagnosticNumber(child.exitSignal)}</td>
      <td>{child?.killOutcome == null ? '—' : diagnosticEnum(child.killOutcome, { accepted: '请求已接受，退出须另行确认', failed: '请求失败' })}</td>
    </tr>)}</tbody></table></div>}
  </div>;
}

export function RuntimeDiagnosticsPanel({ getRuntimeDiagnostics }: { getRuntimeDiagnostics?: () => Promise<RuntimeDiagnostics> }): ReactElement {
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState(false);
  const diagnosticsLock = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function refreshDiagnostics(): Promise<void> {
    if (!getRuntimeDiagnostics || diagnosticsLock.current) return;
    diagnosticsLock.current = true; setDiagnosticsBusy(true);
    try {
      const next = await getRuntimeDiagnostics();
      if (!next || typeof next !== 'object') throw Error('invalid_diagnostics');
      if (mounted.current) { setDiagnostics(next); setDiagnosticsError(false); }
    } catch { if (mounted.current) setDiagnosticsError(true); }
    finally { diagnosticsLock.current = false; if (mounted.current) setDiagnosticsBusy(false); }
  }

  return <section className="processing-panel" aria-label="运行诊断"><div className="processing-section-title"><div><h2>运行诊断</h2><p>只显示本应用及其持有的子进程元数据。点击刷新读取当前快照。</p></div><button type="button" disabled={!getRuntimeDiagnostics || diagnosticsBusy} onClick={() => void refreshDiagnostics()}>刷新运行诊断</button></div>
      {diagnosticsError ? <p role="alert" className="processing-error">无法读取运行诊断，请刷新重试。{diagnostics ? '下方为上次成功读取的快照。' : ''}</p> : null}
      {diagnostics ? <RuntimeMetadata diagnostics={diagnostics}/> : <p>{diagnosticsBusy ? '正在读取运行诊断…' : '运行诊断尚未读取。'}</p>}
    </section>;
}

export function ProcessingConsole({ api, getRuntimeDiagnostics }: { api: ProcessingConsoleApi; getRuntimeDiagnostics?: () => Promise<RuntimeDiagnostics> }): ReactElement {
  const prefix = useId();
  const [state, setState] = useState<RuleState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [comparison, setComparison] = useState<RuleState | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [records, setRecords] = useState<ProcessingRecord[] | null>(null);
  const [recordError, setRecordError] = useState(false);
  const [recordsBusy, setRecordsBusy] = useState(false);
  // A ref closes the gap before React commits disabled buttons on the next render.
  const lock = useRef(false);
  const recordsLock = useRef(false);
  const mounted = useRef(false);
  const parsed = editor ? validated(editor) : null;
  const dirty = !!editor && !!state && (!parsed || !rulesEqual(parsed, state.draft.rules));

  async function loadRules(): Promise<void> {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const next = await api.processingRules();
      if (!mounted.current) return;
      if (editor && (dirty || blocked || comparison)) { setComparison(next); setBlocked(true); setError('请比较服务器草稿与本地编辑，再选择使用哪份草稿。'); }
      else { setState(next); setEditor(editorFor(next.draft.rules)); setComparison(null); setBlocked(false); setError(''); }
    } catch { if (mounted.current) setError('无法加载规则，请重新加载。本地编辑会保留。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function loadRecords(): Promise<void> {
    if (recordsLock.current) return;
    recordsLock.current = true; setRecordsBusy(true);
    try { const next = await api.processingRecords(); if (mounted.current) { setRecords(next.records); setRecordError(false); } }
    catch { if (mounted.current) setRecordError(true); }
    finally { recordsLock.current = false; if (mounted.current) setRecordsBusy(false); }
  }
  useEffect(() => { mounted.current = true; void loadRules(); void loadRecords(); return () => { mounted.current = false; }; }, [api]);

  async function mutate(kind: 'save' | 'apply' | 'rollback', versionId?: string): Promise<void> {
    if (lock.current || blocked || !state || !parsed || (kind !== 'save' && dirty)) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const expectedRevision = state.draft.revision;
      if (kind === 'save') {
        const draft = await api.saveProcessingRulesDraft({ rules: parsed, expectedRevision });
        if (!mounted.current) return;
        setState({ ...state, draft }); setEditor(editorFor(draft.rules)); setMessage('草稿已保存，尚未应用。');
      } else {
        const result = kind === 'apply' ? await api.applyProcessingRules({ expectedRevision }) : await api.rollbackProcessingRules({ versionId: versionId!, expectedRevision });
        if (!mounted.current) return;
        setState({ ...result, versions: [result.applied, ...state.versions.filter(v => v.versionId !== result.applied.versionId)] });
        setEditor(editorFor(result.draft.rules)); setMessage(kind === 'apply' ? '已应用保存的草稿。任务执行接入状态由主应用决定。' : '已创建新的应用版本，历史版本保持不变。');
      }
    } catch (failure) {
      if (mounted.current) { setBlocked(true); setComparison(null); setError(isConflict(failure) ? '版本冲突：本地编辑已保留。请重新加载并比较后重试。' : '操作未能确认：本地编辑已保留。请重新加载并比较服务器状态后再操作。'); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function chooseComparison(keepLocal: boolean): void {
    if (!comparison || busy) return;
    setState(comparison); if (!keepLocal) setEditor(editorFor(comparison.draft.rules));
    setComparison(null); setBlocked(false); setError(''); setMessage(keepLocal ? '已保留本地编辑；保存时将使用新修订。' : '已使用服务器草稿。');
  }

  return <main className="processing-console" aria-label="处理规则与记录">
    <header className="processing-console-header"><div><span className="processing-eyebrow">知序 · 管理</span><h1>处理规则与记录</h1><p>任务保持任务开始时的规则版本。关闭此窗口不会关闭主应用或 Core 服务。</p></div><button type="button" disabled={busy} onClick={() => void loadRules()}>重新加载并比较</button></header>
    <p className="processing-note">这是独立管理页。保存草稿后需单独应用；本页不发起模型调用。版本应用记录不代表实际任务已经采用该版本。</p>
    {error ? <p role="alert" className="processing-error">{error}</p> : null}
    {message ? <p role="status" className="processing-feedback">{message}</p> : null}
    {!state ? <p role="status">{busy ? '正在加载规则…' : '规则尚未加载。'}</p> : null}
    {comparison ? <section className="processing-panel processing-comparison" aria-label="服务器草稿比较"><h2>服务器草稿修订 {comparison.draft.revision}</h2><p>下方编辑区仍保留本地内容。选择后才允许重试操作。</p><p>服务器当前已应用版本：{comparison.applied.versionId}</p><RuleSummary rules={comparison.draft.rules}/><div className="processing-actions"><button type="button" disabled={busy} onClick={() => chooseComparison(true)}>保留本地编辑并使用新修订</button><button type="button" disabled={busy} onClick={() => chooseComparison(false)}>使用服务器草稿替换本地编辑</button></div></section> : null}
    {state && editor ? <div className="processing-columns"><section className="processing-panel" aria-label="规则草稿"><div className="processing-section-title"><h2>规则草稿</h2><span>草稿修订 {state.draft.revision}</span></div><p>{dirty ? '有未保存的本地编辑。' : '编辑区与已保存草稿一致。'}</p>
      <fieldset disabled={busy}><legend>处理阈值</legend><div className="processing-fields">{fields.map(f => <label key={f.key} htmlFor={`${prefix}-${f.key}`}>{f.label}<input id={`${prefix}-${f.key}`} aria-label={f.label} aria-describedby={`${prefix}-${f.key}-hint`} type="number" readOnly={f.key === 'minNewNodeItemCount'} min={f.min} max={f.max} step={f.step} required value={editor.thresholds[f.key]} onChange={e => { if (f.key !== 'minNewNodeItemCount') setEditor({ ...editor, thresholds: { ...editor.thresholds, [f.key]: e.target.value } }); }}/><small id={`${prefix}-${f.key}-hint`}>{f.key === 'minNewNodeItemCount' ? '保留配置，当前不参与处理决策' : `${f.min}–${f.max}${f.step === 1 ? '，整数' : ''}`}</small></label>)}</div></fieldset>
      <fieldset disabled={busy}><legend>处理指令</legend>{(['extractionInstructions', 'classificationInstructions'] as const).map((key, i) => <label className="processing-instruction" key={key} htmlFor={`${prefix}-${key}`}>{i === 0 ? '提取指令' : '分类指令'}<textarea id={`${prefix}-${key}`} aria-label={i === 0 ? '提取指令' : '分类指令'} value={editor[key]} maxLength={4000} rows={6} onChange={e => setEditor({ ...editor, [key]: e.target.value })}/><small>{editor[key].length}/4000 字符</small></label>)}</fieldset>
      {!parsed ? <p role="alert" className="processing-error">请填写范围内的阈值，数量必须是整数，指令最多 4000 字符。</p> : null}
      <div className="processing-actions"><button type="button" disabled={busy || blocked || !parsed || !dirty} onClick={() => void mutate('save')}>保存草稿</button><button type="button" className="processing-primary" disabled={busy || blocked || !parsed || dirty} onClick={() => void mutate('apply')}>应用已保存草稿</button></div><p className="processing-note">保存仅更新草稿修订；应用会创建一个独立版本。未保存的编辑需先保存。</p>
    </section><section className="processing-panel" aria-label="已应用规则"><h2>当前已应用版本：{state.applied.versionId}</h2><p><time>{state.applied.createdAt}</time></p><details><summary>查看已应用规则</summary><RuleSummary rules={state.applied.rules}/></details><h3>版本历史</h3><p>回滚会创建新的应用版本，并替换草稿。请先保存本地编辑。</p><ol className="processing-history">{state.versions.map(v => <li key={v.versionId}><code>{v.versionId}</code><time>{v.createdAt}</time>{v.versionId === state.applied.versionId ? <span>当前应用</span> : <button type="button" disabled={busy || blocked || dirty || !parsed} onClick={() => void mutate('rollback', v.versionId)}>回滚到 {v.versionId}</button>}<details><summary>查看版本规则</summary><RuleSummary rules={v.rules}/></details></li>)}</ol></section></div> : null}
    <section className="processing-panel" aria-label="处理记录"><div className="processing-section-title"><div><h2>处理记录</h2><p>仅显示任务标识、规则版本与处理状态；不显示原文、图片或密钥。</p></div><button type="button" disabled={recordsBusy} onClick={() => void loadRecords()}>刷新处理记录</button></div>
      {recordError ? <p role="alert" className="processing-error">无法加载处理记录，请刷新重试。{records ? '下方为上次成功加载的记录。' : ''}</p> : null}
      {records === null ? <p>{recordsBusy ? '正在加载处理记录…' : '处理记录尚未加载。'}</p> : records.length === 0 ? <p>暂无处理记录。</p> : <div className="processing-table-scroll"><table><caption>任务处理元数据</caption><thead><tr>{['记录 ID','任务 ID','规则版本','创建时间','更新时间','阶段','状态','错误码'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{records.map(r => <tr key={r.recordId}><td>{r.recordId}</td><td>{r.taskId}</td><td>{r.ruleVersionId}</td><td><time>{r.createdAt}</time></td><td><time>{r.updatedAt}</time></td><td>{r.phase}</td><td>{r.status}</td><td>{r.errorCode ?? '—'}</td></tr>)}</tbody></table></div>}
    </section>
    <RuntimeDiagnosticsPanel getRuntimeDiagnostics={getRuntimeDiagnostics}/>
  </main>;
}
