import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent, ReactElement, WheelEvent } from 'react';
import type { GraphEdge, GraphNode } from '@noltri/schema';
import { buildGraphModel, graphContextAnchorId, graphContextPathIds, graphStructureKey, selectGraphWindow } from './workbench-graph-model';
import type { GraphModel, GraphQueryMatch, GraphViewNode } from './workbench-graph-model';
import { DEFAULT_GRAPH_SETTINGS, createGraphGroup, graphColorInputValue } from './workbench-graph-settings';
import type { GraphColorGroup, GraphSettings } from './workbench-graph-settings';
import { graphStateScopeIdentity, readGraphState, writeGraphState } from './workbench-graph-state';
import { cameraForFit, cameraForInitialGraphFit, graphNodeAtPoint, graphNodeScreenRadius, graphPointFromScreen, graphPointToScreen, interpolateGraphCamera, zoomCameraAt } from './workbench-graph-view-model';
import type { GraphCamera, GraphViewport } from './workbench-graph-view-model';
import type { GraphForces, GraphPoint } from './workbench-graph-simulation';
import { compositeGraphSnapshot, DEFAULT_GRAPH_PALETTE, graphPaletteFromElement, WorkbenchGraphRenderer } from './workbench-graph-renderer';
import type { GraphPalette } from './workbench-graph-renderer';
import './workbench-graph.css';

export interface WorkbenchGraphProps {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly scopeIdentity: string;
  readonly contextNodeId: string;
  readonly mode: 'mini' | 'expanded';
  readonly selectedNodeId: string | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRefresh?: () => void;
  readonly evaluateQuery: (query: string) => Promise<ReadonlySet<string>>;
  readonly onModeChange: (mode: 'mini' | 'expanded') => void;
  readonly onNodeOpen: (node: GraphNode, intent: GraphOpenIntent) => void;
  readonly onNodeMore?: (node: GraphNode) => void;
  readonly onNodeHover?: (node: GraphNode | null, anchor: DOMRect | null) => void;
}

export interface GraphOpenIntent {
  newTab: boolean;
  split: boolean;
}

interface QueryResult {
  match: GraphQueryMatch;
}

interface WorkerTick {
  type: 'tick';
  epoch: number;
  coordinates: Float32Array;
  alpha: number;
  tickCount: number;
  engine: 'wasm' | 'js';
}

interface WorkerLayout {
  epoch: number;
  nodeIds: string[];
  layoutKey: string;
}

interface GraphDrag {
  pointerId: number;
  nodeId: string | null;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  lastMoveTime: number;
  panVelocityX: number;
  panVelocityY: number;
  startScreen: GraphPoint;
  startCamera: GraphCamera;
  moved: boolean;
}

interface ContextMenu {
  nodeId: string;
  x: number;
  y: number;
}

const INITIAL_CAMERA: GraphCamera = { x: 0, y: 0, scale: 0.5 };
const MATCH_DEBOUNCE_MS = 100;
const SAVE_DEBOUNCE_MS = 700;

function localPoint(event: { clientX: number; clientY: number }, element: HTMLElement): GraphPoint {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function uniqueSimulationLinks(model: GraphModel): Array<{ source: string; target: string }> {
  const links = new Map<string, { source: string; target: string }>();
  for (const edge of model.edges) {
    const [source, target] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
    links.set(`${source}\0${target}`, { source, target });
  }
  return [...links.values()];
}

function forceKey(forces: GraphForces): string {
  return `${forces.centerStrength}/${forces.repelStrength}/${forces.linkStrength}/${forces.linkDistance}`;
}

function setGroup(groups: GraphColorGroup[], id: string, patch: Partial<GraphColorGroup>): GraphColorGroup[] {
  return groups.map((group) => group.id === id ? { ...group, ...patch } : group);
}

function ControlToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): ReactElement {
  return <label className="workbench-graph-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
}

function RangeControl({ label, value, min, max, step, onChange, valueText }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; valueText?: string;
}): ReactElement {
  return <label className="workbench-graph-range"><span>{label}<output>{valueText ?? value}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} /></label>;
}

export function WorkbenchGraph({
  nodes: semanticNodes,
  edges: semanticEdges,
  scopeIdentity,
  contextNodeId,
  mode,
  selectedNodeId,
  loading = false,
  error = null,
  onRefresh,
  evaluateQuery,
  onModeChange,
  onNodeOpen,
  onNodeMore,
  onNodeHover,
}: WorkbenchGraphProps): ReactElement {
  const scope = useMemo(() => graphStateScopeIdentity(scopeIdentity, mode), [scopeIdentity, mode]);
  const initialState = useMemo(() => readGraphState(scope), [scope]);
  const [settings, setSettingsState] = useState<GraphSettings>(initialState.settings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [queryResults, setQueryResults] = useState<Map<string, QueryResult>>(() => new Map());
  const [queryPending, setQueryPending] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const queryEpochRef = useRef(0);
  const evaluateQueryRef = useRef(evaluateQuery);
  evaluateQueryRef.current = evaluateQuery;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [rendererState, setRendererState] = useState<{ mode: 'webgl' | 'canvas' | 'error'; message: string | null }>({ mode: 'error', message: null });
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>({ width: 0, height: 0 });

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WorkbenchGraphRenderer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerEpochRef = useRef(0);
  const workerLayoutRef = useRef<WorkerLayout | null>(null);
  const positionsRef = useRef<Record<string, GraphPoint>>({ ...initialState.positions });
  const cameraRef = useRef<GraphCamera>(initialState.camera ?? INITIAL_CAMERA);
  const targetCameraRef = useRef<GraphCamera>(initialState.camera ?? INITIAL_CAMERA);
  const viewportRef = useRef(viewport);
  const modelRef = useRef<GraphModel>({ nodes: [], edges: [] });
  const settingsScopeRef = useRef(scope);
  const layoutKeyRef = useRef('');
  const settledLayoutKeyRef = useRef<string | null>(null);
  const drawFrameRef = useRef<number | null>(null);
  const cameraFrameRef = useRef<number | null>(null);
  const cameraFrameTimeRef = useRef(0);
  const panFrameRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const saveTimerRef = useRef<number | null>(null);
  const dragRef = useRef<GraphDrag | null>(null);
  const hoveredNodeIdRef = useRef<string | null>(null);
  const hoveredSemanticNodeRef = useRef<GraphNode | null>(null);
  const paletteRef = useRef<GraphPalette>(DEFAULT_GRAPH_PALETTE);
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;
  const autoFitPendingRef = useRef(false);
  const forceSettingsKey = forceKey(settings.forces);
  const appliedForceSettingsKeyRef = useRef(forceSettingsKey);

  const currentQueries = useMemo(
    () => [...new Set([settings.filterQuery.trim(), ...settings.groups.map((group) => group.query.trim())].filter(Boolean))],
    [settings.filterQuery, settings.groups],
  );

  useEffect(() => {
    const epoch = ++queryEpochRef.current;
    let active = true;
    setQueryResults(new Map());
    setQueryError(null);
    setQueryPending(currentQueries.length > 0);
    if (currentQueries.length === 0) return () => { active = false; };

    const timer = window.setTimeout(() => {
      void Promise.all(currentQueries.map(async (query) => {
        const nodeIds = await evaluateQueryRef.current(query);
        return [query, { nodeIds: new Set(nodeIds) }] as const;
      })).then((results) => {
        if (!active || queryEpochRef.current !== epoch) return;
        setQueryResults(new Map(results.map(([query, match]) => [query, { match }])));
        setQueryPending(false);
      }).catch((cause: unknown) => {
        if (!active || queryEpochRef.current !== epoch) return;
        setQueryError(cause instanceof Error ? cause.message : '查询匹配失败');
        setQueryPending(false);
      });
    }, MATCH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [currentQueries, scopeIdentity, semanticNodes, semanticEdges]);

  const filterResult = queryResults.get(settings.filterQuery.trim());
  const filterMatch = settings.filterQuery.trim() === '' ? null : filterResult?.match ?? null;
  const groupMatches = useMemo(() => settings.groups.flatMap((group) => {
    const query = group.query.trim();
    const result = queryResults.get(query);
    return query !== '' && result !== undefined ? [{ query, color: group.color, match: result.match }] : [];
  }), [queryResults, settings.groups]);

  const contextAnchorId = useMemo(() => graphContextAnchorId(contextNodeId, semanticNodes), [contextNodeId, semanticNodes]);
  const preserveNodeIds = useMemo(() => graphContextPathIds(contextAnchorId ?? contextNodeId, selectedNodeId, semanticNodes), [contextAnchorId, contextNodeId, selectedNodeId, semanticNodes]);
  const modelOptions = useMemo(() => ({
    showOrphans: settings.showOrphans,
    nodeSizeMultiplier: settings.nodeSizeMultiplier,
    lineSizeMultiplier: settings.lineSizeMultiplier,
    preserveNodeIds,
  }), [settings.showOrphans, settings.nodeSizeMultiplier, settings.lineSizeMultiplier, preserveNodeIds]);
  const fullModel = useMemo(() => buildGraphModel(semanticNodes, semanticEdges, modelOptions, { filter: filterMatch, groups: groupMatches }), [semanticNodes, semanticEdges, modelOptions, filterMatch, groupMatches]);
  const miniWindow = useMemo(() => selectGraphWindow(fullModel, contextAnchorId ?? contextNodeId, selectedNodeId, semanticNodes, 40), [fullModel, contextAnchorId, contextNodeId, selectedNodeId, semanticNodes]);
  const model = useMemo<GraphModel>(() => mode === 'mini' ? { nodes: miniWindow.nodes, edges: miniWindow.edges } : fullModel, [mode, miniWindow, fullModel]);
  const structureKey = useMemo(() => graphStructureKey(model), [model]);
  const layoutKey = `${scope}\0${structureKey}`;
  layoutKeyRef.current = layoutKey;

  settingsRef.current = settings;
  modelRef.current = model;
  viewportRef.current = viewport;

  const persistNow = useCallback((targetScope = settingsScopeRef.current): void => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    writeGraphState(targetScope, {
      camera: autoFitPendingRef.current ? null : targetCameraRef.current,
      cameraReady: !autoFitPendingRef.current,
      positions: positionsRef.current,
      settings: settingsRef.current,
    });
  }, []);

  const schedulePersist = useCallback((): void => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    const capturedScope = settingsScopeRef.current;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      writeGraphState(capturedScope, {
        camera: autoFitPendingRef.current ? null : targetCameraRef.current,
        cameraReady: !autoFitPendingRef.current,
        positions: positionsRef.current,
        settings: settingsRef.current,
      });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const scheduleDraw = useCallback((): void => {
    if (drawFrameRef.current !== null) return;
    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null;
      drawRef.current();
    });
  }, []);

  const fitInitialGraphIfReady = useCallback((): void => {
    if (!autoFitPendingRef.current) return;
    const camera = cameraForInitialGraphFit(modelRef.current.nodes, positionsRef.current, viewportRef.current, settledLayoutKeyRef.current === layoutKeyRef.current);
    if (camera === null) return;
    autoFitPendingRef.current = false;
    cameraRef.current = camera;
    targetCameraRef.current = camera;
    schedulePersist();
    scheduleDraw();
  }, [scheduleDraw, schedulePersist]);

  const animateCamera = useCallback((): void => {
    if (cameraFrameRef.current !== null) return;
    const tick = (time: number): void => {
      const elapsed = cameraFrameTimeRef.current === 0 ? 1000 / 60 : Math.min(50, time - cameraFrameTimeRef.current);
      cameraFrameTimeRef.current = time;
      cameraRef.current = interpolateGraphCamera(cameraRef.current, targetCameraRef.current, elapsed);
      scheduleDraw();
      if (cameraRef.current === targetCameraRef.current) {
        cameraFrameRef.current = null;
        cameraFrameTimeRef.current = 0;
        schedulePersist();
      } else cameraFrameRef.current = window.requestAnimationFrame(tick);
    };
    cameraFrameRef.current = window.requestAnimationFrame(tick);
  }, [scheduleDraw, schedulePersist]);

  const drawGraph = useCallback((): void => {
    const renderer = rendererRef.current;
    const surface = surfaceRef.current;
    const currentModel = modelRef.current;
    const currentViewport = viewportRef.current;
    if (renderer === null || surface === null || currentViewport.width <= 0 || currentViewport.height <= 0) return;
    renderer.draw({
      model: currentModel,
      positions: positionsRef.current,
      camera: cameraRef.current,
      viewport: currentViewport,
      palette: paletteRef.current,
      selectedId: selectedNodeId,
      focusedId: contextAnchorId,
      hoveredId,
      labelMode: settingsRef.current.labelMode,
      showArrows: settingsRef.current.showArrows,
    });
  }, [contextAnchorId, hoveredId, selectedNodeId]);

  drawRef.current = drawGraph;

  const updateSettings = useCallback((change: Partial<GraphSettings> | ((current: GraphSettings) => GraphSettings)): void => {
    setSettingsState((current) => {
      const next = typeof change === 'function' ? change(current) : { ...current, ...change };
      settingsRef.current = next;
      return next;
    });
    schedulePersist();
    scheduleDraw();
  }, [scheduleDraw, schedulePersist]);

  const updateCamera = useCallback((camera: GraphCamera, persist = true): void => {
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    autoFitPendingRef.current = false;
    targetCameraRef.current = camera;
    animateCamera();
    if (persist) schedulePersist();
  }, [animateCamera, schedulePersist]);

  const setCameraImmediately = useCallback((camera: GraphCamera, persist = false): void => {
    if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = null;
    cameraFrameTimeRef.current = 0;
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    autoFitPendingRef.current = false;
    cameraRef.current = camera;
    targetCameraRef.current = camera;
    scheduleDraw();
    if (persist) schedulePersist();
  }, [scheduleDraw, schedulePersist]);

  const startPanInertia = useCallback((velocityX: number, velocityY: number): void => {
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    let lastTime = 0;
    let elapsedTotal = 0;
    let xVelocity = velocityX;
    let yVelocity = velocityY;
    const tick = (time: number): void => {
      if (lastTime === 0) lastTime = time;
      const elapsed = Math.min(50, time - lastTime);
      lastTime = time;
      elapsedTotal += elapsed;
      cameraRef.current = {
        ...cameraRef.current,
        x: cameraRef.current.x + xVelocity * elapsed,
        y: cameraRef.current.y + yVelocity * elapsed,
      };
      targetCameraRef.current = cameraRef.current;
      scheduleDraw();
      const decay = Math.exp(-elapsed / 180);
      xVelocity *= decay;
      yVelocity *= decay;
      if (elapsedTotal < 900 && Math.hypot(xVelocity, yVelocity) >= 0.025) panFrameRef.current = window.requestAnimationFrame(tick);
      else {
        panFrameRef.current = null;
        schedulePersist();
      }
    };
    panFrameRef.current = window.requestAnimationFrame(tick);
  }, [scheduleDraw, schedulePersist]);

  useEffect(() => {
    const state = readGraphState(scope);
    if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = null;
    cameraFrameTimeRef.current = 0;
    settingsScopeRef.current = scope;
    positionsRef.current = state.positions;
    cameraRef.current = state.camera ?? INITIAL_CAMERA;
    targetCameraRef.current = cameraRef.current;
    autoFitPendingRef.current = !state.cameraReady;
    settingsRef.current = state.settings;
    setSettingsState(state.settings);
    setHoveredId(null);
    setKeyboardFocusId(null);
    setContextMenu(null);
    fitInitialGraphIfReady();
    scheduleDraw();
    return () => persistNow(scope);
  }, [scope, fitInitialGraphIfReady, persistNow, scheduleDraw]);

  useEffect(() => {
    if (surfaceRef.current === null || webglCanvasRef.current === null || fallbackCanvasRef.current === null || labelCanvasRef.current === null) return;
    try {
      const renderer = new WorkbenchGraphRenderer(webglCanvasRef.current, fallbackCanvasRef.current, labelCanvasRef.current);
      rendererRef.current = renderer;
      const surface = surfaceRef.current;
      if (surface !== null) paletteRef.current = graphPaletteFromElement(surface);
      setRendererState({ mode: renderer.mode, message: renderer.fallbackReason });
      renderer.resize(viewportRef.current);
      scheduleDraw();
      return () => {
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch (cause) {
      setRendererState({ mode: 'error', message: cause instanceof Error ? cause.message : '无法初始化图谱渲染器' });
    }
  }, [scheduleDraw]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      const next = { width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
      viewportRef.current = next;
      setViewport(next);
      rendererRef.current?.resize(next);
      fitInitialGraphIfReady();
      scheduleDraw();
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [fitInitialGraphIfReady, scheduleDraw]);

  useEffect(() => {
    const themeRoot = surfaceRef.current?.closest('[data-theme]');
    if (themeRoot === null || themeRoot === undefined) return;
    const observer = new MutationObserver(() => {
      const surface = surfaceRef.current;
      if (surface !== null) paletteRef.current = graphPaletteFromElement(surface);
      scheduleDraw();
    });
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [scheduleDraw]);

  useEffect(() => {
    if (typeof Worker === 'undefined') {
      setLayoutError('此环境无法创建图谱布局 Worker。');
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./workbench-graph.worker.ts', import.meta.url), { type: 'module', name: 'Knowledge Graph Worker' });
    } catch (cause) {
      setLayoutError(cause instanceof Error ? cause.message : '图谱布局 Worker 启动失败');
      return;
    }
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerTick>) => {
      const message = event.data;
      const layout = workerLayoutRef.current;
      if (message.type !== 'tick' || layout === null || message.epoch !== layout.epoch || message.coordinates.length !== layout.nodeIds.length * 2) return;
      for (let index = 0; index < layout.nodeIds.length; index += 1) {
        const x = message.coordinates[index * 2]!;
        const y = message.coordinates[index * 2 + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const nodeId = layout.nodeIds[index]!;
        const point = positionsRef.current[nodeId];
        if (point === undefined) positionsRef.current[nodeId] = { x, y };
        else {
          point.x = x;
          point.y = y;
        }
      }
      if (message.alpha <= 0.001) {
        settledLayoutKeyRef.current = layout.layoutKey;
        fitInitialGraphIfReady();
        if (!autoFitPendingRef.current) schedulePersist();
      }
      scheduleDraw();
    };
    worker.onerror = (event) => setLayoutError(event.message || '图谱布局 Worker 出错');
    return () => {
      const layout = workerLayoutRef.current;
      if (layout !== null) worker.postMessage({ type: 'stop', epoch: layout.epoch });
      if (workerRef.current === worker) {
        workerRef.current = null;
        workerLayoutRef.current = null;
      }
      worker.terminate();
    };
  }, [fitInitialGraphIfReady, scheduleDraw, schedulePersist]);

  useEffect(() => {
    const worker = workerRef.current;
    if (worker === null) return;
    const currentModel = modelRef.current;
    const epoch = ++workerEpochRef.current;
    const nodeIds = currentModel.nodes.map((node) => node.id);
    workerLayoutRef.current = { epoch, nodeIds, layoutKey };
    settledLayoutKeyRef.current = null;
    setLayoutError(null);
    appliedForceSettingsKeyRef.current = forceKey(settingsRef.current.forces);
    const nodes = currentModel.nodes.map((node) => ({ id: node.id, ...positionsRef.current[node.id] }));
    worker.postMessage({ type: 'init', epoch, nodes, links: uniqueSimulationLinks(currentModel), forces: settingsRef.current.forces });
    scheduleDraw();
    return () => {
      if (workerRef.current !== worker || workerLayoutRef.current?.epoch !== epoch) return;
      workerLayoutRef.current = null;
      worker.postMessage({ type: 'stop', epoch });
    };
  }, [layoutKey, scheduleDraw]);

  useEffect(() => {
    if (appliedForceSettingsKeyRef.current === forceSettingsKey) return;
    appliedForceSettingsKeyRef.current = forceSettingsKey;
    const worker = workerRef.current;
    if (worker === null) return;
    worker.postMessage({ type: 'forces', epoch: workerEpochRef.current, forces: settings.forces });
    schedulePersist();
  }, [forceSettingsKey, settings.forces, schedulePersist]);

  useEffect(() => {
    scheduleDraw();
  }, [model, scheduleDraw, selectedNodeId, contextAnchorId, hoveredId, settings.labelMode, settings.showArrows]);

  useEffect(() => () => {
    persistNow();
    if (drawFrameRef.current !== null) window.cancelAnimationFrame(drawFrameRef.current);
    if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
  }, [persistNow]);

  const nodeById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);
  const semanticNodeById = useMemo(() => new Map(semanticNodes.map((node) => [node.id, node])), [semanticNodes]);

  const openNode = useCallback((node: GraphViewNode, intent: GraphOpenIntent = { newTab: false, split: false }): void => {
    const semanticNode = semanticNodeById.get(node.id);
    if (semanticNode !== undefined) onNodeOpen(semanticNode, intent);
  }, [onNodeOpen, semanticNodeById]);

  const notifyNodeHover = useCallback((node: GraphViewNode | null): void => {
    const nextId = node?.id ?? null;
    const previousId = hoveredNodeIdRef.current;
    if (previousId !== nextId) {
      if (previousId !== null) onNodeHoverRef.current?.(hoveredSemanticNodeRef.current, null);
      hoveredNodeIdRef.current = nextId;
    }
    if (node === null || nextId === null) {
      hoveredSemanticNodeRef.current = null;
      return;
    }
    const semanticNode = semanticNodeById.get(nextId);
    if (semanticNode === undefined) return;
    hoveredSemanticNodeRef.current = semanticNode;
    const surface = surfaceRef.current;
    const position = positionsRef.current[node.id];
    if (surface === null || position === undefined) return;
    const center = graphPointToScreen(position, cameraRef.current, viewportRef.current);
    const radius = graphNodeScreenRadius(node, cameraRef.current.scale);
    const bounds = surface.getBoundingClientRect();
    onNodeHoverRef.current?.(semanticNode, new DOMRect(bounds.left + center.x - radius, bounds.top + center.y - radius, radius * 2, radius * 2));
  }, [semanticNodeById]);

  useEffect(() => () => {
    if (hoveredNodeIdRef.current !== null) onNodeHoverRef.current?.(hoveredSemanticNodeRef.current, null);
  }, []);

  useEffect(() => {
    const id = hoveredNodeIdRef.current;
    if (id !== null && !model.nodes.some((node) => node.id === id)) {
      onNodeHoverRef.current?.(hoveredSemanticNodeRef.current, null);
      hoveredNodeIdRef.current = null;
      hoveredSemanticNodeRef.current = null;
    }
  }, [model.nodes, semanticNodeById]);

  const fitGraph = useCallback((): void => {
    updateCamera(cameraForFit(modelRef.current.nodes, positionsRef.current, viewportRef.current));
  }, [updateCamera]);

  const takeScreenshot = useCallback(async (): Promise<void> => {
    const canvases = [webglCanvasRef.current, fallbackCanvasRef.current, labelCanvasRef.current].filter((canvas): canvas is HTMLCanvasElement => canvas !== null);
    try {
      drawRef.current();
      const url = compositeGraphSnapshot(canvases);
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
        try {
          const png = fetch(url).then((response) => response.blob());
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
          return;
        } catch {
          // Clipboard permissions and image support vary by host; keep screenshot export available.
        }
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = 'noltri-graph.png';
      link.click();
    } catch (cause) {
      setLayoutError(cause instanceof Error ? cause.message : '截图失败');
    }
  }, []);

  const updatePointer = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const point = localPoint(event, surface);
    const drag = dragRef.current;
    if (drag !== null && drag.pointerId === event.pointerId) {
      const movement = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
      if (drag.nodeId !== null) {
        if (!drag.moved && movement < 5) return;
        drag.moved = true;
        const world = graphPointFromScreen(point, cameraRef.current, viewportRef.current);
        positionsRef.current[drag.nodeId] = world;
        workerRef.current?.postMessage({ type: 'pin', epoch: workerEpochRef.current, id: drag.nodeId, point: world });
      } else {
        const elapsed = Math.max(8, event.timeStamp - drag.lastMoveTime);
        const instantX = Math.max(-2, Math.min(2, (event.clientX - drag.lastClientX) / elapsed));
        const instantY = Math.max(-2, Math.min(2, (event.clientY - drag.lastClientY) / elapsed));
        drag.panVelocityX = drag.panVelocityX * 0.55 + instantX * 0.45;
        drag.panVelocityY = drag.panVelocityY * 0.55 + instantY * 0.45;
        drag.lastClientX = event.clientX;
        drag.lastClientY = event.clientY;
        drag.lastMoveTime = event.timeStamp;
        drag.moved = movement >= 1 || drag.moved;
        setCameraImmediately({
          ...drag.startCamera,
          x: drag.startCamera.x + point.x - drag.startScreen.x,
          y: drag.startCamera.y + point.y - drag.startScreen.y,
        }, false);
      }
      scheduleDraw();
      return;
    }
    const node = graphNodeAtPoint(modelRef.current.nodes, positionsRef.current, cameraRef.current, viewportRef.current, point);
    setHoveredId(node?.id ?? null);
    setKeyboardFocusId(null);
    notifyNodeHover(node);
  }, [notifyNodeHover, scheduleDraw, setCameraImmediately]);

  const endPointer = useCallback((event: PointerEvent<HTMLDivElement>, canceled = false): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer may already be released */ }
    if (drag.nodeId !== null && drag.moved) {
      workerRef.current?.postMessage({ type: 'pin', epoch: workerEpochRef.current, id: drag.nodeId, point: null });
      schedulePersist();
    } else if (drag.nodeId === null && drag.moved) {
      if (!canceled && Math.hypot(drag.panVelocityX, drag.panVelocityY) >= 0.025) startPanInertia(drag.panVelocityX, drag.panVelocityY);
      else schedulePersist();
    } else if (!canceled && !drag.moved && drag.nodeId !== null) {
      const node = nodeById.get(drag.nodeId);
      if (node !== undefined) openNode(node, { newTab: event.metaKey || event.ctrlKey, split: (event.metaKey || event.ctrlKey) && event.shiftKey });
    }
    scheduleDraw();
  }, [nodeById, notifyNodeHover, openNode, scheduleDraw, schedulePersist, startPanInertia]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    setContextMenu(null);
    if (cameraFrameRef.current !== null) window.cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = null;
    cameraFrameTimeRef.current = 0;
    targetCameraRef.current = cameraRef.current;
    const surface = surfaceRef.current;
    if (surface === null) return;
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
    const point = localPoint(event, surface);
    const node = graphNodeAtPoint(modelRef.current.nodes, positionsRef.current, cameraRef.current, viewportRef.current, point);
    dragRef.current = {
      pointerId: event.pointerId,
      nodeId: node?.id ?? null,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastMoveTime: event.timeStamp,
      panVelocityX: 0,
      panVelocityY: 0,
      startScreen: point,
      startCamera: cameraRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current.height : 1;
    const delta = event.deltaY * unit;
    const anchor = delta > 0 ? { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 } : localPoint(event, event.currentTarget);
    updateCamera(zoomCameraAt(targetCameraRef.current, targetCameraRef.current.scale * 1.5 ** (-delta / 120), anchor, viewportRef.current));
  }, [updateCamera]);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const surface = surfaceRef.current;
    if (surface === null) return;
    const point = localPoint(event, surface);
    const node = graphNodeAtPoint(modelRef.current.nodes, positionsRef.current, cameraRef.current, viewportRef.current, point);
    if (node !== null) setContextMenu({ nodeId: node.id, x: point.x, y: point.y });
    else setContextMenu(null);
  }, []);

  const handleKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      setContextMenu(null);
      setKeyboardFocusId(null);
      setHoveredId(null);
      notifyNodeHover(null);
      scheduleDraw();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      fitGraph();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      updateCamera(zoomCameraAt(targetCameraRef.current, targetCameraRef.current.scale * 1.2, { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 }, viewportRef.current));
      return;
    }
    if (event.key === '-') {
      updateCamera(zoomCameraAt(targetCameraRef.current, targetCameraRef.current.scale / 1.2, { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 }, viewportRef.current));
      return;
    }
    const nodes = modelRef.current.nodes;
    if (nodes.length === 0) return;
    const index = Math.max(0, nodes.findIndex((node) => node.id === (keyboardFocusId ?? hoveredId)));
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = nodes[(index + 1) % nodes.length]!;
      setKeyboardFocusId(next.id);
      setHoveredId(next.id);
      notifyNodeHover(next);
      scheduleDraw();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = nodes[(index - 1 + nodes.length) % nodes.length]!;
      setKeyboardFocusId(next.id);
      setHoveredId(next.id);
      notifyNodeHover(next);
      scheduleDraw();
    } else if (event.key === 'Enter') {
      const node = nodes[index];
      if (node !== undefined) openNode(node);
    }
  }, [fitGraph, hoveredId, keyboardFocusId, notifyNodeHover, openNode, scheduleDraw, updateCamera]);

  const updateForce = (key: keyof GraphForces, value: number): void => updateSettings((current) => ({
    ...current,
    forces: { ...current.forces, [key]: value },
  }));

  const contextNode = contextMenu === null ? null : nodeById.get(contextMenu.nodeId) ?? null;
  const fullNodeCount = fullModel.nodes.length;

  return <section className="workbench-graph" aria-label="笔记关系图谱">
    <div className="workbench-graph-toolbar">
      <div className="workbench-graph-mode" role="group" aria-label="图谱范围">
        <button type="button" aria-pressed={mode === 'mini'} onClick={() => onModeChange('mini')}>小图</button>
        <button type="button" aria-pressed={mode === 'expanded'} onClick={() => onModeChange('expanded')}>展开</button>
      </div>
      <button type="button" className="workbench-graph-control" aria-label="适配当前图谱窗口" title="适配当前图谱窗口" onClick={fitGraph}>适配</button>
      <button type="button" className="workbench-graph-control" aria-label="复制或下载图谱截图" title="复制截图；剪贴板不可用时下载" onClick={takeScreenshot}>截图</button>
      {onRefresh !== undefined ? <button type="button" className="workbench-graph-control" aria-label="刷新图谱" title="刷新图谱" onClick={onRefresh}>刷新</button> : null}
      <details className="workbench-graph-options">
        <summary aria-label="图谱设置">⚙</summary>
        <div className="workbench-graph-options-menu">
          <section aria-labelledby="graph-filters-heading">
            <h3 id="graph-filters-heading">筛选</h3>
            <label className="workbench-graph-query"><span>查询</span><input value={settings.filterQuery} maxLength={2000} placeholder="path:项目 tag:方法" onChange={(event) => updateSettings({ filterQuery: event.currentTarget.value })} /></label>
            {queryPending ? <span className="workbench-graph-query-status" role="status">正在匹配…</span> : null}
            {queryError !== null ? <span className="workbench-graph-query-error" role="status">匹配失败：{queryError}</span> : null}
            <div className="workbench-graph-toggles">
              <ControlToggle label="孤立节点" checked={settings.showOrphans} onChange={(showOrphans) => updateSettings({ showOrphans })} />
            </div>
          </section>
          <section aria-labelledby="graph-display-heading">
            <h3 id="graph-display-heading">显示</h3>
            <div className="workbench-graph-toggles">
              <ControlToggle label="箭头" checked={settings.showArrows} onChange={(showArrows) => updateSettings({ showArrows })} />
            </div>
            <label className="workbench-graph-select"><span>标签密度</span><select value={settings.labelMode} onChange={(event) => updateSettings({ labelMode: event.currentTarget.value as GraphSettings['labelMode'] })}><option value="auto">自动</option><option value="show">全部</option><option value="hide">隐藏</option></select></label>
            <RangeControl label="节点大小" value={settings.nodeSizeMultiplier} min={0.1} max={5} step={0.1} valueText={settings.nodeSizeMultiplier.toFixed(1)} onChange={(nodeSizeMultiplier) => updateSettings({ nodeSizeMultiplier })} />
            <RangeControl label="连线粗细" value={settings.lineSizeMultiplier} min={0.1} max={5} step={0.1} valueText={settings.lineSizeMultiplier.toFixed(1)} onChange={(lineSizeMultiplier) => updateSettings({ lineSizeMultiplier })} />
          </section>
          <section aria-labelledby="graph-groups-heading">
            <div className="workbench-graph-section-heading"><h3 id="graph-groups-heading">分组</h3><button type="button" onClick={() => updateSettings((current) => ({ ...current, groups: [...current.groups, createGraphGroup(current.groups.length)] }))}>添加</button></div>
            {settings.groups.length === 0 ? <p className="workbench-graph-muted">分组只着色，不会过滤节点。</p> : null}
            {settings.groups.map((group, index) => <div className="workbench-graph-group" key={group.id}>
              <input aria-label={`分组 ${index + 1} 查询`} value={group.query} maxLength={2000} placeholder="查询" onChange={(event) => {
                const query = event.currentTarget.value;
                updateSettings((current) => ({ ...current, groups: setGroup(current.groups, group.id, { query }) }));
              }} />
              <input type="color" aria-label={`分组 ${index + 1} 颜色`} value={graphColorInputValue(group.color)} onChange={(event) => {
                const color = event.currentTarget.value;
                updateSettings((current) => ({ ...current, groups: setGroup(current.groups, group.id, { color }) }));
              }} />
              <button type="button" aria-label={`删除分组 ${index + 1}`} onClick={() => updateSettings((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) }))}>×</button>
            </div>)}
          </section>
          <section aria-labelledby="graph-forces-heading">
            <h3 id="graph-forces-heading">布局</h3>
            <RangeControl label="向心力" value={settings.forces.centerStrength} min={0} max={1} step={0.01} valueText={settings.forces.centerStrength.toFixed(2)} onChange={(value) => updateForce('centerStrength', value)} />
            <RangeControl label="斥力" value={settings.forces.repelStrength} min={0} max={20} step={0.1} valueText={settings.forces.repelStrength.toFixed(1)} onChange={(value) => updateForce('repelStrength', value)} />
            <RangeControl label="弹簧力" value={settings.forces.linkStrength} min={0} max={1} step={0.01} valueText={settings.forces.linkStrength.toFixed(2)} onChange={(value) => updateForce('linkStrength', value)} />
            <RangeControl label="连线距离" value={settings.forces.linkDistance} min={30} max={500} step={5} valueText={`${settings.forces.linkDistance}px`} onChange={(value) => updateForce('linkDistance', value)} />
            <button type="button" className="workbench-graph-reset" onClick={() => updateSettings((current) => ({ ...current, forces: { ...DEFAULT_GRAPH_SETTINGS.forces } }))}>恢复默认力参数</button>
          </section>
        </div>
      </details>
    </div>

    <div
      ref={surfaceRef}
      className="workbench-graph-surface"
      role="application"
      aria-label={`${mode === 'mini' ? '小图' : '完整'}笔记关系图。方向键选择节点，回车打开，Home 适配画布。`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={updatePointer}
      onPointerUp={(event) => endPointer(event)}
      onPointerCancel={(event) => endPointer(event, true)}
      onPointerLeave={() => { if (dragRef.current === null) { setHoveredId(null); notifyNodeHover(null); } }}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyboard}
    >
      <canvas ref={webglCanvasRef} className="workbench-graph-layer workbench-graph-webgl" aria-hidden="true" />
      <canvas ref={fallbackCanvasRef} className="workbench-graph-layer workbench-graph-fallback" aria-hidden="true" />
      <canvas ref={labelCanvasRef} className="workbench-graph-layer workbench-graph-labels" aria-hidden="true" />
      {model.nodes.length === 0 && !loading ? <div className="workbench-graph-empty" role="status">{error !== null ? '图谱暂不可用' : '当前范围没有符合条件的节点'}</div> : null}
      {loading ? <span className="workbench-graph-loading" role="status">正在刷新图谱…</span> : null}
      {error !== null ? <span className="workbench-graph-error" role="alert">{error}</span> : null}
      {rendererState.mode === 'canvas' ? <span className="workbench-graph-fallback-note" role="status">WebGL2 不可用，已切换到 Canvas 2D。</span> : null}
      {rendererState.mode === 'error' ? <span className="workbench-graph-error" role="alert">图谱渲染不可用：{rendererState.message}</span> : null}
      {layoutError !== null ? <span className="workbench-graph-error" role="alert">{layoutError}</span> : null}
      {contextMenu !== null && contextNode !== null ? <div className="workbench-graph-context" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => { openNode(contextNode); setContextMenu(null); }}>打开 {contextNode.title}</button>
        {onNodeMore !== undefined ? <button type="button" role="menuitem" onClick={() => {
          const semanticNode = semanticNodeById.get(contextNode.id);
          if (semanticNode !== undefined) onNodeMore(semanticNode);
          setContextMenu(null);
        }}>更多操作</button> : null}
      </div> : null}
      {layoutError === null && rendererState.mode !== 'error' ? <span className="workbench-graph-count" aria-live="polite">{model.nodes.length} / {fullNodeCount} 个节点 · {model.edges.length} 条连接{mode === 'mini' && miniWindow.hiddenCount > 0 ? ` · 还有 ${miniWindow.hiddenCount} 个` : ''}</span> : null}
    </div>
  </section>;
}
