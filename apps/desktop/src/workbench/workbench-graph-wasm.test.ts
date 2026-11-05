import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGraphSimulation,
  setSimulationPin,
  tickGraphSimulation,
} from './workbench-graph-simulation';
import { createWasmGraphSimulation, loadGraphForceWasm } from './workbench-graph-wasm';

describe('graph WASM force solver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('matches the JS fallback forces and deterministic overlap jiggle', async () => {
    vi.stubGlobal('__NOLTRI_GRAPH_WASM_BYTES__', new Uint8Array(readFileSync(new URL('./workbench-graph-force.wasm', import.meta.url))));
    const exports = await loadGraphForceWasm();
    const inputNodes = [
      { id: 'discipline', x: 0, y: 0 },
      { id: 'topic-政策', x: 0, y: 0 },
      { id: 'chapter', x: 140, y: 12 },
      { id: 'fixed', x: -180, y: 40 },
    ];
    const inputLinks = [
      { source: 'discipline', target: 'topic-政策' },
      { source: 'topic-政策', target: 'chapter' },
      { source: 'discipline', target: 'fixed' },
    ];
    const js = createGraphSimulation(inputNodes, inputLinks);
    const wasmFallback = createGraphSimulation(inputNodes, inputLinks);
    const wasm = createWasmGraphSimulation(exports, wasmFallback);
    tickGraphSimulation(js);
    wasm.step();
    wasmFallback.alpha = wasm.alpha;
    const coordinates = wasm.coordinates();
    expect([...coordinates].every(Number.isFinite)).toBe(true);
    for (let index = 0; index < js.nodes.length; index += 1) {
      expect(coordinates[index * 2]).toBeCloseTo(js.nodes[index]!.x, 4);
      expect(coordinates[index * 2 + 1]).toBeCloseTo(js.nodes[index]!.y, 4);
    }

    let jsCalls = 1;
    while (js.alpha > 0.001) {
      tickGraphSimulation(js);
      jsCalls += 1;
    }
    while (wasm.alpha > 0.001) {
      wasm.step();
      wasmFallback.alpha = wasm.alpha;
    }
    expect(jsCalls).toBe(300);
    expect(wasm.tickCount).toBe(300);
    expect(wasm.alpha).toBeLessThanOrEqual(0.001);
    expect([...wasm.coordinates()].every(Number.isFinite)).toBe(true);
    wasm.dispose();
  });

  it('keeps pinned nodes fixed and resumes layout after release', async () => {
    vi.stubGlobal('__NOLTRI_GRAPH_WASM_BYTES__', new Uint8Array(readFileSync(new URL('./workbench-graph-force.wasm', import.meta.url))));
    const exports = await loadGraphForceWasm();
    const inputNodes = [{ id: 'root', x: 0, y: 0 }, { id: 'child', x: 30, y: 20 }];
    const inputLinks = [{ source: 'root', target: 'child' }];
    const js = createGraphSimulation(inputNodes, inputLinks);
    const wasmFallback = createGraphSimulation(inputNodes, inputLinks);
    const wasm = createWasmGraphSimulation(exports, wasmFallback);
    const fixedPoint = { x: -210, y: 80 };
    setSimulationPin(js, 'root', fixedPoint);
    wasm.setPin('root', fixedPoint);
    tickGraphSimulation(js);
    wasm.step();
    wasmFallback.alpha = wasm.alpha;
    expect(wasm.coordinates().slice(0, 2)).toEqual(new Float32Array([fixedPoint.x, fixedPoint.y]));

    setSimulationPin(js, 'root', null);
    wasm.setPin('root', null);
    tickGraphSimulation(js);
    wasm.step();
    expect(wasm.coordinates().slice(0, 2)).not.toEqual(new Float32Array([fixedPoint.x, fixedPoint.y]));
    expect([...wasm.coordinates()].every(Number.isFinite)).toBe(true);
    wasm.dispose();
  });
});
