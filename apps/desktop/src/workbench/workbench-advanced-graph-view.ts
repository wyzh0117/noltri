import type { GraphEdge, GraphNode, GraphScope, VaultGraph } from '@noltri/schema';
import { vaultGraphNodeId } from './vault-relations-graph-model';
import type { GraphRenderEdge, GraphRenderNode, VaultGraphRenderNode } from './workbench-graph-render-data';
import { projectWholeDisciplineGraph } from './workbench-semantic-graph-projection';

export interface AdvancedGraphFilters {
  showTags: boolean;
  showAttachments: boolean;
  showUnresolved: boolean;
}

export interface AdvancedGraphView {
  nodes: GraphRenderNode[];
  edges: GraphRenderEdge[];
}

export const DEFAULT_ADVANCED_GRAPH_FILTERS: AdvancedGraphFilters = {
  showTags: true,
  showAttachments: false,
  showUnresolved: false,
};

function edgeKey(edge: GraphRenderEdge): string {
  return `${edge.relationType}\0${edge.fromNodeId}\0${edge.toNodeId}`;
}

function nodePaths(node: GraphNode): string[] {
  return [...new Set([node.notePath, ...(node.notePaths ?? [])].filter((path): path is string => typeof path === 'string' && path !== ''))];
}

function scopedSemanticGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  scope: GraphScope | null,
  contextNodeId: string,
  advancedScope: 'focus' | 'discipline' | 'all',
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (advancedScope === 'all') return { nodes: [...nodes], edges: [...edges] };
  if (advancedScope === 'discipline') {
    if (scope === null) return { nodes: [], edges: [] };
    const projected = projectWholeDisciplineGraph({ nodes: [...nodes], edges: [...edges] }, scope.disciplineId);
    return { nodes: [...projected.nodes], edges: [...projected.edges] };
  }
  const focusId = nodes.some((node) => node.id === contextNodeId)
    ? contextNodeId
    : scope?.kind === 'topic' ? scope.anchorTopicId
      : scope?.kind === 'subdiscipline' ? scope.subdisciplineId
        : scope?.disciplineId ?? '';
  if (!nodes.some((node) => node.id === focusId)) return { nodes: [], edges: [] };
  const ids = new Set([focusId]);
  for (const edge of edges) {
    if (edge.fromNodeId === focusId) ids.add(edge.toNodeId);
    else if (edge.toNodeId === focusId) ids.add(edge.fromNodeId);
  }
  return {
    nodes: nodes.filter((node) => ids.has(node.id)),
    edges: edges.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)),
  };
}

function auxiliaryNode(path: string, title: string, type: Exclude<VaultGraphRenderNode['nodeType'], 'tag'>): VaultGraphRenderNode {
  const kind = type;
  return {
    id: vaultGraphNodeId(path),
    title,
    nodeType: type,
    parentId: null,
    summary: `${kind === 'note' ? 'Markdown 文档' : kind === 'attachment' ? '附件' : '未解析链接'} · ${path}`,
    graphTarget: { kind, path },
  };
}

/** Merge Vault links only into the advanced graph. Subject views remain taxonomy-only. */
export function buildAdvancedGraphView(input: {
  semanticNodes: readonly GraphNode[];
  semanticEdges: readonly GraphEdge[];
  vaultGraph: VaultGraph | null;
  scope: GraphScope | null;
  contextNodeId: string;
  advancedScope: 'focus' | 'discipline' | 'all';
  filters?: AdvancedGraphFilters;
}): AdvancedGraphView {
  const filters = input.filters ?? DEFAULT_ADVANCED_GRAPH_FILTERS;
  const semantic = scopedSemanticGraph(input.semanticNodes, input.semanticEdges, input.scope, input.contextNodeId, input.advancedScope);
  const nodes: GraphRenderNode[] = [...semantic.nodes];
  const edges = new Map<string, GraphRenderEdge>();
  for (const edge of semantic.edges) edges.set(edgeKey(edge), edge);
  const graph = input.vaultGraph;
  if (graph === null) return { nodes, edges: [...edges.values()] };

  const semanticIdsByPath = new Map<string, Set<string>>();
  for (const node of semantic.nodes) {
    for (const path of nodePaths(node)) {
      const ids = semanticIdsByPath.get(path) ?? new Set<string>();
      ids.add(node.id);
      semanticIdsByPath.set(path, ids);
    }
  }

  const includedPaths = new Set<string>();
  if (input.advancedScope === 'all') {
    for (const node of graph.nodes) includedPaths.add(node.path);
  } else {
    const focusPaths = new Set(semanticIdsByPath.keys());
    for (const path of focusPaths) includedPaths.add(path);
    // Advanced focus/discipline includes one direct Vault-link neighborhood around semantic notes.
    for (const edge of graph.edges) {
      if (focusPaths.has(edge.sourcePath)) includedPaths.add(edge.targetPath);
      if (focusPaths.has(edge.targetPath)) includedPaths.add(edge.sourcePath);
    }
  }

  const vaultNodeByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const pathToGraphIds = new Map<string, Set<string>>();
  for (const path of includedPaths) {
    const source = vaultNodeByPath.get(path);
    if (source === undefined) continue;
    const semanticIds = semanticIdsByPath.get(path);
    if (source.type === 'note' && semanticIds !== undefined && semanticIds.size > 0) {
      pathToGraphIds.set(path, semanticIds);
      continue;
    }
    if (source.type === 'attachment' && !filters.showAttachments) continue;
    if (source.type === 'unresolved' && !filters.showUnresolved) continue;
    const node = auxiliaryNode(source.path, source.title || source.basename || source.path, source.type);
    nodes.push(node);
    pathToGraphIds.set(path, new Set([node.id]));
  }

  if (filters.showTags) {
    const tags = new Map<string, Set<string>>();
    for (const path of includedPaths) {
      const source = vaultNodeByPath.get(path);
      if (source?.type !== 'note') continue;
      const owners = pathToGraphIds.get(path);
      if (owners === undefined) continue;
      for (const tag of source.tags) {
        const tagId = `vault-tag:${encodeURIComponent(tag)}`;
        const ownersForTag = tags.get(tagId) ?? new Set<string>();
        for (const owner of owners) ownersForTag.add(owner);
        tags.set(tagId, ownersForTag);
      }
    }
    for (const [tagId, owners] of tags) {
      const tag = decodeURIComponent(tagId.slice('vault-tag:'.length));
      nodes.push({
        id: tagId,
        title: tag,
        nodeType: 'tag',
        parentId: null,
        summary: '标签',
        graphTarget: { kind: 'tag', tag },
      });
      for (const owner of owners) {
        const edge: GraphRenderEdge = { id: `tagged:${encodeURIComponent(owner)}:${encodeURIComponent(tagId)}`, fromNodeId: owner, toNodeId: tagId, relationType: 'tagged', source: 'vault_tag' };
        edges.set(edgeKey(edge), edge);
      }
    }
  }

  for (const edge of graph.edges) {
    if (!includedPaths.has(edge.sourcePath) || !includedPaths.has(edge.targetPath)) continue;
    const sources = pathToGraphIds.get(edge.sourcePath);
    const targets = pathToGraphIds.get(edge.targetPath);
    if (sources === undefined || targets === undefined) continue;
    for (const fromNodeId of sources) for (const toNodeId of targets) {
      if (fromNodeId === toNodeId) continue;
      const link: GraphEdge = {
        id: `vault-link:${JSON.stringify([edge.sourcePath, edge.targetPath, fromNodeId, toNodeId])}`,
        fromNodeId,
        toNodeId,
        relationType: 'wikilink',
        source: edge.resolved ? 'vault_graph' : 'vault_graph_unresolved',
      };
      const key = edgeKey(link);
      if (!edges.has(key)) edges.set(key, link);
    }
  }

  return { nodes, edges: [...edges.values()] };
}
