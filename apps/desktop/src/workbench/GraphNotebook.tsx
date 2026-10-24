import { MAX_GRAPH_NOTE_CHARS } from '@noltri/schema';
import type { GraphEdge, GraphNode, GraphScope, NodeDetail } from '@noltri/schema';
import type { ReactElement, ReactNode, RefObject } from 'react';
import type { NoteIdentity } from './note-drafts';
import { graphChapterAttachment } from './graph-navigation';
import type { WorkbenchContent } from './graph-navigation';

export function ChapterChoicePanel({
  chapterTitle,
  candidates,
  action,
  onChoose,
}: {
  chapterTitle: string;
  candidates: readonly { id: string; title: string }[];
  action: 'open' | 'more';
  onChoose: (topicId: string) => void;
}): ReactElement {
  return <section className="chapter-choice chapter-choice-global" aria-live="polite" aria-label={action === 'more' ? '选择章节更多信息' : '选择章节正文所属主题'}>
    <strong>“{chapterTitle}”关联多个主题</strong>
    <p>{action === 'more' ? '选择一个关联主题以查看更多信息。' : '选择正文所属主题后继续阅读。'}</p>
    {candidates.length > 0 ? <div>{candidates.map((candidate) => <button type="button" className="button-soft" key={candidate.id} aria-label={action === 'more' ? `查看「${candidate.title}」更多信息` : undefined} onClick={() => onChoose(candidate.id)}>{candidate.title}</button>)}</div> : <p role="alert">当前无法显示可用主题。</p>}
  </section>;
}

export interface GraphNotebookProps {
  content: WorkbenchContent;
  scope: GraphScope | null;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  pathLabel: string;
  loading: boolean;
  error: string | null;
  note: { identity: NoteIdentity; vaultRoot: string; title: string; content: string; status: 'loading' | 'saved' | 'saving' | 'error'; error?: string; loadFailed?: boolean; rootMismatch?: boolean; draftRecoverable?: boolean } | null;
  notes: readonly { topicId: string; chapterId: string | null; chapterTitle: string | null; updatedAt: string; attached: boolean }[];
  connectableTopics: readonly GraphNode[];
  historyAvailable: boolean;
  choice: { chapterTitle: string; candidates: readonly { id: string; title: string }[]; action: 'open' | 'more' } | null;
  moreOpen: boolean;
  moreDetail: NodeDetail | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  search: string;
  searchError: string | null;
  searchLoading: boolean;
  searchHits: readonly { itemId: string | null; nodeId: string | null; title: string; text: string; score: number }[];
  classificationOptions: readonly { id: string; title: string }[];
  onSearch: (query: string) => void;
  renderTopicCard: (node: GraphNode, onOpen: () => void, onMore: () => void) => ReactNode;
  onOpenTopic: (node: GraphNode) => void;
  onOpenChapter: (chapterId: string) => void;
  onOpenOrphan: (topicId: string, chapterId: string, title: string) => void;
  onChooseTopic: (topicId: string) => void;
  onBack: () => void;
  onChangeNote: (content: string) => void;
  onRetrySave: () => void;
  onMore: (topicId: string) => void;
  onCloseMore: () => void;
  onMoveTopic: (topicId: string, targetParentId: string) => void;
  onCreateChapter: () => void;
  onChapterTitleChange: (title: string) => void;
  newChapterOpen: boolean;
  newChapterTitle: string;
  actionBusy: boolean;
  onToggleNewChapter: () => void;
  onDetachChapter: () => void;
  onConnectChapter: (topicId: string) => void;
  onOpenSearchHit: (nodeId: string) => void;
  onOpenSearchItem: (itemId: string) => void;
  onCollect: () => void;
  onToggleTheme: () => void;
  theme: 'dark' | 'light';
}

export function GraphNotebook({
  content,
  scope,
  nodes,
  edges,
  pathLabel,
  loading,
  error,
  note,
  notes,
  connectableTopics,
  historyAvailable,
  choice,
  moreOpen,
  moreDetail,
  scrollRef,
  search,
  searchError,
  searchLoading,
  searchHits,
  classificationOptions,
  onSearch,
  renderTopicCard,
  onOpenTopic,
  onOpenChapter,
  onOpenOrphan,
  onChooseTopic,
  onBack,
  onChangeNote,
  onRetrySave,
  onMore,
  onCloseMore,
  onMoveTopic,
  onCreateChapter,
  onChapterTitleChange,
  newChapterOpen,
  newChapterTitle,
  actionBusy,
  onToggleNewChapter,
  onDetachChapter,
  onConnectChapter,
  onOpenSearchHit,
  onOpenSearchItem,
  onCollect,
  onToggleTheme,
  theme,
}: GraphNotebookProps): ReactElement {
  const topicId = content.kind === 'topic' || content.kind === 'chapter' ? content.topicId : null;
  const topic = topicId === null ? null : nodes.find((node) => node.id === topicId) ?? null;
  const chapterNodes = topicId === null ? [] : nodes.filter((node) => node.nodeType === 'chapter'
    && edges.some((edge) => edge.fromNodeId === node.id && edge.toNodeId === topicId));
  const topicNodes = uniqueTopics(nodes);
  const orphanNotes = notes.filter((entry) => !entry.attached && entry.chapterId !== null);
  const chapterAttachment = content.kind === 'chapter' ? graphChapterAttachment(notes, content.topicId, content.chapterId) : null;
  const rootLabel = scope === null ? '主题' : scope.kind === 'discipline' ? '学科' : scope.kind === 'subdiscipline' ? '研究方向' : '主题';
  const morePane = moreOpen ? <section className="topic-more-pane" aria-label="主题更多信息">
    <header><div><div className="eyebrow">主题信息</div><h2>{moreDetail?.node.title ?? topic?.title ?? note?.title ?? '主题更多信息'}</h2></div><button className="dialog-close" type="button" onClick={onCloseMore} aria-label="关闭更多信息">×</button></header>
    {moreDetail === null ? <p className="empty-hint">正在读取主题来源和关系…</p> : <>
      {moreDetail.node.summary ? <p>{moreDetail.node.summary}</p> : null}
      <div className="more-stat-line"><span>{moreDetail.stats.itemCount} 条知识内容</span><span>{moreDetail.stats.sourceCount} 个来源</span><span>{moreDetail.stats.childCount} 个下级节点</span></div>
      <label className="more-field"><span>调整分类</span><select value={moreDetail.node.parentId ?? ''} onChange={(event) => onMoveTopic(moreDetail.node.id, event.target.value)}><option value="">根节点</option>{classificationOptions.filter((option) => option.id !== moreDetail.node.id).map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>
      {moreDetail.items.length > 0 ? <div className="more-source-list"><strong>来源</strong>{moreDetail.items.flatMap((entry) => entry.sources).map((source) => <a key={source.rawSourceId} href={source.sourceUrl ?? undefined} target={source.sourceUrl ? '_blank' : undefined} rel={source.sourceUrl ? 'noreferrer' : undefined}>{source.sourceTitle ?? source.sourcePlatform ?? '未命名来源'}</a>)}</div> : <p className="empty-hint">没有关联的原始来源。</p>}
      {moreDetail.relatedNodes.length > 0 ? <div className="more-relationship-list"><strong>相关主题</strong>{moreDetail.relatedNodes.map((entry) => <div className="related-topic-row" key={`${entry.node.id}:${entry.relationType}`}><span>{entry.node.title}</span><small>{entry.relationType}</small></div>)}</div> : null}
      {content.kind === 'chapter' && topicId !== null ? <div className="more-relationship-list"><strong>章节关系</strong><span>当前主题：{topic?.title ?? topicId}</span>{connectableTopics.filter((node) => node.id !== topicId).map((node) => <button type="button" className="button-soft" key={node.id} disabled={actionBusy} onClick={() => onConnectChapter(node.id)}>关联到「{node.title}」</button>)}</div> : null}
    </>}
  </section> : null;

  return (
    <div className="notebook-center">
      <span className="editor-width-probe" aria-hidden="true" />
      {choice !== null ? <ChapterChoicePanel chapterTitle={choice.chapterTitle} candidates={choice.candidates} action={choice.action} onChoose={onChooseTopic} /> : null}
      <header className="notebook-header">
        <div className="header-copy">
          <div className="eyebrow">{pathLabel}</div>
          <h1>{content.kind === 'cards' ? pathLabel.split(' / ').at(-1) || rootLabel : note?.title ?? '知识正文'}</h1>
          <p>{content.kind === 'cards' ? '选择一张主题卡片，打开可编辑的主题笔记。' : '在正文中直接阅读和编辑，内容会自动保存。'}</p>
        </div>
        <div className="header-actions">
          {historyAvailable ? <button className="button-quiet" type="button" onClick={onBack} aria-label="返回上一段阅读">← 返回</button> : null}
          <button className="button-quiet theme-header-toggle" type="button" onClick={onToggleTheme} aria-label={`切换到${theme === 'dark' ? '浅色' : '深色'}模式`}>{theme === 'dark' ? '☼' : '☾'}</button>
          <button className="button-primary" type="button" onClick={onCollect}><span className="button-plus" aria-hidden="true">＋</span>快速收集</button>
        </div>
      </header>

      {scope !== null ? <label className="search-field notebook-search">
        <span aria-hidden="true" className="search-icon">⌕</span>
        <input type="search" value={search} maxLength={2000} onChange={(event) => onSearch(event.target.value)} placeholder="在当前学科范围中搜索…" aria-label="搜索当前知识范围" />
        {search !== '' ? <button type="button" className="clear-search" onClick={() => onSearch('')} aria-label="清空搜索">×</button> : null}
      </label> : null}

      {morePane}

      {scope !== null && search.trim() !== '' ? (
        <section className="graph-search-results" aria-label="搜索结果">
          {searchError !== null ? <div className="inline-error" role="alert">{searchError}</div> : null}
          {searchHits.map((hit, index) => <button type="button" className="graph-search-hit" key={`${hit.nodeId ?? hit.itemId ?? index}:${index}`} disabled={hit.nodeId === null && hit.itemId === null} onClick={() => hit.itemId !== null ? onOpenSearchItem(hit.itemId) : hit.nodeId !== null && onOpenSearchHit(hit.nodeId)}>
            <strong>{hit.title}</strong><span>{hit.text}</span><small>{hit.itemId !== null ? '资料来源' : '知识节点'}</small>
          </button>)}
          {!searchLoading && searchError === null && searchHits.length === 0 ? <p className="empty-hint">没有找到范围内的匹配结果。</p> : null}
          {searchLoading ? <p className="empty-hint">正在搜索…</p> : null}
        </section>
      ) : content.kind === 'cards' ? (
        <div className="notebook-scroll" ref={scrollRef}>
          {error !== null ? <div className="inline-error" role="alert"><span>Graph 数据暂不可用：{error}</span></div> : null}
          {loading && nodes.length === 0 ? <div className="loading-state" role="status"><span className="loader" />正在读取主题…</div> : error !== null ? null : topicNodes.length === 0 ? (
            <div className="empty-state"><div className="empty-orbit" aria-hidden="true">⌘</div><h2>这里还没有主题</h2><p>主题出现后，会以知识卡片显示在这里。</p><button className="button-primary" type="button" onClick={onCollect}>快速收集</button></div>
          ) : (
            <section className="card-grid" aria-label="主题卡片">
              {topicNodes.map((node) => renderTopicCard(node, () => onOpenTopic(node), () => onMore(node.id)))}
            </section>
          )}
        </div>
      ) : (
        <div className="notebook-scroll" ref={scrollRef}>
          {topic !== null && content.kind === 'topic' ? <section className="chapter-directory" aria-label="当前主题目录">
            <div className="chapter-directory-head"><span>章节目录</span><button type="button" className="text-action" onClick={onToggleNewChapter}>{newChapterOpen ? '取消' : '＋ 新章节'}</button></div>
            {newChapterOpen ? <form className="chapter-create-form" onSubmit={(event) => { event.preventDefault(); onCreateChapter(); }}><input value={newChapterTitle} maxLength={200} onChange={(event) => onChapterTitleChange(event.target.value)} placeholder="章节名称" aria-label="新章节名称" /><button type="submit" className="button-soft" disabled={actionBusy || newChapterTitle.trim() === ''}>创建</button></form> : null}
            {chapterNodes.length === 0 ? <p className="empty-hint">还没有章节，可以继续编辑主题概览。</p> : <div className="chapter-list">{chapterNodes.map((chapter) => <button className="chapter-row" type="button" key={chapter.id} onClick={() => onOpenChapter(chapter.id)}><span>{chapter.title}</span><span aria-hidden="true">›</span></button>)}</div>}
            {orphanNotes.length > 0 ? <details className="orphan-notes"><summary>未归属章节正文（{orphanNotes.length}）</summary>{orphanNotes.map((entry) => <button type="button" className="chapter-row" key={`${entry.topicId}:${entry.chapterId}`} onClick={() => onOpenOrphan(entry.topicId, entry.chapterId!, entry.chapterTitle ?? '未命名章节')}><span>{entry.chapterTitle ?? '未命名章节'}</span><small>正文保留</small></button>)}</details> : null}
          </section> : null}

          {note === null || note.status === 'loading' ? <div className="loading-state" role="status"><span className="loader" />正在载入正文…</div> : (
            <section className="note-writing-area" aria-label={`${note.title}正文编辑区`}>
              <div className="note-status-row">
                <span className={`note-save-status note-save-${note.status}`} role="status">{note.status === 'saved' ? '已保存' : note.status === 'saving' ? '自动保存中…' : note.rootMismatch ? 'Vault 已切换；正文已隔离' : note.loadFailed ? '正文载入失败；未修改正文' : note.draftRecoverable ? '保存失败；草稿可恢复' : '保存失败；请保持本页并重试'}</span>
                {note.status === 'error' ? <button type="button" className="text-action" onClick={onRetrySave}>{note.rootMismatch ? '在当前 Vault 重新载入' : note.loadFailed ? '重新载入正文' : '重试保存'}</button> : null}
                {chapterAttachment === 'detached' ? <span className="note-unattached-label">未归属章节</span> : null}
              </div>
              {note.error ? <p className="note-save-error" role="alert">{note.error}</p> : null}
              <textarea className="note-editor" value={note.content} readOnly={note.loadFailed === true || note.rootMismatch === true} onChange={(event) => onChangeNote(event.target.value)} placeholder={note.rootMismatch ? 'Vault 已切换，请在当前 Vault 重新载入。' : note.loadFailed ? '正文尚未载入，请重新载入后编辑。' : '从这里开始写下你的理解…'} aria-label={`${note.title}正文`} />
              {note.content.length > MAX_GRAPH_NOTE_CHARS ? <p className="note-save-error" role="status">{note.content.length.toLocaleString()} / {MAX_GRAPH_NOTE_CHARS.toLocaleString()} 字符；超出部分保留在当前正文和本机草稿中，缩短后即可保存。</p> : null}
              <div className="note-footer-actions">
                <button type="button" className="button-quiet" onClick={() => topicId !== null && onMore(topicId)}>更多主题信息</button>
                {content.kind === 'chapter' ? <button type="button" className="text-action" disabled={actionBusy} onClick={onDetachChapter}>解除当前主题关联</button> : null}
              </div>
            </section>
          )}

          {content.kind === 'chapter' && topicId !== null && connectableTopics.some((node) => node.id !== topicId) ? <label className="chapter-connect-field"><span>将此章节关联到同学科主题</span><select value="" disabled={actionBusy} onChange={(event) => { if (event.target.value) onConnectChapter(event.target.value); }}><option value="">选择主题…</option>{connectableTopics.filter((node) => node.id !== topicId).map((node) => <option value={node.id} key={node.id}>{node.title}</option>)}</select></label> : null}

        </div>
      )}

    </div>
  );
}

function uniqueTopics(nodes: readonly GraphNode[]): GraphNode[] {
  const found = new Map<string, GraphNode>();
  for (const node of nodes) if (node.nodeType === 'topic' && !found.has(node.id)) found.set(node.id, node);
  return [...found.values()];
}
