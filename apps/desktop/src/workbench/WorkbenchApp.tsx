import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import type { CreateLibraryItemInput, GraphNode, HealthResponse, ItemRelation, LibraryItem, TreeNode } from '@noltri/schema';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import { findTreePath } from './graph-navigation';
import { CourseWorkspace } from './course-workspace/CourseWorkspace';
const KIND_LABELS: Record<LibraryItem['kind'],string> = { knowledge:'知识内容',paper_excerpt:'论文摘录',web_page:'网页',image:'图片' };
const AI_LABELS: Record<LibraryItem['aiStatus'],string> = {ready:'已整理',pending:'等待整理',processing:'正在整理',failed:'可手动整理'};
type LibraryView = 'all'|'organize'|'archive';
export interface CategoryPath {id:string;labels:string[];title:string}
export interface WorkbenchAppProps {api:WorkbenchApi;apiBaseUrl:string;mcpEndpoint:string;tokenConfigured:boolean;outsideTauri:boolean;modelSettings?:ReactNode}
export default function WorkbenchApp(props:WorkbenchAppProps):ReactElement { return <CourseWorkspace {...props}/>; }
function relationLabel(relation:ItemRelation):string {if(relation.relation==='related')return '相关资料';if(relation.relation==='supports')return relation.direction==='incoming'?'该资料支持本文':'本文支持该资料';return relation.direction==='incoming'?'该资料提出相反观点':'本文提出相反观点';}
export function CaptureDialog({ api, paths, onClose, onCreated, onError }: {
  api: WorkbenchApi;
  paths: CategoryPath[];
  onClose: () => void;
  onCreated: (item: LibraryItem) => Promise<void>;
  onError: (message: string) => void;
}): ReactElement {
  const [kind, setKind] = useState<LibraryItem['kind']>('knowledge');
  const [sourceType, setSourceType] = useState<CreateLibraryItemInput['source']['type']>('manual');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [citation, setCitation] = useState('');
  const [doi, setDoi] = useState('');
  const [page, setPage] = useState('');
  const [researchPoint, setResearchPoint] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [subjectPathInput, setSubjectPathInput] = useState('');
  const [tags, setTags] = useState('');
  const [previewImageUrl, setPreviewImageUrl] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const safeImage = previewImageUrl.trim() === '' ? undefined : safeHttpUrl(previewImageUrl.trim()) ?? undefined;
    const safeSourceUrl = url.trim() === '' ? undefined : safeHttpUrl(url.trim()) ?? undefined;
    if (url.trim() !== '' && safeSourceUrl === undefined) {
      onError('来源地址请使用 http 或 https 链接。');
      return;
    }
    if (previewImageUrl.trim() !== '' && safeImage === undefined) {
      onError('封面地址请使用 http 或 https 链接。');
      return;
    }
    const category = paths.find((path) => path.id === categoryId);
    const newPath = parseSubjectPath(subjectPathInput);
    const subjectPath = newPath.length > 0 ? newPath : category?.labels;
    const input: CreateLibraryItemInput = {
      content: content.trim(),
      kind,
      source: {
        type: sourceType,
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        ...(safeSourceUrl === undefined ? {} : { url: safeSourceUrl }),
        platform: sourceType === 'web' ? '网页' : sourceType === 'agent' ? 'Agent' : sourceType === 'desktop_app' ? '桌面应用' : '手动收集',
        capturedAt: new Date().toISOString(),
        author: author.trim() || null,
        citation: citation.trim() || null,
        doi: doi.trim() || null,
        page: page.trim() || null,
      },
      ...(subjectPath === undefined ? {} : { subjectPath }),
      researchPoint: researchPoint.trim() || null,
      tags: tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
      ...(safeImage === undefined ? {} : { previewImageUrl: safeImage }),
    };
    setSaving(true);
    try {
      const result = await api.createItem(input);
      await onCreated(result.item);
    } catch (error) {
      onError(`保存失败：${describeError(error)}。原文仍在输入框中，请重试。`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="dialog-content capture-dialog" aria-labelledby="collect-title">
      <DialogHeader eyebrow="放进知识库" title="收集一条资料" onClose={onClose} />
      <p className="dialog-intro">保存原文后，AI 会自动判断学科与研究方向；你也可以手动指定或稍后修改。</p>
      <form className="capture-form" onSubmit={(event) => void submit(event)}>
        <div className="form-field">
          <label>资料类型</label>
          <div className="kind-picker" role="group" aria-label="选择资料类型">
            {(['knowledge', 'paper_excerpt', 'web_page', 'image'] as const).map((option) => (
              <button key={option} type="button" className={kind === option ? 'kind-option kind-option-active' : 'kind-option'} aria-pressed={kind === option} onClick={() => setKind(option)}>{KIND_LABELS[option]}</button>
            ))}
          </div>
        </div>
        <div className="form-two-column">
          <div className="form-field"><label htmlFor="capture-source-type">来自哪里</label>
            <select id="capture-source-type" value={sourceType} onChange={(event) => setSourceType(event.target.value as CreateLibraryItemInput['source']['type'])}>
              <option value="manual">手动摘录</option><option value="web">网页</option><option value="agent">Agent 对话</option><option value="desktop_app">桌面应用</option>
            </select>
          </div>
          <div className="form-field"><label htmlFor="capture-category">学科与研究方向</label>
            <select id="capture-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">由 AI 自动判断</option>{paths.map((path) => <option key={path.id} value={path.id}>{path.title}</option>)}
            </select>
          </div>
        </div>
        <div className="form-field"><label htmlFor="capture-new-path">新建学科或研究方向 <span>可留空</span></label><input id="capture-new-path" value={subjectPathInput} onChange={(event) => setSubjectPathInput(event.target.value)} placeholder="例如：社会科学 / 经济学 / 因果推断" /><p className="field-hint">用“/”分层；填写后会按此路径创建或归类。</p></div>
        <div className="form-field"><label htmlFor="capture-title">标题 <span>可留空</span></label><input id="capture-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={600} placeholder={kind === 'paper_excerpt' ? '论文或章节标题' : '给这条资料起个名字'} /></div>
        <div className="form-field"><label htmlFor="capture-content">原文或摘录</label><textarea id="capture-content" required minLength={8} maxLength={40000} value={content} onChange={(event) => setContent(event.target.value)} rows={6} placeholder={kind === 'paper_excerpt' ? '粘贴研究发现、方法或关键段落…' : '粘贴网页内容、Agent 答复或自己的笔记…'} data-autofocus /></div>
        {kind === 'paper_excerpt' ? <div className="form-field"><label htmlFor="capture-point">研究点 <span>这段摘录说明了什么？</span></label><input id="capture-point" value={researchPoint} onChange={(event) => setResearchPoint(event.target.value)} maxLength={1000} placeholder="例如：市场规模变化与融资约束的关系" /></div> : null}
        <details className="citation-fields">
          <summary>补充出处与标签</summary>
          <div className="form-field"><label htmlFor="capture-url">来源链接</label><input id="capture-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></div>
          {kind === 'paper_excerpt' ? (
            <div className="form-two-column">
              <div className="form-field"><label htmlFor="capture-author">作者</label><input id="capture-author" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="作者姓名" /></div>
              <div className="form-field"><label htmlFor="capture-page">页码</label><input id="capture-page" value={page} onChange={(event) => setPage(event.target.value)} placeholder="例如 12–14" /></div>
              <div className="form-field"><label htmlFor="capture-doi">DOI</label><input id="capture-doi" value={doi} onChange={(event) => setDoi(event.target.value)} placeholder="10.…" /></div>
              <div className="form-field"><label htmlFor="capture-citation">完整引用</label><input id="capture-citation" value={citation} onChange={(event) => setCitation(event.target.value)} placeholder="期刊、年份、卷期" /></div>
            </div>
          ) : null}
          <div className="form-field"><label htmlFor="capture-tags">标签</label><input id="capture-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，如：方法, 综述" /></div>
          {(kind === 'image' || kind === 'web_page') ? <div className="form-field"><label htmlFor="capture-image">封面图片地址 <span>可留空</span></label><input id="capture-image" type="url" value={previewImageUrl} onChange={(event) => setPreviewImageUrl(event.target.value)} placeholder="https://…" /></div> : null}
        </details>
        <div className="dialog-actions"><button type="button" className="button-soft" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={saving || content.trim().length < 8}>{saving ? '正在保存…' : '保存到知序'}</button></div>
      </form>
    </section>
  );
}

export function ItemDetailDialog({ api, item, items, paths, compareSelected, busy, onClose, onCompare, onUpdated, onArchive, onRestore, onError }: {
  api: WorkbenchApi;
  item: LibraryItem;
  items: LibraryItem[];
  paths: CategoryPath[];
  compareSelected: boolean;
  busy: boolean;
  onClose: () => void;
  onCompare: () => void;
  onUpdated: (item: LibraryItem) => void;
  onArchive: () => void;
  onRestore: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const currentCategory = paths.find((path) => samePath(path.labels, item.subjectPath));
  const [categoryId, setCategoryId] = useState(currentCategory?.id ?? '');
  const [subjectPathInput, setSubjectPathInput] = useState('');
  const [researchPoint, setResearchPoint] = useState(item.researchPoint ?? '');
  const [editTitle, setEditTitle] = useState(item.source.title ?? '');
  const [editContent, setEditContent] = useState(item.content);
  const [relations, setRelations] = useState<ItemRelation[]>([]);
  const [relationsError, setRelationsError] = useState<string | null>(null);
  const [relationTarget, setRelationTarget] = useState('');
  const [relationKind, setRelationKind] = useState<ItemRelation['relation']>('related');
  const [saving, setSaving] = useState(false);
  const [loadingRelations, setLoadingRelations] = useState(true);

  useEffect(() => {
    setCategoryId(currentCategory?.id ?? '');
    setSubjectPathInput('');
    setResearchPoint(item.researchPoint ?? '');
  }, [currentCategory?.id, item.id, item.researchPoint]);

  useEffect(() => { setEditTitle(item.source.title ?? ''); setEditContent(item.content); }, [item.id, item.content, item.source.title]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRelations(true);
    void api.listItemRelations(item.id).then((result) => {
      if (!cancelled) { setRelations(result); setRelationsError(null); }
    }).catch((error: unknown) => {
      if (!cancelled) setRelationsError(describeError(error));
    }).finally(() => { if (!cancelled) setLoadingRelations(false); });
    return () => { cancelled = true; };
  }, [api, item.id]);

  async function saveClassification(): Promise<void> {
    setSaving(true);
    const newPath = parseSubjectPath(subjectPathInput);
    const path = paths.find((option) => option.id === categoryId);
    try {
      const result = await api.patchItem(item.id, {
        subjectPath: newPath.length > 0 ? newPath : path?.labels ?? [],
        researchPoint: researchPoint.trim() || null,
      });
      onUpdated(result.item);
    } catch (error) {
      onError(`保存失败：${describeError(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveContent(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api.patchItem(item.id, { content: editContent.trim(), source: { title: editTitle.trim() || null } });
      onUpdated(result.item);
    } catch (error) {
      onError(`保存失败：${describeError(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function addRelation(): Promise<void> {
    if (relationTarget === '') return;
    try {
      const result = await api.createItemRelation(item.id, { targetId: relationTarget, relation: relationKind });
      setRelations((current) => [...current.filter((relation) => relation.targetId !== result.relation.targetId), result.relation]);
      setRelationTarget('');
      onError('已建立关联。');
    } catch (error) {
      onError(`关联失败：${describeError(error)}`);
    }
  }

  async function removeRelation(targetId: string): Promise<void> {
    try {
      await api.deleteItemRelation(item.id, targetId);
      setRelations((current) => current.filter((relation) => relation.targetId !== targetId));
    } catch (error) {
      onError(`移除关联失败：${describeError(error)}`);
    }
  }

  const availableTargets = items.filter((candidate) => candidate.id !== item.id && !relations.some((relation) => relation.targetId === candidate.id) && !candidate.archived);

  return (
    <div className="detail-layout">
      <div className="detail-main">
        <div className="detail-topbar"><span className="eyebrow">{KIND_LABELS[item.kind]} · {formatDate(item.source.capturedAt)}</span><button type="button" className="dialog-close" onClick={onClose} aria-label="关闭详情">×</button></div>
        <h2 id="detail-title" className="detail-title">{titleForItem(item)}</h2>
        <div className="detail-source-line">{sourceLabel(item)}{item.source.author ? ` · ${item.source.author}` : ''}{item.source.page ? ` · ${item.source.page}` : ''}</div>
        {item.aiStatus !== 'ready' ? <div className={`detail-ai-state detail-ai-${item.aiStatus}`}><span aria-hidden="true">✳</span>{AI_LABELS[item.aiStatus]}。原文已保存{item.aiStatus === 'failed' ? '，可继续手动分类和关联' : ''}。</div> : null}
        {item.summary ? <section className="detail-summary"><div className="section-eyebrow">快速回忆</div><p>{item.summary}</p></section> : null}
        {item.researchPoint ? <section className="detail-point"><div className="section-eyebrow">研究点</div><p>{item.researchPoint}</p></section> : null}
        <section className="detail-original"><div className="section-eyebrow">原文摘录</div><blockquote>{item.content}</blockquote></section>
        <details className="detail-content-editor"><summary>编辑原文与标题</summary><form className="capture-form" onSubmit={(event) => void saveContent(event)}>
          <div className="form-field"><label htmlFor="detail-edit-title">标题</label><input id="detail-edit-title" value={editTitle} maxLength={600} onChange={(event) => setEditTitle(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="detail-edit-content">原文或摘录</label><textarea id="detail-edit-content" rows={8} minLength={8} maxLength={40000} required value={editContent} onChange={(event) => setEditContent(event.target.value)} /></div>
          <button className="button-soft" type="submit" disabled={saving || editContent.trim().length < 8}>{saving ? '正在保存…' : '保存内容'}</button>
        </form></details>
        {item.source.citation ? <section className="detail-citation"><div className="section-eyebrow">引用出处</div><p>{item.source.citation}</p>{item.source.doi ? <span>DOI：{item.source.doi}</span> : null}</section> : null}
        <section className="detail-origin"><div className="section-eyebrow">来源</div>
          {item.source.title ? <p>{item.source.title}</p> : null}
          {item.source.url && safeHttpUrl(item.source.url) ? <a href={safeHttpUrl(item.source.url) ?? undefined} target="_blank" rel="noreferrer">打开原始来源 ↗</a> : null}
          <span>收集于 {formatDate(item.createdAt || item.source.capturedAt)}</span>
        </section>
      </div>
      <aside className="detail-rail" aria-label="资料操作">
        <div className="detail-actions"><button type="button" className={compareSelected ? 'button-primary button-wide' : 'button-soft button-wide'} onClick={onCompare}>{compareSelected ? '✓ 已加入对读' : '⇄ 加入对读'}</button></div>
        <section className="detail-edit-section"><div className="section-eyebrow">放在哪个方向</div>
          <label className="visually-hidden" htmlFor="detail-category">学科与研究方向</label>
          <select id="detail-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">未分类</option>{paths.map((path) => <option key={path.id} value={path.id}>{path.title}</option>)}
          </select>
          <label className="visually-hidden" htmlFor="detail-new-path">新建学科或研究方向</label><input id="detail-new-path" value={subjectPathInput} onChange={(event) => setSubjectPathInput(event.target.value)} placeholder="新路径：社会科学 / 经济学 / 因果推断" /><p className="field-hint">填写新路径后会优先使用；空着则使用上方分类。</p>
          <label className="section-eyebrow" htmlFor="detail-research-point">研究点</label>
          <textarea id="detail-research-point" rows={3} maxLength={1000} value={researchPoint} onChange={(event) => setResearchPoint(event.target.value)} placeholder="补充这条资料想回答的问题" />
          <button type="button" className="button-soft button-wide" disabled={saving} onClick={() => void saveClassification()}>{saving ? '保存中…' : '保存分类'}</button>
        </section>
        <section className="detail-edit-section"><div className="section-eyebrow">关联资料</div>
          {loadingRelations ? <p className="detail-muted">正在读取关联…</p> : null}
          {relationsError ? <p className="detail-muted">关联暂不可用：{relationsError}</p> : null}
          {relations.map((relation) => {
            const target = items.find((candidate) => candidate.id === relation.targetId);
            return <div className="relation-row" key={relation.targetId}><span className="relation-symbol" aria-hidden="true">{relation.direction === 'incoming' ? '←' : '→'}</span><div><strong>{target ? titleForItem(target) : '关联资料'}</strong><small>{relationLabel(relation)}</small></div><button type="button" aria-label="移除关联" onClick={() => void removeRelation(relation.targetId)}>×</button></div>;
          })}
          <label className="visually-hidden" htmlFor="relation-target">选择要关联的资料</label>
          <select id="relation-target" value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}>
            <option value="">选择一条资料…</option>{availableTargets.map((target) => <option key={target.id} value={target.id}>{titleForItem(target)}</option>)}
          </select>
          <div className="relation-add-row"><label className="visually-hidden" htmlFor="relation-kind">关系</label><select id="relation-kind" value={relationKind} onChange={(event) => setRelationKind(event.target.value as ItemRelation['relation'])}><option value="related">相关</option><option value="supports">支持</option><option value="contradicts">相反</option></select><button type="button" className="button-soft" disabled={relationTarget === ''} onClick={() => void addRelation()}>关联</button></div>
        </section>
        <div className="detail-archive">{item.archived ? <button type="button" className="text-action" disabled={busy} onClick={onRestore}>恢复到资料库</button> : <button type="button" className="text-action" disabled={busy} onClick={onArchive}>移到归档</button>}</div>
      </aside>
    </div>
  );
}

export function CompareDialog({ items, onClose }: { items: LibraryItem[]; onClose: () => void }): ReactElement {
  const [left, right] = items;
  const commonPath = left && right ? commonPrefix(left.subjectPath, right.subjectPath) : [];
  return (
    <section className="dialog-content compare-dialog-content" aria-labelledby="compare-title">
      <DialogHeader eyebrow="并排阅读" title="把两条资料放在一起" onClose={onClose} />
      {left && right ? <>
        <p className="compare-context">{commonPath.length > 0 ? `共同方向：${commonPath.join(' / ')}` : '两条资料来自不同方向'}{left.researchPoint && right.researchPoint && left.researchPoint !== right.researchPoint ? ' · 研究问题不同，可对照阅读' : ''}</p>
        <div className="compare-columns">
          {[left, right].map((item, index) => (
            <article className="compare-column" key={item.id}>
              <div className="compare-column-head"><span>摘录 {index + 1}</span><span>{KIND_LABELS[item.kind]}</span></div>
              <h3>{titleForItem(item)}</h3>
              <p className="compare-source">{item.source.author || item.source.title || sourceLabel(item)}{item.source.page ? ` · ${item.source.page}` : ''}</p>
              {item.researchPoint ? <div className="compare-point"><span>研究点</span><p>{item.researchPoint}</p></div> : null}
              {item.summary ? <div className="compare-summary"><span>摘要</span><p>{item.summary}</p></div> : null}
              <blockquote className="compare-excerpt">{item.content}</blockquote>
              {item.source.citation ? <p className="compare-citation">{item.source.citation}{item.source.doi ? ` · DOI ${item.source.doi}` : ''}</p> : null}
            </article>
          ))}
        </div>
      </> : <p className="empty-compare">请先从资料卡片中选两条内容。</p>}
      <div className="dialog-actions"><button type="button" className="button-primary" onClick={onClose}>完成对读</button></div>
    </section>
  );
}

export function SettingsDialog({ modelSettings, apiBaseUrl, mcpEndpoint, tokenConfigured, outsideTauri, health, healthError, onClose, onCopyEndpoint, onRefresh }: {
  modelSettings?: ReactNode;
  apiBaseUrl: string;
  mcpEndpoint: string;
  tokenConfigured: boolean;
  outsideTauri: boolean;
  health: HealthResponse | null;
  healthError: string | null;
  onClose: () => void;
  onCopyEndpoint: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <section className="dialog-content settings-dialog-content" aria-labelledby="settings-title">
      <DialogHeader eyebrow="Provider 管理" title="模型服务与收集入口" onClose={onClose} />
      {modelSettings}
      <details className="connection-details"><summary>浏览器、Agent 与本机连接</summary>
      <p className="dialog-intro">收集入口接到同一个知识库。论文摘录也可以直接从这里粘贴保存。</p>
      <div className="setup-steps">
        <div className="setup-step"><span>01</span><div><strong>网页</strong><p>安装知序浏览器扩展。遇到有用的网页或段落时，点扩展即可收集来源和内容。</p></div></div>
        <div className="setup-step"><span>02</span><div><strong>Agent</strong><p>在 Codex 或其他 Agent 的 MCP 设置中添加下方入口；之后把想留存的回答发送给知序。</p><code>{mcpEndpoint || '暂不可用'}</code><button type="button" className="copy-inline" onClick={onCopyEndpoint} disabled={!mcpEndpoint}>复制入口地址</button></div></div>
        <div className="setup-step"><span>03</span><div><strong>论文与手记</strong><p>点“快速收集”，粘贴段落，再补上作者、页码和研究点，日后就能按方向对读。</p></div></div>
      </div>
      <div className="connection-summary">
        <div><span className={health === null ? 'connection-dot connection-dot-off' : 'connection-dot'} /><strong>{health === null ? '本机服务未连接' : health.status === 'ok' ? '本机服务正常' : '本机服务需要检查'}</strong></div>
        <span>{health === null ? healthError ?? apiBaseUrl : `${health.storageDriver} · AI ${health.aiProvider}`}</span>
        {outsideTauri ? <small>当前是浏览器预览模式，读取不到应用内的本机连接设置。</small> : tokenConfigured ? <small>本机授权已配置，密钥不会显示在此处。</small> : null}
        <button type="button" className="text-action" onClick={onRefresh}>重新检查连接</button>
      </div>
      </details>
    </section>
  );
}

function EmptyLibrary({ view, hasQuery, hasMore, onClear, onCollect }: {
  view: LibraryView;
  hasQuery: boolean;
  hasMore: boolean;
  onClear: () => void;
  onCollect: () => void;
}): ReactElement {
  if (hasQuery) {
    return <div className="empty-state empty-state-filtered"><div className="empty-orbit" aria-hidden="true">⌕</div><h2>这里暂时没有匹配的资料</h2><p>{hasMore ? '还有资料尚未载入，可以继续查看。' : '试试其他关键词，或清除当前筛选条件。'}</p><button className="button-soft" type="button" onClick={onClear}>清除筛选</button></div>;
  }
  if (view === 'archive') {
    return <div className="empty-state"><div className="empty-orbit" aria-hidden="true">⌑</div><h2>归档还是空的</h2><p>不常用的资料可以放进归档，需要时随时恢复。</p></div>;
  }
  if (view === 'organize') {
    return <div className="empty-state"><div className="empty-orbit" aria-hidden="true">✳</div><h2>目前没有待整理内容</h2><p>需要整理或暂时无法自动整理的资料会显示在这里。</p></div>;
  }
  return (
    <div className="empty-state empty-state-first">
      <div className="empty-art" aria-hidden="true"><div className="empty-paper empty-paper-back" /><div className="empty-paper empty-paper-front"><span>知</span><i /><i /><i /></div><span className="empty-spark empty-spark-one">✳</span><span className="empty-spark empty-spark-two">·</span></div>
      <div className="eyebrow">从一个想法开始</div><h2>你的知识树，正等着第一片叶子</h2><p>保存看不懂的概念、网页灵感，或论文里值得回看的那一段。知序会把它们放到一起。</p><button className="button-primary" type="button" onClick={onCollect}>收集第一条资料 <span aria-hidden="true">→</span></button>
    </div>
  );
}

function DialogHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }): ReactElement {
  return <header className="dialog-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div><button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button></header>;
}

function collectPaths(nodes: readonly TreeNode[], prefix: string[] = []): CategoryPath[] {
  return nodes.flatMap((node) => {
    const labels = [...prefix, node.title];
    return [{ id: node.id, labels, title: labels.join(' / ') }, ...collectPaths(node.children ?? [], labels)];
  });
}

function collectClassificationOptions(nodes: readonly TreeNode[], prefix: string[] = []): { id: string; title: string }[] {
  return nodes.flatMap((node) => {
    const labels = [...prefix, node.title];
    const current = node.nodeType === 'topic' || node.nodeType === 'chapter' ? [] : [{ id: node.id, title: labels.join(' / ') }];
    return [...current, ...collectClassificationOptions(node.children ?? [], labels)];
  });
}

function collectTopicNodes(nodes: readonly TreeNode[], disciplineId: string, parents: readonly TreeNode[] = []): GraphNode[] {
  return nodes.flatMap((node) => {
    const path = [...parents, node];
    const current = node.nodeType === 'topic' && path[0]?.id === disciplineId
      ? [{ id: node.id, title: node.title, nodeType: 'topic' as const, parentId: parents.at(-1)?.id ?? null, summary: node.summary }]
      : [];
    return [...current, ...collectTopicNodes(node.children ?? [], disciplineId, path)];
  });
}

function graphNodeFromTree(nodes: readonly TreeNode[], id: string): GraphNode | null {
  const path = findTreePath(nodes, id);
  const node = path?.at(-1);
  if (node === undefined || (node.nodeType !== 'topic' && node.nodeType !== 'chapter')) return null;
  return {
    id: node.id,
    title: node.title,
    nodeType: node.nodeType,
    parentId: path!.at(-2)?.id ?? null,
    summary: node.summary,
  };
}

function findTreeDisciplineId(nodes: readonly TreeNode[], id: string): string | null {
  return findTreePath(nodes, id)?.[0]?.id ?? null;
}

function toggleSet(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function isWithinPath(itemPath: string[], selectedPath: string[]): boolean {
  return selectedPath.every((segment, index) => itemPath[index] === segment);
}

export function parseSubjectPath(input: string): string[] {
  return input.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

export function toggleComparedItems(current: LibraryItem[], item: LibraryItem): LibraryItem[] {
  if (current.some((selected) => selected.id === item.id)) {
    return current.filter((selected) => selected.id !== item.id);
  }
  return current.length >= 2 ? current : [...current, item];
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function commonPrefix(left: string[], right: string[]): string[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return left.slice(0, length);
}

function titleForItem(item: LibraryItem): string {
  return item.source.title?.trim() || firstSentence(item.researchPoint || item.summary || item.content) || KIND_LABELS[item.kind];
}

function firstSentence(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentence = clean.split(/(?<=[。！？.!?])\s/)[0] ?? clean;
  return excerpt(sentence, 58);
}

function excerpt(text: string | null | undefined, maxLength: number): string {
  if (text === null || text === undefined) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trimEnd()}…` : clean;
}

function sourceLabel(item: LibraryItem): string {
  return item.source.platform || item.source.appName || (item.source.type === 'agent' ? 'Agent' : item.source.type === 'web' ? '网页' : item.source.type === 'desktop_app' ? '桌面应用' : '手动摘录');
}

function sourceHost(item: LibraryItem): string | null {
  const url = safeHttpUrl(item.source.url);
  if (url === null) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}
