import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

interface TickMessage {
  type: 'tick';
  epoch: number;
  coordinates: Float32Array;
  alpha: number;
  tickCount: number;
  engine: 'wasm' | 'js';
  computeMs?: number;
  yieldMs?: number | null;
}

describe('graph simulation worker scheduler', () => {
  it('batches force ticks and applies pin and unpin messages between batches', async () => {
    const messages: TickMessage[] = [];
    const NativeMessageChannel = globalThis.MessageChannel;
    let messageChannelsCreated = 0;
    let resolveNext: ((message: TickMessage) => void) | null = null;
    vi.stubGlobal('MessageChannel', class extends NativeMessageChannel {
      constructor() {
        super();
        messageChannelsCreated += 1;
      }
    });
    vi.stubGlobal('postMessage', (message: TickMessage) => {
      messages.push(message);
      resolveNext?.(message);
      resolveNext = null;
    });
    vi.stubGlobal('__NOLTRI_GRAPH_WASM_BYTES__', new Uint8Array(readFileSync(new URL('./workbench-graph-force.wasm', import.meta.url))));
    vi.stubGlobal('onmessage', null);
    vi.resetModules();

    const waitForNext = (): Promise<TickMessage> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker did not post a tick')), 1500);
      resolveNext = (message) => { clearTimeout(timeout); resolve(message); };
    });

    try {
      await import('./workbench-graph.worker');
      const send = (globalThis as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage;
      const firstTick = waitForNext();
      send({ data: {
        type: 'init', epoch: 1, profile: true,
        nodes: [{ id: 'one' }], links: [],
        forces: { centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 },
      } });
      const first = await firstTick;
      expect(first.alpha).toBeLessThan(0.97);
      expect(first.tickCount).toBeGreaterThan(0);
      expect(first.engine).toBe('wasm');
      expect(first.computeMs).toBeGreaterThan(0);
      expect(first.yieldMs).toBeNull();
      expect(messageChannelsCreated).toBeGreaterThan(0);

      const pinnedTick = waitForNext();
      send({ data: { type: 'pin', epoch: 1, id: 'one', point: { x: 123, y: 456 } } });
      const pinned = await pinnedTick;
      expect(pinned.coordinates[0]).toBe(123);
      expect(pinned.coordinates[1]).toBe(456);

      const unpinnedTick = waitForNext();
      send({ data: { type: 'pin', epoch: 1, id: 'one', point: null } });
      const unpinned = await unpinnedTick;
      expect([unpinned.coordinates[0], unpinned.coordinates[1]]).not.toEqual([123, 456]);
      send({ data: { type: 'stop', epoch: 1 } });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 7_000);

  it('uses the timer fallback without MessageChannel and cancels pending work on stop', async () => {
    const messages: TickMessage[] = [];
    let resolveFirst: ((message: TickMessage) => void) | null = null;
    vi.stubGlobal('MessageChannel', undefined);
    vi.stubGlobal('__NOLTRI_GRAPH_WASM_BYTES__', new Uint8Array([0, 1, 2]));
    vi.stubGlobal('postMessage', (message: TickMessage) => {
      messages.push(message);
      resolveFirst?.(message);
      resolveFirst = null;
    });
    vi.stubGlobal('onmessage', null);
    vi.resetModules();

    try {
      await import('./workbench-graph.worker');
      const send = (globalThis as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage;
      const firstTick = new Promise<TickMessage>((resolve) => { resolveFirst = resolve; });
      send({ data: {
        type: 'init', epoch: 2, profile: true,
        nodes: [{ id: 'fallback' }], links: [],
        forces: { centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 },
      } });
      const first = await firstTick;
      expect(first.engine).toBe('js');
      expect(first.computeMs).toBeGreaterThan(0);
      send({ data: { type: 'stop', epoch: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(messages).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
