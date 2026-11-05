import type { GraphCamera } from './workbench-graph-view-model';
import type { GraphPoint } from './workbench-graph-simulation';
import { DEFAULT_GRAPH_SETTINGS, normalizeGraphSettings } from './workbench-graph-settings';
import type { GraphSettings } from './workbench-graph-settings';

export interface SavedGraphState {
  camera: GraphCamera | null;
  cameraReady: boolean;
  positions: Record<string, GraphPoint>;
  settings: GraphSettings;
}

const STORAGE_PREFIX = 'noltri:knowledge-graph-v1:';
const INITIAL_CAMERA: GraphCamera = { x: 0, y: 0, scale: 0.5 };

export function graphStateScopeIdentity(scopeIdentity: string, mode: 'mini' | 'expanded'): string {
  return `${scopeIdentity}\0${mode}`;
}

export function graphStateKey(scopeIdentity: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scopeIdentity)}`;
}

function emptyGraphState(): SavedGraphState {
  return { camera: null, cameraReady: false, positions: {}, settings: { ...DEFAULT_GRAPH_SETTINGS, groups: [] } };
}

export function readGraphState(scopeIdentity: string): SavedGraphState {
  try {
    const raw = window.localStorage.getItem(graphStateKey(scopeIdentity));
    if (raw === null) return emptyGraphState();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return emptyGraphState();
    const record = parsed as { camera?: Partial<GraphCamera> | null; cameraReady?: unknown; positions?: unknown; settings?: unknown };
    const storedCamera = record.camera !== null && record.camera !== undefined
      && Number.isFinite(record.camera.x) && Number.isFinite(record.camera.y) && Number.isFinite(record.camera.scale)
      ? {
          x: record.camera.x!,
          y: record.camera.y!,
          scale: Math.min(8, Math.max(1 / 128, record.camera.scale!)),
        }
      : null;
    // Older builds persisted the initial placeholder camera when layout settled before ResizeObserver.
    const legacyPlaceholder = record.cameraReady !== true && storedCamera !== null
      && storedCamera.x === INITIAL_CAMERA.x && storedCamera.y === INITIAL_CAMERA.y && storedCamera.scale === INITIAL_CAMERA.scale;
    const cameraReady = storedCamera !== null
      && (record.cameraReady === true || (record.cameraReady !== false && !legacyPlaceholder));
    const camera = cameraReady ? storedCamera : null;
    const positions: Record<string, GraphPoint> = {};
    if (record.positions !== null && typeof record.positions === 'object' && !Array.isArray(record.positions)) {
      for (const [id, value] of Object.entries(record.positions).slice(0, 20_000)) {
        if (value !== null && typeof value === 'object') {
          const point = value as Partial<GraphPoint>;
          if (Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { x: point.x!, y: point.y! };
        }
      }
    }
    return { camera, cameraReady, positions, settings: normalizeGraphSettings(record.settings) };
  } catch {
    return emptyGraphState();
  }
}

export function writeGraphState(scopeIdentity: string, state: SavedGraphState): void {
  try {
    window.localStorage.setItem(graphStateKey(scopeIdentity), JSON.stringify({ ...state, camera: state.cameraReady ? state.camera : null }));
  } catch {
    // Browser storage can be disabled or full; the in-memory view remains usable.
  }
}

export function scheduleGraphStateWrite<State, Timer>(
  scopeIdentity: string,
  state: State,
  getCurrentScope: () => string,
  write: (scopeIdentity: string, state: State) => void,
  schedule: (callback: () => void, delayMs: number) => Timer,
  cancel: (timer: Timer) => void,
): () => void {
  let written = false;
  const timer = schedule(() => {
    written = true;
    write(scopeIdentity, state);
  }, 220);

  return () => {
    cancel(timer);
    if (!written && getCurrentScope() !== scopeIdentity) {
      written = true;
      write(scopeIdentity, state);
    }
  };
}
