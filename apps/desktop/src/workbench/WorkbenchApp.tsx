import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, SyntheticEvent } from 'react';
import { MAX_GRAPH_NOTE_CHARS } from '@noltri/schema';
import type { CreateLibraryItemInput, GraphEdge, GraphNode, GraphNoteIndexEntry, GraphScope, HealthResponse, ItemRelation, LibraryItem, NodeDetail, SearchHit, TreeNode } from '@noltri/schema';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import { clearNoteDraft, listNoteDrafts, readNoteDraft, writeNoteDraft } from './note-drafts';
import type { NoteDraft, NoteIdentity } from './note-drafts';
import { scheduleLibraryItemsLoad } from './library-items-query';
import { commitLatestNavigation, contentIdentity, disciplineScopesForTopics, findTreePath, graphChapterAttachment, graphChapterTitle, graphScopeIdentity, NavigationIntentClock, searchGraphNodes, selectionForTreeNode, shouldReuseActiveNote } from './graph-navigation';
import type { WorkbenchContent } from './graph-navigation';
import { ChapterChoicePanel, GraphNotebook } from './GraphNotebook';
import { WorkbenchGraph } from './WorkbenchGraph';

const PAGE_SIZE = 200;
const KIND_LABELS: Record<LibraryItem['kind'], string> = {
  knowledge: '知识卡片',
  paper_excerpt: '论文摘录',
  web_page: '网页',
  image: '图片',
};
const AI_LABELS: Record<LibraryItem['aiStatus'], string> = {
  ready: '已整理',
  pending: '等待整理',
  processing: '正在整理',
  failed: '可手动整理',
};
function relationLabel(relation: ItemRelation): string {
  if (relation.relation === 'related') return '相关资料';
  if (relation.relation === 'supports') return relation.direction === 'incoming' ? '该资料支持本文' : '本文支持该资料';
  return relation.direction === 'incoming' ? '该资料提出相反观点' : '本文提出相反观点';
}

type LibraryView = 'all' | 'organize' | 'archive';
type Overlay = 'detail' | 'collect' | 'compare' | 'settings' | null;
interface CategoryPath {
  id: string;
  labels: string[];
  title: string;
}

type GraphPanelMode = 'entry' | 'mini' | 'expanded';
type NoteSaveStatus = 'loading' | 'saved' | 'saving' | 'error';
type ColorTheme = 'dark' | 'light';

interface ActiveGraphNote {
  identity: NoteIdentity;
  title: string;
  content: string;
  status: NoteSaveStatus;
  error?: string;
  loadFailed?: boolean;
  draftRecoverable?: boolean;
}

interface ChapterChoice {
  chapterId: string;
  topicIds: string[];
  scope: GraphScope;
  activateScope: boolean;
  action: 'open' | 'more';
}

interface LoadNoteOptions {
  intent: number;
  addHistory?: boolean;
  transitionPrepared?: boolean;
  collapseNavigation?: boolean;
  forceReload?: boolean;
}

interface ReadingHistoryEntry {
  content: WorkbenchContent;
  scope: GraphScope | null;
  mode: GraphPanelMode;
  navCollapsed: boolean;
}

export interface WorkbenchAppProps {
  api: WorkbenchApi;
  apiBaseUrl: string;
  mcpEndpoint: string;
  tokenConfigured: boolean;
  outsideTauri: boolean;
  modelSettings?: ReactNode;
}

export default function WorkbenchApp({
  api,
  apiBaseUrl,
  mcpEndpoint,
  tokenConfigured,
  outsideTauri,
  modelSettings,
}: WorkbenchAppProps): ReactElement {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [itemsReloadVersion, setItemsReloadVersion] = useState(0);
  const [view, setView] = useState<LibraryView>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [openNodes, setOpenNodes] = useState<Set<string>>(() => new Set());
  const [contentSelection, setContentSelection] = useState<WorkbenchContent>({ kind: 'library' });
  const [graphScope, setGraphScope] = useState<GraphScope | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [graphNotes, setGraphNotes] = useState<GraphNoteIndexEntry[]>([]);
  const [graphQuery, setGraphQuery] = useState('');
  const [graphSearchHits, setGraphSearchHits] = useState<SearchHit[]>([]);
  const [graphSearchError, setGraphSearchError] = useState<string | null>(null);
  const [graphSearchLoading, setGraphSearchLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphMode, setGraphMode] = useState<GraphPanelMode>('entry');
  const [graphPanelWidth, setGraphPanelWidth] = useState(420);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [activeNote, setActiveNote] = useState<ActiveGraphNote | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<NoteDraft[]>([]);
  const [chapterChoice, setChapterChoice] = useState<ChapterChoice | null>(null);
  const [moreDetail, setMoreDetail] = useState<NodeDetail | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [newChapterOpen, setNewChapterOpen] = useState(false);
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [chapterActionBusy, setChapterActionBusy] = useState(false);
  const [theme, setTheme] = useState<ColorTheme>(() => readColorTheme());
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<LibraryItem['kind'] | 'all'>('all');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [compareItems, setCompareItems] = useState<LibraryItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRequestId = useRef(0);
  const graphRequestId = useRef(0);
  const graphSearchRequestId = useRef(0);
  const noteLoadRequestId = useRef(0);
  const navigationIntent = useRef(new NavigationIntentClock());
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteSaveChain = useRef<Promise<void>>(Promise.resolve());
  const activeNoteRef = useRef<ActiveGraphNote | null>(null);
  const contentRef = useRef<WorkbenchContent>({ kind: 'library' });
  const graphScopeRef = useRef<GraphScope | null>(null);
  const contentHistory = useRef<ReadingHistoryEntry[]>([]);
  const noteScrollPositions = useRef(new Map<string, number>());
  const centerRef = useRef<HTMLElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const graphPanelRef = useRef<HTMLElement | null>(null);
  const noteScrollRef = useRef<HTMLDivElement | null>(null);
  const graphResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function beginNavigationIntent(): number {
    return navigationIntent.current.begin();
  }

  function isCurrentNavigationIntent(intent: number): boolean {
    return navigationIntent.current.isCurrent(intent);
  }

  const refresh = useCallback(async (): Promise<void> => {
    const [treeResult, healthResult] = await Promise.allSettled([
      Promise.resolve().then(() => api.tree()),
      Promise.resolve().then(() => api.health()),
    ]);
    if (treeResult.status === 'fulfilled') {
      setTree(treeResult.value.nodes);
      setTreeError(null);
      setOpenNodes((current) => {
        if (current.size > 0) return current;
        return new Set(treeResult.value.nodes.map((node) => node.id));
      });
    } else {
      setTreeError(describeError(treeResult.reason));
    }
    if (healthResult.status === 'fulfilled') {
      setHealth(healthResult.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(describeError(healthResult.reason));
    }
  }, [api]);

  function replaceActiveNote(next: ActiveGraphNote | null): void {
    activeNoteRef.current = next;
    setActiveNote(next);
  }

  function replaceContent(next: WorkbenchContent): void {
    contentRef.current = next;
    setContentSelection(next);
  }

  function replaceGraphScope(next: GraphScope | null): void {
    graphScopeRef.current = next;
    setGraphScope(next);
  }

  function pushCurrentHistory(): void {
    contentHistory.current.push({ content: contentRef.current, scope: graphScopeRef.current, mode: graphMode, navCollapsed });
  }

  function refreshPendingDrafts(): void {
    setPendingDrafts(listNoteDrafts());
  }

  async function loadGraph(scope: GraphScope): Promise<void> {
    const requestId = ++graphRequestId.current;
    setGraphLoading(true);
    setGraphError(null);
    setGraphNodes([]);
    setGraphEdges([]);
    try {
      const result = await api.selectGraph(scope);
      if (requestId !== graphRequestId.current) return;
      setGraphNodes(result.nodes);
      setGraphEdges(result.edges);
      setGraphError(null);
    } catch (error) {
      if (requestId === graphRequestId.current) setGraphError(describeError(error));
    } finally {
      if (requestId === graphRequestId.current) setGraphLoading(false);
    }
  }

  function rememberReadingPosition(): void {
    if (activeNoteRef.current !== null && noteScrollRef.current !== null) {
      noteScrollPositions.current.set(contentIdentity(contentRef.current), noteScrollRef.current.scrollTop);
    }
  }

  async function prepareContentTransition(next: WorkbenchContent, addHistory: boolean, intent: number): Promise<boolean> {
    if (!isCurrentNavigationIntent(intent)) return false;
    if (contentIdentity(contentRef.current) === contentIdentity(next)) return true;
    const canLeave = await flushActiveNote();
    if (!isCurrentNavigationIntent(intent)) return false;
    if (!canLeave) {
      const active = activeNoteRef.current;
      setNotice(active?.loadFailed
        ? '正文尚未载入。为避免覆盖已有内容，请重新载入后再切换。'
        : '正文尚未保存，且本地恢复草稿不可用；请重试保存后再切换。');
      return false;
    }
    rememberReadingPosition();
    if (addHistory) pushCurrentHistory();
    return true;
  }

  async function persistNoteSnapshot(note: ActiveGraphNote): Promise<{ serverSaved: boolean; localSaved: boolean }> {
    const draft: NoteDraft = { ...note.identity, content: note.content, updatedAt: new Date().toISOString() };
    const localSaved = writeNoteDraft(draft);
    refreshPendingDrafts();
    if (sameNoteIdentity(activeNoteRef.current?.identity, note.identity) && activeNoteRef.current?.content === note.content
      && activeNoteRef.current.status !== 'saving') {
      replaceActiveNote({ ...activeNoteRef.current, status: 'saving', error: undefined });
    }

    if (note.content.length > MAX_GRAPH_NOTE_CHARS) {
      const error = `正文为 ${note.content.length.toLocaleString()} 个字符，超过服务器上限 ${MAX_GRAPH_NOTE_CHARS.toLocaleString()} 个字符。${localSaved ? '草稿已保存在本机；请缩短正文后重试。' : '本机草稿也无法保存；请缩短正文后重试。'}`;
      const current = activeNoteRef.current;
      if (sameNoteIdentity(current?.identity, note.identity) && current?.content === note.content) {
        replaceActiveNote({ ...current, status: 'error', error, draftRecoverable: localSaved });
      }
      return { serverSaved: false, localSaved };
    }

    let serverSaved = false;
    let saveError: string | undefined;
    const operation = noteSaveChain.current.catch(() => undefined).then(async () => {
      try {
        await api.saveGraphNote(note.identity.topicId, {
          chapterId: note.identity.chapterId,
          content: note.content,
        });
        serverSaved = true;
        clearNoteDraft(note.identity, note.content);
      } catch (error) {
        saveError = describeError(error);
      }
    });
    noteSaveChain.current = operation.then(() => undefined);
    await operation;
    refreshPendingDrafts();

    const current = activeNoteRef.current;
    if (sameNoteIdentity(current?.identity, note.identity) && current?.content === note.content) {
      replaceActiveNote(serverSaved
        ? { ...current, status: 'saved', error: undefined, draftRecoverable: false }
        : { ...current, status: 'error', error: saveError ?? '保存失败。', draftRecoverable: localSaved });
    }
    return { serverSaved, localSaved };
  }

  async function flushActiveNote(): Promise<boolean> {
    while (true) {
      const active = activeNoteRef.current;
      if (active === null) return true;
      if (active.status === 'loading') return true;
      if (active.loadFailed) return false;
      if (active.status === 'saved' && readNoteDraft(active.identity) === null) return true;
      if (noteSaveTimer.current !== null) {
        clearTimeout(noteSaveTimer.current);
        noteSaveTimer.current = null;
      }
      const result = await persistNoteSnapshot(active);
      const latest = activeNoteRef.current;
      if (sameNoteIdentity(latest?.identity, active.identity) && latest?.content !== active.content) continue;
      return result.serverSaved || result.localSaved;
    }
  }

  async function loadNote(identity: NoteIdentity, title: string, selection: WorkbenchContent, options: LoadNoteOptions): Promise<void> {
    const { intent, addHistory = true, transitionPrepared = false, collapseNavigation = true, forceReload = false } = options;
    if (!isCurrentNavigationIntent(intent)) return;
    const current = contentRef.current;
    if (contentIdentity(current) !== contentIdentity(selection)) {
      if (!transitionPrepared && !(await prepareContentTransition(selection, addHistory, intent))) return;
      if (!isCurrentNavigationIntent(intent)) return;
    }

    const active = activeNoteRef.current;
    if (shouldReuseActiveNote(active?.identity ?? null, identity, forceReload)) {
      if (active === null) return;
      replaceContent(selection);
      setChapterChoice(null);
      setMoreOpen(false);
      setMoreDetail(null);
      if (collapseNavigation) setNavCollapsed(true);
      if (active.title !== title) replaceActiveNote({ ...active, title });
      return;
    }

    replaceContent(selection);
    setChapterChoice(null);
    setMoreOpen(false);
    setMoreDetail(null);
    if (collapseNavigation) setNavCollapsed(true);

    const requestId = ++noteLoadRequestId.current;
    replaceActiveNote({ identity, title, content: '', status: 'loading' });
    try {
      const [serverResult, indexResult] = await Promise.allSettled([
        api.graphNote(identity.topicId, identity.chapterId),
        api.listGraphNotes(identity.topicId),
      ]);
      if (requestId !== noteLoadRequestId.current) return;
      if (indexResult.status === 'fulfilled') setGraphNotes(indexResult.value.notes);
      else setGraphNotes([]);
      if (serverResult.status === 'rejected') throw serverResult.reason;

      const serverNote = serverResult.value;
      const draft = readNoteDraft(identity);
      const draftWins = draft !== null && (serverNote.updatedAt === null
        || (Number.isFinite(Date.parse(draft.updatedAt)) && Number.isFinite(Date.parse(serverNote.updatedAt))
          ? Date.parse(draft.updatedAt) >= Date.parse(serverNote.updatedAt)
          : true));
      if (draft !== null && !draftWins) clearNoteDraft(identity, draft.content);
      const content = draftWins ? draft!.content : serverNote.content;
      replaceActiveNote({ identity, title, content, status: draftWins ? 'saving' : 'saved', draftRecoverable: draftWins });
    } catch (error) {
      if (requestId !== noteLoadRequestId.current) return;
      const draft = readNoteDraft(identity);
      if (draft !== null) {
        replaceActiveNote({ identity, title, content: draft.content, status: 'error', error: `服务器暂不可用：${describeError(error)}`, draftRecoverable: true });
      } else {
        replaceActiveNote({ identity, title, content: '', status: 'error', error: describeError(error), loadFailed: true });
      }
    }
    refreshPendingDrafts();
    const position = noteScrollPositions.current.get(contentIdentity(selection)) ?? 0;
    requestAnimationFrame(() => {
      if (contentIdentity(contentRef.current) === contentIdentity(selection) && noteScrollRef.current !== null) {
        noteScrollRef.current.scrollTop = position;
      }
    });
  }

  async function navigateToCards(scope: GraphScope, selectedId: string, intent = beginNavigationIntent(), addHistory = true): Promise<void> {
    const next: WorkbenchContent = { kind: 'cards', scope, selectedNodeId: selectedId };
    if (!(await prepareContentTransition(next, addHistory, intent)) || !isCurrentNavigationIntent(intent)) return;
    updateContent(next);
    setNavCollapsed(false);
    setChapterChoice(null);
    setMoreOpen(false);
    setMoreDetail(null);
    setQuery('');
    setKindFilter('all');
    setView('all');
    setSelectedNodeId(selectedId);
    replaceGraphScope(scope);
    setGraphMode('entry');
    setGraphQuery('');
    void loadGraph(scope);
  }

  async function navigateToTopic(topic: GraphNode, fromGraph = false, intent = beginNavigationIntent(), addHistory = true): Promise<void> {
    if (!isCurrentNavigationIntent(intent)) return;
    let scope = graphScopeRef.current;
    if (!fromGraph && (graphMode !== 'expanded' || !graphNodes.some((node) => node.id === topic.id))) {
      const topicRoute = selectionForTreeNode(tree, topic.id);
      if (topicRoute !== null) scope = topicRoute.scope;
      if (scope?.kind !== 'topic' || scope.anchorTopicId !== topic.id) {
        const disciplineId = scope?.disciplineId ?? findTreeDisciplineId(tree, topic.id);
        if (disciplineId !== null && disciplineId !== undefined) scope = { kind: 'topic', disciplineId, anchorTopicId: topic.id };
      }
    }
    if (scope === null) {
      setNotice('无法确定该主题所属学科范围。');
      return;
    }
    const selection: WorkbenchContent = { kind: 'topic', topicId: topic.id };
    const transitionPrepared = await prepareContentTransition(selection, addHistory, intent);
    if (!transitionPrepared || !isCurrentNavigationIntent(intent)) return;
    if (!sameGraphScope(graphScopeRef.current, scope)) {
      replaceGraphScope(scope);
      void loadGraph(scope);
    }
    setGraphQuery('');
    if (!(graphMode === 'expanded' && graphNodes.some((node) => node.id === topic.id))) setGraphMode('mini');
    await loadNote({ topicId: topic.id, chapterId: null }, topic.title, selection, { intent, addHistory: false, transitionPrepared: true });
  }

  async function navigateToChapter(topicId: string, chapterId: string, title: string, options: { intent?: number; addHistory?: boolean; activateScope?: GraphScope } = {}): Promise<void> {
    const intent = options.intent ?? beginNavigationIntent();
    if (!isCurrentNavigationIntent(intent)) return;
    const selection: WorkbenchContent = { kind: 'chapter', topicId, chapterId };
    if (!(await prepareContentTransition(selection, options.addHistory ?? true, intent)) || !isCurrentNavigationIntent(intent)) return;
    if (options.activateScope !== undefined && !sameGraphScope(graphScopeRef.current, options.activateScope)) {
      replaceGraphScope(options.activateScope);
      setGraphMode('mini');
      void loadGraph(options.activateScope);
    }
    setGraphQuery('');
    await loadNote({ topicId, chapterId }, title, selection, { intent, addHistory: false, transitionPrepared: true });
  }

  async function navigateToLibrary(nextView: LibraryView, intent = beginNavigationIntent()): Promise<void> {
    if (!(await prepareContentTransition({ kind: 'library' }, true, intent)) || !isCurrentNavigationIntent(intent)) return;
    updateContent({ kind: 'library' });
    setChapterChoice(null);
    replaceGraphScope(null);
    setGraphMode('entry');
    setNavCollapsed(false);
    setGraphQuery('');
    setView(nextView);
    setSelectedNodeId(null);
    setQuery('');
    setKindFilter('all');
    invalidateItems();
  }

  async function selectTreeNode(id: string): Promise<void> {
    const intent = beginNavigationIntent();
    const route = selectionForTreeNode(tree, id);
    if (route === null) {
      const node = findTreePath(tree, id)?.at(-1);
      if (node?.nodeType === 'chapter') {
        await resolveParentlessChapter(node, intent);
        return;
      }
    }
    setSelectedNodeId(id);
    setView('all');
    setQuery('');
    setKindFilter('all');
    if (route === null) {
      if (!(await prepareContentTransition({ kind: 'library' }, true, intent)) || !isCurrentNavigationIntent(intent)) return;
      updateContent({ kind: 'library' });
      setChapterChoice(null);
      replaceGraphScope(null);
      setGraphMode('entry');
      setNavCollapsed(false);
      invalidateItems();
      return;
    }
    if (route.content.kind === 'cards') {
      await navigateToCards(route.scope, id, intent);
      return;
    }
    if (route.content.kind === 'topic') {
      const node = route.path.at(-1)!;
      await navigateToTopic({ id: node.id, title: node.title, nodeType: 'topic', parentId: route.path.at(-2)?.id ?? null, summary: node.summary }, false, intent);
    } else {
      const chapter = route.path.at(-1)!;
      const inCurrentGraph = graphMode === 'expanded' && graphNodes.some((node) => node.id === chapter.id);
      const targetScope = inCurrentGraph ? graphScopeRef.current : route.scope;
      const parentTopic = [...route.path].reverse().find((node) => node.nodeType === 'topic');
      await resolveAndOpenChapter(chapter.id, {
        intent,
        ...(targetScope === null ? {} : { scope: targetScope }),
        ...(parentTopic === undefined ? {} : { activeTopicId: parentTopic.id }),
        ...(targetScope !== null && !sameGraphScope(graphScopeRef.current, targetScope) ? { activateScope: true } : {}),
      });
    }
  }

  function updateContent(next: WorkbenchContent): void {
    if (contentIdentity(next) !== contentIdentity(contentRef.current)) noteLoadRequestId.current += 1;
    contentRef.current = next;
    setContentSelection(next);
    if (next.kind === 'library' || next.kind === 'cards') replaceActiveNote(null);
  }

  async function resolveAndOpenChapter(chapterId: string, options: { intent?: number; scope?: GraphScope; activeTopicId?: string; activateScope?: boolean; action?: 'open' | 'more' } = {}): Promise<void> {
    const intent = options.intent ?? beginNavigationIntent();
    if (!isCurrentNavigationIntent(intent)) return;
    const scope = options.scope ?? graphScopeRef.current;
    if (scope === null) return;
    setChapterChoice(null);
    const current = contentRef.current;
    const activeTopicId = options.activeTopicId ?? (current.kind === 'topic' || current.kind === 'chapter' ? current.topicId : undefined);
    try {
      await commitLatestNavigation(
        navigationIntent.current,
        intent,
        api.resolveChapter({ chapterId, ...(activeTopicId ? { activeTopicId } : {}), scope }),
        (target) => applyChapterTarget(target, chapterId, scope, intent, options.activateScope ?? false, options.action ?? 'open'),
      );
    } catch (error) {
      if (isCurrentNavigationIntent(intent)) setNotice(`无法定位章节：${describeError(error)}`);
    }
  }

  async function applyChapterTarget(target: Awaited<ReturnType<WorkbenchApi['resolveChapter']>>, chapterId: string, scope: GraphScope, intent: number, activateScope: boolean, action: 'open' | 'more' = 'open'): Promise<void> {
    if (!isCurrentNavigationIntent(intent)) return;
    if (target.kind === 'resolved') {
      setChapterChoice(null);
      if (action === 'more') {
        await openTopicMore(target.topicId, intent);
        return;
      }
      const chapter = graphNodes.find((node) => node.id === target.chapterId);
      const pathChapter = findTreePath(tree, target.chapterId)?.at(-1);
      await navigateToChapter(target.topicId, target.chapterId, chapter?.title ?? pathChapter?.title ?? '章节正文', {
        intent,
        activateScope: activateScope ? scope : undefined,
      });
    } else if (target.kind === 'choose-topic') {
      setChapterChoice({ chapterId: target.chapterId, topicIds: target.topicIds, scope, activateScope, action });
      setGraphQuery('');
    } else {
      setChapterChoice(null);
      setNotice('这个章节已不可用；当前正文保持不变。');
      if (sameGraphScope(graphScopeRef.current, scope)) void loadGraph(scope);
    }
  }

  async function resolveParentlessChapter(chapter: TreeNode, intent: number): Promise<void> {
    if (!isCurrentNavigationIntent(intent)) return;
    setChapterChoice(null);
    try {
      const detail = await api.nodeDetail(chapter.id);
      if (!isCurrentNavigationIntent(intent)) return;
      const topicIds = detail.relatedNodes
        .filter((entry) => entry.relationType === 'part_of' && entry.node.nodeType === 'topic')
        .map((entry) => entry.node.id);
      let scopes = disciplineScopesForTopics(tree, topicIds);
      if (scopes.length === 0) {
        const disciplineScopes = tree
          .filter((node) => node.nodeType === 'discipline')
          .map((node): GraphScope => ({ kind: 'discipline', disciplineId: node.id }));
        const graphResults = await Promise.allSettled(disciplineScopes.map((scope) => api.selectGraph(scope)));
        if (!isCurrentNavigationIntent(intent)) return;
        scopes = graphResults.flatMap((result, index) => {
          if (result.status !== 'fulfilled') return [];
          const selection = result.value;
          const hasValidMembership = selection.nodes.some((node) => node.id === chapter.id && node.nodeType === 'chapter')
            && selection.edges.some((edge) => edge.fromNodeId === chapter.id && selection.nodes.some((node) => node.id === edge.toNodeId && node.nodeType === 'topic'));
          return hasValidMembership ? [disciplineScopes[index]!] : [];
        });
      }
      if (scopes.length === 0) {
        setNotice('这个章节没有可用的主题归属；当前内容和草稿保持不变。');
        return;
      }

      const current = contentRef.current;
      const activeTopicId = current.kind === 'topic' || current.kind === 'chapter' ? current.topicId : undefined;
      const targets = await Promise.allSettled(scopes.map((scope) => api.resolveChapter({ chapterId: chapter.id, ...(activeTopicId === undefined ? {} : { activeTopicId }), scope })));
      if (!isCurrentNavigationIntent(intent)) return;
      const resolved = targets.find((result) => result.status === 'fulfilled' && result.value.kind !== 'unavailable');
      if (resolved?.status === 'fulfilled') {
        const scopeIndex = targets.indexOf(resolved);
        const scope = scopes[scopeIndex]!;
        await applyChapterTarget(resolved.value, chapter.id, scope, intent, !sameGraphScope(graphScopeRef.current, scope));
      } else if (targets.some((result) => result.status === 'rejected')) {
        const failed = targets.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        setNotice(`无法定位章节：${describeError(failed?.reason)}`);
      } else {
        setNotice('这个章节没有可用的主题归属；当前内容和草稿保持不变。');
      }
    } catch (error) {
      if (isCurrentNavigationIntent(intent)) setNotice(`无法定位章节：${describeError(error)}`);
    }
  }

  async function chooseChapterTopic(topicId: string): Promise<void> {
    const choice = chapterChoice;
    if (choice === null || !choice.topicIds.includes(topicId)) return;
    const intent = beginNavigationIntent();
    if (choice.action === 'more') {
      setChapterChoice(null);
      await openTopicMore(topicId, intent);
      return;
    }
    const chapter = graphNodes.find((node) => node.id === choice.chapterId) ?? graphNodeFromTree(tree, choice.chapterId);
    await navigateToChapter(topicId, choice.chapterId, chapter?.title ?? '章节正文', {
      intent,
      activateScope: choice.activateScope ? choice.scope : undefined,
    });
  }

  async function handleGraphNodeOpen(node: GraphNode, intent = beginNavigationIntent()): Promise<void> {
    if (!isCurrentNavigationIntent(intent)) return;
    if (node.nodeType === 'topic') {
      await navigateToTopic(node, true, intent);
      return;
    }
    await resolveAndOpenChapter(node.id, { intent });
  }

  async function openGraphSearchHit(nodeId: string): Promise<void> {
    const intent = beginNavigationIntent();
    setGraphQuery('');
    setChapterChoice(null);
    const known = graphNodes.find((node) => node.id === nodeId);
    if (known !== undefined) {
      await handleGraphNodeOpen(known, intent);
      return;
    }
    try {
      await commitLatestNavigation(navigationIntent.current, intent, api.nodeDetail(nodeId), async (detail) => {
        if (!isCurrentNavigationIntent(intent)) return;
        if (detail.node.nodeType === 'chapter') {
          await resolveAndOpenChapter(detail.node.id, { intent });
        } else if (detail.node.nodeType === 'topic') {
          await navigateToTopic({
            id: detail.node.id,
            title: detail.node.title,
            nodeType: 'topic',
            parentId: detail.node.parentId,
            summary: detail.node.summary,
          }, true, intent);
        } else {
          setNotice('搜索结果不是可打开的主题或章节。');
        }
      });
    } catch (error) {
      if (isCurrentNavigationIntent(intent)) setNotice(`无法载入搜索结果：${describeError(error)}`);
    }
  }

  async function returnToPreviousContent(intent = beginNavigationIntent()): Promise<void> {
    const previous = contentHistory.current.at(-1);
    if (previous === undefined) return;
    const canLeave = await flushActiveNote();
    if (!isCurrentNavigationIntent(intent)) return;
    if (!canLeave) {
      const active = activeNoteRef.current;
      setNotice(active?.loadFailed
        ? '正文尚未载入。为避免覆盖已有内容，请重新载入后再返回。'
        : '正文尚未保存，且本地恢复草稿不可用；请重试保存后再返回。');
      return;
    }
    contentHistory.current.pop();
    rememberReadingPosition();
    const previousContent = previous.content;
    const reloadGraph = previous.scope !== null && !sameGraphScope(graphScopeRef.current, previous.scope);
    setChapterChoice(null);
    replaceGraphScope(previous.scope);
    setGraphMode(previous.mode);
    setNavCollapsed(previous.navCollapsed);
    if (reloadGraph && previous.scope !== null) void loadGraph(previous.scope);
    if (previousContent.kind === 'topic') {
      const topic = graphNodes.find((node) => node.id === previousContent.topicId)
        ?? graphNodeFromTree(tree, previousContent.topicId);
      if (topic !== null) await loadNote({ topicId: topic.id, chapterId: null }, topic.title, previousContent, { intent, addHistory: false, transitionPrepared: true, collapseNavigation: previous.navCollapsed });
    } else if (previousContent.kind === 'chapter') {
      const chapter = graphNodes.find((node) => node.id === previousContent.chapterId);
      const indexed = graphNotes.find((entry) => entry.chapterId === previousContent.chapterId);
      await loadNote({ topicId: previousContent.topicId, chapterId: previousContent.chapterId }, chapter?.title ?? indexed?.chapterTitle ?? '章节正文', previousContent, { intent, addHistory: false, transitionPrepared: true, collapseNavigation: previous.navCollapsed });
    } else if (previousContent.kind === 'cards') {
      updateContent(previousContent);
      setSelectedNodeId(previousContent.selectedNodeId);
      setView('all');
      setQuery('');
      setKindFilter('all');
      setNavCollapsed(false);
    } else {
      updateContent(previousContent);
      replaceGraphScope(null);
      replaceActiveNote(null);
      setNavCollapsed(false);
    }
  }

  function changeNoteContent(content: string): void {
    const active = activeNoteRef.current;
    if (active === null || active.status === 'loading') return;
    const next: ActiveGraphNote = { ...active, content, status: 'saving', error: undefined };
    replaceActiveNote(next);
    const cached = writeNoteDraft({ ...next.identity, content, updatedAt: new Date().toISOString() });
    refreshPendingDrafts();
    replaceActiveNote({ ...next, draftRecoverable: cached, ...(cached ? {} : { error: '本地恢复草稿不可用；自动保存仍会重试服务器。' }) });
  }

  async function retryActiveNote(): Promise<void> {
    const active = activeNoteRef.current;
    if (active === null) return;
    if (active.loadFailed) {
      await loadNote(active.identity, active.title, contentRef.current, { intent: beginNavigationIntent(), addHistory: false, forceReload: true });
      return;
    }
    const result = await persistNoteSnapshot(active);
    if (!result.serverSaved && !result.localSaved) setNotice('保存失败，浏览器无法创建本地恢复草稿。请保持此页并重试。');
  }

  async function openDraft(draft: NoteDraft): Promise<void> {
    const intent = beginNavigationIntent();
    let title = draft.chapterId === null
      ? graphNodes.find((node) => node.id === draft.topicId)?.title ?? graphNodeFromTree(tree, draft.topicId)?.title ?? '主题概览'
      : graphChapterTitle(draft.topicId, draft.chapterId, graphNodes, tree, graphNotes);
    const topic = graphNodes.find((node) => node.id === draft.topicId) ?? graphNodeFromTree(tree, draft.topicId);
    const selection: WorkbenchContent = draft.chapterId === null
      ? { kind: 'topic', topicId: draft.topicId }
      : { kind: 'chapter', topicId: draft.topicId, chapterId: draft.chapterId };
    if (!(await prepareContentTransition(selection, true, intent)) || !isCurrentNavigationIntent(intent)) return;
    if (draft.chapterId !== null && title === '章节正文') {
      try {
        const detail = await api.nodeDetail(draft.chapterId);
        if (!isCurrentNavigationIntent(intent)) return;
        if (detail.node.nodeType === 'chapter') title = detail.node.title;
      } catch {
        // Keep the neutral title when optional detail lookup cannot resolve a stale draft.
      }
    }
    setGraphQuery('');
    if (topic !== null) {
      const route = selectionForTreeNode(tree, topic.id);
      const topicIsInExpandedGraph = graphMode === 'expanded' && graphNodes.some((node) => node.id === topic.id);
      if (route !== null && !topicIsInExpandedGraph && !sameGraphScope(graphScopeRef.current, route.scope)) {
        replaceGraphScope(route.scope);
        setGraphMode('mini');
        void loadGraph(route.scope);
      }
    } else {
      replaceGraphScope(null);
      setGraphMode('entry');
    }
    await loadNote(draft, title, selection, { intent, addHistory: false, transitionPrepared: true });
  }

  async function openTopicMore(topicId: string, intent = beginNavigationIntent()): Promise<void> {
    if (!isCurrentNavigationIntent(intent)) return;
    setMoreOpen(true);
    setMoreDetail(null);
    try {
      const detail = await api.nodeDetail(topicId);
      if (!isCurrentNavigationIntent(intent)) return;
      setMoreDetail(detail);
    } catch (error) {
      if (isCurrentNavigationIntent(intent)) setNotice(`无法读取主题资料：${describeError(error)}`);
    }
  }

  async function createChapterForTopic(): Promise<void> {
    if (contentSelection.kind !== 'topic' || newChapterTitle.trim() === '') return;
    const intent = beginNavigationIntent();
    if (!(await flushActiveNote())) {
      setNotice('正文尚未保存，且本地恢复草稿不可用；请重试保存后再新建章节。');
      return;
    }
    if (!isCurrentNavigationIntent(intent)) return;
    setChapterActionBusy(true);
    try {
      const created = await api.createChapter(contentSelection.topicId, { title: newChapterTitle.trim() });
      if (!isCurrentNavigationIntent(intent)) return;
      setNewChapterTitle('');
      setNewChapterOpen(false);
      const scope = graphScopeRef.current;
      if (scope !== null) void loadGraph(scope);
      await navigateToChapter(contentSelection.topicId, created.chapter.id, created.chapter.title, { intent });
    } catch (error) {
      setNotice(`新建章节失败：${describeError(error)}`);
    } finally {
      setChapterActionBusy(false);
    }
  }

  async function detachCurrentChapter(): Promise<void> {
    if (contentSelection.kind !== 'chapter') return;
    setChapterActionBusy(true);
    try {
      await api.disconnectChapter(contentSelection.chapterId, contentSelection.topicId);
      const scope = graphScopeRef.current;
      if (scope !== null) void loadGraph(scope);
      const index = await api.listGraphNotes(contentSelection.topicId);
      setGraphNotes(index.notes);
      setNotice('已解除章节关联，正文仍保留在未归属列表中。');
    } catch (error) {
      setNotice(`解除关联失败：${describeError(error)}`);
    } finally {
      setChapterActionBusy(false);
    }
  }

  async function connectChapterToTopic(targetTopicId: string): Promise<void> {
    if (contentSelection.kind !== 'chapter') return;
    setChapterActionBusy(true);
    try {
      await api.connectChapter(contentSelection.chapterId, targetTopicId);
      const scope = graphScopeRef.current;
      if (scope !== null) void loadGraph(scope);
      setGraphNotes((await api.listGraphNotes(contentSelection.topicId)).notes);
      setNotice('章节已关联；正文仍按主题与章节 ID 保存。');
    } catch (error) {
      setNotice(`关联章节失败：${describeError(error)}`);
    } finally {
      setChapterActionBusy(false);
    }
  }

  async function moveTopic(topicId: string, targetParentId: string): Promise<void> {
    try {
      await api.moveNode(topicId, { targetParentId: targetParentId || null });
      const result = await api.tree();
      setTree(result.nodes);
      const route = selectionForTreeNode(result.nodes, topicId);
      if (route !== null) {
        replaceGraphScope(route.scope);
        void loadGraph(route.scope);
      }
      setMoreDetail(await api.nodeDetail(topicId));
      setNotice('主题分类已更新。');
    } catch (error) {
      setNotice(`更新主题分类失败：${describeError(error)}`);
    }
  }

  useEffect(() => {
    refreshPendingDrafts();
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem('noltri:color-theme:v1', theme); } catch { /* preference is optional */ }
  }, [theme]);

  useEffect(() => {
    if (activeNote === null || activeNote.status !== 'saving') return;
    if (noteSaveTimer.current !== null) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(() => {
      noteSaveTimer.current = null;
      const latest = activeNoteRef.current;
      if (latest !== null && sameNoteIdentity(latest.identity, activeNote.identity) && latest.content === activeNote.content) {
        void persistNoteSnapshot(latest);
      }
    }, 650);
    return () => {
      if (noteSaveTimer.current !== null) {
        clearTimeout(noteSaveTimer.current);
        noteSaveTimer.current = null;
      }
    };
  }, [activeNote?.identity.topicId, activeNote?.identity.chapterId, activeNote?.content, activeNote?.status]);

  useEffect(() => {
    const requestId = ++graphSearchRequestId.current;
    const requestQuery = graphQuery.trim();
    if (requestQuery === '' || graphScope === null || contentSelection.kind === 'library') {
      setGraphSearchHits([]);
      setGraphSearchError(null);
      setGraphSearchLoading(false);
      return;
    }
    const graphNodeHits = searchGraphNodes(graphNodes, requestQuery);
    setGraphSearchHits(graphNodeHits);
    const scopeNodeId = graphScope.kind === 'discipline'
      ? graphScope.disciplineId
      : graphScope.kind === 'subdiscipline' ? graphScope.subdisciplineId : graphScope.anchorTopicId;
    setGraphSearchLoading(true);
    setGraphSearchError(null);
    const timer = window.setTimeout(() => {
      void api.search({ query: requestQuery, scopeNodeId, limit: 50 }).then((result) => {
        if (requestId === graphSearchRequestId.current) {
          // Graph nodes are filtered by the complete server-selected GraphScope; parentId subtrees
          // miss chapters shared through valid part_of edges. Keep the old API for material hits.
          const materialHits = result.hits.filter((hit) => hit.itemId !== null);
          setGraphSearchHits([...graphNodeHits, ...materialHits]);
        }
      }).catch((error: unknown) => {
        if (requestId === graphSearchRequestId.current) setGraphSearchError(describeError(error));
      }).finally(() => {
        if (requestId === graphSearchRequestId.current) setGraphSearchLoading(false);
      });
    }, 180);
    return () => {
      clearTimeout(timer);
      if (requestId === graphSearchRequestId.current) graphSearchRequestId.current += 1;
    };
  }, [api, contentSelection.kind, graphNodes, graphQuery, graphScope]);

  useEffect(() => {
    if (graphScope === null || graphMode === 'entry' || typeof ResizeObserver === 'undefined') return;
    const shell = shellRef.current;
    const center = centerRef.current;
    const sidebar = shell?.querySelector<HTMLElement>('.library-sidebar');
    const graphPanel = graphPanelRef.current;
    if (shell === null || shell === undefined || center === null || sidebar === null || sidebar === undefined || graphPanel === null) return;

    const ensureReadableCenter = (): void => {
      const probe = center.querySelector<HTMLElement>('.editor-width-probe');
      const notebook = center.querySelector<HTMLElement>('.notebook-center');
      if (probe === null || notebook === null) return;
      const readableWidth = probe.getBoundingClientRect().width;
      const oneRowWidth = sidebar.getBoundingClientRect().width + readableWidth + graphPanel.getBoundingClientRect().width;
      if (notebook.clientWidth < readableWidth || shell.clientWidth < oneRowWidth) setGraphMode('entry');
    };
    const observer = new ResizeObserver(ensureReadableCenter);
    observer.observe(shell);
    observer.observe(center);
    observer.observe(graphPanel);
    ensureReadableCenter();
    return () => observer.disconnect();
  }, [graphScope, graphMode, graphPanelWidth, contentSelection.kind]);

  useEffect(() => {
    const requestId = ++itemsRequestId.current;
    const requestQuery = query.trim();
    const cancelItemsTimer = scheduleLibraryItemsLoad(() => {
      if (requestId !== itemsRequestId.current) return;
      setLoading(true);
      setLoadingMore(false);
      setItemsError(null);
      setItems([]);
      setOffset(0);
      setHasMore(false);
      void Promise.resolve().then(() => api.listItems({
        query: requestQuery,
        nodeId: selectedNodeId ?? undefined,
        kind: kindFilter === 'all' ? undefined : kindFilter,
        state: view,
        limit: PAGE_SIZE,
        offset: 0,
      })).then((result) => {
        if (requestId !== itemsRequestId.current) return;
        setItems(result.items);
        setOffset(result.items.length);
        setHasMore(result.items.length === PAGE_SIZE);
        setItemsError(null);
      }).catch((error: unknown) => {
        if (requestId === itemsRequestId.current) setItemsError(describeError(error));
      }).finally(() => {
        if (requestId === itemsRequestId.current) setLoading(false);
      });
    }, requestQuery === '' ? 0 : 200);
    return () => {
      const requestStarted = cancelItemsTimer();
      if (requestId === itemsRequestId.current) {
        itemsRequestId.current += 1;
        if (requestStarted) setLoading(false);
      }
    };
  }, [api, itemsReloadVersion, kindFilter, query, selectedNodeId, view]);

  async function refreshTree(): Promise<void> {
    try {
      const result = await api.tree();
      setTree(result.nodes);
      setTreeError(null);
      setOpenNodes((current) => current.size > 0 ? current : new Set(result.nodes.map((node) => node.id)));
    } catch (error) {
      setTreeError(describeError(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function invalidateItems(): void {
    itemsRequestId.current += 1;
    setItemsError(null);
    setLoading(false);
    setLoadingMore(false);
  }

  function updateQuery(next: string): void {
    if (next !== query) invalidateItems();
    setQuery(next);
  }

  function updateView(next: LibraryView): void {
    if (next !== view) invalidateItems();
    setView(next);
  }

  function updateSelectedNode(next: string | null): void {
    if (next !== selectedNodeId) invalidateItems();
    setSelectedNodeId(next);
  }

  function updateKindFilter(next: LibraryItem['kind'] | 'all'): void {
    if (next !== kindFilter) invalidateItems();
    setKindFilter(next);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (overlay !== null && dialog !== null && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (overlay === null && dialog?.open) {
      dialog.close();
    }
  }, [overlay, selectedItemId]);

  useEffect(() => {
    if (notice === null) return;
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
    return () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    };
  }, [notice]);

  useEffect(() => {
    if (overlay !== null) return;
    setSelectedItemId(null);
  }, [overlay]);

  const paths = useMemo(() => collectPaths(tree), [tree]);
  const sidebarSelectedNodeId = chapterChoice?.chapterId ?? (contentSelection.kind === 'chapter' ? contentSelection.chapterId : selectedNodeId);
  const selectedPath = useMemo(
    () => paths.find((path) => path.id === selectedNodeId)?.labels ?? [],
    [paths, selectedNodeId],
  );
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;
  const compareIds = compareItems.map((item) => item.id);
  const notebookPath = contentSelection.kind === 'cards'
    ? paths.find((path) => path.id === contentSelection.selectedNodeId)?.labels.join(' / ') ?? ''
    : contentSelection.kind === 'topic' || contentSelection.kind === 'chapter'
      ? paths.find((path) => path.id === contentSelection.topicId)?.labels.join(' / ') ?? ''
      : '';
  const classificationOptions = useMemo(() => collectClassificationOptions(tree), [tree]);
  const connectableTopics = useMemo(
    () => graphScope === null ? [] : collectTopicNodes(tree, graphScope.disciplineId),
    [graphScope, tree],
  );
  const chapterChoiceView = chapterChoice === null ? null : {
    chapterTitle: graphNodes.find((node) => node.id === chapterChoice.chapterId)?.title
      ?? graphNodeFromTree(tree, chapterChoice.chapterId)?.title
      ?? graphNotes.find((entry) => entry.chapterId === chapterChoice.chapterId)?.chapterTitle
      ?? '章节正文',
    candidates: chapterChoice.topicIds.map((id) => ({
      id,
      title: graphNodes.find((node) => node.id === id)?.title ?? graphNodeFromTree(tree, id)?.title ?? '主题',
    })),
    action: chapterChoice.action,
  };

  const visibleItems = items;

  const notify = useCallback((message: string): void => setNotice(message), []);

  function changeGraphMode(next: 'mini' | 'expanded'): void {
    if (next === 'expanded') {
      if (graphError !== null && graphScope !== null) void loadGraph(graphScope);
      setGraphMode('expanded');
      return;
    }
    setGraphMode(graphScope?.kind === 'topic' ? 'mini' : 'entry');
  }

  function openMoreForGraphNode(node: GraphNode): void {
    const intent = beginNavigationIntent();
    setMoreOpen(false);
    setMoreDetail(null);
    if (node.nodeType === 'topic') {
      void openTopicMore(node.id, intent);
      return;
    }
    const current = contentRef.current;
    const scope = current.kind === 'cards' ? current.scope : graphScopeRef.current;
    if (scope === null) {
      setNotice('当前知识范围无法定位这个章节。');
      return;
    }
    const activeTopicId = current.kind === 'topic' || current.kind === 'chapter' ? current.topicId : undefined;
    void resolveAndOpenChapter(node.id, { intent, scope, ...(activeTopicId === undefined ? {} : { activeTopicId }), action: 'more' });
  }

  function beginGraphResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    graphResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: graphPanelWidth };
  }

  function moveGraphResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    const start = graphResizeRef.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    const shell = shellRef.current;
    const side = shell?.querySelector<HTMLElement>('.library-sidebar');
    const available = (shell?.clientWidth ?? window.innerWidth) - (side?.getBoundingClientRect().width ?? 0);
    const max = Math.max(300, available - 320);
    setGraphPanelWidth(Math.max(300, Math.min(max, start.startWidth + start.startX - event.clientX)));
  }

  function endGraphResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (graphResizeRef.current?.pointerId === event.pointerId) graphResizeRef.current = null;
  }

  function adjustGraphResize(direction: -1 | 1): void {
    setGraphPanelWidth((width) => Math.max(300, Math.min(window.innerWidth * 0.62, width + direction * 24)));
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    const requestId = itemsRequestId.current;
    const requestOffset = offset;
    setLoadingMore(true);
    try {
      const result = await api.listItems({
        query: query.trim(),
        nodeId: selectedNodeId ?? undefined,
        kind: kindFilter === 'all' ? undefined : kindFilter,
        state: view,
        limit: PAGE_SIZE,
        offset: requestOffset,
      });
      if (requestId !== itemsRequestId.current) return;
      setItems((current) => {
        const knownIds = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !knownIds.has(item.id))];
      });
      setOffset(requestOffset + result.items.length);
      setHasMore(result.items.length === PAGE_SIZE);
    } catch (error) {
      if (requestId === itemsRequestId.current) setItemsError(describeError(error));
    } finally {
      if (requestId === itemsRequestId.current) setLoadingMore(false);
    }
  }

  async function handleCreated(item: LibraryItem): Promise<void> {
    invalidateItems();
    setView('all');
    setSelectedNodeId(null);
    setKindFilter('all');
    setQuery('');
    setItemsReloadVersion((current) => current + 1);
    setOverlay(null);
    setSelectedItemId(null);
    notify(item.aiStatus === 'failed' ? '已保存原文，AI 整理失败；内容仍可手动编辑。' : '已收进知识库。');
    void refresh();
  }

  function openDetail(itemId: string): void {
    setSelectedItemId(itemId);
    setOverlay('detail');
  }

  function toggleCompare(item: LibraryItem): void {
    setCompareItems((current) => toggleComparedItems(current, item));
    if (compareItems.length >= 2 && !compareIds.includes(item.id)) notify('一次并排比较两条摘录。');
  }

  async function archiveSelected(item: LibraryItem): Promise<void> {
    setBusy(true);
    try {
      await api.archiveItem(item.id);
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, archived: true } : entry)));
      setCompareItems([]);
      setItemsReloadVersion((current) => current + 1);
      setOverlay(null);
      notify('已移到归档。');
    } catch (error) {
      notify(`归档失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreSelected(item: LibraryItem): Promise<void> {
    setBusy(true);
    try {
      await api.restoreItem(item.id);
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, archived: false } : entry)));
      setCompareItems([]);
      setItemsReloadVersion((current) => current + 1);
      setOverlay(null);
      notify('已恢复到资料库。');
    } catch (error) {
      notify(`恢复失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyMcpEndpoint(): Promise<void> {
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
      notify('连接地址已复制。');
    } catch {
      notify('复制失败，请手动选中地址复制。');
    }
  }

  function closeOverlay(): void {
    setOverlay(null);
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    event.preventDefault();
    closeOverlay();
  }

  return (
    <div ref={shellRef} className={`library-shell${contentSelection.kind !== 'library' ? graphScope !== null ? ` library-shell-notebook library-shell-graph-${graphMode}` : ' library-shell-notebook library-shell-notebook-no-graph' : ''}${pendingDrafts.length > 0 ? ' has-pending-drafts' : ''}`} data-theme={theme} style={{ '--graph-panel-width': `${graphPanelWidth}px` } as CSSProperties}>
      <aside className={`library-sidebar${navCollapsed ? ' library-sidebar-tree-collapsed' : ''}`} aria-label="知识库侧栏">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">知</div>
          <div>
            <strong>知序</strong>
            <span>把知识慢慢连起来</span>
          </div>
        </div>

        <div className="sidebar-label">资料库</div>
        <nav className="library-nav" aria-label="资料筛选">
          <button className={view === 'all' && contentSelection.kind === 'library' ? 'nav-row nav-row-active' : 'nav-row'} onClick={() => { void navigateToLibrary('all'); }} type="button">
            <span className="nav-glyph" aria-hidden="true">▦</span><span>全部资料</span>
          </button>
          <button className={view === 'organize' && contentSelection.kind === 'library' ? 'nav-row nav-row-active' : 'nav-row'} onClick={() => { void navigateToLibrary('organize'); }} type="button">
            <span className="nav-glyph nav-glyph-warm" aria-hidden="true">✳</span><span>待整理</span>
            {items.some((item) => !item.archived && item.aiStatus !== 'ready') ? <span className="nav-dot" aria-label="有待整理内容" /> : null}
          </button>
          <button className={view === 'archive' && contentSelection.kind === 'library' ? 'nav-row nav-row-active' : 'nav-row'} onClick={() => { void navigateToLibrary('archive'); }} type="button">
            <span className="nav-glyph" aria-hidden="true">⌑</span><span>已归档</span>
          </button>
        </nav>

        <div className="sidebar-tree-head">
          <span className="sidebar-label">学科与方向</span>
          {tree.length > 0 ? <span className="tree-count">{paths.length}</span> : null}
        </div>
        {navCollapsed ? <button type="button" className="nav-restore" onClick={() => setNavCollapsed(false)}>展开学科导航</button> : null}
        {treeError !== null ? <p className="sidebar-error">知识树暂不可用</p> : null}
        {!navCollapsed && tree.length === 0 && !loading ? (
          <p className="tree-hint">收集资料后，学科与研究方向会出现在这里。</p>
        ) : !navCollapsed ? (
          <nav className="subject-tree" aria-label="学科知识树">
            {tree.map((node) => (
              <TreeBranch
                key={node.id}
                node={node}
                depth={0}
                selectedNodeId={sidebarSelectedNodeId}
                openNodes={openNodes}
                onSelect={(id) => { void selectTreeNode(id); }}
                onToggle={(id) => setOpenNodes((current) => toggleSet(current, id))}
              />
            ))}
          </nav>
        ) : null}

        <div className="sidebar-bottom">
          {pendingDrafts.length > 0 ? <details className="sidebar-draft-recovery">
            <summary>待同步草稿（{pendingDrafts.length}）</summary>
            {pendingDrafts.map((draft) => <button className="draft-recovery-row" type="button" key={`${draft.topicId}:${draft.chapterId ?? ''}`} onClick={() => { void openDraft(draft); }}>
              <span>{draft.chapterId === null
                ? `主题概览 · ${graphNodes.find((node) => node.id === draft.topicId)?.title ?? graphNodeFromTree(tree, draft.topicId)?.title ?? '主题概览'}`
                : `章节 · ${graphChapterTitle(draft.topicId, draft.chapterId, graphNodes, tree, graphNotes)}${graphChapterAttachment(graphNotes, draft.topicId, draft.chapterId) === 'detached' ? ' · 未归属' : ''}`}</span>
              <small>{new Date(draft.updatedAt).toLocaleString()}</small>
            </button>)}
          </details> : null}
          <button type="button" className="settings-link" onClick={() => setOverlay('settings')}>
            <span className="nav-glyph" aria-hidden="true">⚙</span>Provider 管理
          </button>
          <button type="button" className="settings-link theme-toggle" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={`切换到${theme === 'dark' ? '浅色' : '深色'}模式`}>
            <span className="nav-glyph" aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>{theme === 'dark' ? '浅色模式' : '深色模式'}
          </button>
          <div className="privacy-line"><span className={health === null ? 'connection-dot connection-dot-off' : 'connection-dot'} />
            {health === null ? '本机服务未连接' : '仅此设备保存'}</div>
        </div>
      </aside>

      <main ref={centerRef} className={`library-main${contentSelection.kind === 'library' ? '' : ' notebook-main'}`}>
        {contentSelection.kind === 'library' && chapterChoiceView !== null ? <ChapterChoicePanel chapterTitle={chapterChoiceView.chapterTitle} candidates={chapterChoiceView.candidates} action={chapterChoiceView.action} onChoose={(topicId) => { void chooseChapterTopic(topicId); }} /> : null}
        {contentSelection.kind !== 'library' ? <GraphNotebook
          content={contentSelection}
          scope={graphScope}
          nodes={graphNodes}
          edges={graphEdges}
          pathLabel={notebookPath}
          loading={graphLoading}
          error={graphError}
          note={activeNote}
          notes={graphNotes}
          connectableTopics={connectableTopics}
          historyAvailable={contentHistory.current.length > 0}
          moreOpen={moreOpen}
          moreDetail={moreDetail}
          scrollRef={noteScrollRef}
          search={graphQuery}
          searchError={graphSearchError}
          searchLoading={graphSearchLoading}
          searchHits={graphSearchHits}
          classificationOptions={classificationOptions}
          onSearch={setGraphQuery}
          renderTopicCard={(node, onOpen, onMore) => <MemoryCard key={node.id} kind="topic" topic={node} onOpen={onOpen} onMore={onMore} />}
          onOpenTopic={(node) => { void navigateToTopic(node); }}
          onOpenChapter={(chapterId) => { void resolveAndOpenChapter(chapterId); }}
          onOpenOrphan={(topicId, chapterId, title) => { void navigateToChapter(topicId, chapterId, title); }}
          onChooseTopic={(topicId) => { void chooseChapterTopic(topicId); }}
          onBack={() => { void returnToPreviousContent(); }}
          onChangeNote={changeNoteContent}
          onRetrySave={() => { void retryActiveNote(); }}
          onMore={(topicId) => { void openTopicMore(topicId); }}
          onCloseMore={() => setMoreOpen(false)}
          onMoveTopic={(topicId, targetParentId) => { void moveTopic(topicId, targetParentId); }}
          onCreateChapter={() => { void createChapterForTopic(); }}
          onChapterTitleChange={setNewChapterTitle}
          newChapterOpen={newChapterOpen}
          newChapterTitle={newChapterTitle}
          actionBusy={chapterActionBusy}
          onToggleNewChapter={() => { setNewChapterOpen((current) => !current); setNewChapterTitle(''); }}
          onDetachChapter={() => { void detachCurrentChapter(); }}
          onConnectChapter={(topicId) => { void connectChapterToTopic(topicId); }}
          onOpenSearchHit={(nodeId) => { void openGraphSearchHit(nodeId); }}
          onOpenSearchItem={openDetail}
          choice={chapterChoiceView}
          onCollect={() => setOverlay('collect')}
          onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          theme={theme}
        /> : <>
        <header className="library-header">
          <div className="header-copy">
            <div className="eyebrow">{selectedPath.length > 0 ? selectedPath.join(' / ') : '我的知识空间'}</div>
            <h1>{view === 'archive' ? '归档' : view === 'organize' ? '待整理' : '让好奇心有处可去'}</h1>
            <p>{view === 'organize' ? '归纳失败或仍在整理的内容会留在这里。' : '网页、Agent 对话和论文摘录，都能在这里找到。'}</p>
          </div>
          <div className="header-actions">
            <button type="button" className="button-quiet theme-header-toggle" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={`切换到${theme === 'dark' ? '浅色' : '深色'}模式`}>
              <span aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>
            </button>
            <button type="button" className="button-quiet" onClick={() => setOverlay('settings')} aria-label="打开 Provider 管理">
              <span aria-hidden="true">⚙</span>
            </button>
            <button type="button" className="button-primary" onClick={() => setOverlay('collect')}>
              <span className="button-plus" aria-hidden="true">＋</span>快速收集
            </button>
          </div>
        </header>

        <div className="library-tools">
          <label className="search-field">
            <span aria-hidden="true" className="search-icon">⌕</span>
            <input type="search" value={query} maxLength={200} onChange={(event) => updateQuery(event.target.value)} placeholder="搜知识、摘录、来源…" aria-label="搜索资料" />
            {query !== '' ? <button type="button" className="clear-search" onClick={() => updateQuery('')} aria-label="清空搜索">×</button> : null}
          </label>
          {paths.length > 0 ? (
            <label className="subject-picker">
              <span className="visually-hidden">按学科或研究方向筛选</span>
              <select
                aria-label="按学科或研究方向筛选"
                value={selectedNodeId ?? ''}
                onChange={(event) => updateSelectedNode(event.target.value || null)}
              >
                <option value="">全部学科与方向</option>
                {paths.map((path) => <option key={path.id} value={path.id}>{path.labels.join(' / ')}</option>)}
              </select>
            </label>
          ) : null}
          <div className="kind-filters" role="group" aria-label="按资料类型筛选">
            <FilterButton active={kindFilter === 'all'} onClick={() => updateKindFilter('all')}>全部类型</FilterButton>
            <FilterButton active={kindFilter === 'paper_excerpt'} onClick={() => updateKindFilter('paper_excerpt')}>论文摘录</FilterButton>
            <FilterButton active={kindFilter === 'web_page'} onClick={() => updateKindFilter('web_page')}>网页</FilterButton>
            <FilterButton active={kindFilter === 'knowledge'} onClick={() => updateKindFilter('knowledge')}>知识卡片</FilterButton>
            <FilterButton active={kindFilter === 'image'} onClick={() => updateKindFilter('image')}>图片</FilterButton>
          </div>
          <span className="result-count">{loading ? '正在读取…' : `${visibleItems.length}${hasMore ? '+' : ''} 条`}</span>
        </div>

        {itemsError !== null ? (
          <div className="inline-error" role="alert">
            <span>暂时无法载入资料：{itemsError}</span>
            <button type="button" onClick={() => { setItemsReloadVersion((current) => current + 1); void refresh(); }}>重新载入</button>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="loading-state" role="status"><span className="loader" />{query.trim() === '' ? '正在打开你的知识库…' : '正在搜索资料…'}</div>
        ) : visibleItems.length === 0 ? (
          <EmptyLibrary
            view={view}
            hasQuery={query.trim() !== '' || selectedPath.length > 0 || kindFilter !== 'all'}
            hasMore={hasMore}
            onClear={() => { invalidateItems(); setQuery(''); setSelectedNodeId(null); setKindFilter('all'); setView('all'); }}
            onCollect={() => setOverlay('collect')}
          />
        ) : (
          <section className="card-grid" aria-label="资料卡片">
            {visibleItems.map((item) => (
              <MemoryCard
                kind="library"
                key={item.id}
                item={item}
                compareSelected={compareIds.includes(item.id)}
                onOpen={() => openDetail(item.id)}
                onCompare={() => toggleCompare(item)}
              />
            ))}
          </section>
        )}
        {!loading && hasMore ? (
          <div className="load-more-wrap"><button type="button" className="button-soft" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '正在载入…' : '再看一些'}
          </button></div>
        ) : null}
        </>}
      </main>

      {contentSelection.kind !== 'library' && graphScope !== null ? <aside ref={graphPanelRef} className={`graph-panel graph-panel-${graphMode}`} aria-label="Graph 面板">
        <button
          type="button"
          className="graph-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整 Graph 面板宽度"
          aria-valuenow={graphPanelWidth}
          aria-valuemin={300}
          aria-valuemax={Math.max(300, shellRef.current?.clientWidth ?? 300)}
          onPointerDown={beginGraphResize}
          onPointerMove={moveGraphResize}
          onPointerUp={endGraphResize}
          onPointerCancel={endGraphResize}
          onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); adjustGraphResize(1); } else if (event.key === 'ArrowRight') { event.preventDefault(); adjustGraphResize(-1); } }}
        />
        {graphMode === 'entry' ? <div className="graph-entry">
          {graphError !== null ? <p className="graph-entry-error" role="alert">Graph 暂不可用：{graphError}</p> : null}
          {graphLoading ? <span className="graph-entry-loading" role="status">正在读取 Graph…</span> : null}
          <button type="button" className="button-soft graph-entry-button" onClick={() => changeGraphMode('expanded')}>展开graph view</button>
          {graphError !== null ? <button type="button" className="text-action" onClick={() => graphScope !== null && void loadGraph(graphScope)}>重新载入</button> : null}
        </div> : graphError !== null ? <div className="graph-panel-status" role="alert"><span>Graph 暂不可用：{graphError}</span><button type="button" className="text-action" onClick={() => graphScope !== null && void loadGraph(graphScope)}>重新载入</button></div> : graphLoading && graphNodes.length === 0 ? <div className="graph-panel-status" role="status"><span className="loader" />正在读取 Graph…</div> : <WorkbenchGraph
          nodes={graphNodes}
          edges={graphEdges}
          scopeIdentity={graphScopeIdentity(graphScope)}
          selectedNodeId={contentSelection.kind === 'topic' ? contentSelection.topicId : contentSelection.kind === 'chapter' ? contentSelection.chapterId : null}
          mode={graphMode}
          onNodeOpen={(node) => { void handleGraphNodeOpen(node); }}
          onModeChange={changeGraphMode}
          onNodeMore={openMoreForGraphNode}
        />}
      </aside> : null}

      {compareIds.length > 0 ? (
        <div className="compare-dock" role="region" aria-label="并排比较">
          <div><span className="compare-dock-mark" aria-hidden="true">⇄</span><strong>对读资料</strong><span className="compare-count">{compareIds.length}/2</span></div>
          <span className="compare-dock-title">{compareItems.map((item) => titleForItem(item)).join('  ·  ')}</span>
          <div className="compare-dock-actions">
            <button type="button" className="button-quiet" onClick={() => setCompareItems([])}>清空</button>
            <button type="button" className="button-primary" disabled={compareIds.length < 2} onClick={() => setOverlay('compare')}>并排比较</button>
          </div>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        className={`library-dialog ${overlay === 'detail' ? 'library-dialog-detail' : overlay === 'compare' ? 'library-dialog-compare' : ''}`}
        aria-label={overlay === 'detail' ? '资料详情' : overlay === 'collect' ? '收集资料' : overlay === 'compare' ? '并排比较资料' : overlay === 'settings' ? 'Provider 管理与收集入口设置' : undefined}
        onCancel={handleDialogCancel}
        onClick={(event) => { if (event.target === dialogRef.current) closeOverlay(); }}
      >
        {overlay === 'collect' ? (
          <CaptureDialog api={api} paths={paths} onClose={closeOverlay} onCreated={handleCreated} onError={notify} />
        ) : null}
        {overlay === 'detail' && selectedItem !== null ? (
          <ItemDetailDialog
            api={api}
            item={selectedItem}
            items={items}
            paths={paths}
            compareSelected={compareIds.includes(selectedItem.id)}
            busy={busy}
            onClose={closeOverlay}
            onCompare={() => toggleCompare(selectedItem)}
            onUpdated={(updated) => {
              setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
              setCompareItems((current) => current.map((item) => item.id === updated.id ? updated : item));
              void refreshTree();
              notify('更改已保存。');
            }}
            onArchive={() => void archiveSelected(selectedItem)}
            onRestore={() => void restoreSelected(selectedItem)}
            onError={notify}
          />
        ) : null}
        {overlay === 'compare' ? (
          <CompareDialog items={compareItems} onClose={closeOverlay} />
        ) : null}
        {overlay === 'settings' ? (
          <SettingsDialog
            modelSettings={modelSettings}
            apiBaseUrl={apiBaseUrl}
            mcpEndpoint={mcpEndpoint}
            tokenConfigured={tokenConfigured}
            outsideTauri={outsideTauri}
            health={health}
            healthError={healthError}
            onClose={closeOverlay}
            onCopyEndpoint={() => void copyMcpEndpoint()}
            onRefresh={() => void refresh()}
          />
        ) : null}
      </dialog>

      {notice !== null ? <div className="toast-message" role="status" aria-live="polite">{notice}</div> : null}
    </div>
  );
}

function TreeBranch({
  node,
  depth,
  selectedNodeId,
  openNodes,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedNodeId: string | null;
  openNodes: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}): ReactElement {
  const children = node.children ?? [];
  const isOpen = openNodes.has(node.id);
  const isSelected = selectedNodeId === node.id;
  return (
    <div className="tree-branch">
      <div className={isSelected ? 'tree-line tree-line-active' : 'tree-line'} style={{ '--depth': depth } as CSSProperties}>
        {children.length > 0 ? (
          <button className="tree-expander" type="button" aria-label={`${isOpen ? '收起' : '展开'}${node.title}`} aria-expanded={isOpen} onClick={() => onToggle(node.id)}>
            <span aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
          </button>
        ) : <span className="tree-expander-placeholder" />}
        <button className="tree-select" type="button" aria-current={isSelected ? 'page' : undefined} onClick={() => onSelect(node.id)} title={node.title}>
          <span className="tree-node-dot" aria-hidden="true" />
          <span className="tree-node-name">{node.title}</span>
          {(node.descendantItemCount ?? node.itemCount) > 0 ? <span className="tree-node-count">{node.descendantItemCount ?? node.itemCount}</span> : null}
        </button>
      </div>
      {isOpen && children.length > 0 ? (
        <div className="tree-children">
          {children.map((child) => <TreeBranch key={child.id} node={child} depth={depth + 1} selectedNodeId={selectedNodeId} openNodes={openNodes} onSelect={onSelect} onToggle={onToggle} />)}
        </div>
      ) : null}
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactElement {
  return <button className={active ? 'filter-chip filter-chip-active' : 'filter-chip'} type="button" aria-pressed={active} onClick={onClick}>{children}</button>;
}

type MemoryCardProps =
  | { kind: 'library'; item: LibraryItem; compareSelected: boolean; onOpen: () => void; onCompare: () => void }
  | { kind: 'topic'; topic: GraphNode; onOpen: () => void; onMore: () => void };

function MemoryCard(props: MemoryCardProps): ReactElement {
  const isTopic = props.kind === 'topic';
  const item = isTopic ? null : props.item;
  const topic = isTopic ? props.topic : null;
  const title = topic?.title ?? titleForItem(item!);
  const summary = topic === null ? item!.summary?.trim() || excerpt(item!.content, 160) : topic.summary ?? '';
  return (
    <article className={isTopic ? 'memory-card topic-memory-card' : 'memory-card'} onContextMenu={props.kind === 'topic' ? (event) => { event.preventDefault(); props.onMore(); } : undefined}>
      <button className="memory-card-open" type="button" onClick={props.onOpen} aria-label={isTopic ? `打开主题笔记：${title}` : `查看：${title}`}>
        {topic === null ? <MemoryCover kind="library" item={item!} /> : <MemoryCover kind="topic" topic={topic} />}
        <div className="memory-card-copy">
          <div className="memory-card-kicker"><span>{isTopic ? '主题' : KIND_LABELS[item!.kind]}</span>{!isTopic && item!.aiStatus !== 'ready' ? <span className={`ai-state ai-state-${item!.aiStatus}`}>{AI_LABELS[item!.aiStatus]}</span> : null}</div>
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>
      </button>
      {props.kind === 'library' ? <>
        <div className="memory-card-meta">
          <span className="card-source">{sourceLabel(props.item)}</span>
          <span>{formatDate(props.item.createdAt || props.item.source.capturedAt)}</span>
        </div>
        {props.item.subjectPath.length > 0 ? <div className="memory-card-path" title={props.item.subjectPath.join(' / ')}>{props.item.subjectPath.join(' · ')}</div> : null}
        <button className={props.compareSelected ? 'card-compare card-compare-active' : 'card-compare'} type="button" aria-pressed={props.compareSelected} onClick={props.onCompare}>
          <span aria-hidden="true">{props.compareSelected ? '✓' : '⇄'}</span>{props.compareSelected ? '已加入对读' : '加入对读'}
        </button>
      </> : <button className="card-compare topic-card-more" type="button" onClick={props.onMore} aria-label={`更多主题操作：${title}`}>⋯ 更多</button>}
    </article>
  );
}

function MemoryCover(props: { kind: 'library'; item: LibraryItem } | { kind: 'topic'; topic: GraphNode }): ReactElement {
  const item = props.kind === 'library' ? props.item : null;
  const topic = props.kind === 'topic' ? props.topic : null;
  const imageUrl = item === null ? null : safeHttpUrl(item.previewImageUrl);
  const [imageFailed, setImageFailed] = useState(false);
  const tone = `cover-tone-${hashString(topic?.id ?? item!.id) % 5}`;
  useEffect(() => setImageFailed(false), [imageUrl]);
  if (topic !== null) {
    return <div className={`memory-cover note-cover ${tone}`}><span className="cover-label">主题笔记</span><span className="note-cover-mark" aria-hidden="true">知</span><span className="note-cover-summary">{topic.summary ?? ''}</span></div>;
  }
  if (item === null) return <></>;
  if (imageUrl !== null && !imageFailed) {
    return <div className="memory-cover memory-cover-image"><img src={imageUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} /><span className="image-kind-label">{KIND_LABELS[item.kind]}</span></div>;
  }
  if (item.kind === 'paper_excerpt') {
    return (
      <div className={`memory-cover paper-cover ${tone}`}>
        <span className="cover-label">研究摘录</span>
        <span className="cover-quote" aria-hidden="true">“</span>
        <span className="paper-cover-point">{excerpt(item.researchPoint || item.summary || item.content, 92)}</span>
        <span className="paper-cover-source">{item.source.author || item.source.citation || sourceLabel(item)}{item.source.page ? ` · ${item.source.page}` : ''}</span>
      </div>
    );
  }
  if (item.kind === 'web_page') {
    return (
      <div className={`memory-cover web-cover ${tone}`}>
        <span className="cover-orbit cover-orbit-one" /><span className="cover-orbit cover-orbit-two" />
        <span className="cover-label">网页灵感</span>
        <strong>{sourceHost(item) || '网页收藏'}</strong>
        <span className="web-cover-title">{titleForItem(item)}</span>
        <span className="web-cover-bottom">{item.source.platform || '网页来源'}</span>
      </div>
    );
  }
  if (item.kind === 'image') {
    return (
      <div className={`memory-cover image-placeholder ${tone}`}>
        <span className="image-placeholder-icon" aria-hidden="true">▧</span>
        <span className="cover-label">{imageFailed ? '预览暂不可用' : '图片资料'}</span>
        <strong>{titleForItem(item)}</strong>
        <span>{sourceHost(item) || '已保存图片说明'}</span>
      </div>
    );
  }
  return (
    <div className={`memory-cover note-cover ${tone}`}>
      <span className="cover-label">知识卡片</span>
      <span className="note-cover-mark" aria-hidden="true">知</span>
      <span className="note-cover-summary">{excerpt(item.summary || item.content, 96)}</span>
      <span className="note-cover-bottom">{item.subjectPath.at(-1) || '随手收集'}</span>
    </div>
  );
}

function CaptureDialog({ api, paths, onClose, onCreated, onError }: {
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

function ItemDetailDialog({ api, item, items, paths, compareSelected, busy, onClose, onCompare, onUpdated, onArchive, onRestore, onError }: {
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

function CompareDialog({ items, onClose }: { items: LibraryItem[]; onClose: () => void }): ReactElement {
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

function SettingsDialog({ modelSettings, apiBaseUrl, mcpEndpoint, tokenConfigured, outsideTauri, health, healthError, onClose, onCopyEndpoint, onRefresh }: {
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

function sameNoteIdentity(left: NoteIdentity | null | undefined, right: NoteIdentity): boolean {
  return left !== null && left !== undefined && left.topicId === right.topicId && left.chapterId === right.chapterId;
}

function sameGraphScope(left: GraphScope | null, right: GraphScope): boolean {
  return left !== null && graphScopeIdentity(left) === graphScopeIdentity(right);
}

function readColorTheme(): ColorTheme {
  try {
    const stored = window.localStorage.getItem('noltri:color-theme:v1');
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
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
