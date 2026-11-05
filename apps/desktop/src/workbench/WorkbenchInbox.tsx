import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { InboxImageSource, InboxSavedImages, isImageSource } from './InboxImageSource';
import type { ImageActivity } from './InboxImageSource';
import type { InboxEntry, InboxResponse, RawSource } from '@noltri/schema';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import './workbench-inbox.css';

type ReviewStatus = InboxEntry['reviewStatus'];
type ReviewRequest = Parameters<WorkbenchApi['reviewSource']>[1];
type ReviewAction = ReviewRequest['action'];
const REVIEW_LABEL: Record<ReviewStatus, string> = { needs_review: '待确认', deferred: '延后', rejected: '已拒绝', confirmed: '已确认' };
const PROCESS_LABEL: Record<RawSource['processingStatus'], string> = { pending: '等待处理', processing: '处理中', done: '已完成', failed: '处理失败' };
const FILTERS: ReviewStatus[] = ['needs_review', 'deferred', 'rejected', 'confirmed'];
const PAGE_SIZE = 50;

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

function sourceHref(url: string | null): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}

export interface WorkbenchInboxProps {
  api: WorkbenchApi;
  active?: boolean;
  onUpdateSafetyChange?: (safe: boolean) => void;
  selectedNodeId?: string | null;
  targetNodes?: readonly { id: string; label: string }[];
  /** LibraryItem identity is the original RawSource id, not KnowledgeItem.id. */
  onOpenItem?: (rawSourceId: string) => Promise<void> | void;
}

export function WorkbenchInbox({ api, active = true, selectedNodeId, targetNodes, onOpenItem, onUpdateSafetyChange }: WorkbenchInboxProps): ReactElement {
  const [filter, setFilter] = useState<ReviewStatus>('needs_review');
  const [offset, setOffset] = useState(0);
  const [feed, setFeed] = useState<InboxResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<RawSource | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [draftBaselines, setDraftBaselines] = useState<Record<string, string>>({});
  const [targetBaselines, setTargetBaselines] = useState<Record<string, string>>({});
  const [imageActivity, setImageActivity] = useState<Record<string, 'running' | 'processing' | 'uncertain' | 'checking'>>({});
  const [uncertainSources, setUncertainSources] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<{ id: string; request: ReviewRequest } | null>(null);
  const alive = useRef(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const actionLock = useRef(false);
  const current = useRef({ filter, offset, selectedId, active });
  current.current = { filter, offset, selectedId, active };

  const loadList = useCallback(async (reviewStatus = current.current.filter, pageOffset = current.current.offset): Promise<void> => {
    const request = ++listRequest.current;
    setListLoading(true);
    setListError(null);
    try {
      const response = await api.inbox({ reviewStatus, limit: PAGE_SIZE, offset: pageOffset });
      if (alive.current && request === listRequest.current) setFeed(response);
    } catch (error) {
      if (alive.current && request === listRequest.current) setListError(describeError(error));
    } finally {
      if (alive.current && request === listRequest.current) setListLoading(false);
    }
  }, [api]);

  const loadSource = useCallback(async (id: string): Promise<void> => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await api.rawSource(id);
      if (!alive.current || request !== detailRequest.current || current.current.selectedId !== id) return;
      setSource(response);
      setDrafts(previous => Object.hasOwn(previous, id) ? previous : { ...previous, [id]: response.rawText });
      setDraftBaselines(previous => Object.hasOwn(previous, id) ? previous : { ...previous, [id]: response.rawText });
    } catch (error) {
      if (alive.current && request === detailRequest.current) setDetailError(describeError(error));
    } finally {
      if (alive.current && request === detailRequest.current) setDetailLoading(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    const refresh = (): void => {
      if (!current.current.active) return;
      void loadList();
      if (current.current.selectedId) void loadSource(current.current.selectedId);
    };
    const visible = (): void => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      listRequest.current++;
      detailRequest.current++;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [loadList, loadSource]);

  useEffect(() => {
    if (!active) return;
    void loadList();
    if (current.current.selectedId) void loadSource(current.current.selectedId);
  }, [active, loadList, loadSource]);

  const imageBusy = Object.values(imageActivity).some(state => state === 'running');
  const onImageActivity = useCallback<ImageActivity>((key, state) => {
    setImageActivity(previous => {
      if (state === 'checking' && previous[key] !== undefined) return previous;
      if (state === 'pending' && previous[key] === 'running') return previous;
      if (state === 'checked' && previous[key] !== 'checking') return previous;
      if (state === 'observed' && previous[key] !== 'uncertain' && previous[key] !== 'processing' && previous[key] !== 'checking') return previous;
      const next = { ...previous };
      if (state === 'settled' || state === 'observed' || state === 'checked') delete next[key]; else next[key] = state === 'pending' ? 'processing' : state;
      return next;
    });
  }, []);
  const refreshAfterImage = useCallback(async (): Promise<void> => {
    await loadList();
    if (current.current.selectedId) await loadSource(current.current.selectedId);
  }, [loadList, loadSource]);
  const modifiedIds = [...new Set([...Object.keys(drafts), ...Object.keys(targets)])].filter(id =>
    (Object.hasOwn(drafts, id) && drafts[id] !== draftBaselines[id]) ||
    (Object.hasOwn(targets, id) && targets[id] !== targetBaselines[id]));
  const updateSafe = modifiedIds.length === 0 && !uncertain && uncertainSources.size === 0 && !busy && Object.keys(imageActivity).length === 0;
  useEffect(() => { onUpdateSafetyChange?.(updateSafe); }, [onUpdateSafetyChange, updateSafe]);

  function selectEntry(entry: InboxEntry): void {
    if (actionLock.current || imageBusy) return;
    setTargetBaselines(previous => Object.hasOwn(previous, entry.id) ? previous : { ...previous, [entry.id]: targetNodes ? targetNodes.find(node => node.id === selectedNodeId)?.id ?? '' : selectedNodeId ?? '' });
    current.current.selectedId = entry.id;
    setSelectedId(entry.id);
    setSource(null);
    setActionError(null);
    setUncertain(null);
    setConflict(false);
    setNotice(null);
    void loadSource(entry.id);
  }

  function changeFilter(next: ReviewStatus, pageOffset = 0): void {
    current.current.filter = next;
    current.current.offset = pageOffset;
    setFilter(next);
    setOffset(pageOffset);
    setFeed(null);
    void loadList(next, pageOffset);
  }

  const draft = source ? drafts[source.id] ?? source.rawText : '';
  const candidateTarget = (source && targets[source.id]) ?? selectedNodeId ?? '';
  const targetNodeId = targetNodes ? targetNodes.find(node => node.id.trim() !== '' && node.id === candidateTarget)?.id ?? '' : candidateTarget;
  const retryAvailable = uncertain && uncertain.id === source?.id && (source.reviewStatus === 'confirmed' || uncertain.request.action !== 'confirm' || (uncertain.request.nodeId === targetNodeId && uncertain.request.editedText === draft));
  const invalidDraft = draft.trim() === '' || draft.length > 4000;
  const blocked = busy || imageBusy || detailLoading || detailError !== null;
  const openItemBlocked = blocked || uncertainSources.size > 0 || Object.keys(imageActivity).length > 0;
  const confirmation = !detailLoading && detailError === null && source?.reviewStatus === 'confirmed' &&
    source.reviewConfirmation?.rawSourceId === source.id && source.reviewConfirmation.reviewRevision === source.reviewRevision &&
    source.reviewConfirmation.path.at(-1)?.id === source.reviewConfirmation.targetNodeId ? source.reviewConfirmation : null;
  const separateLocalIds = modifiedIds.filter(id => id !== source?.id || source.reviewStatus === 'confirmed');

  function discardLocalChanges(id: string): void {
    if (actionLock.current || imageBusy) return;
    setDrafts(previous => ({ ...previous, [id]: draftBaselines[id] ?? '' }));
    setTargets(previous => ({ ...previous, [id]: targetBaselines[id] ?? '' }));
  }

  async function openSourceDetail(): Promise<void> {
    if (!source || !onOpenItem || actionLock.current || openItemBlocked) return;
    const id = source.id;
    actionLock.current = true;
    setBusy(true);
    try {
      await onOpenItem(id);
    } catch (error) {
      if (alive.current && current.current.selectedId === id) setActionError(describeError(error));
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function review(action: ReviewAction, retry?: { id: string; request: ReviewRequest }): Promise<void> {
    if (!source || actionLock.current || blocked) return;
    if (action === 'confirm' && !retry && (!targetNodeId.trim() || invalidDraft)) return;
    const id = retry?.id ?? source.id;
    const identity = { actionId: retry?.request.actionId ?? crypto.randomUUID(), expectedRevision: retry?.request.expectedRevision ?? source.reviewRevision };
    const request: ReviewRequest = retry?.request ?? (action === 'confirm'
      ? { ...identity, action, nodeId: targetNodeId, editedText: draft }
      : { ...identity, action });
    actionLock.current = true;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    setNotice(null);
    setUncertain(null);
    try {
      const result = await api.reviewSource(id, request);
      if (!alive.current || current.current.selectedId !== id) return;
      setSource(previous => previous?.id === id ? { ...previous, reviewStatus: result.reviewStatus, reviewRevision: result.reviewRevision } : previous);
      setUncertainSources(previous => { const next = new Set(previous); next.delete(id); return next; });
      if (request.action === 'confirm') {
        if (draft === (request.editedText ?? source.rawText)) setDraftBaselines(previous => ({ ...previous, [id]: request.editedText ?? source.rawText }));
        if (candidateTarget === request.nodeId) setTargetBaselines(previous => ({ ...previous, [id]: request.nodeId }));
      }
      setNotice(result.duplicate ? '审核结果已存在，已恢复此前结果。' : `审核已更新：${REVIEW_LABEL[result.reviewStatus]}。`);
      await Promise.all([loadList(), loadSource(id)]);
    } catch (error) {
      if (!alive.current || current.current.selectedId !== id) return;
      const status = errorStatus(error);
      if (status === 409) {
        setConflict(true);
        setActionError('审核发生冲突：资料已被其他操作更新。正在读取最新审核状态；本地草稿已保留，请比较原文和草稿后再决定是否重试。');
        await Promise.all([loadList(), loadSource(id)]);
        setUncertainSources(previous => { const next = new Set(previous); next.delete(id); return next; });
      } else {
        setActionError(describeError(error));
        if (status === undefined || status >= 500) { setUncertain({ id, request }); setUncertainSources(previous => new Set(previous).add(id)); }
      }
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function retryProcessing(): Promise<void> {
    if (!source || actionLock.current || blocked) return;
    const id = source.id;
    actionLock.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await api.retryCapture(id);
      if (!alive.current || current.current.selectedId !== id) return;
      setNotice('已请求重新处理，原件继续保留。');
      await Promise.all([loadList(), loadSource(id)]);
    } catch (error) {
      if (alive.current && current.current.selectedId === id) setActionError(describeError(error));
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <section className="workbench-inbox" aria-label="资料审核">
    <header className="inbox-header">
      <div><h1>资料审核</h1><p>查看原件，编辑归档草稿，再明确决定如何处理。</p></div>
      <button type="button" className="button-soft" disabled={listLoading || busy || imageBusy} onClick={() => void loadList()}>刷新列表</button>
    </header>
    <nav className="inbox-filters" aria-label="审核状态筛选">
      {FILTERS.map(status => <button key={status} type="button" aria-pressed={filter === status} disabled={busy || imageBusy} onClick={() => changeFilter(status)}>{REVIEW_LABEL[status]} {feed?.reviewCounts[status] ?? '—'}</button>)}
    </nav>
    {feed ? <p className="inbox-processing-counts" aria-label="处理状态统计">等待处理 {feed.counts.pending} · 处理中 {feed.counts.processing} · 已完成 {feed.counts.done} · 处理失败 {feed.counts.failed}</p> : null}
    {listError ? <div role="alert" className="inbox-error">{listError} <button type="button" disabled={listLoading} onClick={() => void loadList()}>重试加载列表</button></div> : null}
    <InboxSavedImages api={api} active={active} disabled={busy || imageBusy} onProcessed={refreshAfterImage} onActivity={onImageActivity} />
    <div className="inbox-layout">
      <section className="inbox-feed" aria-label="资料列表" aria-busy={listLoading}>
        {listLoading ? <p role="status">正在加载资料…</p> : null}
        {feed?.entries.length === 0 ? <p>当前筛选下没有资料。</p> : null}
        <ul>{feed?.entries.map(entry => <li key={entry.id}>
          <button type="button" className="inbox-entry" aria-label={`打开资料 ${entry.sourceTitle || entry.textPreview || entry.id}`} aria-current={selectedId === entry.id ? 'true' : undefined} disabled={busy || imageBusy} onClick={() => selectEntry(entry)}>
            <strong>{entry.sourceTitle || '未命名资料'}</strong>
            <span className="inbox-entry-preview">{entry.textPreview || '（原文为空）'}</span>
            <small>{REVIEW_LABEL[entry.reviewStatus]} · {PROCESS_LABEL[entry.processingStatus]}</small>
            <small>{entry.sourceApp || entry.sourcePlatform || entry.sourceType} · {entry.capturedAt}</small>
          </button>
        </li>)}</ul>
        <div className="inbox-pagination">
          <button type="button" disabled={offset === 0 || listLoading || busy || imageBusy} onClick={() => changeFilter(filter, Math.max(0, offset - PAGE_SIZE))}>上一页</button>
          <span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页</span>
          <button type="button" disabled={!feed || feed.entries.length < PAGE_SIZE || listLoading || busy || imageBusy} onClick={() => changeFilter(filter, offset + PAGE_SIZE)}>下一页</button>
        </div>
      </section>
      <section className="inbox-detail" aria-label="原件与审核草稿" aria-busy={detailLoading || busy}>
        {!selectedId ? <p className="inbox-empty">选择一条资料，查看完整原文与来源。</p> : null}
        {detailLoading ? <p role="status">正在加载完整原文…</p> : null}
        {detailError ? <div role="alert" className="inbox-error">{detailError} <button type="button" disabled={detailLoading} onClick={() => selectedId && void loadSource(selectedId)}>重试加载原文</button></div> : null}
        {source ? <>
          <header className="inbox-detail-header"><h2>{source.sourceTitle || '未命名资料'}</h2><div><span>审核：{REVIEW_LABEL[source.reviewStatus]}</span><span>处理：{PROCESS_LABEL[source.processingStatus]}</span><small>审核修订 {source.reviewRevision}</small></div></header>
          <dl className="inbox-provenance">
            <dt>来源</dt><dd>{source.sourceApp || '未知应用'} · {source.sourcePlatform || '未知平台'} · {source.sourceType}</dd>
            <dt>采集时间</dt><dd>{source.capturedAt}</dd>
            <dt>来源链接</dt><dd>{sourceHref(source.sourceUrl) ? <a href={sourceHref(source.sourceUrl)} target="_blank" rel="noreferrer">{source.sourceUrl}</a> : source.sourceUrl || '未提供'}</dd>
            <dt>原件 ID</dt><dd>{source.id}</dd>
          </dl>
          <h3>{isImageSource(source) ? '原始附文（只读）' : '原始全文（只读）'}</h3><pre className="inbox-original">{source.rawText || '（原文为空）'}</pre>
          {source.surroundingContext ? <details><summary>采集上下文</summary><pre className="inbox-original">{source.surroundingContext}</pre></details> : null}
          {source.errorReason ? <p className="inbox-error">处理信息：{source.errorReason}</p> : null}
          {source.processingStatus === 'failed' && !isImageSource(source) ? <button type="button" className="button-soft" disabled={blocked} onClick={() => void retryProcessing()}>重试处理</button> : null}
          {isImageSource(source) ? <InboxImageSource key={source.id} api={api} source={source} active={active} disabled={busy || imageBusy} onProcessed={refreshAfterImage} onActivity={onImageActivity} /> : null}
          {source.reviewStatus === 'confirmed' ? <section aria-label="确认时归档结果">
            {confirmation ? <>
              <h3>确认时归档内容（只读）</h3><pre className="inbox-confirmed-text inbox-original">{confirmation.text}</pre>
              <h3>确认时归档方向（只读）</h3><p className="inbox-confirmed-path">{confirmation.path.map(node => node.title).join(' / ')}</p>
            </> : !detailLoading && detailError === null ? <p>未找到可恢复的人工确认记录。原始全文仍保留，不能据此还原确认时归档内容和方向。</p> : null}
          </section> : <><div className="inbox-target">
            {targetNodes ? <><label htmlFor="inbox-review-target">归档学科</label><select id="inbox-review-target" aria-label="归档学科" value={targetNodeId} disabled={busy || imageBusy} onChange={event => { setTargets(previous => ({ ...previous, [source.id]: event.target.value })); setUncertain(null); }}>
              <option value="">选择归档学科</option>
              {targetNodes.filter(node => node.id.trim() !== '').map(node => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
            </select></> : targetNodeId ? <p>归档节点：{targetNodeId}</p> : null}
          </div>
          <div className="inbox-draft">
            <label htmlFor="inbox-review-draft">归档草稿（独立于原文）</label>
            <p id="inbox-draft-help">确认时将草稿另存为人工知识项。延后、拒绝和恢复均保留原件。</p>
            <textarea id="inbox-review-draft" aria-describedby="inbox-draft-help" value={draft} disabled={busy || imageBusy} onChange={event => { setDrafts(previous => ({ ...previous, [source.id]: event.target.value })); setUncertain(null); }} rows={9} />
            {source.reviewStatus === 'needs_review' && !targetNodeId.trim() ? <p>请先创建或选择归档学科。</p> : null}
            {source.reviewStatus === 'needs_review' && invalidDraft ? <p>归档草稿需为 1–4,000 个字符。</p> : null}
          </div></>}
          {actionError ? <div role="alert" className="inbox-error">{actionError}{conflict ? <p>最新审核修订：{source.reviewRevision}。再次点击审核按钮会提交一次新操作。</p> : null}</div> : null}
          {uncertain && retryAvailable ? <div className="inbox-retry"><p>{source.reviewStatus === 'confirmed' ? '请求结果尚未确认。重试会复用原操作 ID 和原提交内容，恢复该操作的结果。' : '请求结果尚未确认。重试会复用同一操作 ID 和提交内容；修改草稿后将开始新操作。'}</p><button type="button" disabled={blocked} onClick={() => void review(uncertain.request.action, uncertain)}>重试审核操作</button></div> : null}
          {notice ? <p role="status">{notice}</p> : null}
          <div className="inbox-actions">
            {source.reviewStatus === 'needs_review' ? <>
              <button type="button" className="button-primary" disabled={blocked || !targetNodeId.trim() || invalidDraft} onClick={() => void review('confirm')}>确认归档</button>
              <button type="button" className="button-soft" disabled={blocked} onClick={() => void review('defer')}>延后处理</button>
              <button type="button" className="button-soft" disabled={blocked} onClick={() => void review('reject')}>拒绝</button>
            </> : null}
            {source.reviewStatus === 'deferred' || source.reviewStatus === 'rejected' ? <button type="button" className="button-soft" disabled={blocked} onClick={() => void review('restore')}>恢复待确认</button> : null}
            {onOpenItem ? <button type="button" className="button-soft" disabled={openItemBlocked} onClick={() => void openSourceDetail()}>查看原件资料</button> : null}
          </div>
        </> : null}
        {separateLocalIds.length > 0 ? <section aria-label="未提交的本地修改">
          <h3>未提交的本地修改</h3><p>以下本地草稿和方向尚未归档，与确认时记录分开保留。</p>
          {separateLocalIds.map(id => <div key={id}>
            <p>原件 ID：{id}</p>
            <label htmlFor={id === source?.id ? 'inbox-review-draft' : `inbox-local-draft-${id}`}>未提交的本地草稿（只读）</label>
            <textarea id={id === source?.id ? 'inbox-review-draft' : `inbox-local-draft-${id}`} aria-label="未提交的本地草稿" value={drafts[id] ?? draftBaselines[id] ?? ''} readOnly rows={9} />
            <p className="inbox-local-target">未提交的本地方向：{targets[id] ?? targetBaselines[id] ?? '未选择'}</p>
            <button type="button" className="button-soft" disabled={busy || imageBusy} onClick={() => discardLocalChanges(id)}>放弃本地未提交修改</button>
          </div>)}
        </section> : null}
      </section>
    </div>
  </section>;
}
