import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, WheelEvent as ReactWheelEvent } from 'react';
import type { GraphEdge, GraphNode } from '@noltri/schema';
import { layoutGraph, selectGraphWindow } from './workbench-graph-layout';
import type { GraphPoint, GraphPositions } from './workbench-graph-layout';
import { scheduleGraphStateWrite } from './workbench-graph-state';
import { GRAPH_VIEW_HEIGHT, GRAPH_VIEW_WIDTH, graphNodeRadius, graphScreenSizeScale, resolveGraphLabelIds } from './workbench-graph-view';
import type { GraphCamera as Camera, GraphLabelMode as LabelMode, GraphViewport } from './workbench-graph-view';
import './workbench-graph.css';

const WIDTH = GRAPH_VIEW_WIDTH;
const HEIGHT = GRAPH_VIEW_HEIGHT;
const STORAGE_PREFIX = 'noltri:graph-v3-view:';
const SCALE_MIN = 0.22;
const SCALE_MAX = 4;

interface SavedScopeState {
  camera: Camera;
  positions: GraphPositions | null;
}

interface DragState {
  pointerId: number;
  kind: 'node' | 'pan';
  nodeId?: string;
  startClientX: number;
  startClientY: number;
  startPoint: GraphPoint;
  startCamera?: Camera;
  startPosition?: GraphPoint;
  moved: boolean;
}

export interface WorkbenchGraphProps {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly scopeIdentity: string;
  readonly selectedNodeId: string | null;
  readonly mode: 'mini' | 'expanded';
  readonly onNodeOpen: (node: GraphNode) => void;
  readonly onModeChange: (mode: 'mini' | 'expanded') => void;
  readonly onNodeMore?: (node: GraphNode) => void;
}

function readScopeState(scopeIdentity: string): SavedScopeState {
  const fallback: SavedScopeState = { camera: { x: 0, y: 0, scale: 1 }, positions: null };
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(scopeIdentity)}`);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return fallback;
    const record = value as { camera?: Partial<Camera>; positions?: GraphPositions | null };
    const camera = record.camera;
    if (camera === undefined || !Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.scale)) return fallback;
    const positions: GraphPositions = {};
    if (record.positions !== null && typeof record.positions === 'object') {
      for (const [id, point] of Object.entries(record.positions)) {
        if (point !== null && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { x: point.x, y: point.y };
      }
    }
    return {
      camera: { x: camera.x!, y: camera.y!, scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, camera.scale!)) },
      positions: record.positions === null ? null : positions,
    };
  } catch {
    return fallback;
  }
}

function writeScopeState(scopeIdentity: string, state: SavedScopeState): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${encodeURIComponent(scopeIdentity)}`, JSON.stringify(state));
  } catch {
    // Browser storage can be disabled or full; the in-memory view remains usable.
  }
}

function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

function graphPoint(svg: SVGSVGElement, clientX: number, clientY: number): GraphPoint {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const matrix = svg.getScreenCTM();
  if (matrix === null) return { x: clientX, y: clientY };
  const local = point.matrixTransform(matrix.inverse());
  return { x: local.x, y: local.y };
}

function boundsFor(nodes: readonly GraphNode[], positions: GraphPositions): { left: number; right: number; top: number; bottom: number } {
  if (nodes.length === 0) return { left: 0, right: WIDTH, top: 0, bottom: HEIGHT };
  const points = nodes.map((node) => positions[node.id]).filter((point): point is GraphPoint => point !== undefined);
  if (points.length === 0) return { left: 0, right: WIDTH, top: 0, bottom: HEIGHT };
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function cameraForFit(nodes: readonly GraphNode[], positions: GraphPositions): Camera {
  const bounds = boundsFor(nodes, positions);
  const width = Math.max(120, bounds.right - bounds.left);
  const height = Math.max(100, bounds.bottom - bounds.top);
  const scale = clampScale(Math.min(880 / width, 580 / height, 1.65));
  return {
    scale,
    x: WIDTH / 2 - ((bounds.left + bounds.right) / 2) * scale,
    y: HEIGHT / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
  };
}

export function WorkbenchGraph({
  nodes,
  edges,
  scopeIdentity,
  selectedNodeId,
  mode,
  onNodeOpen,
  onModeChange,
  onNodeMore,
}: WorkbenchGraphProps): ReactElement {
  const graphWindow = useMemo(() => selectGraphWindow(nodes, edges, selectedNodeId), [nodes, edges, selectedNodeId]);
  const [stored, setStored] = useState<{ scopeIdentity: string; value: SavedScopeState }>(() => ({ scopeIdentity, value: readScopeState(scopeIdentity) }));
  const activeState = stored.scopeIdentity === scopeIdentity ? stored.value : readScopeState(scopeIdentity);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const dragRef = useRef<DragState | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(selectedNodeId);
  const [labelMode, setLabelMode] = useState<LabelMode>('auto');
  const [canvasSize, setCanvasSize] = useState<GraphViewport>({ width: 0, height: 0 });
  const [measureGraphLabel] = useState(() => {
    const context = document.createElement('canvas').getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    if (context !== null) context.font = `13px ${fontFamily}`;
    return (text: string): number => context?.measureText(text).width ?? text.length * 7;
  });
  const suppressNodeClickRef = useRef<string | null>(null);
  const stateSnapshotRef = useRef({ scopeIdentity, state: activeState });
  stateSnapshotRef.current = { scopeIdentity, state: activeState };

  const visibleEdges = useMemo(() => graphWindow.edges, [graphWindow.edges]);
  const layoutPositions = useMemo(
    () => layoutGraph(graphWindow.nodes, visibleEdges, activeState.positions ?? undefined),
    // A camera change doesn't affect layout; graph changes reuse the last persisted node positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphWindow.nodes, visibleEdges, scopeIdentity],
  );
  const positions = useMemo(() => ({ ...layoutPositions, ...(activeState.positions ?? {}) }), [layoutPositions, activeState.positions]);
  const camera = activeState.camera;
  const activeNodeId = hoveredNodeId ?? selectedNodeId;
  const pinnedNodeIds = useMemo(() => new Set([selectedNodeId, hoveredNodeId, focusedNodeId].filter((id): id is string => id !== null)), [selectedNodeId, hoveredNodeId, focusedNodeId]);
  const nodeScreenScale = graphScreenSizeScale(camera, canvasSize);
  const labelIds = useMemo(
    () => resolveGraphLabelIds(graphWindow.nodes, visibleEdges, positions, camera, labelMode, pinnedNodeIds, canvasSize, measureGraphLabel),
    [graphWindow.nodes, visibleEdges, positions, camera, labelMode, pinnedNodeIds, canvasSize, measureGraphLabel],
  );
  const connectedIds = useMemo(() => {
    const result = new Set<string>();
    if (activeNodeId === null) return result;
    result.add(activeNodeId);
    for (const edge of visibleEdges) {
      if (edge.fromNodeId === activeNodeId) result.add(edge.toNodeId);
      if (edge.toNodeId === activeNodeId) result.add(edge.fromNodeId);
    }
    return result;
  }, [visibleEdges, activeNodeId]);

  const updateScopeState = useCallback((update: (current: SavedScopeState) => SavedScopeState): void => {
    setStored((previous) => {
      const current = previous.scopeIdentity === scopeIdentity ? previous.value : readScopeState(scopeIdentity);
      return { scopeIdentity, value: update(current) };
    });
  }, [scopeIdentity]);

  useEffect(() => {
    if (stored.scopeIdentity !== scopeIdentity) setStored({ scopeIdentity, value: readScopeState(scopeIdentity) });
    dragRef.current = null;
    setHoveredNodeId(null);
    setLabelMode('auto');
  }, [scopeIdentity, stored.scopeIdentity]);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return undefined;
    const measure = (): void => {
      const { width, height } = svg.getBoundingClientRect();
      setCanvasSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return scheduleGraphStateWrite(
      scopeIdentity,
      activeState,
      () => stateSnapshotRef.current.scopeIdentity,
      writeScopeState,
      (callback, delay) => window.setTimeout(callback, delay),
      (timer) => window.clearTimeout(timer),
    );
  }, [scopeIdentity, activeState]);

  useEffect(() => () => writeScopeState(stateSnapshotRef.current.scopeIdentity, stateSnapshotRef.current.state), []);

  useEffect(() => {
    const missingPosition = graphWindow.nodes.some((node) => activeState.positions?.[node.id] === undefined);
    if (activeState.positions === null || missingPosition) {
      updateScopeState((current) => ({ ...current, positions }));
    }
  }, [graphWindow.nodes, positions, activeState.positions, updateScopeState]);

  useEffect(() => {
    setFocusedNodeId((current) => current !== null && graphWindow.nodes.some((node) => node.id === current)
      ? current
      : selectedNodeId ?? graphWindow.nodes[0]?.id ?? null);
  }, [graphWindow.nodes, selectedNodeId]);

  const setCamera = useCallback((nextCamera: Camera): void => {
    updateScopeState((current) => ({ ...current, camera: { ...nextCamera, scale: clampScale(nextCamera.scale) } }));
  }, [updateScopeState]);

  const fitView = useCallback((): void => setCamera(cameraForFit(graphWindow.nodes, positions)), [setCamera, graphWindow.nodes, positions]);

  const updatePositions = useCallback((nextPositions: GraphPositions): void => {
    updateScopeState((current) => ({ ...current, positions: nextPositions }));
  }, [updateScopeState]);

  function moveFocus(currentId: string, key: string): void {
    const point = positions[currentId];
    if (point === undefined) return;
    const direction = key === 'ArrowRight' ? { x: 1, y: 0 } : key === 'ArrowLeft' ? { x: -1, y: 0 } : key === 'ArrowDown' ? { x: 0, y: 1 } : { x: 0, y: -1 };
    const candidates = graphWindow.nodes.filter((node) => node.id !== currentId).map((node) => ({ node, point: positions[node.id] })).filter((candidate): candidate is { node: GraphNode; point: GraphPoint } => candidate.point !== undefined);
    const target = candidates
      .map((candidate) => {
        const dx = candidate.point.x - point.x;
        const dy = candidate.point.y - point.y;
        const forward = dx * direction.x + dy * direction.y;
        const sideways = Math.abs(dx * direction.y - dy * direction.x);
        return { ...candidate, forward, score: forward > 0 ? sideways * 2 + forward * 0.35 : Number.POSITIVE_INFINITY };
      })
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((a, b) => a.score - b.score)[0]?.node ?? candidates[0]?.node;
    if (target === undefined) return;
    setFocusedNodeId(target.id);
    nodeRefs.current.get(target.id)?.focus();
  }

  function openMore(node: GraphNode): void {
    onNodeMore?.(node);
  }

  function onNodePointerDown(event: ReactPointerEvent<SVGGElement>, node: GraphNode): void {
    if (event.button !== 0 || svgRef.current === null) return;
    suppressNodeClickRef.current = null;
    event.preventDefault();
    event.stopPropagation();
    const point = graphPoint(svgRef.current, event.clientX, event.clientY);
    const nodePoint = positions[node.id];
    if (nodePoint === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      kind: 'node',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: point,
      startPosition: nodePoint,
      moved: false,
    };
  }

  function onCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || (event.target as Element).closest('[data-graph-node]') !== null) return;
    event.preventDefault();
    const point = graphPoint(event.currentTarget, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      kind: 'pan',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: point,
      startCamera: camera,
      moved: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const point = graphPoint(event.currentTarget, event.clientX, event.clientY);
    if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 4) drag.moved = true;
    if (drag.kind === 'pan' && drag.startCamera !== undefined) {
      setCamera({ ...drag.startCamera, x: drag.startCamera.x + point.x - drag.startPoint.x, y: drag.startCamera.y + point.y - drag.startPoint.y });
    } else if (drag.nodeId !== undefined && drag.startPosition !== undefined) {
      const nextPoint = {
        x: drag.startPosition.x + (point.x - drag.startPoint.x) / camera.scale,
        y: drag.startPosition.y + (point.y - drag.startPoint.y) / camera.scale,
      };
      updatePositions({ ...positions, [drag.nodeId]: nextPoint });
    }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = drag.moved || Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 4;
    if (drag.kind === 'node' && moved && drag.nodeId !== undefined) suppressNodeClickRef.current = drag.nodeId;
  }

  function onNodeClick(event: ReactMouseEvent<SVGGElement>, node: GraphNode): void {
    if (event.detail > 0 && suppressNodeClickRef.current === node.id) {
      suppressNodeClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onNodeOpen(node);
  }

  function onWheel(event: ReactWheelEvent<SVGSVGElement>): void {
    event.preventDefault();
    const point = graphPoint(event.currentTarget, event.clientX, event.clientY);
    const nextScale = clampScale(camera.scale * Math.exp(-event.deltaY * 0.0012));
    const graphX = (point.x - camera.x) / camera.scale;
    const graphY = (point.y - camera.y) / camera.scale;
    setCamera({ scale: nextScale, x: point.x - graphX * nextScale, y: point.y - graphY * nextScale });
  }

  function onGraphKeyDown(event: ReactKeyboardEvent<SVGSVGElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setCamera({ ...camera, scale: clampScale(camera.scale * 1.18) });
    } else if (event.key === '-') {
      event.preventDefault();
      setCamera({ ...camera, scale: clampScale(camera.scale / 1.18) });
    } else if (event.key === '0') {
      event.preventDefault();
      setCamera({ x: 0, y: 0, scale: 1 });
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      fitView();
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const shift = event.key === 'ArrowLeft' ? { x: 40, y: 0 } : event.key === 'ArrowRight' ? { x: -40, y: 0 } : event.key === 'ArrowUp' ? { x: 0, y: 40 } : { x: 0, y: -40 };
      setCamera({ ...camera, x: camera.x + shift.x, y: camera.y + shift.y });
    }
  }

  const onMoreKeyboard = (event: ReactKeyboardEvent<SVGGElement>, node: GraphNode): void => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      event.stopPropagation();
      openMore(node);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onNodeOpen(node);
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(node.id, event.key);
    }
  };

  return (
    <section className={`workbench-graph workbench-graph-${mode}`} aria-label="知识关系图">
      <div className="workbench-graph-toolbar">
        <button type="button" className="workbench-graph-control" onClick={fitView} aria-label="适配全部节点">适配</button>
        <details className="workbench-graph-options">
          <summary aria-label="图显示设置" title="图显示设置">⋯</summary>
          <div className="workbench-graph-options-menu" role="group" aria-label="标签设置">
            <span className="workbench-graph-options-label">节点标签</span>
            <button type="button" aria-pressed={labelMode === 'auto'} onClick={() => setLabelMode('auto')}>自动显示</button>
            <button type="button" aria-pressed={labelMode === 'show'} onClick={() => setLabelMode('show')}>显示全部文字</button>
            <button type="button" aria-pressed={labelMode === 'hide'} onClick={() => setLabelMode('hide')}>隐藏文字</button>
            {graphWindow.hiddenCount > 0 && <span className="workbench-graph-limit-note">为保持流畅暂时折叠 {graphWindow.hiddenCount} 个节点；选中节点及相邻关系会优先保留。</span>}
          </div>
        </details>
        <button
          type="button"
          className="workbench-graph-control workbench-graph-mode"
          aria-label={mode === 'expanded' ? '收起 graph view' : '展开 graph view'}
          onClick={() => onModeChange(mode === 'expanded' ? 'mini' : 'expanded')}
        >
          {mode === 'expanded' ? '收起' : '展开 graph view'}
        </button>
      </div>
      <svg
        ref={svgRef}
        className="workbench-graph-canvas"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={`知识关系图，已绘制 ${graphWindow.nodes.length} 个节点`}
        tabIndex={0}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onGraphKeyDown}
        onDoubleClick={(event) => { if ((event.target as Element).tagName.toLowerCase() === 'svg') fitView(); }}
      >
        <title>知识关系图</title>
        <g className="workbench-graph-world" transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          <g className="workbench-graph-edges" aria-hidden="true">
            {visibleEdges.map((edge: GraphEdge) => {
              const from = positions[edge.fromNodeId];
              const to = positions[edge.toNodeId];
              if (from === undefined || to === undefined) return null;
              const isActive = activeNodeId !== null && (edge.fromNodeId === activeNodeId || edge.toNodeId === activeNodeId);
              return <line key={edge.id} className={isActive ? 'workbench-graph-edge workbench-graph-edge-active' : 'workbench-graph-edge'} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
            })}
          </g>
          <g className="workbench-graph-nodes">
            {graphWindow.nodes.map((node) => {
              const point = positions[node.id];
              if (point === undefined) return null;
              const degree = graphWindow.degree.get(node.id) ?? 0;
              const radius = graphNodeRadius(degree);
              const isSelected = node.id === selectedNodeId;
              const isConnected = connectedIds.has(node.id);
              const isDimmed = activeNodeId !== null && !isConnected;
              const hasLabel = labelIds.has(node.id);
              return (
                <g
                  key={node.id}
                  ref={(element) => { if (element === null) nodeRefs.current.delete(node.id); else nodeRefs.current.set(node.id, element); }}
                  className={`workbench-graph-node${isSelected ? ' is-selected' : ''}${isDimmed ? ' is-dimmed' : ''}${hasLabel ? ' has-label' : ''}`}
                  data-graph-node
                  data-node-type={node.nodeType}
                  data-selected={isSelected || undefined}
                  role="button"
                  aria-label={`${node.title}${node.nodeType === 'chapter' ? '，章节' : '，主题'}${degree ? `，${degree} 个关系` : ''}`}
                  aria-pressed={isSelected}
                  tabIndex={focusedNodeId === node.id || (focusedNodeId === null && node.id === graphWindow.nodes[0]?.id) ? 0 : -1}
                  transform={`translate(${point.x} ${point.y}) scale(${nodeScreenScale})`}
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onClick={(event) => onNodeClick(event, node)}
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId((current) => current === node.id ? null : current)}
                  onFocus={() => setFocusedNodeId(node.id)}
                  onKeyDown={(event) => onMoreKeyboard(event, node)}
                  onContextMenu={(event) => { event.preventDefault(); openMore(node); }}
                >
                  <title>{node.title}</title>
                  <circle className="workbench-graph-node-hit" r="12" />
                  <circle className="workbench-graph-node-halo" r={radius + 5} />
                  <circle className="workbench-graph-node-dot" r={radius} />
                  <text className="workbench-graph-label" x={radius + 7} y="4">{node.title}</text>
                </g>
              );
            })}
          </g>
        </g>
        {graphWindow.nodes.length === 0 && <text className="workbench-graph-empty" x="500" y="350" textAnchor="middle">当前范围还没有可连接的知识</text>}
      </svg>
    </section>
  );
}
