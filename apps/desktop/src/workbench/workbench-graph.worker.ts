import { createGraphSimulation, reheatGraphSimulation, setSimulationPin, tickGraphSimulation } from './workbench-graph-simulation';
import type { GraphForces, SimulationLinkInput, SimulationNodeInput } from './workbench-graph-simulation';

type WorkerInput =
  | { type: 'init'; epoch: number; nodes: SimulationNodeInput[]; links: SimulationLinkInput[]; forces: GraphForces }
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
let timer: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;
const FRAME_INTERVAL_MS = 1000 / 60;
const TICK_BUDGET_MS = 12;

function stop(): void {
  if (timer !== null) scope.clearTimeout(timer);
  timer = null;
}

function schedule(delayMs = 0): void {
  if (timer !== null || simulation === null || simulation.nodes.length === 0) return;
  timer = scope.setTimeout(() => {
    timer = null;
    if (simulation === null) return;
    const started = performance.now();
    do {
      tickGraphSimulation(simulation);
      if (simulation.alpha <= 0.001 && simulation.alphaTarget === 0) break;
      if (performance.now() - started >= TICK_BUDGET_MS) break;
    } while (true);
    const coordinates = new Float32Array(simulation.nodes.length * 2);
    simulation.nodes.forEach((node, index) => {
      coordinates[index * 2] = node.x;
      coordinates[index * 2 + 1] = node.y;
    });
    scope.postMessage({ type: 'tick', epoch, coordinates, alpha: simulation.alpha }, [coordinates.buffer]);
    if (simulation.alpha > 0.001 || simulation.alphaTarget > 0) {
      // ponytail: yield at roughly 60 Hz after a 12 ms worker batch; an expensive tick runs alone.
      schedule(Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
    }
  }, delayMs);
}

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init':
      epoch = data.epoch;
      stop();
      simulation = createGraphSimulation(data.nodes, data.links, data.forces);
      schedule();
      break;
    case 'forces':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      simulation.forces = data.forces;
      reheatGraphSimulation(simulation);
      schedule();
      break;
    case 'pin':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      setSimulationPin(simulation, data.id, data.point);
      reheatGraphSimulation(simulation);
      schedule();
      break;
    case 'reheat':
      if (data.epoch !== epoch) return;
      if (simulation === null) return;
      reheatGraphSimulation(simulation, data.alpha);
      schedule();
      break;
    case 'stop':
      if (data.epoch !== epoch) return;
      stop();
      simulation = null;
      break;
  }
};
