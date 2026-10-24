import { describe, expect, it } from 'vitest';
import { cameraForFit, graphNodeAtPoint, graphPointFromScreen, graphPointToScreen, graphPointVisibleInViewport, graphSegmentVisibleInViewport, resolveGraphLabelIds, zoomCameraAt } from './workbench-graph-view-model';
import type { GraphViewNode } from './workbench-graph-model';

const node = (id: string, degree = 1): GraphViewNode => ({
  id, path: id, title: id, basename: id, type: 'note', tags: [], degree, weight: degree, size: 8, colorGroup: null, depth: null,
});

describe('graph camera and screen interaction', () => {
  it('maps world points and zooms around the pointer anchor', () => {
    const camera = { x: 30, y: -20, scale: 2 };
    const viewport = { width: 600, height: 400 };
    const screen = graphPointToScreen({ x: 25, y: -10 }, camera, viewport);
    expect(graphPointFromScreen(screen, camera, viewport)).toEqual({ x: 25, y: -10 });
    const next = zoomCameraAt(camera, 4, { x: 180, y: 150 }, viewport);
    expect(graphPointToScreen(graphPointFromScreen({ x: 180, y: 150 }, camera, viewport), next, viewport)).toEqual({ x: 180, y: 150 });
  });

  it('fits positions into the viewport and finds the closest node under the pointer', () => {
    const nodes = [node('a'), node('b')];
    const positions = { a: { x: -200, y: 100 }, b: { x: 200, y: -100 } };
    const camera = cameraForFit(nodes, positions, { width: 600, height: 400 });
    const a = graphPointToScreen(positions.a, camera, { width: 600, height: 400 });
    expect(a.x).toBeGreaterThan(0);
    expect(a.y).toBeGreaterThan(0);
    expect(graphNodeAtPoint(nodes, positions, camera, { width: 600, height: 400 }, a)?.id).toBe('a');
  });

  it('keeps focused labels and reduces automatic labels when boxes overlap', () => {
    const nodes = Array.from({ length: 12 }, (_, index) => node(`node-${index}`, 12 - index));
    const positions = Object.fromEntries(nodes.map((entry, index) => [entry.id, { x: index < 6 ? 0 : 300, y: index % 6 * 2 }])) as Record<string, { x: number; y: number }>;
    const viewport = { width: 420, height: 400 };
    const auto = resolveGraphLabelIds(nodes, positions, { x: 0, y: 0, scale: 1 }, viewport, 'auto', new Set(['node-11']), (text) => text.length * 8);
    const hidden = resolveGraphLabelIds(nodes, positions, { x: 0, y: 0, scale: 1 }, viewport, 'hide', new Set(['node-11']), (text) => text.length * 8);
    expect(auto.size).toBeLessThan(nodes.length);
    expect(auto.has('node-11')).toBe(true);
    expect(hidden).toEqual(new Set(['node-11']));
  });

  it('culls offscreen points and segments without dropping lines that cross the viewport', () => {
    const viewport = { width: 100, height: 80 };
    expect(graphPointVisibleInViewport({ x: 50, y: 40 }, viewport)).toBe(true);
    expect(graphPointVisibleInViewport({ x: 500, y: 40 }, viewport)).toBe(false);
    expect(graphSegmentVisibleInViewport({ x: -100, y: 40 }, { x: 200, y: 40 }, viewport)).toBe(true);
    expect(graphSegmentVisibleInViewport({ x: -100, y: -100 }, { x: -50, y: -50 }, viewport)).toBe(false);
  });
});
