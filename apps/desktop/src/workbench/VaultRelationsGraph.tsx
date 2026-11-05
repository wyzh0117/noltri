import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ApiClient } from '@noltri/api-client';
import type { VaultGraph } from '@noltri/schema';
import { WorkbenchGraph } from './WorkbenchGraph';
import type { GraphOpenIntent } from './WorkbenchGraph';
import './vault-relations-graph.css';
import { projectVaultGraph, vaultGraphMatchIds, vaultGraphNodeId, vaultGraphOpenPath } from './vault-relations-graph-model';

export interface VaultRelationsGraphProps {
  readonly api: Pick<ApiClient, 'vaultGraph' | 'vaultMatch'>;
  readonly rootPath: string | null;
  readonly selectedPath: string | null;
  readonly revision: number;
  readonly active: boolean;
  readonly onOpen: (path: string, intent: GraphOpenIntent) => void;
}

const EMPTY_GRAPH: VaultGraph = { nodes: [], edges: [], revision: 0 };

/** Keep mounted when inactive so WorkbenchGraph retains its camera and local controls. */
export function VaultRelationsGraph({ api, rootPath, selectedPath, revision, active, onOpen }: VaultRelationsGraphProps): ReactElement {
  const [mode, setMode] = useState<'mini' | 'expanded'>('mini');
  const [refresh, setRefresh] = useState(0);
  const context = useMemo(() => ({ api, rootPath, selectedPath, revision, active, refresh }), [api, rootPath, selectedPath, revision, active, refresh]);
  const latest = useRef(context);
  latest.current = context;
  const [snapshot, setSnapshot] = useState<{ context: typeof context; graph: VaultGraph } | null>(null);
  const [failure, setFailure] = useState<{ context: typeof context; message: string } | null>(null);
  const eligible = rootPath !== null && selectedPath !== null && /\.md$/i.test(selectedPath);

  useEffect(() => {
    if (!context.active || !eligible) return;
    let cancelled = false;
    void context.api.vaultGraph().then(graph => {
      if (cancelled || latest.current !== context) return;
      setSnapshot({ context, graph });
      setFailure(null);
    }).catch(() => {
      if (cancelled || latest.current !== context) return;
      // Raw transport errors may contain paths or source details; show a bounded generic state.
      setFailure({ context, message: '文档链接图加载失败，请重试。' });
    });
    return () => { cancelled = true; };
  }, [context, eligible]);

  const graph = snapshot?.context.api === api && snapshot.context.rootPath === rootPath && snapshot.context.selectedPath === selectedPath ? snapshot.graph : EMPTY_GRAPH;
  const view = useMemo(() => projectVaultGraph(graph, selectedPath), [graph, selectedPath]);
  const current = active && eligible && snapshot?.context === context;
  const error = failure?.context === context ? failure.message : null;
  const loading = active && eligible && !current && error === null;
  const evaluateQuery = useCallback(async (query: string): Promise<ReadonlySet<string>> => {
    if (!current || latest.current !== context) throw new Error('文档链接图尚未就绪，请刷新后重试。');
    if (query.trim() === '') return new Set(view.nodes.map(node => node.id));
    let matches;
    try { matches = await api.vaultMatch(query); }
    catch { throw new Error('文档链接匹配失败，请重试。'); }
    if (latest.current !== context) throw new Error('文档链接图上下文已变化，请重试。');
    if (matches.revision !== graph.revision) throw new Error('文档索引已变化，请刷新链接图后重试。');
    return vaultGraphMatchIds(view, matches);
  }, [api, context, current, graph.revision, view]);

  const contextNodeId = selectedPath === null ? '' : vaultGraphNodeId(selectedPath);
  return <section className="vault-document-relations" aria-label="文档链接图" hidden={!active}>
    <h3>文档链接图</h3>
    <p>Markdown 文档可打开；“附件”和“未解析”节点仅展示链接关系。</p>
    {!eligible ? <p role="status">请选择一个 Markdown 文档。</p> : null}
    {view.omittedNodes > 0 || view.omittedEdges > 0 ? <p role="status">图已限制显示范围：另有 {view.omittedNodes} 个节点、{view.omittedEdges} 条链接未显示。优先保留当前文档及直接关联。</p> : null}
    {current && !view.metadata.has(contextNodeId) ? <p role="status">当前文档尚未出现在链接索引中。</p> : null}
    <WorkbenchGraph
      nodes={view.nodes} edges={view.edges}
      scopeIdentity={`vault-documents:${JSON.stringify([rootPath, selectedPath])}`}
      contextNodeId={contextNodeId} selectedNodeId={view.metadata.has(contextNodeId) ? contextNodeId : null}
      mode={mode} onModeChange={setMode}
      loading={loading} error={error}
      onRefresh={() => { if (latest.current.active) setRefresh(value => value + 1); }}
      evaluateQuery={evaluateQuery}
      onNodeOpen={(node, intent) => {
        if (!current || latest.current !== context) return;
        const path = vaultGraphOpenPath(view, node.id);
        if (path !== null) onOpen(path, intent);
      }}
    />
  </section>;
}
