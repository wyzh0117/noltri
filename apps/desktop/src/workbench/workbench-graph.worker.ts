import { createGraphSimulation, reheatGraphSimulation, setSimulationPin, tickGraphSimulation } from './workbench-graph-simulation';
import type { GraphForces, SimulationLinkInput, SimulationNodeInput } from './workbench-graph-simulation';
import { createWasmGraphSimulation, loadGraphForceWasm } from './workbench-graph-wasm';
import type { WasmGraphSimulation } from './workbench-graph-wasm';

type WorkerInput =
  | { type: 'init'; epoch: number; nodes: SimulationNodeInput[]; links: SimulationLinkInput[]; forces: GraphForces; profile?: boolean }
  | { type: 'forces'; epoch: number; forces: GraphForces }
  | { type: 'pin'; epoch: number; id: string; point: { x: number; y: number } | null }
  | { type: 'reheat'; epoch: number; alpha?: number }
  | { type: 'stop'; epoch: number };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const scope = globalThis as unknown as WorkerScope;
let simulation: ReturnType<typeof createGraphSimulation> | null = null;
let wasmSimulation: WasmGraphSimulation | null = null;
let wasmModule: ReturnType<typeof loadGraphForceWasm> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let taskChannel: MessageChannel | null = null;
let scheduleGeneration = 0;
let scheduledGeneration: number | null = null;
let profiling = false;
let lastBatchEndedAt: number | null = null;
let epoch = 0;
let tickCount = 0;
let initializing = false;
let engine: 'wasm' | 'js' = 'js';
const FRAME_INTERVAL_MS = 1000 / 60;
const TICK_BUDGET_MS = 16;

function stop(): void {
  if (timer !== null) scope.clearTimeout(timer);
  timer = null;
  scheduleGeneration += 1;
  scheduledGeneration = null;
  lastBatchEndedAt = null;
  if (taskChannel !== null) {
    taskChannel.port1.onmessage = null;
    taskChannel.port1.close();
    taskChannel.port2.close();
    taskChannel = null;
  }
}

function runBatch(): void {
  if (simulation === null) return;
  const started = performance.now();
  const yieldMs = lastBatchEndedAt === null ? null : started - lastBatchEndedAt;
  do {
    if (wasmSimulation === null) {
      tickGraphSimulation(simulation);
      tickCount += 1;
    } else {
      try {
        wasmSimulation.step();
        simulation.alpha = wasmSimulation.alpha;
        tickCount = wasmSimulation.tickCount;
      } catch {
        try { wasmSimulation.syncToFallback(simulation); } catch { /* the JS state remains usable */ }
        try { wasmSimulation.dispose(); } catch { /* the WASM instance may already be trapped */ }
        wasmSimulation = null;
        engine = 'js';
        tickGraphSimulation(simulation);
        tickCount += 1;
      }
    }
    if (simulation.alpha <= 0.001 && simulation.alphaTarget === 0) break;
    if (performance.now() - started >= TICK_BUDGET_MS) break;
  } while (true);
  const coordinates = wasmSimulation?.coordinates() ?? new Float32Array(simulation.nodes.length * 2);
  if (wasmSimulation === null) {
    simulation.nodes.forEach((node, index) => {
      coordinates[index * 2] = node.x;
      coordinates[index * 2 + 1] = node.y;
    });
  }
  const batchEndedAt = performance.now();
  const message = { type: 'tick', epoch, coordinates, alpha: simulation.alpha, tickCount, engine };
  if (profiling) {
    lastBatchEndedAt = batchEndedAt;
    scope.postMessage({
      ...message,
      computeMs: batchEndedAt - started,
      yieldMs,
    }, [coordinates.buffer]);
  } else {
    scope.postMessage(message, [coordinates.buffer]);
  }
  if (simulation.alpha > 0.001 || simulation.alphaTarget > 0) {
    // ponytail: yield on the display cadence after a short worker batch; an expensive tick runs alone.
    schedule(Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
  }
}

function getTaskChannel(): MessageChannel | null {
  if (typeof MessageChannel !== 'function') return null;
  if (taskChannel !== null) return taskChannel;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    if (event.data !== scheduledGeneration) return;
    scheduledGeneration = null;
    runBatch();
  };
  // Node's worker test runner should not stay alive solely because of the reusable task ports.
  (channel.port1 as MessagePort & { unref?: () => void }).unref?.();
  (channel.port2 as MessagePort & { unref?: () => void }).unref?.();
  taskChannel = channel;
  return channel;
}

function schedule(delayMs = 0): void {
  if (scheduledGeneration !== null || timer !== null || initializing || simulation === null || simulation.nodes.length === 0) return;
  const generation = ++scheduleGeneration;
  scheduledGeneration = generation;
  const run = (): void => {
    if (generation !== scheduleGeneration) return;
    scheduledGeneration = null;
    runBatch();
  };
  if (delayMs > 0) {
    timer = scope.setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
    return;
  }
  const channel = getTaskChannel();
  if (channel !== null) {
    channel.port2.postMessage(generation);
    return;
  }
  // Older WebViews and unit-test stubs without MessageChannel keep the timer scheduler.
  timer = scope.setTimeout(() => {
    timer = null;
    run();
  }, 0);
}

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init': {
      epoch = data.epoch;
      stop();
      if (wasmSimulation !== null) {
        try { wasmSimulation.dispose(); } catch { /* the WASM instance may already be trapped */ }
      }
      wasmSimulation = null;
      engine = 'js';
      simulation = createGraphSimulation(data.nodes, data.links, data.forces);
      profiling = data.profile === true;
      tickCount = 0;
      lastBatchEndedAt = null;
      initializing = true;
      const requestedEpoch = epoch;
      const requestedSimulation = simulation;
      wasmModule ??= loadGraphForceWasm();
      void wasmModule.then((exports) => {
        if (epoch !== requestedEpoch || simulation !== requestedSimulation) return;
        wasmSimulation = createWasmGraphSimulation(exports, requestedSimulation);
        engine = 'wasm';
      }).catch(() => {
        if (epoch === requestedEpoch && simulation === requestedSimulation) engine = 'js';
      }).finally(() => {
        if (epoch === requestedEpoch && simulation === requestedSimulation) {
          initializing = false;
          schedule();
        }
      });
      break;
    }
    case 'forces':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      simulation.forces = data.forces;
      reheatGraphSimulation(simulation);
      wasmSimulation?.setForces(simulation);
      wasmSimulation?.reheat(simulation.alpha);
      schedule();
      break;
    case 'pin':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      setSimulationPin(simulation, data.id, data.point);
      wasmSimulation?.setPin(data.id, data.point);
      reheatGraphSimulation(simulation);
      wasmSimulation?.reheat(simulation.alpha);
      schedule();
      break;
    case 'reheat':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      reheatGraphSimulation(simulation, data.alpha);
      wasmSimulation?.reheat(simulation.alpha);
      schedule();
      break;
    case 'stop':
      if (data.epoch !== epoch) return;
      stop();
      initializing = false;
      simulation = null;
      if (wasmSimulation !== null) {
        try { wasmSimulation.dispose(); } catch { /* the WASM instance may already be trapped */ }
        wasmSimulation = null;
      }
      break;
  }
};
