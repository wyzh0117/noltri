'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  CaptureResult,
  HealthResponse,
  KnowledgeNode,
  MoveNodeResponse,
  NodeDetail,
  TreeNode,
  TreeResponse,
} from '@noltri/schema';
import TopBar from './TopBar';
import DomainRail from './DomainRail';
import KnowledgeTreeView from './KnowledgeTreeView';
import NodeDetailPanel from './NodeDetailPanel';
import NodeChatPanel from './NodeChatPanel';
import EmptyState from './EmptyState';
import { apiGet, apiPost, describeError } from '@/lib/client-api';
import {
  findNodePath,
  flattenTree,
  initialExpandedIds,
  navigateKeyboard,
  summarizeTree,
  toExpandedSet,
  toggleExpanded,
  withExpanded,
  type ArrowKey,
} from '@/lib/tree-view';
import type { SessionStrategy } from '@/lib/cookie';
import type { ProjectMode } from './ProjectTypeSwitch';

const NAVIGATION_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];

export interface WorkspaceProps {
  strategy: SessionStrategy;
  /** Project Type switch state, owned by the workbench shell; the tree stays the default body. */
  mode?: ProjectMode;
  onSwitchMode?: (mode: ProjectMode) => void;
}

export default function Workspace({ strategy, mode, onSwitchMode }: WorkspaceProps): ReactElement {
  const [fullNodes, setFullNodes] = useState<TreeNode[]>([]);
  const [centreNodes, setCentreNodes] = useState<TreeNode[]>([]);
  const [totalNodes, setTotalNodes] = useState(0);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);
  const [rootId, setRootId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => toExpandedSet([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [lastVersionId, setLastVersionId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthProblem, setHealthProblem] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoadingTree(true);
    void (async () => {
      try {
        const centre: TreeResponse = await apiGet<TreeResponse>('/api/web/tree', rootId ? { rootId } : undefined);
        if (cancelled) return;
        setCentreNodes(centre.nodes);
        setTotalNodes(centre.totalNodes);
        setTreeError(null);
        setExpanded((previous) => mergeExpanded(previous, centre.nodes));
        if (rootId === null) setFullNodes(centre.nodes);
        else {
          const full: TreeResponse = await apiGet<TreeResponse>('/api/web/tree');
          if (cancelled) return;
          setFullNodes(full.nodes);
        }
      } catch (error) {
        if (cancelled) return;
        setTreeError(describeError(error));
      } finally {
        if (!cancelled) setLoadingTree(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootId, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiGet<HealthResponse>('/api/web/health');
        if (cancelled) return;
        setHealth(result);
        setHealthProblem(null);
      } catch (error) {
        if (cancelled) return;
        setHealth(null);
        setHealthProblem(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    void (async () => {
      try {
        const result = await apiGet<NodeDetail>(`/api/web/nodes/${encodeURIComponent(selectedId)}`);
        if (cancelled) return;
        setDetail(result);
        setDetailError(null);
      } catch (error) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(describeError(error));
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const flat = useMemo(() => flattenTree(centreNodes, expanded), [centreNodes, expanded]);
  const summary = useMemo(() => summarizeTree(fullNodes), [fullNodes]);

  const selectNode = useCallback(
    (id: string | null): void => {
      setSelectedId(id);
      setChatOpen(false);
      setLastVersionId(null);
      if (id === null) return;
      const path = findNodePath(centreNodes, id);
      if (path.length === 0) return;
      setExpanded((previous) => {
        let next = previous;
        for (const node of path.slice(0, -1)) next = withExpanded(next, node.id, true);
        return next;
      });
    },
    [centreNodes],
  );

  const handleNavigationKey = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (!NAVIGATION_KEYS.includes(event.key)) return;
      event.preventDefault();
      if (flat.length === 0) return;
      const result = navigateKeyboard(flat, selectedId, event.key as ArrowKey, expanded);
      setExpanded(result.expanded);
      if (result.selectedId !== null && result.selectedId !== selectedId) {
        setSelectedId(result.selectedId);
        setChatOpen(false);
        setLastVersionId(null);
      }
    },
    [expanded, flat, selectedId],
  );

  const handleToggle = useCallback((id: string): void => {
    setExpanded((previous) => toggleExpanded(previous, id));
  }, []);

  const handleRename = useCallback(
    async (patch: { title?: string; summary?: string }): Promise<void> => {
      if (selectedId === null) return;
      try {
        await apiPost<KnowledgeNode>('/api/web/patch', { id: selectedId, ...patch });
        setDetail(await apiGet<NodeDetail>(`/api/web/nodes/${encodeURIComponent(selectedId)}`));
        setActionError(null);
        refresh();
      } catch (error) {
        setActionError(describeError(error));
      }
    },
    [refresh, selectedId],
  );

  const handleMove = useCallback(
    async (targetParentId: string | null): Promise<void> => {
      if (selectedId === null) return;
      try {
        const result = await apiPost<MoveNodeResponse>(
          `/api/web/nodes/${encodeURIComponent(selectedId)}/move`,
          { targetParentId },
        );
        setLastVersionId(result.versionRecordId);
        setDetail(await apiGet<NodeDetail>(`/api/web/nodes/${encodeURIComponent(selectedId)}`));
        setActionError(null);
        refresh();
      } catch (error) {
        setActionError(describeError(error));
      }
    },
    [refresh, selectedId],
  );

  const handleCapture = useCallback(
    async (text: string): Promise<string> => {
      try {
        const result = await apiPost<CaptureResult>('/api/web/capture', {
          text,
          title: '网页粘贴收录',
        });
        setActionError(null);
        refresh();
        return result.items[0]?.nodePath.join(' / ') ?? result.rawSourceId;
      } catch (error) {
        setActionError(describeError(error));
        return '';
      }
    },
    [refresh],
  );

  return (
    <div className="app-shell">
      {strategy === 'dev-token' ? (
        <div className="dev-banner" role="status">
          当前为本地开发登录，未接入 Supabase Auth
        </div>
      ) : null}

      <TopBar
        strategy={strategy}
        health={health}
        healthProblem={healthProblem}
        domainCount={summary.domainCount}
        nodeCount={summary.nodeCount}
        itemCount={summary.itemCount}
        onPickNode={selectNode}
        mode={mode}
        onSwitchMode={onSwitchMode}
      />

      <div className="workspace">
        <nav className="rail" aria-label="知识领域">
          <DomainRail
            domains={fullNodes}
            activeRootId={rootId}
            onSelectDomain={(id) => {
              setRootId((previous) => (previous === id ? null : id));
              setSelectedId(null);
              setChatOpen(false);
            }}
          />
          <p className="rail-note">
            知识领域即知识树的根节点。点击只看该领域子树，再次点击取消筛选。
          </p>
        </nav>

        <main
          className="tree-column"
          onKeyDown={handleNavigationKey}
          aria-label="知识树"
          aria-busy={loadingTree}
        >
          <div className="tree-caption">
            <span className="column-title column-title-tight">
              Knowledge Tree
            </span>
            {rootId !== null ? <span className="badge badge-accent">已筛选子树</span> : null}
            <span className="column-hint">
              方向键上下移动、左右展开收起、Enter 打开节点详情。
            </span>
          </div>

          {treeError !== null ? <p className="error-note">{treeError}</p> : null}

          {!loadingTree && fullNodes.length === 0 && treeError === null ? (
            <EmptyState onCapture={handleCapture} />
          ) : (
            <KnowledgeTreeView
              nodes={centreNodes}
              flat={flat}
              expanded={expanded}
              selectedId={selectedId}
              loading={loadingTree}
              onToggle={handleToggle}
              onSelect={selectNode}
            />
          )}
        </main>

        <aside className="detail-column" aria-label="节点详情">
          {chatOpen && detail !== null ? (
            <NodeChatPanel
              node={{ id: detail.node.id, title: detail.node.title }}
              onClose={() => setChatOpen(false)}
            />
          ) : (
            <NodeDetailPanel
              detail={detail}
              error={detailError ?? actionError}
              loading={loadingDetail}
              treeNodes={fullNodes}
              versionRecordId={lastVersionId}
              onOpenNode={selectNode}
              onRename={handleRename}
              onMove={handleMove}
              onOpenChat={() => setChatOpen(true)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function mergeExpanded(previous: ReadonlySet<string>, nodes: readonly TreeNode[]): Set<string> {
  const next = new Set(previous);
  for (const id of initialExpandedIds(nodes)) next.add(id);
  return next;
}
