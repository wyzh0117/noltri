import { Worker } from 'node:worker_threads';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(desktopRoot, 'src/workbench/workbench-graph.worker.ts');
const wasmBuildScript = resolve(desktopRoot, 'scripts/build-workbench-graph-wasm.mjs');
const wasmPath = resolve(desktopRoot, 'src/workbench/workbench-graph-force.wasm');
const runId = `${process.pid}-${Date.now()}`;
const workerBundle = resolve('/tmp', `noltri-graph-worker-${runId}.mjs`);
const workerBridge = resolve('/tmp', `noltri-graph-worker-bridge-${runId}.mjs`);
const options = new Map(process.argv.slice(2).filter((item) => item.startsWith('--')).map((item) => {
  const [key, ...value] = item.slice(2).split('=');
  return [key, value.join('=')];
}));
const nodeCounts = (options.get('nodes') ?? '100,1000,5000').split(',').map(Number);
const runs = Number(options.get('runs') ?? 3);
const outputPath = options.has('output') ? resolve(options.get('output')) : null;
const fallbackOnly = options.get('fallback-only') === 'true';
const runFallbackSmoke = options.get('fallback-smoke') === 'true';
const edgeShape = options.get('shape') ?? 'star';
const forces = { centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 };

if (!['star', 'chain'].includes(edgeShape)) throw new Error(`Unsupported graph shape: ${edgeShape}`);

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function minimumSeparation(coordinates) {
  const cellSize = 120;
  const cells = new Map();
  let minimum = Infinity;
  for (let index = 0; index < coordinates.length / 2; index += 1) {
    const x = coordinates[index * 2];
    const y = coordinates[index * 2 + 1];
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (const other of cells.get(`${cellX + dx},${cellY + dy}`) ?? []) {
          minimum = Math.min(minimum, Math.hypot(x - coordinates[other * 2], y - coordinates[other * 2 + 1]));
        }
      }
    }
    const key = `${cellX},${cellY}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(index);
    cells.set(key, bucket);
  }
  return minimum;
}

async function createWorkerBundle() {
  execFileSync(process.execPath, [wasmBuildScript], { stdio: 'inherit' });
  await build({ entryPoints: [sourcePath], outfile: workerBundle, bundle: true, format: 'esm', platform: 'node', target: 'node22' });
  const bridge = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { readFile } from 'node:fs/promises';
    let messageHandler = null;
    Object.defineProperty(globalThis, 'onmessage', { configurable: true, get: () => messageHandler, set: (handler) => { messageHandler = handler; } });
    globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
    parentPort.on('message', (data) => messageHandler?.({ data }));
    globalThis.__NOLTRI_GRAPH_WASM_BYTES__ = workerData.invalidWasm
      ? new Uint8Array([0, 1, 2])
      : new Uint8Array(await readFile(workerData.wasmPath));
    await import(${JSON.stringify(pathToFileURL(workerBundle).href)});
    parentPort.postMessage({ type: 'ready' });
  `;
  await writeFile(workerBridge, bridge);
}

async function runOnce(count, run) {
  const workerStarted = performance.now();
  const worker = new Worker(workerBridge, { workerData: { wasmPath } });
  await new Promise((resolveReady, reject) => {
    worker.once('message', (message) => message.type === 'ready' ? resolveReady() : reject(new Error('Worker did not initialize')));
    worker.once('error', reject);
  });
  const workerReadyMs = performance.now() - workerStarted;
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `topic-${index}` }));
  const links = nodes.slice(1).map((node, index) => ({
    source: edgeShape === 'star' ? nodes[0].id : nodes[index].id,
    target: node.id,
  }));
  const messageTimes = [];
  const batchComputeMs = [];
  const batchYieldMs = [];
  const started = performance.now();
  const completed = new Promise((resolveFinal, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker ${count} graph run exceeded 10 seconds`)), 10_000);
    worker.on('message', (message) => {
      if (message.type !== 'tick') return;
      messageTimes.push(performance.now());
      if (typeof message.computeMs === 'number') batchComputeMs.push(message.computeMs);
      if (typeof message.yieldMs === 'number') batchYieldMs.push(message.yieldMs);
      if (message.alpha <= 0.001) {
        clearTimeout(timeout);
        resolveFinal(message);
      }
    });
    worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  try {
    worker.postMessage({ type: 'init', epoch: run, nodes, links, forces, profile: true });
    const final = await completed;
    const elapsedMs = performance.now() - started;
    const startupToConvergenceMs = performance.now() - workerStarted;
    const intervals = messageTimes.slice(1).map((time, index) => time - messageTimes[index]);
    const messageP95Ms = percentile(intervals, 0.95);
    const messageMaxMs = Math.max(0, ...intervals);
    const minimumNodeSeparationPx = minimumSeparation(final.coordinates);
    const result = {
      run,
      nodeCount: count,
      edgeCount: links.length,
      edgeShape: edgeShape === 'star' ? 'star rooted at topic-0' : 'chain from topic-0 through each topic',
      forceParameters: forces,
      physicalTickCount: final.tickCount,
      engine: final.engine,
      finalAlpha: final.alpha,
      workerCreationToReadyMs: Number(workerReadyMs.toFixed(2)),
      layoutConvergenceMs: Number(elapsedMs.toFixed(2)),
      workerStartupToConvergenceMs: Number(startupToConvergenceMs.toFixed(2)),
      workerMessageCount: messageTimes.length,
      messageIntervalP95Ms: Number(messageP95Ms.toFixed(2)),
      messageIntervalMaxMs: Number(messageMaxMs.toFixed(2)),
      workerComputeMsTotal: Number(batchComputeMs.reduce((sum, duration) => sum + duration, 0).toFixed(2)),
      workerComputeMsP95Batch: Number(percentile(batchComputeMs, 0.95).toFixed(2)),
      workerYieldMsTotal: Number(batchYieldMs.reduce((sum, duration) => sum + duration, 0).toFixed(2)),
      workerYieldMsP95Batch: Number(percentile(batchYieldMs, 0.95).toFixed(2)),
      minimumNodeSeparationPx: Number(minimumNodeSeparationPx.toFixed(3)),
      checks: {
        nodeAndEdgeCounts: nodes.length === count && links.length === count - 1,
        all300PhysicsTicks: final.tickCount === 300,
        finiteCoordinates: final.coordinates.length === count * 2 && [...final.coordinates].every(Number.isFinite),
        separatedNodes: minimumNodeSeparationPx > 1,
        usedWasmBackend: final.engine === 'wasm',
        convergenceUnder2s: elapsedMs < 2_000,
        workerStartupToConvergenceUnder2s: startupToConvergenceMs < 2_000,
        messageP95Under34ms: messageP95Ms < 34,
        messageMaxUnder100ms: messageMaxMs < 100,
      },
    };
    result.passed = Object.values(result.checks).every(Boolean);
    return result;
  } finally {
    await worker.terminate();
  }
}

async function runFallbackPinSmoke() {
  const worker = new Worker(workerBridge, { workerData: { wasmPath, invalidWasm: true } });
  const queued = [];
  const waiters = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveReadyWorker, rejectReadyWorker) => {
    resolveReady = resolveReadyWorker;
    rejectReady = rejectReadyWorker;
  });
  worker.on('message', (message) => {
    if (message.type === 'ready') {
      resolveReady();
      return;
    }
    if (message.type !== 'tick') return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(message);
    else queued.push(message);
  });
  worker.once('error', (error) => rejectReady(error));
  await ready;
  const waitForTick = () => queued.length > 0
    ? Promise.resolve(queued.shift())
    : new Promise((resolveTick, rejectTick) => {
      const timeout = setTimeout(() => rejectTick(new Error('Fallback Worker did not post a tick')), 2_000);
      waiters.push((message) => { clearTimeout(timeout); resolveTick(message); });
    });
  const nodes = [{ id: 'root', x: 0, y: 0 }, { id: 'dragged', x: 160, y: 30 }];
  const links = [{ source: 'root', target: 'dragged' }];
  try {
    worker.postMessage({ type: 'init', epoch: 1, nodes, links, forces });
    const initial = await waitForTick();
    const fixedPoint = { x: 123, y: 456 };
    worker.postMessage({ type: 'pin', epoch: 1, id: 'dragged', point: fixedPoint });
    const pinned = await waitForTick();
    worker.postMessage({ type: 'pin', epoch: 1, id: 'dragged', point: null });
    const released = await waitForTick();
    return {
      executionKind: 'Node worker_threads dedicated Worker with an intentionally invalid WASM payload',
      engine: initial.engine,
      pinEngine: pinned.engine,
      releaseEngine: released.engine,
      tickCount: released.tickCount,
      checks: {
        fellBackToJavaScript: initial.engine === 'js' && pinned.engine === 'js' && released.engine === 'js',
        finiteCoordinates: [...released.coordinates].every(Number.isFinite),
        dragPinMessageApplied: pinned.coordinates[2] === fixedPoint.x && pinned.coordinates[3] === fixedPoint.y,
        unpinMessageReleasedNode: released.coordinates[2] !== fixedPoint.x || released.coordinates[3] !== fixedPoint.y,
        layoutContinuedAfterRelease: released.tickCount > pinned.tickCount,
      },
    };
  } finally {
    await worker.terminate();
  }
}

await createWorkerBundle();
const results = [];
if (!fallbackOnly) {
  for (const count of nodeCounts) {
    for (let run = 1; run <= runs; run += 1) {
      results.push(await runOnce(count, run));
    }
  }
}
const fallbackSmoke = runFallbackSmoke ? await runFallbackPinSmoke() : null;
if (fallbackSmoke !== null) fallbackSmoke.passed = Object.values(fallbackSmoke.checks).every(Boolean);
const report = {
  recordedAt: new Date().toISOString(),
  command: `pnpm --filter @noltri/desktop exec node scripts/benchmark-workbench-graph.mjs ${process.argv.slice(2).join(' ')}`.trim(),
  executionKind: 'Node worker_threads dedicated Worker running the production graph Worker with the release Rust WASM solver',
  environment: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length },
  benchmark: {
    target: 'full 300-worker-tick graph layout',
    edgeShape: edgeShape === 'star' ? 'star rooted at topic-0' : 'chain from topic-0 through each topic',
    solver: 'release Rust WASM; JavaScript solver retained as fallback',
    wasmAssetBytes: (await stat(wasmPath)).size,
    sourceHashes: {
      worker: await sha256(sourcePath),
      wasmBridge: await sha256(resolve(desktopRoot, 'src/workbench/workbench-graph-wasm.ts')),
      rustSource: await sha256(resolve(desktopRoot, 'src/workbench/graph-force-wasm/src/lib.rs')),
      wasmBuildScript: await sha256(wasmBuildScript),
      wasm: await sha256(wasmPath),
      workerBundle: await sha256(workerBundle),
    },
    limits: { layoutConvergenceMs: 2_000, workerStartupToConvergenceMs: 2_000, messageIntervalP95Ms: 34, messageIntervalMaxMs: 100 },
    tickBudgetMs: 16,
    frameIntervalMs: 1000 / 60,
    viewport: null,
    devicePixelRatio: null,
    webgl: null,
    gpu: null,
    runs: results,
    fallbackSmoke,
    passed: (fallbackOnly || results.length === nodeCounts.length * runs)
      && results.every((result) => result.passed)
      && (fallbackSmoke === null || fallbackSmoke.passed),
  },
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath !== null) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
  console.log(`Wrote ${outputPath}`);
}
console.log(json);
if (!report.benchmark.passed) process.exitCode = 1;
