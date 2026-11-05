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

const CAMERA_RETENTION_PER_FRAME = 0.85;
const REFERENCE_FRAME_MS = 1000 / 60;

export function interpolateGraphCamera(current: GraphCamera, target: GraphCamera, elapsedMs: number): GraphCamera {
  const amount = 1 - CAMERA_RETENTION_PER_FRAME ** (Math.max(0, elapsedMs) / REFERENCE_FRAME_MS);
  const next = {
    x: current.x + (target.x - current.x) * amount,
    y: current.y + (target.y - current.y) * amount,
    scale: current.scale + (target.scale - current.scale) * amount,
  };
  return Math.abs(target.x - next.x) < 0.01 && Math.abs(target.y - next.y) < 0.01 && Math.abs(target.scale - next.scale) < 0.0001
    ? target
    : next;
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
  let p = -dx;
  let q = x0 - left;
  if (p === 0) { if (q < 0) return false; }
  else { const ratio = q / p; if (p < 0) first = Math.max(first, ratio); else last = Math.min(last, ratio); if (first > last) return false; }
  p = dx;
  q = right - x0;
  if (p === 0) { if (q < 0) return false; }
  else { const ratio = q / p; if (p < 0) first = Math.max(first, ratio); else last = Math.min(last, ratio); if (first > last) return false; }
  p = -dy;
  q = y0 - top;
  if (p === 0) { if (q < 0) return false; }
  else { const ratio = q / p; if (p < 0) first = Math.max(first, ratio); else last = Math.min(last, ratio); if (first > last) return false; }
  p = dy;
  q = bottom - y0;
  if (p === 0) { if (q < 0) return false; }
  else { const ratio = q / p; if (p < 0) first = Math.max(first, ratio); else last = Math.min(last, ratio); if (first > last) return false; }
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
  let scale = Math.min(8, (Math.min(viewport.width, viewport.height) - 72) / Math.max(width, height));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const radius = Math.max(2, ...nodes.map((node) => node.size * Math.sqrt(Math.max(1 / 128, scale)) / 2));
    const labelWidth = Math.max(0, ...nodes.map((node) => Math.min(320, node.title.length * 12)));
    const horizontalPadding = radius * 2 + labelWidth + 7;
    const verticalPadding = radius * 2;
    scale = Math.min(
      8,
      (viewport.width - 72 - horizontalPadding) / width,
      (viewport.height - 72 - verticalPadding) / height,
    );
  }
  scale = Math.max(1 / 128, scale);
  const radius = Math.max(2, ...nodes.map((node) => node.size * Math.sqrt(Math.max(1 / 128, scale)) / 2));
  const labelWidth = Math.max(0, ...nodes.map((node) => Math.min(320, node.title.length * 12)));
  const leftPadding = radius;
  const rightPadding = radius + 7 + labelWidth;
  return {
    x: -((left + right) / 2) * scale + (leftPadding - rightPadding) / 2,
    y: -((top + bottom) / 2) * scale,
    scale,
  };
}

export function cameraForInitialGraphFit(
  nodes: readonly GraphViewNode[],
  positions: Readonly<Record<string, GraphPoint>>,
  viewport: GraphViewport,
  layoutSettled: boolean,
): GraphCamera | null {
  if (!layoutSettled || nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  if (nodes.some((node) => {
    const point = positions[node.id];
    return point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y);
  })) return null;
  return cameraForFit(nodes, positions, viewport);
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

export function resolveGraphLabelIds(
  nodes: readonly GraphViewNode[],
  positions: Readonly<Record<string, GraphPoint>>,
  camera: GraphCamera,
  viewport: GraphViewport,
  mode: GraphLabelMode,
  pinnedIds: ReadonlySet<string>,
  measureText: (text: string) => number,
  alreadySorted = false,
): Set<string> {
  const available = alreadySorted ? nodes : nodes.filter((node) => positions[node.id] !== undefined).sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id));
  if (mode === 'hide') return new Set(available.filter((node) => positions[node.id] !== undefined && pinnedIds.has(node.id)).map((node) => node.id));
  if (mode === 'show') return new Set(available.filter((node) => positions[node.id] !== undefined).map((node) => node.id));
  const budget = Math.max(pinnedIds.size, Math.floor(viewport.width * viewport.height / 5000));
  const occupied = new Map<string, Array<{ left: number; right: number; top: number; bottom: number }>>();
  const result = new Set<string>();
  const cellSize = 80;

  const place = (node: GraphViewNode, force: boolean): void => {
    const point = positions[node.id];
    if (point === undefined) return;
    const left = viewport.width / 2 + camera.x + point.x * camera.scale + graphNodeScreenRadius(node, camera.scale) + 7;
    const top = viewport.height / 2 + camera.y + point.y * camera.scale - 9;
    const box = { left, right: left + Math.max(8, Math.min(280, measureText(node.title))) + 4, top, bottom: top + 18 };
    const firstCellX = Math.floor((box.left - 5) / cellSize);
    const lastCellX = Math.floor((box.right + 5) / cellSize);
    const firstCellY = Math.floor((box.top - 3) / cellSize);
    const lastCellY = Math.floor((box.bottom + 3) / cellSize);
    let overlaps = false;
    for (let y = firstCellY; y <= lastCellY && !overlaps; y += 1) {
      for (let x = firstCellX; x <= lastCellX && !overlaps; x += 1) {
        const bucket = occupied.get(`${x},${y}`);
        if (bucket === undefined) continue;
        for (const other of bucket) {
          if (box.left < other.right + 5 && box.right + 5 > other.left && box.top < other.bottom + 3 && box.bottom + 3 > other.top) {
            overlaps = true;
            break;
          }
        }
      }
    }
    if (overlaps && !force) return;
    result.add(node.id);
    for (let y = firstCellY; y <= lastCellY; y += 1) {
      for (let x = firstCellX; x <= lastCellX; x += 1) {
        const key = `${x},${y}`;
        const bucket = occupied.get(key);
        if (bucket === undefined) occupied.set(key, [box]);
        else bucket.push(box);
      }
    }
  };

  for (const node of available) if (pinnedIds.has(node.id)) place(node, true);
  for (const node of available) {
    if (pinnedIds.has(node.id)) continue;
    if (result.size >= budget) break;
    place(node, false);
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
