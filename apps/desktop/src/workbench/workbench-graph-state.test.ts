import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphStateKey, readGraphState, writeGraphState } from './workbench-graph-state';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

describe('graph view state', () => {
  const scope = 'discipline:scope\0mini';
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('invalidates the old placeholder camera while retaining query settings', () => {
    storage.setItem(graphStateKey(scope), JSON.stringify({
      camera: { x: 0, y: 0, scale: 0.5 },
      positions: { a: { x: 10, y: 20 } },
      settings: { filterQuery: 'tag:policy', groups: [{ id: 'g1', query: 'path:notes', color: '#112233' }] },
    }));

    expect(readGraphState(scope)).toMatchObject({
      camera: null,
      cameraReady: false,
      positions: { a: { x: 10, y: 20 } },
      settings: { filterQuery: 'tag:policy', groups: [{ id: 'g1', query: 'path:notes', color: '#112233' }] },
    });
  });

  it('keeps legacy user cameras and explicitly ready default cameras', () => {
    storage.setItem(graphStateKey(scope), JSON.stringify({ camera: { x: 12, y: -8, scale: 1.7 } }));
    expect(readGraphState(scope)).toMatchObject({ camera: { x: 12, y: -8, scale: 1.7 }, cameraReady: true });

    storage.setItem(graphStateKey(scope), JSON.stringify({ camera: { x: 0, y: 0, scale: 0.5 }, cameraReady: true }));
    expect(readGraphState(scope)).toMatchObject({ camera: { x: 0, y: 0, scale: 0.5 }, cameraReady: true });
  });

  it('does not persist a placeholder when layout has not fit yet', () => {
    writeGraphState(scope, { camera: { x: 0, y: 0, scale: 0.5 }, cameraReady: false, positions: {}, settings: readGraphState(scope).settings });
    expect(JSON.parse(storage.getItem(graphStateKey(scope))!)).toMatchObject({ camera: null, cameraReady: false });
  });
});
