import type { GraphEdge, GraphNode, GraphScope, GraphSelection } from '@noltri/schema';

export interface SemanticGraphData {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.relationType}\0${edge.fromNodeId}\0${edge.toNodeId}`;
}

/** Merge opt-in per-discipline Core selections without changing the existing selectGraph contract. */
export function mergeSemanticGraphSelections(selections: readonly GraphSelection[]): SemanticGraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const selection of selections) {
    for (const node of selection.nodes) {
      const current = nodes.get(node.id);
      if (current === undefined) {
        nodes.set(node.id, node);
        continue;
      }
      nodes.set(node.id, {
        ...current,
        summary: current.summary ?? node.summary,
        notePath: current.notePath ?? node.notePath,
        notePaths: [...new Set([...(current.notePaths ?? []), ...(node.notePaths ?? [])])].sort(),
      });
    }
    for (const edge of selection.edges) {
      const key = edgeKey(edge);
      const current = edges.get(key);
      if (current === undefined || current.implicit === true && edge.implicit !== true) edges.set(key, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function parentsFor(data: SemanticGraphData): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const node of data.nodes) {
    if (node.parentId !== null) {
      const values = parents.get(node.id) ?? new Set<string>();
      values.add(node.parentId);
      parents.set(node.id, values);
    }
  }
  for (const edge of data.edges) {
    if (edge.relationType !== 'part_of') continue;
    const values = parents.get(edge.fromNodeId) ?? new Set<string>();
    values.add(edge.toNodeId);
    parents.set(edge.fromNodeId, values);
  }
  return parents;
}

function descendantsOf(data: SemanticGraphData, ancestorId: string): Set<string> {
  const children = new Map<string, Set<string>>();
  for (const node of data.nodes) {
    if (node.parentId === null) continue;
    const values = children.get(node.parentId) ?? new Set<string>();
    values.add(node.id);
    children.set(node.parentId, values);
  }
  for (const edge of data.edges) {
    if (edge.relationType !== 'part_of') continue;
    const values = children.get(edge.toNodeId) ?? new Set<string>();
    values.add(edge.fromNodeId);
    children.set(edge.toNodeId, values);
  }
  const result = new Set<string>();
  const pending = [...(children.get(ancestorId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

function keepInducedGraph(data: SemanticGraphData, ids: Set<string>): SemanticGraphData {
  return {
    nodes: data.nodes.filter((node) => ids.has(node.id)),
    edges: data.edges.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)),
  };
}

/** The complete discipline view is the Core discipline selection, trimmed to that root and descendants. */
export function projectWholeDisciplineGraph(data: SemanticGraphData, disciplineId: string): SemanticGraphData {
  const root = data.nodes.find((node) => node.id === disciplineId && node.nodeType === 'discipline');
  if (root === undefined) return { nodes: [], edges: [] };
  const ids = descendantsOf(data, disciplineId);
  ids.add(disciplineId);
  return keepInducedGraph(data, ids);
}

/** Select the taxonomy view before rendering; callers opt into global scope through their own mode. */
export function buildSubjectGraphView(
  data: SemanticGraphData,
  scope: GraphScope | null,
  subjectScope: 'local' | 'whole-discipline',
  localFocusScope: GraphScope | null = scope,
): SemanticGraphData {
  if (scope === null) return { nodes: [], edges: [] };
  return subjectScope === 'whole-discipline'
    ? projectWholeDisciplineGraph(data, scope.disciplineId)
    : localFocusScope === null ? { nodes: [], edges: [] } : projectLocalSubjectGraph(data, localFocusScope);
}

/** Project the clicked taxonomy object plus its direct children and shared same-level boundaries. */
export function projectLocalSubjectGraph(data: SemanticGraphData, scope: GraphScope): SemanticGraphData {
  const focusId = scope.kind === 'topic' ? scope.anchorTopicId : scope.kind === 'discipline' ? scope.disciplineId : scope.subdisciplineId;
  const focus = data.nodes.find((node) => node.id === focusId);
  if (focus === undefined) return { nodes: [], edges: [] };
  const allowedChildren: Record<GraphNode['nodeType'], readonly GraphNode['nodeType'][]> = {
    discipline: ['subdiscipline', 'domain'],
    subdiscipline: ['topic'],
    domain: ['topic'],
    topic: ['chapter'],
    chapter: [],
  };
  const allowedBoundaries: Record<GraphNode['nodeType'], readonly GraphNode['nodeType'][]> = {
    discipline: ['discipline'],
    subdiscipline: ['subdiscipline', 'domain'],
    domain: ['subdiscipline', 'domain'],
    topic: ['topic'],
    chapter: [],
  };
  const parents = parentsFor(data);
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  const childIds = data.nodes
    .filter((node) => allowedChildren[focus.nodeType].includes(node.nodeType)
      && (parents.get(node.id)?.has(focusId) ?? false))
    .map((node) => node.id);
  const ids = new Set([focusId, ...childIds]);
  for (const childId of childIds) {
    for (const parentId of parents.get(childId) ?? []) {
      const parent = nodesById.get(parentId);
      if (parent !== undefined && parent.id !== focusId && allowedBoundaries[focus.nodeType].includes(parent.nodeType)) ids.add(parent.id);
    }
  }
  return keepInducedGraph(data, ids);
}
