import { expect, it } from 'vitest';
import type { WorkbenchApi } from './api';
import { createWorkbenchApiActivity } from './api-activity';
import { createApplicationUpdateGuard } from './application-update-guard';

it('tracks overlapping promises, binds method receivers and preserves method and promise identity', async () => {
  const activity = createWorkbenchApiActivity();
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const first = new Promise<string>(r => { resolve = r; });
  const second = new Promise<string>((_r, j) => { reject = j; });
  const original = { marker: 'original receiver', tree() { expect(this.marker).toBe('original receiver'); return first; }, health() { return second; } };
  const api = activity.wrap(original as unknown as WorkbenchApi);
  expect(api).toBe(activity.wrap(original as unknown as WorkbenchApi));
  expect(api.tree).toBe(api.tree);
  expect(api.tree()).toBe(first);
  const failure = api.health();
  expect(failure).toBe(second);
  expect(activity.isIdle()).toBe(false);
  resolve('done'); await first;
  expect(activity.isIdle()).toBe(false);
  const error = new Error('synthetic rejection');
  reject(error); await expect(failure).rejects.toBe(error);
  expect(activity.isIdle()).toBe(true);
});

it('keeps the aggregate across API replacement and balances synchronous throws and values', async () => {
  const activity = createWorkbenchApiActivity();
  let release!: () => void;
  const old = activity.wrap({ tree: () => new Promise<void>(r => { release = r; }) } as unknown as WorkbenchApi);
  const pending = old.tree();
  const error = new Error('synthetic sync failure');
  const next = activity.wrap({ health: () => { throw error; }, tree: () => 42 } as unknown as WorkbenchApi);
  expect(() => next.health()).toThrow(error);
  expect(next.tree()).toBe(42);
  expect(activity.isIdle()).toBe(false);
  release(); await pending;
  expect(activity.isIdle()).toBe(true);
});

it('finishes tracking the guard preflight before its final idle recheck', async () => {
  const activity = createWorkbenchApiActivity();
  const api = activity.wrap({ inbox: async () => { expect(activity.isIdle()).toBe(false); return { counts: { processing: 0 } }; } } as unknown as WorkbenchApi);
  const guard = createApplicationUpdateGuard(activity.isIdle, async () => (await api.inbox({ limit: 1 })).counts.processing);
  expect(await guard()).toBe(true);
  expect(activity.isIdle()).toBe(true);
});
