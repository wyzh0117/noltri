import { describe, expect, it } from 'vitest';
import { cameraForFit, cameraForInitialGraphFit, graphNodeScreenRadius, graphSegmentCoordinatesVisibleInViewport, graphPointToScreen, interpolateGraphCamera } from './workbench-graph-view-model';

describe('graph view geometry and camera', () => {
  it('uses the documented exponential camera interpolation and snaps when settled', () => {
    const target = { x: 100, y: -40, scale: 2 };
    const firstFrame = interpolateGraphCamera({ x: 0, y: 0, scale: 1 }, target, 1000 / 60);
    expect(firstFrame.x).toBeCloseTo(15);
    expect(firstFrame.y).toBeCloseTo(-6);
    expect(firstFrame.scale).toBeCloseTo(1.15);

    let current = firstFrame;
    for (let frame = 0; frame < 200 && current !== target; frame += 1) current = interpolateGraphCamera(current, target, 1000 / 60);
    expect(current).toBe(target);
  });

  it('clips segments without changing edge visibility at the viewport boundary', () => {
    const viewport = { width: 100, height: 80 };
    expect(graphSegmentCoordinatesVisibleInViewport(-50, 40, 150, 40, viewport, 0)).toBe(true);
    expect(graphSegmentCoordinatesVisibleInViewport(-50, -50, 150, -50, viewport, 0)).toBe(false);
    expect(graphSegmentCoordinatesVisibleInViewport(100, 80, 130, 120, viewport, 0)).toBe(true);
    expect(graphSegmentCoordinatesVisibleInViewport(101, 81, 130, 120, viewport, 0)).toBe(false);
  });

  it('fits a new scope once both its layout and viewport are ready, regardless of arrival order', () => {
    const nodes = [{ id: 'root', title: 'Root', type: 'discipline' as const, degree: 0, weight: 0, size: 20, colorGroup: null }];
    const positions = { root: { x: 80, y: -30 } };
    const viewport = { width: 0, height: 0 };
    expect(cameraForInitialGraphFit(nodes, positions, viewport, true)).toBeNull();
    expect(cameraForInitialGraphFit(nodes, positions, { width: 800, height: 600 }, false)).toBeNull();
    expect(cameraForInitialGraphFit(nodes, {}, { width: 800, height: 600 }, true)).toBeNull();

    const fitted = cameraForInitialGraphFit(nodes, positions, { width: 800, height: 600 }, true);
    expect(fitted).not.toBeNull();
    expect(fitted!.x).toBeCloseTo(-80 * fitted!.scale - (7 + 'Root'.length * 12) / 2);
    expect(fitted!.y).toBeCloseTo(30 * fitted!.scale);
  });

  it('fits rightmost labels inside the viewport, including taxonomy roots', () => {
    const nodes = [
      { id: 'topic', title: '短主题', type: 'topic' as const, degree: 1, weight: 1, size: 12, colorGroup: null },
      { id: 'root', title: '验收学科公共政策', type: 'discipline' as const, degree: 1, weight: 1, size: 12, colorGroup: null },
    ];
    const positions = { topic: { x: -100, y: 0 }, root: { x: 100, y: 0 } };
    const viewport = { width: 800, height: 600 };
    const camera = cameraForFit(nodes, positions, viewport);
    const screen = graphPointToScreen(positions.root, camera, viewport);
    const radius = graphNodeScreenRadius(nodes[1]!, camera.scale);

    expect(screen.x + radius + 7 + nodes[1]!.title.length * 12).toBeLessThanOrEqual(viewport.width - 36);
    expect(screen.x - radius).toBeGreaterThanOrEqual(36);
  });
});
