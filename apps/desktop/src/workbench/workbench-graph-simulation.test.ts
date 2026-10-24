import { describe, expect, it } from 'vitest';
import { createGraphSimulation, DEFAULT_GRAPH_FORCES, reheatGraphSimulation, setSimulationPin, tickGraphSimulation } from './workbench-graph-simulation';

describe('graph force simulation', () => {
  it('uses Obsidian force defaults and clamps exposed values', () => {
    expect(DEFAULT_GRAPH_FORCES).toEqual({ centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 });
    const simulation = createGraphSimulation([], [], { centerStrength: 4, repelStrength: -2, linkDistance: 900 });
    expect(simulation.forces).toEqual({ centerStrength: 1, repelStrength: 0, linkStrength: 1, linkDistance: 500 });
  });

  it('separates exactly overlapping nodes without producing non-finite positions', () => {
    const simulation = createGraphSimulation([
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }, { id: 'c', x: 0, y: 0 },
    ], [], { centerStrength: 0, repelStrength: 0 });
    tickGraphSimulation(simulation, 2);
    expect(simulation.nodes.map(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toEqual([true, true, true]);
    expect(new Set(simulation.nodes.map(({ x, y }) => `${x.toFixed(3)},${y.toFixed(3)}`)).size).toBeGreaterThan(1);
  });

  it('keeps a dragged node pinned and unlocks it on release', () => {
    const simulation = createGraphSimulation([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }], [{ source: 'a', target: 'b' }]);
    setSimulationPin(simulation, 'a', { x: 120, y: -40 });
    tickGraphSimulation(simulation, 2);
    expect(simulation.nodes[0]).toMatchObject({ x: 120, y: -40, fx: 120, fy: -40 });
    setSimulationPin(simulation, 'a', null);
    expect(simulation.nodes[0]).toMatchObject({ fx: null, fy: null });
    expect(simulation.alphaTarget).toBe(0);
  });

  it('places newly added nodes around their positioned document neighbors and preserves existing coordinates', () => {
    const simulation = createGraphSimulation([
      { id: 'left', x: 100, y: 50 },
      { id: 'right', x: 200, y: 50 },
      { id: 'new' },
    ], [
      { source: 'left', target: 'new' },
      { source: 'right', target: 'new' },
    ]);
    const [left, right, added] = simulation.nodes;
    expect(left).toMatchObject({ x: 100, y: 50 });
    expect(right).toMatchObject({ x: 200, y: 50 });
    expect(Math.hypot(added!.x - 150, added!.y - 50)).toBeCloseTo(60);
  });

  it('scales neighbor jitter by the count of new nodes in the batch, not document degree', () => {
    const simulation = createGraphSimulation([
      { id: 'anchor', x: 25, y: 25 },
      { id: 'new-a' },
      { id: 'new-b' },
    ], [
      { source: 'anchor', target: 'new-a' },
      { source: 'anchor', target: 'new-b' },
    ]);
    for (const node of simulation.nodes.slice(1)) {
      expect(Math.hypot(node.x - 25, node.y - 25)).toBeCloseTo(60 * Math.sqrt(2));
    }
  });

  it('places isolated new nodes on an annulus instead of the origin', () => {
    const simulation = createGraphSimulation([{ id: 'one' }, { id: 'two' }], []);
    expect(simulation.nodes.every(({ x, y }) => Math.hypot(x, y) >= 60)).toBe(true);
    expect(new Set(simulation.nodes.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`)).size).toBe(2);
  });

  it('reheats without restarting a hotter simulation', () => {
    const simulation = createGraphSimulation([{ id: 'a' }], []);
    simulation.alpha = 0.7;
    reheatGraphSimulation(simulation, 0.3);
    expect(simulation.alpha).toBe(0.7);
    reheatGraphSimulation(simulation, 1.5);
    expect(simulation.alpha).toBe(1);
  });
});
