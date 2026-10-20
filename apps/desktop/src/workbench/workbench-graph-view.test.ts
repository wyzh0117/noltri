import { describe, expect, it } from 'vitest';
import type { GraphNode } from '@noltri/schema';
import { graphPointToScreen, graphScreenSizeScale, graphViewportMetrics, resolveGraphLabelIds } from './workbench-graph-view';

function node(id: string): GraphNode {
  return { id, title: id, nodeType: 'topic', parentId: null, summary: null };
}

describe('graph screen geometry', () => {
  it('maps world points through camera and the SVG meet viewBox scale', () => {
    const point = graphPointToScreen({ x: 100, y: 200 }, { x: 100, y: 50, scale: 1.5 }, { width: 420, height: 400 });
    expect(point.x).toBeCloseTo(105);
    expect(point.y).toBeCloseTo(200);
  });

  it('keeps node and label geometry in CSS pixels across viewBox sizes and zoom levels', () => {
    for (const viewport of [{ width: 420, height: 400 }, { width: 900, height: 600 }]) {
      for (const scale of [0.22, 0.6, 1, 2.5, 4]) {
        const compensation = graphScreenSizeScale({ x: 0, y: 0, scale }, viewport);
        const { unit } = graphViewportMetrics(viewport);
        expect(unit * scale * compensation).toBeCloseTo(1);
      }
    }
  });

  it('uses measured screen-space collisions so sparse names appear at fit and fade as they overlap on zoom-out', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => node(`Node ${index}`));
    const positions = Object.fromEntries(nodes.map((entry, index) => [entry.id, { x: index < 5 ? 200 : 550, y: 100 + (index % 5) * 100 }])) as Record<string, { x: number; y: number }>;
    const viewport = { width: 420, height: 400 };
    const measureText = (text: string): number => text.length * 6.5;
    const atFit = resolveGraphLabelIds(nodes, [], positions, { x: 0, y: 0, scale: 1 }, 'auto', new Set(), viewport, measureText);
    const zoomedOut = resolveGraphLabelIds(nodes, [], positions, { x: 0, y: 0, scale: 0.25 }, 'auto', new Set(), viewport, measureText);
    const hiddenButFocused = resolveGraphLabelIds(nodes, [], positions, { x: 0, y: 0, scale: 0.25 }, 'hide', new Set([nodes[0]!.id]), viewport, measureText);

    expect(atFit.size).toBe(10);
    expect(zoomedOut.size).toBeLessThan(atFit.size);
    expect(hiddenButFocused).toEqual(new Set([nodes[0]!.id]));
  });
});
