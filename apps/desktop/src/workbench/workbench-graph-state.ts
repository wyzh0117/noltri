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
