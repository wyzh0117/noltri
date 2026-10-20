/** Defer loading/clearing the library until its debounced request actually starts. */
export function scheduleLibraryItemsLoad(start: () => void, delay: number): () => boolean {
  let started = false;
  const timer = setTimeout(() => {
    started = true;
    start();
  }, delay);
  return () => {
    clearTimeout(timer);
    return started;
  };
}
