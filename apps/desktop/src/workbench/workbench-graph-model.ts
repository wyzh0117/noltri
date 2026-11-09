import type { GraphRenderEdge, GraphRenderNode } from './workbench-graph-render-data';

export interface GraphGroupMatch {
  query: string;
  color: string;
  match: GraphQueryMatch;
}

export interface GraphQueryMatch {
  nodeIds: ReadonlySet<string>;
}

export interface GraphModelOptions {
  showOrphans: boolean;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  preserveNodeIds?: ReadonlySet<string>;
}

export interface GraphModelMatches {
  filter: GraphQueryMatch | null;
  groups: readonly GraphGroupMatch[];
}

export interface GraphViewNode {
  id: string;
  title: string;
  type: GraphRenderNode['nodeType'];
  degree: number;
  weight: number;
  size: number;
  colorGroup: string | null;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  width: number;
  relationType: GraphRenderEdge['relationType'];
}

export interface GraphModel {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const nodeTypeOrder: Record<GraphRenderNode['nodeType'], number> = {
  discipline: 0,
  subdiscipline: 1,
  domain: 2,
  topic: 3,
  chapter: 4,
  note: 5,
  attachment: 6,
  unresolved: 7,
  tag: 8,
};

export function graphNodeSize(weight: number, multiplier = 1): number {
  return clamp(multiplier, 0.1, 5) * clamp(3 * Math.sqrt(Math.max(0, weight) + 1), 8, 30);
}

function colorForGroup(nodeId: string, groups: readonly GraphGroupMatch[]): string | null {
  return groups.find((group) => group.match.nodeIds.has(nodeId))?.color ?? null;
}

export function buildGraphModel(
  sourceNodes: readonly GraphRenderNode[],
  sourceEdges: readonly GraphRenderEdge[],
  options: GraphModelOptions,
  matches: GraphModelMatches = { filter: null, groups: [] },
): GraphModel {
  const nodeById = new Map<string, GraphRenderNode>();
  for (const node of sourceNodes) if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  const preserve = options.preserveNodeIds ?? new Set<string>();
  const visibleIds = new Set([...nodeById.keys()].filter((id) => matches.filter === null || matches.filter.nodeIds.has(id) || preserve.has(id)));
  let edges = sourceEdges
    .filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId))
    .map((edge) => ({
      id: edge.id || `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.relationType}`,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      count: 1,
      width: clamp(options.lineSizeMultiplier, 0.1, 5),
      relationType: edge.relationType,
    } satisfies GraphViewEdge));
  const degrees = new Map([...visibleIds].map((id) => [id, 0]));
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  if (!options.showOrphans) {
    for (const id of visibleIds) if ((degrees.get(id) ?? 0) === 0 && !preserve.has(id)) visibleIds.delete(id);
    edges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  }

  const nodes = [...visibleIds].map((id) => {
    const node = nodeById.get(id)!;
    const degree = degrees.get(id) ?? 0;
    return {
      id,
      title: node.title,
      type: node.nodeType,
      degree,
      weight: degree,
      size: graphNodeSize(degree, options.nodeSizeMultiplier),
      colorGroup: colorForGroup(id, matches.groups),
    } satisfies GraphViewNode;
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    nodes,
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function graphContextAnchorId(
  contextNodeId: string,
  nodes: readonly GraphRenderNode[],
): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return byId.has(contextNodeId) ? contextNodeId : null;
}

/** Keep the selected semantic node's taxonomy path when a query filters the graph. */
export function graphContextPathIds(
  contextNodeId: string,
  selectedNodeId: string | null,
  nodes: readonly GraphRenderNode[],
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  if (byId.has(contextNodeId)) ids.add(contextNodeId);
  let current = selectedNodeId === null ? undefined : byId.get(selectedNodeId);
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    ids.add(current.id);
    if (current.id === contextNodeId || current.parentId === null) break;
    current = byId.get(current.parentId);
  }
  return ids;
}

export interface GraphWindow {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  hiddenCount: number;
}

/** Keep the current node and scope root visible, then fill the mini graph by breadth-first adjacency. */
export function selectGraphWindow(
  model: GraphModel,
  contextNodeId: string,
  selectedNodeId: string | null,
  allSemanticNodes: readonly GraphRenderNode[],
  limit = 40,
): GraphWindow {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const fullById = new Map(allSemanticNodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const visitedPath = new Set<string>();
  let current = selectedNodeId === null ? undefined : fullById.get(selectedNodeId);
  while (current !== undefined && !visitedPath.has(current.id)) {
    visitedPath.add(current.id);
    if (nodeById.has(current.id)) path.unshift(current.id);
    if (current.id === contextNodeId || current.parentId === null) break;
    current = fullById.get(current.parentId);
  }
  const seeds = [...new Set([
    ...(nodeById.has(contextNodeId) ? [contextNodeId] : []),
    ...path,
    ...(selectedNodeId !== null && nodeById.has(selectedNodeId) ? [selectedNodeId] : []),
  ])];
  const maximum = Math.max(1, Math.floor(limit));
  const neighbors = new Map<string, Set<string>>();
  for (const edge of model.edges) {
    const left = neighbors.get(edge.source) ?? new Set<string>();
    left.add(edge.target);
    neighbors.set(edge.source, left);
    const right = neighbors.get(edge.target) ?? new Set<string>();
    right.add(edge.source);
    neighbors.set(edge.target, right);
  }
  const children = new Map<string, string[]>();
  for (const node of allSemanticNodes) {
    if (node.parentId === null || !nodeById.has(node.id)) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const compare = (left: string, right: string): number => {
    const leftNode = nodeById.get(left)!;
    const rightNode = nodeById.get(right)!;
    return (nodeTypeOrder[leftNode.type] - nodeTypeOrder[rightNode.type])
      || (rightNode.degree - leftNode.degree)
      || left.localeCompare(right);
  };
  const ordered: GraphViewNode[] = [];
  const included = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (included.size >= maximum) break;
    const node = nodeById.get(seed);
    if (node === undefined || included.has(seed)) continue;
    included.add(seed);
    ordered.push(node);
    queue.push(seed);
  }
  for (let cursor = 0; cursor < queue.length && ordered.length < maximum; cursor += 1) {
    const current = queue[cursor]!;
    const descendants = (children.get(current) ?? []).filter((id) => !included.has(id)).sort(compare);
    const descendantSet = new Set(descendants);
    const adjacent = [...new Set([...descendants, ...(neighbors.get(current) ?? [])])].filter((id) => !included.has(id)).sort((left, right) => {
      const leftIsChild = descendantSet.has(left);
      const rightIsChild = descendantSet.has(right);
      return (leftIsChild === rightIsChild ? 0 : leftIsChild ? -1 : 1) || compare(left, right);
    });
    for (const id of adjacent) {
      if (ordered.length >= maximum) break;
      const node = nodeById.get(id);
      if (node === undefined) continue;
      included.add(id);
      ordered.push(node);
      queue.push(id);
    }
  }
  if (ordered.length < maximum) {
    for (const node of [...model.nodes].sort((left, right) => compare(left.id, right.id))) {
      if (ordered.length >= maximum) break;
      if (!included.has(node.id)) {
        included.add(node.id);
        ordered.push(node);
      }
    }
  }
  const ids = new Set(ordered.map((node) => node.id));
  return {
    nodes: ordered,
    edges: model.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    hiddenCount: Math.max(0, model.nodes.length - ordered.length),
  };
}

export function graphStructureKey(model: GraphModel): string {
  let hash = 2166136261;
  const feed = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16777619);
  };
  for (const node of model.nodes) feed(node.id);
  for (const edge of model.edges) {
    feed(edge.id);
    feed(edge.source);
    feed(edge.target);
  }
  return `${model.nodes.length}:${model.edges.length}:${hash >>> 0}`;
}
