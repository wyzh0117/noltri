import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphEdge, GraphNode } from '@noltri/schema';

interface WorkerRun {
  nodeCount: number;
  edgeCount: number;
  epoch: number;
  workerId: number;
  workerCreatedAt: number;
  startedAt: number;
  firstMessageAt: number | null;
  finishedAt: number | null;
  workerCreationToFirstMessageMs: number | null;
  workerStartupToConvergenceMs: number | null;
  initToFirstMessageMs: number | null;
  initToConvergenceMs: number | null;
  tickCount: number | null;
  finalAlpha: number | null;
  engine: 'wasm' | 'js' | null;
  batchComputeMs: number[];
  batchYieldMs: number[];
  messageTimes: number[];
}

declare global {
  interface Window {
    __graphAcceptance: {
      nodeCount: number;
      edgeCount: number;
      edgeShape: 'chain' | 'star';
      expand: () => void;
      collapse: () => void;
      verifyMiniExpandReuse: (rounds?: number) => Promise<Array<Pick<WorkerRun, 'nodeCount' | 'edgeCount' | 'epoch' | 'workerId' | 'initToFirstMessageMs' | 'initToConvergenceMs' | 'tickCount' | 'engine'>>>;
      workerRuns: WorkerRun[];
      drawDurations: number[];
      rerun: () => void;
      rendererInfo: () => {
        viewport: { width: number; height: number };
        devicePixelRatio: number;
        rendererMode: string;
        webgl2: boolean;
        webglVersion: string | null;
        vendor: string | null;
        renderer: string | null;
      };
      captureFrames: (durationMs?: number) => Promise<{ durationMs: number; frameCount: number; p95IntervalMs: number; maxIntervalMs: number }>;
    };
  }
}

const nodeCountParam = Number(new URLSearchParams(location.search).get('nodes'));
const nodeCount = [100, 1_000, 5_000].includes(nodeCountParam) ? nodeCountParam : 5_000;
const edgeShape = new URLSearchParams(location.search).get('shape') === 'star' ? 'star' : 'chain';
const nodes: GraphNode[] = Array.from({ length: nodeCount }, (_, index) => ({
  id: `topic-${index}`,
  title: `知识主题 ${index}`,
  nodeType: 'topic',
  parentId: null,
  summary: null,
  notePath: `topics/topic-${index}.md`,
  notePaths: [`topics/topic-${index}.md`],
}));
const edges: GraphEdge[] = nodes.slice(1).map((node, index) => ({
  id: `edge-${index}`,
  fromNodeId: edgeShape === 'star' ? nodes[0]!.id : nodes[index]!.id,
  toNodeId: node.id,
  relationType: 'wikilink',
  source: 'acceptance',
}));
const workerRuns: WorkerRun[] = [];
const drawDurations: number[] = [];
const workerRunsByWorker = new WeakMap<Worker, WorkerRun>();
const workerCreatedAt = new WeakMap<Worker, number>();
const workerIds = new WeakMap<Worker, number>();
let nextWorkerId = 0;
const NativeWorker = window.Worker;

window.__graphAcceptance = {
  nodeCount,
  edgeCount: edges.length,
  edgeShape,
  expand: () => undefined,
  workerRuns,
  drawDurations,
  rerun: () => undefined,
  rendererInfo() {
    const canvas = document.querySelector<HTMLCanvasElement>('.workbench-graph-webgl');
    const graph = document.querySelector<HTMLElement>('.workbench-graph-surface');
    const context = canvas?.hidden === false ? canvas.getContext('webgl2') : null;
    const debug = context?.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
    return {
      viewport: { width: graph?.clientWidth ?? 0, height: graph?.clientHeight ?? 0 },
      devicePixelRatio: window.devicePixelRatio,
      rendererMode: context !== null ? 'webgl' : canvas?.hidden === true ? 'canvas-fallback' : 'uninitialized',
      webgl2: context !== null,
      webglVersion: context?.getParameter(context.VERSION) ?? null,
      vendor: context === null ? null : context.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR),
      renderer: context === null ? null : context.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER),
    };
  },
  captureFrames(durationMs = 3_000) {
    const intervals: number[] = [];
    const startedAt = performance.now();
    let previousFrameAt = 0;
    return new Promise((resolve) => {
      const frame = (time: number): void => {
        if (previousFrameAt > 0) intervals.push(time - previousFrameAt);
        previousFrameAt = time;
        if (time - startedAt >= durationMs) {
          const sorted = [...intervals].sort((left, right) => left - right);
          resolve({
            durationMs: Number((time - startedAt).toFixed(2)),
            frameCount: intervals.length,
            p95IntervalMs: Number((sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0).toFixed(2)),
            maxIntervalMs: Number(Math.max(0, ...intervals).toFixed(2)),
          });
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  },
};

window.Worker = new Proxy(NativeWorker, {
  construct(target, args: [string | URL, WorkerOptions?]) {
    const worker = Reflect.construct(target, args) as Worker;
    workerCreatedAt.set(worker, performance.now());
    workerIds.set(worker, ++nextWorkerId);
    worker.addEventListener('message', (event: MessageEvent<{ type?: string; epoch?: number; alpha?: number; tickCount?: number; engine?: 'wasm' | 'js'; computeMs?: number; yieldMs?: number | null }>) => {
      const run = workerRunsByWorker.get(worker);
      if (run === undefined || event.data.type !== 'tick' || event.data.epoch !== run.epoch) return;
      const now = performance.now();
      run.firstMessageAt ??= now;
      run.workerCreationToFirstMessageMs ??= now - run.workerCreatedAt;
      run.initToFirstMessageMs ??= now - run.startedAt;
      run.messageTimes.push(now);
      run.finalAlpha = event.data.alpha ?? null;
      run.tickCount = event.data.tickCount ?? null;
      run.engine = event.data.engine === 'wasm' || event.data.engine === 'js' ? event.data.engine : null;
      if (typeof event.data.computeMs === 'number') run.batchComputeMs.push(event.data.computeMs);
      if (typeof event.data.yieldMs === 'number') run.batchYieldMs.push(event.data.yieldMs);
      if ((event.data.alpha ?? 1) <= 0.001) {
        run.finishedAt = now;
        run.workerStartupToConvergenceMs = now - run.workerCreatedAt;
        run.initToConvergenceMs = now - run.startedAt;
      }
    });
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = new Proxy(postMessage, {
      apply(targetPostMessage, _thisArg, args: [unknown, Transferable[]?]) {
        const message = args[0] as { type?: string; epoch?: number; nodes?: unknown[]; links?: unknown[]; profile?: boolean };
        if (message.type === 'init') {
          message.profile = true;
          const run: WorkerRun = {
            nodeCount: message.nodes?.length ?? 0,
            edgeCount: message.links?.length ?? 0,
            epoch: message.epoch ?? 0,
            workerId: workerIds.get(worker) ?? 0,
            workerCreatedAt: workerCreatedAt.get(worker) ?? performance.now(),
            startedAt: performance.now(),
            firstMessageAt: null,
            finishedAt: null,
            workerCreationToFirstMessageMs: null,
            workerStartupToConvergenceMs: null,
            initToFirstMessageMs: null,
            initToConvergenceMs: null,
            tickCount: null,
            finalAlpha: null,
            engine: null,
            batchComputeMs: [],
            batchYieldMs: [],
            messageTimes: [],
          };
          workerRuns.push(run);
          workerRunsByWorker.set(worker, run);
          workerCreatedAt.set(worker, workerCreatedAt.get(worker) ?? run.startedAt);
        }
        return Reflect.apply(targetPostMessage, worker, args);
      },
    }) as typeof worker.postMessage;
    return worker;
  },
});

const { WorkbenchGraphRenderer } = await import('./src/workbench/workbench-graph-renderer');
const draw = WorkbenchGraphRenderer.prototype.draw;
WorkbenchGraphRenderer.prototype.draw = function (input) {
  const startedAt = performance.now();
  draw.call(this, input);
  drawDurations.push(performance.now() - startedAt);
};
const { WorkbenchGraph } = await import('./src/workbench/WorkbenchGraph');

function App(): ReactElement {
  const [mode, setMode] = useState<'mini' | 'expanded'>('mini');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('topic-0');
  const [runGeneration, setRunGeneration] = useState(0);
  window.__graphAcceptance.rerun = () => setRunGeneration((generation) => generation + 1);
  window.__graphAcceptance.expand = () => setMode('expanded');
  window.__graphAcceptance.collapse = () => setMode('mini');
  window.__graphAcceptance.verifyMiniExpandReuse = async (rounds = 3) => {
    const waitForRun = async (count: number): Promise<WorkerRun> => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const run = workerRuns[count - 1];
        if (run !== undefined && run.finishedAt !== null) return run;
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for graph run ${count}`);
    };
    const result: WorkerRun[] = [await waitForRun(1)];
    for (let index = 0; index < rounds; index += 1) {
      const expandedCount = workerRuns.length + 1;
      setMode('expanded');
      const expanded = await waitForRun(expandedCount);
      if (expanded.nodeCount <= 40) throw new Error('Expanded graph did not include the full scope');
      result.push(expanded);
      if (index < rounds - 1) {
        const miniCount = workerRuns.length + 1;
        setMode('mini');
        const mini = await waitForRun(miniCount);
        if (mini.nodeCount !== 40) throw new Error(`Mini graph contained ${mini.nodeCount} nodes instead of 40`);
        result.push(mini);
      }
    }
    const workerIds = new Set(result.map((run) => run.workerId));
    if (workerIds.size !== 1) throw new Error(`Graph modes created ${workerIds.size} Workers`);
    const invalidRun = result.find((run) => run.tickCount !== 300);
    if (invalidRun !== undefined) throw new Error(`Graph epoch ${invalidRun.epoch} settled after ${invalidRun.tickCount} ticks`);
    return result.map(({ nodeCount, edgeCount, epoch, workerId, initToFirstMessageMs, initToConvergenceMs, tickCount, engine }) => ({
      nodeCount, edgeCount, epoch, workerId, initToFirstMessageMs, initToConvergenceMs, tickCount, engine,
    }));
  };
  return <main style={{ width: '100%', height: '100%', display: 'grid', gridTemplateRows: '30px 1fr' }}>
    <output id="harness-status">{nodeCount} semantic topics · {edges.length} {edgeShape} wiki edges</output>
    <WorkbenchGraph
      key={runGeneration}
      nodes={nodes}
      edges={edges}
      scopeIdentity="acceptance-graph"
      contextNodeId="topic-0"
      mode={mode}
      selectedNodeId={selectedNodeId}
      evaluateQuery={async (query) => new Set(nodes.filter((node) => node.title.includes(query)).map((node) => node.id))}
      onModeChange={setMode}
      onNodeOpen={(node) => setSelectedNodeId(node.id)}
    />
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
