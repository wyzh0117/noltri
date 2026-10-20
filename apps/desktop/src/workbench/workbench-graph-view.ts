import type { GraphEdge, GraphNode } from '@noltri/schema';
import type { GraphPoint, GraphPositions } from './workbench-graph-layout';

export const GRAPH_VIEW_WIDTH = 1000;
export const GRAPH_VIEW_HEIGHT = 700;

export interface GraphCamera {
  x: number;
  y: number;
  scale: number;
}

export interface GraphViewport {
  width: number;
  height: number;
}

export type GraphLabelMode = 'auto' | 'show' | 'hide';

export function graphViewportMetrics(viewport: GraphViewport): { unit: number; offsetX: number; offsetY: number } {
  if (viewport.width <= 0 || viewport.height <= 0) return { unit: 1, offsetX: 0, offsetY: 0 };
  const unit = Math.min(viewport.width / GRAPH_VIEW_WIDTH, viewport.height / GRAPH_VIEW_HEIGHT);
  return {
    unit,
    offsetX: (viewport.width - GRAPH_VIEW_WIDTH * unit) / 2,
    offsetY: (viewport.height - GRAPH_VIEW_HEIGHT * unit) / 2,
  };
}

export function graphPointToScreen(point: GraphPoint, camera: GraphCamera, viewport: GraphViewport): GraphPoint {
  const { unit, offsetX, offsetY } = graphViewportMetrics(viewport);
  return {
    x: offsetX + (camera.x + point.x * camera.scale) * unit,
    y: offsetY + (camera.y + point.y * camera.scale) * unit,
  };
}

export function graphScreenSizeScale(camera: GraphCamera, viewport: GraphViewport): number {
  return 1 / (camera.scale * graphViewportMetrics(viewport).unit);
}

export function graphNodeRadius(degree: number): number {
  return Math.min(5.8, 3.8 + Math.sqrt(Math.max(0, degree)) * 0.28);
}

export function resolveGraphLabelIds(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  positions: GraphPositions,
  camera: GraphCamera,
  labelMode: GraphLabelMode,
  pinnedNodeIds: ReadonlySet<string>,
  viewport: GraphViewport,
  measureText: (text: string) => number,
): Set<string> {
  if (labelMode === 'hide') return new Set([...pinnedNodeIds].filter((id) => positions[id] !== undefined));

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
  }
  const candidates = [...nodes].sort((left, right) => {
    if (pinnedNodeIds.has(left.id) && !pinnedNodeIds.has(right.id)) return -1;
    if (pinnedNodeIds.has(right.id) && !pinnedNodeIds.has(left.id)) return 1;
    if (left.nodeType !== right.nodeType) return left.nodeType === 'topic' ? -1 : 1;
    return (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id);
  });
  const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const result = new Set<string>();

  for (const node of candidates) {
    const point = positions[node.id];
    if (point === undefined) continue;
    const center = graphPointToScreen(point, camera, viewport);
    const left = center.x + graphNodeRadius(degree.get(node.id) ?? 0) + 7;
    const top = center.y - 9;
    const box = { left, right: left + Math.max(8, measureText(node.title)) + 4, top, bottom: top + 18 };
    const overlaps = occupied.some((other) => box.left < other.right + 5 && box.right + 5 > other.left && box.top < other.bottom + 3 && box.bottom + 3 > other.top);
    if (overlaps && labelMode === 'auto' && !pinnedNodeIds.has(node.id)) continue;
    occupied.push(box);
    result.add(node.id);
  }
  return result;
}
