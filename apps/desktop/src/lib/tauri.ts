/**
 * The only place that touches `@tauri-apps/api`. UI components import these helpers so tests and
 * stories can stay DOM-only, and the command names live in exactly one file next to the Rust
 * `#[tauri::command]` definitions they mirror.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return await tauriInvoke<T>(command, args);
}

export const commands = {
  captureState: () => invoke<import('./types').CaptureStateOut>('capture_state'),
  testSelectionCapture: () => invoke<import('./types').SelectionProbeOut>('test_selection_capture'),
  recheckPermission: (prompt: boolean) => invoke<boolean>('recheck_permission', { prompt }),
  openAccessibilitySettings: () => invoke<void>('open_accessibility_settings'),
  openPasteWindow: () => invoke<void>('open_paste_window'),
  pasteSelection: (payload: { text: string; appName?: string; windowTitle?: string }) =>
    invoke<unknown>('paste_selection', { payload }),
  setCaptureEnabled: (enabled: boolean) => invoke<import('./types').CaptureStateOut>('set_capture_enabled', { enabled }),
  getSettings: () => invoke<import('./types').SettingsShape>('get_settings'),
  setSettings: (patch: Record<string, unknown>) => invoke<import('./types').SettingsShape>('set_settings', { patch }),
  setAppOptOut: (app: string, disabled: boolean) => invoke<unknown>('set_app_opt_out', { app, disabled }),
  listIncompatibleApps: () => invoke<unknown[]>('list_incompatible_apps'),
  clearIncompatibleApp: (app: string) => invoke<unknown[]>('clear_incompatible_app', { app }),
  testConnection: (target: string) => invoke<import('./types').ConnectionProbeOut>('test_connection', { target }),
  mcpConfigFor: (target: string) => invoke<import('./types').TargetFacts>('mcp_config_for', { target }),
  readConfigFile: (path: string) => invoke<string | null>('read_config_file', { path }),
  writeMcpConfig: (target: string, path: string, contents: string) =>
    invoke<string>('write_mcp_config', { target, path, contents }),
  openConnectionUrl: (target: string) => invoke<string>('open_connection_url', { target }),
  openDocumentation: (target: string) => invoke<string>('open_documentation', { target }),
  recordCaptureOutcome: (outcome: {
    ok: boolean;
    length: number;
    appName: string;
    path: string[];
    message: string;
    via: string;
  }) => invoke<unknown>('record_capture_outcome', { outcome }),
  dismissOverlay: () => invoke<void>('dismiss_overlay'),
  hideWindow: (label: string) => invoke<void>('hide_window', { label }),
};

/** Event names, mirroring the `pub const *_EVENT` strings in Rust. */
export const events = {
  selectionChanged: 'selection-changed',
  captureResult: 'capture-result',
  pasteRequested: 'paste-requested',
} as const;

export type EventName = (typeof events)[keyof typeof events];
