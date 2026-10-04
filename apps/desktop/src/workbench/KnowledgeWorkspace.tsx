import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  CaptureResult,
  KnowledgeNode,
  MoveNodeResponse,
  NodeDetail,
  TreeNode,
} from '@noltri/schema';
import { buildCaptureRequest } from '@noltri/api-client';
import {
  findNodePath,
  flattenTree,
  initialExpandedIds,
  navigateKeyboard,
  toExpandedSet,
  toggleExpanded,
  withExpanded,
  type ArrowKey,
} from '@noltri/shared';
import DomainRail from './DomainRail';
import KnowledgeTreeView from './KnowledgeTreeView';
import NodeDetailPanel from './NodeDetailPanel';
import NodeChatPanel from './NodeChatPanel';
import EmptyState from './EmptyState';
import { describeError } from './api';
import type { WorkbenchApi } from './api';

const NAVIGATION_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];

export interface KnowledgeWorkspaceProps {
  api: WorkbenchApi;
  /** Every root with its subtree, so the rail and the move control never need a second request. */
  fullNodes: readonly TreeNode[];
  aiIsOffline: boolean;
  /** Owned by the shell: a search hit in another tab must be able to open a node here. */
  selectedId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  /** 重命名 / 移动 / 收录 change the tree, so the owner of `fullNodes` has to re-read it. */
  onChanged: () => void;
}

/**
 * The migrated knowledge workbench: rail | tree | detail, exactly the §17.1 layout contract. This is the
 * web Workspace minus Next.js — no server action, no cookie, no `/api/web/*` proxy; every call goes
 * through the typed Core client.
 */
export default function KnowledgeWorkspace({
  api,
  fullNodes,
  aiIsOffline,
  selectedId,
  onSelectNode,
  onChanged,
}: KnowledgeWorkspaceProps): ReactElement {
  const [rootId, setRootId] = useState<string | null>(null);
  const [centreNodes, setCentreNodes] = useState<readonly TreeNode[]>(fullNodes);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => toExpandedSet([]));
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [lastVersionId, setLastVersionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const id of initialExpandedIds(fullNodes)) next.add(id);
      return next;
    });
  }, [fullNodes]);

  // Unfiltered means fullNodes is already the centre view; only a domain filter costs a request.
  useEffect(() => {
    if (rootId === null) {
      setCentreNodes(fullNodes);
      setTreeError(null);
      return;
    }
    let cancelled = false;
    setLoadingTree(true);
    void (async () => {
      try {
        const centre = await api.tree({ rootId });
        if (cancelled) return;
        setCentreNodes(centre.nodes);
        setTreeError(null);
        setExpanded((previous) => {
          const next = new Set(previous);
          for (const id of initialExpandedIds(centre.nodes)) next.add(id);
          return next;
        });
      } catch (error) {
        if (!cancelled) setTreeError(describeError(error));
      } finally {
        if (!cancelled) setLoadingTree(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, fullNodes, rootId, reloadToken]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    void (async () => {
      try {
        const result = await api.nodeDetail(selectedId);
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
  }, [api, selectedId]);

  const flat = useMemo(() => flattenTree(centreNodes, expanded), [centreNodes, expanded]);

  const openNode = useCallback(
    (id: string | null): void => {
      setChatOpen(false);
      setLastVersionId(null);
      onSelectNode(id);
    },
    [onSelectNode],
  );

  // Opening a node reveals its ancestors. Kept as an effect because the shell can also change the
  // selection from another tab, e.g. a search hit that lands in the middle of a subtree.
  useEffect(() => {
    if (selectedId === null) return;
    const path = findNodePath(centreNodes, selectedId);
    if (path.length === 0) return;
    setExpanded((previous) => {
      let next = previous;
      for (const node of path.slice(0, -1)) next = withExpanded(next, node.id, true);
      return next;
    });
  }, [centreNodes, selectedId]);

  const handleNavigationKey = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (!NAVIGATION_KEYS.includes(event.key)) return;
      event.preventDefault();
      if (flat.length === 0) return;
      const result = navigateKeyboard(flat, selectedId, event.key as ArrowKey, expanded);
      setExpanded(result.expanded);
      if (result.selectedId !== null && result.selectedId !== selectedId) openNode(result.selectedId);
    },
    [expanded, flat, openNode, selectedId],
  );

  const refreshTree = useCallback((): void => {
    onChanged();
    setReloadToken((token) => token + 1);
  }, [onChanged]);

  const handleRename = useCallback(
    async (patch: { title?: string; summary?: string }): Promise<void> => {
      if (selectedId === null) return;
      try {
        await api.patchNode(selectedId, patch);
        setDetail(await api.nodeDetail(selectedId));
        setActionError(null);
        refreshTree();
      } catch (error) {
        setActionError(describeError(error));
      }
    },
    [api, refreshTree, selectedId],
  );

  const handleMove = useCallback(
    async (targetParentId: string | null): Promise<void> => {
      if (selectedId === null) return;
      try {
        const result: MoveNodeResponse = await api.moveNode(selectedId, { targetParentId });
        setLastVersionId(result.versionRecordId);
        setDetail(await api.nodeDetail(selectedId));
        setActionError(null);
        refreshTree();
      } catch (error) {
        setActionError(describeError(error));
      }
    },
    [api, refreshTree, selectedId],
  );

  const handleCapture = useCallback(
    async (text: string): Promise<string> => {
      const request = buildCaptureRequest({
        text,
        client: 'desktop',
        source: { type: 'manual', title: '工作台粘贴收录' },
      });
      try {
        const result: CaptureResult = await api.capture(request);
        setActionError(null);
        refreshTree();
        if (result.processingStatus === 'failed') {
          setActionError(`原文已保存，但归纳失败：${result.errorReason ?? '未知原因'}。可在收件箱重试或人工归档。`);
          return '';
        }
        return result.items[0]?.nodePath.join(' / ') ?? result.rawSourceId;
      } catch (error) {
        setActionError(describeError(error));
        return '';
      }
    },
    [api, refreshTree],
  );

  return (
    <div className="workspace">
      <nav className="rail" aria-label="知识领域">
        <DomainRail
          domains={fullNodes}
          activeRootId={rootId}
          onSelectDomain={(id) => {
            setRootId((previous) => (previous === id ? null : id));
            openNode(null);
          }}
        />
        <p className="rail-note">知识领域即知识树的根节点。点击只看该领域子树，再次点击取消筛选。</p>
      </nav>

      <main
        className="tree-column"
        onKeyDown={handleNavigationKey}
        aria-label="知识树"
        aria-busy={loadingTree}
      >
        <div className="tree-caption">
          <span className="column-title column-title-tight">Knowledge Tree</span>
          {rootId !== null ? <span className="badge badge-accent">已筛选子树</span> : null}
          <span className="column-hint">方向键上下移动、左右展开收起、Enter 打开节点详情。</span>
        </div>

        {treeError !== null ? <p className="error-note">{treeError}</p> : null}

        {!loadingTree && fullNodes.length === 0 && treeError === null ? (
          <EmptyState onCapture={handleCapture} aiIsOffline={aiIsOffline} />
        ) : (
          <KnowledgeTreeView
            nodes={centreNodes}
            flat={flat}
            expanded={expanded}
            selectedId={selectedId}
            loading={loadingTree}
            onToggle={(id) => setExpanded((previous) => toggleExpanded(previous, id))}
            onSelect={openNode}
          />
        )}
      </main>

      <aside className="detail-column" aria-label="节点详情">
        {chatOpen && detail !== null ? (
          <NodeChatPanel
            api={api}
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
            onOpenNode={openNode}
            onRename={handleRename}
            onMove={handleMove}
            onOpenChat={() => setChatOpen(true)}
          />
        )}
      </aside>
    </div>
  );
}
