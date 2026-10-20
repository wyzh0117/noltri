import { describe, expect, it } from 'vitest';
import { scheduleGraphStateWrite } from './workbench-graph-state';

describe('scope graph view persistence', () => {
  it('flushes the captured old scope and snapshot when a scope change cancels the debounce', () => {
    const snapshot = { camera: { x: 71, y: -38, scale: 1.42 }, positions: { topicA: { x: 211, y: 190 } } };
    const writes: Array<[string, typeof snapshot]> = [];
    let currentScope = 'A';
    const scheduled: { callback?: () => void } = {};
    let canceled = false;
    const cleanup = scheduleGraphStateWrite(
      'A', snapshot, () => currentScope,
      (scope, state) => writes.push([scope, state]),
      (callback) => { scheduled.callback = callback; return 1; },
      () => { canceled = true; },
    );

    currentScope = 'B';
    cleanup();

    expect(canceled).toBe(true);
    expect(writes).toEqual([['A', snapshot]]);
    expect(scheduled.callback).toBeDefined();
  });

  it('keeps same-scope debounce asynchronous and writes its captured snapshot once', () => {
    const snapshot = { camera: { x: 8, y: 9, scale: 1.1 }, positions: null };
    const writes: Array<[string, typeof snapshot]> = [];
    const scheduled: { callback?: () => void } = {};
    scheduleGraphStateWrite(
      'A', snapshot, () => 'A',
      (scope, state) => writes.push([scope, state]),
      (callback) => { scheduled.callback = callback; return 1; },
      () => undefined,
    );

    expect(writes).toEqual([]);
    scheduled.callback?.();
    expect(writes).toEqual([['A', snapshot]]);
  });
});
