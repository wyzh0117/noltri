import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkbenchApp from '../src/workbench/WorkbenchApp';
import type { WorkbenchApi } from '../src/workbench/api';

type TraceEntry = { requestId: string; stage: string; elapsedMs: number; errorCode?: string };
type CaptureResult = { status: 'captured'; captureId: string; mimeType: string; byteLength: number; capturedAt: string; clipboardCopied: boolean; source: null };

const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
const traces: TraceEntry[] = [];
const captureRequestIds: string[] = [];
const callbacks = new Map<number, (event: { event: string; id: number; payload: unknown }) => void>();
const listeners = new Map<number, { event: string; callbackId: number }>();
let nextCallbackId = 1;
let nextEventId = 1;
let holdNextCapture = false;
let releaseHeldCapture: (() => void) | null = null;
let throwNextCapture = false;
let denyNextCapture = false;
let failEventListen = false;
let shortcutStatus = { screenshot: 'registered', openIntake: 'registered' };
let listenAttempts = 0;
let unlistenCalls = 0;
let root: Root | null = null;
let noticeLayouts: Record<string, unknown>[] = [];

const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (command === 'plugin:event|listen') {
    listenAttempts += 1;
    if (failEventListen) throw new Error('synthetic listener registration failure');
    const callbackId = Number(args.handler);
    const event = String(args.event);
    const id = nextEventId++;
    listeners.set(id, { event, callbackId });
    return id;
  }
  if (command === 'plugin:event|unlisten') return undefined;
  if (command === 'get_intake_shortcut_status') return shortcutStatus;
  if (command === 'trace_capture_stage') {
    traces.push({
      requestId: String(args.requestId),
      stage: String(args.stage),
      elapsedMs: Number(args.elapsedMs),
      ...(args.errorCode === undefined ? {} : { errorCode: String(args.errorCode) }),
    });
    return undefined;
  }
  if (command === 'snapshot_system_clipboard') return { status: 'empty', reason: 'no supported clipboard content' };
  if (command === 'begin_screen_capture') {
    const requestId = String(args.requestId);
    captureRequestIds.push(requestId);
    if (holdNextCapture) {
      holdNextCapture = false;
      await new Promise<void>((resolve) => { releaseHeldCapture = resolve; });
    }
    if (throwNextCapture) {
      throwNextCapture = false;
      throw new Error('synthetic native capture failure');
    }
    if (denyNextCapture) {
      denyNextCapture = false;
      return { status: 'permission_denied', reason: 'synthetic permission denial' };
    }
    return {
      status: 'captured', captureId: `capture-${requestId}`, mimeType: 'image/png',
      byteLength: pngBytes.byteLength, capturedAt: new Date().toISOString(), clipboardCopied: false, source: null,
    } satisfies CaptureResult;
  }
  if (command === 'take_screen_capture_bytes') return Array.from(pngBytes);
  throw new Error(`unexpected harness command: ${command}`);
};

const callbacksApi = window as typeof window & {
  __TAURI_INTERNALS__?: { invoke: typeof invoke; transformCallback: (callback: (event: { event: string; id: number; payload: unknown }) => void) => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (_event: string, id: number) => void };
  __captureHarness?: {
    emitShortcut: (requestId: string) => void;
    releaseCapture: () => void;
    setFailEventListen: (value: boolean) => void;
    unmount: () => void;
    stats: () => Record<string, unknown>;
  };
};
callbacksApi.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (callback) => {
    const id = nextCallbackId++;
    callbacks.set(id, callback);
    return id;
  },
};
callbacksApi.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (_event, id) => {
    const listener = listeners.get(id);
    if (listener !== undefined) {
      listeners.delete(id);
      callbacks.delete(listener.callbackId);
      unlistenCalls += 1;
    }
  },
};

const api = {
  tree: async () => ({ rootId: null, nodes: [], totalNodes: 0 }),
  health: async () => ({
    status: 'ok', productId: 'capture-harness', instanceId: 'capture-harness', protocolVersion: '1', version: '0',
    storageDriver: 'memory', storage: { driver: 'memory', ok: true, detail: {} }, aiProvider: 'disabled', embeddingDim: 0, requiresAiKey: false,
  }),
  listItems: async () => ({ items: [] }),
  vaultSnapshot: async () => ({ rootPath: '/synthetic-vault', files: [], revision: 0 }),
  vaultDiagnostics: async () => ({ indexing: false, queued: 0, failedFiles: [] }),
  vaultSettings: async () => ({ newLinkFormat: 'shortest', propertyTypes: {} }),
} as unknown as WorkbenchApi;

function renderApp(): void {
  root = createRoot(document.getElementById('root')!);
  root.render(<WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1" mcpEndpoint="http://127.0.0.1/mcp" tokenConfigured={false} outsideTauri={false} />);
}

function waitFor(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (check()) { window.clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeoutMs) { window.clearInterval(timer); reject(new Error(`timeout waiting for ${label}`)); }
    }, 20);
  });
}

const button = (name: string): HTMLButtonElement => {
  const candidate = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim().includes(name));
  if (candidate === undefined) throw new Error(`button not found: ${name}`);
  return candidate;
};

function emitShortcut(requestId: string): void {
  const listener = [...listeners.values()].find((entry) => entry.event === 'noltri-intake-activation');
  if (listener === undefined) throw new Error('global activation listener is not registered');
  callbacks.get(listener.callbackId)?.({ event: listener.event, id: 0, payload: { action: 'capture', requestId } });
}

function stats(): Record<string, unknown> {
  return { traces: [...traces], captureRequestIds: [...captureRequestIds], listenAttempts, listeners: listeners.size, unlistenCalls, noticeLayouts: [...noticeLayouts] };
}

function measureNoticeNear(buttonElement: HTMLElement, label: string): { visible: boolean; adjacent: boolean } {
  const notice = document.querySelector<HTMLElement>('.intake-capture-notice');
  if (notice === null) return { visible: false, adjacent: false };
  const noticeRect = notice.getBoundingClientRect();
  const buttonRect = buttonElement.getBoundingClientRect();
  const dialogRect = document.querySelector('dialog.library-dialog')!.getBoundingClientRect();
  const style = getComputedStyle(notice);
  const x = noticeRect.left + Math.min(noticeRect.width / 2, 60);
  const y = noticeRect.top + Math.min(noticeRect.height / 2, 8);
  const hit = document.elementFromPoint(x, y);
  const visible = style.display !== 'none' && style.visibility !== 'hidden'
    && noticeRect.width > 0 && noticeRect.height > 0
    && noticeRect.top >= 0 && noticeRect.bottom <= window.innerHeight
    && noticeRect.top >= dialogRect.top && noticeRect.bottom <= dialogRect.bottom
    && hit !== null && notice.contains(hit);
  const gap = noticeRect.top - buttonRect.bottom;
  const adjacent = gap >= 0 && gap <= 96 && noticeRect.left < buttonRect.right && noticeRect.right > buttonRect.left;
  noticeLayouts.push({
    label,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    button: { top: buttonRect.top, bottom: buttonRect.bottom, left: buttonRect.left, right: buttonRect.right },
    notice: { top: noticeRect.top, bottom: noticeRect.bottom, left: noticeRect.left, right: noticeRect.right },
    dialog: { top: dialogRect.top, bottom: dialogRect.bottom },
    visible,
    adjacent,
  });
  return { visible, adjacent };
}

callbacksApi.__captureHarness = {
  emitShortcut,
  releaseCapture: () => { releaseHeldCapture?.(); releaseHeldCapture = null; },
  setFailEventListen: (value) => { failEventListen = value; },
  unmount: () => { root?.unmount(); root = null; },
  stats,
};
const captureHarness = callbacksApi.__captureHarness!;

async function runReplay(): Promise<void> {
  let checks = 0;
  const assert = (condition: boolean, label: string): void => {
    if (!condition) throw new Error(label);
    checks += 1;
  };

  try {
    renderApp();
    await waitFor(() => listeners.size === 1, 'one global activation registration');
    assert(listenAttempts === 1 && listeners.size === 1, 'global activation is registered once');

    button('快速收集').click();
    await waitFor(() => document.querySelector('.intake-window') !== null, 'intake window open');
    await waitFor(() => document.querySelector('.intake-capture-screen') !== null, 'screenshot button available');
    const captureButton = document.querySelector<HTMLButtonElement>('.intake-capture-screen')!;
    await waitFor(() => document.querySelector('.intake-capture-notice')?.textContent?.includes('no supported clipboard content') === true, 'clipboard status shown');
    const clipboardNoticeLayout = measureNoticeNear(captureButton, 'clipboard-status');

    captureButton.click();
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 1, 'first screenshot queued');
    await waitFor(() => captureButton.disabled === false, 'screenshot busy state released after first success');
    denyNextCapture = true;
    captureButton.click();
    await waitFor(() => document.querySelector('.intake-capture-notice')?.textContent?.includes('synthetic permission denial') === true, 'permission error shown with one queued image');
    await waitFor(() => captureButton.disabled === false, 'permission error releases screenshot busy state');
    assert(document.querySelectorAll('.intake-image-list .intake-image-row').length === 1, 'permission denial preserves the image already in the queue');
    const permissionNoticeLayout = measureNoticeNear(captureButton, 'permission-error-with-one-queued-image');
    assert(permissionNoticeLayout.visible && permissionNoticeLayout.adjacent, 'permission error is in the viewport next to the screenshot button');
    assert(clipboardNoticeLayout.visible && clipboardNoticeLayout.adjacent, 'clipboard status is in the viewport next to the screenshot button');
    captureButton.click();
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 2, 'second screenshot queued after success');
    await waitFor(() => captureButton.disabled === false, 'second screenshot busy state released');
    assert(captureRequestIds.length === 3, 'repeated screenshot button calls reach native adapter, including a denied request');

    emitShortcut('intake-hotkey-after-success');
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 3, 'hotkey screenshot queued after button success');
    await waitFor(() => captureButton.disabled === false, 'hotkey screenshot busy state released');
    assert(captureRequestIds[3] === 'intake-hotkey-after-success', 'hotkey request ID reaches native adapter unchanged');

    holdNextCapture = true;
    captureButton.click();
    await waitFor(() => releaseHeldCapture !== null, 'held native capture started');
    emitShortcut('intake-hotkey-while-busy');
    await waitFor(() => {
      const notice = document.querySelector('.intake-capture-notice');
      return notice?.textContent?.includes('正在处理上一项操作') === true;
    }, 'busy activation feedback visible in intake window');
    const busyNoticeLayout = measureNoticeNear(captureButton, 'busy-rejection');
    assert(busyNoticeLayout.visible && busyNoticeLayout.adjacent, 'busy rejection is in the viewport next to the screenshot button');
    assert(captureRequestIds.length === 5, 'busy hotkey is stopped before native call');
    captureHarness.releaseCapture();
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 4, 'held screenshot queued');
    await waitFor(() => captureButton.disabled === false, 'held screenshot busy state released');

    throwNextCapture = true;
    captureButton.click();
    await waitFor(() => captureButton.disabled === false, 'capture button recovers after native exception');
    captureButton.click();
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 5, 'capture succeeds after native exception');
    await waitFor(() => captureButton.disabled === false, 'recovered screenshot busy state released');

    document.querySelector<HTMLButtonElement>('.dialog-close[aria-label="关闭收集窗口"]')!.click();
    await waitFor(() => document.querySelector('.intake-window') === null, 'intake closed');
    button('快速收集').click();
    await waitFor(() => document.querySelector('.intake-window') !== null, 'intake reopened');
    emitShortcut('intake-hotkey-after-reopen');
    await waitFor(() => document.querySelectorAll('.intake-image-list .intake-image-row').length === 1, 'hotkey still works after close and reopen');

    const beforeUnmount = stats();
    assert((beforeUnmount.captureRequestIds as string[]).length === 8, 'button and hotkey requests preserve one-to-one adapter calls');
    captureHarness.unmount();
    await waitFor(() => listeners.size === 0 && unlistenCalls === 1, 'global activation listener cleanup');
    assert(listeners.size === 0 && unlistenCalls === 1, 'global activation listener is removed on component unmount');

    failEventListen = true;
    renderApp();
    await waitFor(() => listenAttempts === 2, 'rejected global listener registration');
    button('快速收集').click();
    await waitFor(() => [...document.querySelectorAll('.intake-shortcut-status span')]
      .filter((status) => status.textContent?.includes('不可用，请使用窗口按钮') === true).length === 2,
    'listener registration failure is visible with button fallbacks');
    assert([...document.querySelectorAll('.intake-shortcut-status span')]
      .filter((status) => status.textContent?.includes('不可用，请使用窗口按钮') === true).length === 2,
    'listener registration failure exposes both shortcut fallbacks');
    assert(listeners.size === 0, 'failed listener registration does not leave a stale listener');
    captureHarness.unmount();

    document.documentElement.dataset.replayExit = '0';
    document.getElementById('harness-result')!.textContent = JSON.stringify({ status: 'passed', checks, ...stats() }, null, 2);
  } catch (error) {
    captureHarness.releaseCapture();
    captureHarness.unmount();
    document.documentElement.dataset.replayExit = '1';
    document.getElementById('harness-result')!.textContent = JSON.stringify({ status: 'failed', checks, error: error instanceof Error ? error.message : 'unexpected', ...stats() }, null, 2);
  }
}

void runReplay();
