export interface ShadowHostHandle {
  readonly host: HTMLElement;
  readonly container: HTMLElement;
  readonly root: ShadowRoot;
}

const HOST_STYLE = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:transparent;';

/**
 * Closed mode on purpose: page scripts cannot grab the handle and page CSS cannot restyle the pill.
 * A closed root is invisible from the page, so the handles are cached here instead of re-attached.
 */
const handles = new Map<string, ShadowHostHandle>();

export function ensureShadowHost(id: string, cssText: string): ShadowHostHandle {
  const cached = handles.get(id);
  if (cached && cached.host.isConnected) return cached;

  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = HOST_STYLE;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = cssText;
  const container = document.createElement('div');
  root.append(style, container);
  document.body.appendChild(host);

  const handle: ShadowHostHandle = { host, container, root };
  handles.set(id, handle);
  return handle;
}

export function removeShadowHost(id: string): void {
  const handle = handles.get(id);
  if (handle) {
    handle.host.remove();
    handles.delete(id);
  }
}

export function ownUiHosts(): HTMLElement[] {
  return Array.from(handles.values(), (handle) => handle.host);
}

/** Walks up through shadow boundaries so a target inside our own UI is always recognised. */
export function isInsideOwnUi(target: EventTarget | null, hosts: readonly HTMLElement[]): boolean {
  let node: Node | null = target instanceof Node ? target : null;
  while (node) {
    const current = node;
    if (hosts.some((host) => host === current || host.contains(current))) return true;
    node = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
  }
  return false;
}
