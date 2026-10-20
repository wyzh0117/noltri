import type { GraphEdge, GraphNode } from '@noltri/schema';

export interface GraphPoint {
  x: number;
  y: number;
}

export type GraphPositions = Record<string, GraphPoint>;

export const GRAPH_RENDER_LIMIT = 260;

export interface GraphWindow {
  nodes: GraphNode[];
  edges: GraphEdge[];
  degree: Map<string, number>;
  hiddenCount: number;
}

export function selectGraphWindow(
  allNodes: readonly GraphNode[],
  allEdges: readonly GraphEdge[],
  selectedNodeId: string | null,
  limit = GRAPH_RENDER_LIMIT,
): GraphWindow {
  const uniqueNodes = new Map<string, GraphNode>();
  for (const node of allNodes) if (!uniqueNodes.has(node.id)) uniqueNodes.set(node.id, node);
  const degree = new Map<string, number>([...uniqueNodes.keys()].map((id) => [id, 0]));
  const validEdges = allEdges.filter((edge) => uniqueNodes.has(edge.fromNodeId) && uniqueNodes.has(edge.toNodeId));
  const neighbors = new Map<string, Set<string>>();
  for (const edge of validEdges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
    neighbors.get(edge.fromNodeId)?.add(edge.toNodeId) ?? neighbors.set(edge.fromNodeId, new Set([edge.toNodeId]));
    neighbors.get(edge.toNodeId)?.add(edge.fromNodeId) ?? neighbors.set(edge.toNodeId, new Set([edge.fromNodeId]));
  }
  const compare = (left: GraphNode, right: GraphNode): number => {
    return (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0)
      || (left.nodeType === right.nodeType ? 0 : left.nodeType === 'topic' ? -1 : 1)
      || left.id.localeCompare(right.id);
  };
  const selected = selectedNodeId === null ? undefined : uniqueNodes.get(selectedNodeId);
  const maximum = Math.max(1, limit);
  const seeds = [...uniqueNodes.values()].sort(compare);
  if (selected !== undefined) seeds.unshift(selected);
  const ordered: GraphNode[] = [];
  const included = new Set<string>();
  for (const seed of seeds) {
    if (included.has(seed.id) || ordered.length >= maximum) continue;
    const queue = [seed.id];
    const queued = new Set(queue);
    let cursor = 0;
    while (cursor < queue.length && ordered.length < maximum) {
      const id = queue[cursor++]!;
      if (included.has(id)) continue;
      const node = uniqueNodes.get(id);
      if (node === undefined) continue;
      included.add(id);
      ordered.push(node);
      for (const neighbor of [...(neighbors.get(id) ?? [])].sort((left, right) => compare(uniqueNodes.get(left)!, uniqueNodes.get(right)!))) {
        if (!included.has(neighbor) && !queued.has(neighbor)) {
          queued.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  const nodes = ordered;
  const renderedIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: validEdges.filter((edge) => renderedIds.has(edge.fromNodeId) && renderedIds.has(edge.toNodeId)),
    degree,
    hiddenCount: Math.max(0, uniqueNodes.size - nodes.length),
  };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function fitGeneratedPositions(points: readonly GraphPoint[]): GraphPoint[] {
  if (points.length === 0) return [];
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const scale = Math.min(1, 920 / width, 620 / height);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return points.map((point) => ({
    x: 500 + (point.x - centerX) * scale,
    y: 350 + (point.y - centerY) * scale,
  }));
}

export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  savedPositions?: GraphPositions,
): GraphPositions {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const fixed = nodes.map((node) => {
    const saved = savedPositions?.[node.id];
    return saved !== undefined && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  });
  const points: GraphPoint[] = nodes.map((node, index) => {
    const saved = savedPositions?.[node.id];
    if (saved !== undefined && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return { x: saved.x, y: saved.y };
    }
    const linked = edges
      .filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id)
      .map((edge) => edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId)
      .map((id) => savedPositions?.[id])
      .filter((point): point is GraphPoint => point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y));
    const seed = hash(node.id);
    const angle = index * 2.399963229728653 + (seed % 6283) / 1000;
    if (linked.length > 0) {
      const center = linked.reduce((sum, point) => ({ x: sum.x + point.x / linked.length, y: sum.y + point.y / linked.length }), { x: 0, y: 0 });
      const distance = 54 + seed % 38;
      return { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
    }
    const spread = Math.sqrt((index + 1) / Math.max(1, nodes.length));
    const distance = 36 + spread * 275 + (seed % 21);
    return { x: 500 + Math.cos(angle) * distance, y: 350 + Math.sin(angle) * distance };
  });

  const indexedEdges = edges.flatMap((edge) => {
    const from = indexById.get(edge.fromNodeId);
    const to = indexById.get(edge.toNodeId);
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });
  const iterations = Math.min(72, Math.max(32, Math.round(Math.sqrt(nodes.length) * 5)));
  // ponytail: pairwise repulsion is O(n²), capped at 260 nodes; use a spatial grid if the cap rises materially.
  for (let step = 0; step < iterations; step += 1) {
    const fx = new Array<number>(points.length).fill(0);
    const fy = new Array<number>(points.length).fill(0);
    const cooling = 1 - step / iterations;
    for (let left = 0; left < points.length; left += 1) {
      const a = points[left]!;
      fx[left]! += (500 - a.x) * 0.00028;
      fy[left]! += (350 - a.y) * 0.00028;
      for (let right = left + 1; right < points.length; right += 1) {
        const b = points[right]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          const jitter = ((hash(`${nodes[left]!.id}:${nodes[right]!.id}`) % 1000) / 1000) * 0.1 + 0.01;
          dx = jitter;
          dy = -jitter;
          distanceSq = dx * dx + dy * dy;
        }
        const force = 250 / (distanceSq + 360);
        fx[left]! += dx * force;
        fy[left]! += dy * force;
        fx[right]! -= dx * force;
        fy[right]! -= dy * force;
      }
    }
    for (const edge of indexedEdges) {
      const from = points[edge.from]!;
      const to = points[edge.to]!;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const pull = (distance - 118) * 0.2;
      const x = dx / distance * pull;
      const y = dy / distance * pull;
      fx[edge.from]! += x;
      fy[edge.from]! += y;
      fx[edge.to]! -= x;
      fy[edge.to]! -= y;
    }
    for (let index = 0; index < points.length; index += 1) {
      if (fixed[index]) continue;
      let dx = fx[index]! * cooling;
      let dy = fy[index]! * cooling;
      const stepLength = Math.hypot(dx, dy);
      if (stepLength > 8) {
        dx *= 8 / stepLength;
        dy *= 8 / stepLength;
      }
      points[index] = {
        x: points[index]!.x + dx,
        y: points[index]!.y + dy,
      };
    }
  }

  // Fit only a fresh graph. Persisted node coordinates are user state and must stay exact.
  const fittedPoints = fixed.some(Boolean) ? points : fitGeneratedPositions(points);

  return Object.fromEntries(nodes.map((node, index) => [node.id, fittedPoints[index]!])) as GraphPositions;
}
