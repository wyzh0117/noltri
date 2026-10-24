import type { GraphPoint } from './workbench-graph-simulation';
import type { GraphViewNode } from './workbench-graph-model';

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

export function graphPointToScreen(point: GraphPoint, camera: GraphCamera, viewport: GraphViewport): GraphPoint {
  return { x: viewport.width / 2 + camera.x + point.x * camera.scale, y: viewport.height / 2 + camera.y + point.y * camera.scale };
}

export function graphPointVisibleInViewport(point: GraphPoint, viewport: GraphViewport, margin = 32): boolean {
  return point.x >= -margin && point.x <= viewport.width + margin && point.y >= -margin && point.y <= viewport.height + margin;
}

export function graphSegmentVisibleInViewport(start: GraphPoint, end: GraphPoint, viewport: GraphViewport, margin = 32): boolean {
  return graphSegmentCoordinatesVisibleInViewport(start.x, start.y, end.x, end.y, viewport, margin);
}

export function graphSegmentCoordinatesVisibleInViewport(x0: number, y0: number, x1: number, y1: number, viewport: GraphViewport, margin = 32): boolean {
  const left = -margin;
  const top = -margin;
  const right = viewport.width + margin;
  const bottom = viewport.height + margin;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let first = 0;
  let last = 1;
  for (const [p, q] of [[-dx, x0 - left], [dx, right - x0], [-dy, y0 - top], [dy, bottom - y0]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) first = Math.max(first, ratio);
    else last = Math.min(last, ratio);
    if (first > last) return false;
  }
  return true;
}

export function graphPointFromScreen(point: GraphPoint, camera: GraphCamera, viewport: GraphViewport): GraphPoint {
  return { x: (point.x - viewport.width / 2 - camera.x) / camera.scale, y: (point.y - viewport.height / 2 - camera.y) / camera.scale };
}

export function cameraForFit(nodes: readonly GraphViewNode[], positions: Readonly<Record<string, GraphPoint>>, viewport: GraphViewport): GraphCamera {
  const points = nodes.flatMap((node) => positions[node.id] === undefined ? [] : [positions[node.id]!]);
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const scale = Math.min(8, Math.max(1 / 128, (Math.min(viewport.width, viewport.height) - 72) / Math.max(width, height)));
  return { x: -((left + right) / 2) * scale, y: -((top + bottom) / 2) * scale, scale };
}

export function zoomCameraAt(
  camera: GraphCamera,
  nextScale: number,
  screenPoint: GraphPoint,
  viewport: GraphViewport,
): GraphCamera {
  const scale = Math.min(8, Math.max(1 / 128, nextScale));
  const worldPoint = graphPointFromScreen(screenPoint, camera, viewport);
  return {
    x: screenPoint.x - viewport.width / 2 - worldPoint.x * scale,
    y: screenPoint.y - viewport.height / 2 - worldPoint.y * scale,
    scale,
  };
}

export function graphNodeScreenRadius(node: GraphViewNode, scale: number): number {
  return Math.max(2, node.size * Math.sqrt(Math.max(1 / 128, scale)) / 2);
}

function cellKeys(left: number, top: number, right: number, bottom: number, cellSize: number): string[] {
  const keys: string[] = [];
  for (let y = Math.floor(top / cellSize); y <= Math.floor(bottom / cellSize); y += 1) {
    for (let x = Math.floor(left / cellSize); x <= Math.floor(right / cellSize); x += 1) keys.push(`${x},${y}`);
  }
  return keys;
}

export function resolveGraphLabelIds(
  nodes: readonly GraphViewNode[],
  positions: Readonly<Record<string, GraphPoint>>,
  camera: GraphCamera,
  viewport: GraphViewport,
  mode: GraphLabelMode,
  pinnedIds: ReadonlySet<string>,
  measureText: (text: string) => number,
): Set<string> {
  const available = nodes.filter((node) => positions[node.id] !== undefined);
  if (mode === 'hide') return new Set(available.filter((node) => pinnedIds.has(node.id)).map((node) => node.id));
  const candidates = [...available].sort((left, right) => {
    if (pinnedIds.has(left.id) && !pinnedIds.has(right.id)) return -1;
    if (pinnedIds.has(right.id) && !pinnedIds.has(left.id)) return 1;
    return right.degree - left.degree || left.id.localeCompare(right.id);
  });
  const budget = mode === 'show' ? candidates.length : Math.max(pinnedIds.size, Math.floor(viewport.width * viewport.height / 5000));
  const occupied = new Map<string, Array<{ left: number; right: number; top: number; bottom: number }>>();
  const result = new Set<string>();
  const cellSize = 80;

  for (const node of candidates) {
    if (result.size >= budget && !pinnedIds.has(node.id)) break;
    const point = graphPointToScreen(positions[node.id]!, camera, viewport);
    const left = point.x + graphNodeScreenRadius(node, camera.scale) + 7;
    const top = point.y - 9;
    const box = { left, right: left + Math.max(8, Math.min(280, measureText(node.title))) + 4, top, bottom: top + 18 };
    const keys = cellKeys(box.left - 5, box.top - 3, box.right + 5, box.bottom + 3, cellSize);
    const overlaps = keys.some((key) => (occupied.get(key) ?? []).some((other) =>
      box.left < other.right + 5 && box.right + 5 > other.left && box.top < other.bottom + 3 && box.bottom + 3 > other.top));
    if (overlaps && mode === 'auto' && !pinnedIds.has(node.id)) continue;
    result.add(node.id);
    for (const key of keys) {
      const bucket = occupied.get(key);
      if (bucket === undefined) occupied.set(key, [box]);
      else bucket.push(box);
    }
  }
  return result;
}

export function graphNodeAtPoint(
  nodes: readonly GraphViewNode[],
  positions: Readonly<Record<string, GraphPoint>>,
  camera: GraphCamera,
  viewport: GraphViewport,
  screenPoint: GraphPoint,
  extraRadius = 8,
): GraphViewNode | null {
  let closest: GraphViewNode | null = null;
  let closestDistance = Infinity;
  for (const node of nodes) {
    const worldPoint = positions[node.id];
    if (worldPoint === undefined) continue;
    const point = graphPointToScreen(worldPoint, camera, viewport);
    const distance = Math.hypot(point.x - screenPoint.x, point.y - screenPoint.y);
    if (distance <= graphNodeScreenRadius(node, camera.scale) + extraRadius && distance < closestDistance) {
      closest = node;
      closestDistance = distance;
    }
  }
  return closest;
}
