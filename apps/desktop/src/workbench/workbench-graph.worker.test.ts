import { describe, expect, it, vi } from 'vitest';

interface TickMessage {
  type: 'tick';
  epoch: number;
  coordinates: Float32Array;
  alpha: number;
}

describe('graph simulation worker scheduler', () => {
  it('batches force ticks and applies pin and unpin messages between batches', async () => {
    const messages: TickMessage[] = [];
    let resolveNext: ((message: TickMessage) => void) | null = null;
    vi.stubGlobal('postMessage', (message: TickMessage) => {
      messages.push(message);
      resolveNext?.(message);
      resolveNext = null;
    });
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
        type: 'init', epoch: 1,
        nodes: [{ id: 'one' }], links: [],
        forces: { centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 },
      } });
      const first = await firstTick;
      expect(first.alpha).toBeLessThan(0.97);

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
  });
});
