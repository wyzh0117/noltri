import type { GraphSimulation, GraphPoint } from './workbench-graph-simulation';

interface GraphForceWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  graph_create(nodeCount: number, linkCount: number, idUnitCount: number): number;
  graph_destroy(simulation: number): void;
  graph_node_data_ptr(simulation: number): number;
  graph_id_units_ptr(simulation: number): number;
  graph_id_offsets_ptr(simulation: number): number;
  graph_link_indices_ptr(simulation: number): number;
  graph_link_parameters_ptr(simulation: number): number;
  graph_set_forces(simulation: number, center: number, repel: number, link: number, distance: number): void;
  graph_set_pin(simulation: number, index: number, x: number, y: number, pinned: number): void;
  graph_reheat(simulation: number, alpha: number): void;
  graph_set_alpha_target(simulation: number, alphaTarget: number): void;
  graph_step(simulation: number, iterations: number): number;
  graph_alpha(simulation: number): number;
  graph_tick_count(simulation: number): number;
}

declare global {
  // The Node benchmark injects the same compiled asset into its real Worker thread.
  var __NOLTRI_GRAPH_WASM_BYTES__: Uint8Array | undefined;
}

const wasmAssetUrl = new URL('./workbench-graph-force.wasm', import.meta.url);

export async function loadGraphForceWasm(): Promise<GraphForceWasmExports> {
  let bytes: BufferSource;
  const injectedBytes = globalThis.__NOLTRI_GRAPH_WASM_BYTES__;
  if (injectedBytes !== undefined) {
    bytes = new Uint8Array(injectedBytes).buffer as ArrayBuffer;
  } else {
    bytes = await fetch(wasmAssetUrl).then((response) => {
      if (!response.ok) throw new Error(`Graph WASM request failed (${response.status})`);
      return response.arrayBuffer();
    });
  }
  const result = await WebAssembly.instantiate(bytes, {});
  return result.instance.exports as GraphForceWasmExports;
}

export interface WasmGraphSimulation {
  readonly alpha: number;
  readonly tickCount: number;
  step(): number;
  coordinates(): Float32Array;
  setForces(simulation: GraphSimulation): void;
  setPin(nodeId: string, point: GraphPoint | null): void;
  reheat(alpha: number): void;
  syncToFallback(simulation: GraphSimulation): void;
  dispose(): void;
}

export function createWasmGraphSimulation(
  exports: GraphForceWasmExports,
  simulation: GraphSimulation,
): WasmGraphSimulation {
  const nodeCount = simulation.nodes.length;
  const linkCount = simulation.links.length;
  const idUnitCount = simulation.nodes.reduce((total, node) => total + node.id.length, 0);
  const handle = exports.graph_create(nodeCount, linkCount, idUnitCount);
  const nodeDataPointer = exports.graph_node_data_ptr(handle);
  const idUnitsPointer = exports.graph_id_units_ptr(handle);
  const idOffsetsPointer = exports.graph_id_offsets_ptr(handle);
  const linkIndicesPointer = exports.graph_link_indices_ptr(handle);
  const linkParametersPointer = exports.graph_link_parameters_ptr(handle);
  const indices = new Map<string, number>();
  const nodeData = () => new Float64Array(exports.memory.buffer, nodeDataPointer, nodeCount * 6);
  const idUnits = new Uint16Array(exports.memory.buffer, idUnitsPointer, idUnitCount);
  const idOffsets = new Uint32Array(exports.memory.buffer, idOffsetsPointer, nodeCount + 1);
  const linkIndices = new Uint32Array(exports.memory.buffer, linkIndicesPointer, linkCount * 2);
  const linkParameters = new Float64Array(exports.memory.buffer, linkParametersPointer, linkCount * 2);
  const data = nodeData();
  for (let index = 0; index < nodeCount; index += 1) {
    const node = simulation.nodes[index]!;
    indices.set(node.id, index);
    data[index] = node.x;
    data[nodeCount + index] = node.y;
    data[nodeCount * 2 + index] = node.vx;
    data[nodeCount * 3 + index] = node.vy;
    data[nodeCount * 4 + index] = node.fx ?? Number.NaN;
    data[nodeCount * 5 + index] = node.fy ?? Number.NaN;
    idOffsets[index] = idOffsets[index] ?? 0;
    let offset = idOffsets[index]!;
    for (let unit = 0; unit < node.id.length; unit += 1) idUnits[offset++] = node.id.charCodeAt(unit);
    idOffsets[index + 1] = offset;
  }
  exports.graph_set_alpha_target(handle, simulation.alphaTarget);
  for (let index = 0; index < linkCount; index += 1) {
    const link = simulation.links[index]!;
    linkIndices[index * 2] = link.source;
    linkIndices[index * 2 + 1] = link.target;
    linkParameters[index * 2] = link.degreeDenominator;
    linkParameters[index * 2 + 1] = link.sourceBias;
  }

  const setForces = (current: GraphSimulation): void => {
    exports.graph_set_forces(
      handle,
      current.forces.centerStrength,
      current.forces.repelStrength,
      current.forces.linkStrength,
      current.forces.linkDistance,
    );
  };
  setForces(simulation);

  return {
    get alpha() { return exports.graph_alpha(handle); },
    get tickCount() { return exports.graph_tick_count(handle); },
    step: () => exports.graph_step(handle, 1),
    coordinates: () => {
      const current = nodeData();
      const coordinates = new Float32Array(nodeCount * 2);
      for (let index = 0; index < nodeCount; index += 1) {
        coordinates[index * 2] = current[index]!;
        coordinates[index * 2 + 1] = current[nodeCount + index]!;
      }
      return coordinates;
    },
    setForces,
    setPin: (nodeId, point) => {
      const index = indices.get(nodeId);
      if (index === undefined) return;
      exports.graph_set_pin(handle, index, point?.x ?? 0, point?.y ?? 0, point === null ? 0 : 1);
    },
    reheat: (alpha) => exports.graph_reheat(handle, alpha),
    syncToFallback: (current) => {
      const currentData = nodeData();
      for (let index = 0; index < nodeCount; index += 1) {
        const node = current.nodes[index]!;
        node.x = currentData[index]!;
        node.y = currentData[nodeCount + index]!;
        node.vx = currentData[nodeCount * 2 + index]!;
        node.vy = currentData[nodeCount * 3 + index]!;
        const fx = currentData[nodeCount * 4 + index]!;
        const fy = currentData[nodeCount * 5 + index]!;
        node.fx = Number.isFinite(fx) ? fx : null;
        node.fy = Number.isFinite(fy) ? fy : null;
      }
      current.alpha = exports.graph_alpha(handle);
    },
    dispose: () => exports.graph_destroy(handle),
  };
}
