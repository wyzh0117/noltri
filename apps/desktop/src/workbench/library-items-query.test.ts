import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleLibraryItemsLoad } from './library-items-query';

describe('debounced library item loading', () => {
  afterEach(() => vi.useRealTimers());

  it('does not start the loading transition when its request is canceled before the debounce expires', () => {
    vi.useFakeTimers();
    const startRequest = vi.fn();
    const cancel = scheduleLibraryItemsLoad(startRequest, 200);

    expect(cancel()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(startRequest).not.toHaveBeenCalled();
  });

  it('marks the request started only after the debounced callback runs', () => {
    vi.useFakeTimers();
    const startRequest = vi.fn();
    const cancel = scheduleLibraryItemsLoad(startRequest, 200);

    vi.advanceTimersByTime(200);
    expect(startRequest).toHaveBeenCalledOnce();
    expect(cancel()).toBe(true);
  });
});
