import type { WorkbenchApi } from './api';

/** One host-owned aggregate; old API instances remain counted after a prop replacement. */
export function createWorkbenchApiActivity() {
  let pending = 0;
  const proxies = new WeakMap<WorkbenchApi, WorkbenchApi>();
  function wrap(api: WorkbenchApi): WorkbenchApi {
    const cached = proxies.get(api);
    if (cached) return cached;
    const methods = new Map<PropertyKey, { original: Function; wrapped: Function }>();
    const proxy = new Proxy(api, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (typeof method !== 'function') return method;
        const cachedMethod = methods.get(key);
        if (cachedMethod && cachedMethod.original === method) return cachedMethod.wrapped;
        const wrapped = (...args: unknown[]) => {
          pending++;
          let finished = false;
          const finish = (): void => { if (!finished) { finished = true; pending--; } };
          try {
            const result = Reflect.apply(method, target, args);
            if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
              // Observe before the caller awaits it, preserving the original promise/value/error.
              result.then(finish, finish);
            } else finish();
            return result;
          } catch (cause) { finish(); throw cause; }
        };
        methods.set(key, { original: method, wrapped });
        return wrapped;
      },
    });
    proxies.set(api, proxy);
    return proxy;
  }
  return { wrap, isIdle: (): boolean => pending === 0 };
}
