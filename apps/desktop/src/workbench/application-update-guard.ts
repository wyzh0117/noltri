/** Refuse unknown activity and recheck drafts after the asynchronous Core preflight. */
export function createApplicationUpdateGuard(localSafe: () => boolean, processingCount: () => Promise<number>): () => Promise<boolean> {
  return async () => {
    if (!localSafe()) return false;
    try {
      const count = await processingCount();
      return Number.isSafeInteger(count) && count === 0 && localSafe();
    } catch { return false; }
  };
}
