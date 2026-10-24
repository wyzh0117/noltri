import type { GraphCamera } from './workbench-graph-view-model';
import type { GraphPoint } from './workbench-graph-simulation';
import { DEFAULT_GRAPH_SETTINGS, normalizeGraphSettings } from './workbench-graph-settings';
import type { GraphSettings } from './workbench-graph-settings';

export interface SavedGraphState {
  camera: GraphCamera | null;
  positions: Record<string, GraphPoint>;
  settings: GraphSettings;
}

const STORAGE_PREFIX = 'noltri:vault-graph-v1:';

export function graphStateScopeIdentity(vaultRoot: string, mode: 'global' | 'local', focusPath: string | null): string {
  return `${vaultRoot}\0${mode}\0${mode === 'local' ? focusPath ?? '' : ''}`;
}

export function graphStateKey(scopeIdentity: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scopeIdentity)}`;
}

function emptyGraphState(): SavedGraphState {
  return { camera: null, positions: {}, settings: { ...DEFAULT_GRAPH_SETTINGS, groups: [] } };
}

export function readGraphState(scopeIdentity: string): SavedGraphState {
  try {
    const raw = window.localStorage.getItem(graphStateKey(scopeIdentity));
    if (raw === null) return emptyGraphState();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return emptyGraphState();
    const record = parsed as { camera?: Partial<GraphCamera> | null; positions?: unknown; settings?: unknown };
    const camera = record.camera !== null && record.camera !== undefined
      && Number.isFinite(record.camera.x) && Number.isFinite(record.camera.y) && Number.isFinite(record.camera.scale)
      ? {
          x: record.camera.x!,
          y: record.camera.y!,
          scale: Math.min(8, Math.max(1 / 128, record.camera.scale!)),
        }
      : null;
    const positions: Record<string, GraphPoint> = {};
    if (record.positions !== null && typeof record.positions === 'object' && !Array.isArray(record.positions)) {
      for (const [id, value] of Object.entries(record.positions).slice(0, 20_000)) {
        if (value !== null && typeof value === 'object') {
          const point = value as Partial<GraphPoint>;
          if (Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { x: point.x!, y: point.y! };
        }
      }
    }
    return { camera, positions, settings: normalizeGraphSettings(record.settings) };
  } catch {
    return emptyGraphState();
  }
}

export function writeGraphState(scopeIdentity: string, state: SavedGraphState): void {
  try {
    window.localStorage.setItem(graphStateKey(scopeIdentity), JSON.stringify(state));
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
