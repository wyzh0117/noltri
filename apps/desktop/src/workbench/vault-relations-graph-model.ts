import type { GraphEdge, GraphNode, NoteMatchesResponse, VaultGraph, VaultGraphNode } from '@noltri/schema';

export interface VaultGraphProjection {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly metadata: ReadonlyMap<string, VaultGraphNode>;
  readonly omittedNodes: number;
  readonly omittedEdges: number;
}

export const VAULT_GRAPH_VIEW_LIMITS = { nodes: 2_000, edges: 4_000 } as const;

export function vaultGraphNodeId(path: string): string {
  return `vault:${encodeURIComponent(path)}`;
}

const pathOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** In-memory renderer DTOs only. These IDs are never semantic node IDs or persisted. */
export function projectVaultGraph(
  graph: VaultGraph,
  selectedPath: string | null,
  limits: { nodes: number; edges: number } = VAULT_GRAPH_VIEW_LIMITS,
): VaultGraphProjection {
  const byPath = new Map(graph.nodes.map(node => [node.path, node]));
  const neighbours = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.sourcePath === selectedPath) neighbours.add(edge.targetPath);
    if (edge.targetPath === selectedPath) neighbours.add(edge.sourcePath);
  }
  const rank = (path: string): number => path === selectedPath ? 0 : neighbours.has(path) ? 1 : 2;
  const paths = [...byPath.keys()].sort((a, b) => rank(a) - rank(b) || pathOrder(a, b));
  const included = paths.slice(0, Math.max(0, Math.floor(limits.nodes)));
  const metadata = new Map(included.map(path => [vaultGraphNodeId(path), byPath.get(path)!]));
  const nodes: GraphNode[] = [...metadata].map(([id, node]) => ({
    id,
    title: `${node.type === 'attachment' ? '附件 · ' : node.type === 'unresolved' ? '未解析 · ' : ''}${node.title || node.basename || node.path}`,
    // The existing renderer requires a GraphNode category. Actual Vault kind lives in metadata;
    // no semantic parent, writable topic action or knowledge-store API is exposed.
    nodeType: 'chapter',
    parentId: null,
    summary: `${node.type === 'note' ? 'Markdown 文档' : node.type === 'attachment' ? '附件（只读）' : '未解析链接'} · ${node.path}`,
    ...(node.type === 'note' && /\.md$/i.test(node.path) ? { notePath: node.path } : {}),
  }));
  const candidates = new Map<string, GraphEdge>();
  for (const edge of graph.edges) {
    const fromNodeId = vaultGraphNodeId(edge.sourcePath);
    const toNodeId = vaultGraphNodeId(edge.targetPath);
    if (!metadata.has(fromNodeId) || !metadata.has(toNodeId)) continue;
    const id = `vault-link:${JSON.stringify([edge.sourcePath, edge.targetPath])}`;
    candidates.set(id, { id, fromNodeId, toNodeId, relationType: 'wikilink', source: 'vault-view' });
  }
  const edges = [...candidates.values()].sort((a, b) => pathOrder(a.id, b.id)).slice(0, Math.max(0, Math.floor(limits.edges)));
  return { nodes, edges, metadata, omittedNodes: byPath.size - nodes.length, omittedEdges: Math.max(0, graph.edges.length - edges.length) };
}

export function vaultGraphOpenPath(view: VaultGraphProjection, id: string): string | null {
  const node = view.metadata.get(id);
  if (node?.type !== 'note' || !/\.md$/i.test(node.path)) return null;
  if (/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(node.path) || /[\\\u0000-\u001f]/.test(node.path) || node.path.split('/').some(part => part === '..' || part === '.' || part === '')) return null;
  return node.path;
}

export function vaultGraphMatchIds(view: VaultGraphProjection, matches: NoteMatchesResponse): ReadonlySet<string> {
  const result = new Set<string>();
  for (const path of [...matches.paths, ...matches.attachmentPaths]) {
    const id = vaultGraphNodeId(path);
    if (view.metadata.has(id)) result.add(id);
  }
  return result;
}
