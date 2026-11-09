import { invoke } from '@tauri-apps/api/core';
import type { CaptureAssetMime } from '@noltri/schema';
import { captureAssetBytesMatchMime, captureAssetMimeSchema, MAX_CAPTURE_ASSET_BYTES, MAX_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import type { ClipboardIntakeAdapter, ScreenshotIntakeAdapter, ScreenshotIntakeResult } from '../workbench/screenshot-entry';

export const INTAKE_ACTIVATION_EVENT = 'noltri-intake-activation';
export const SHORTCUTS_CHANGED_EVENT = 'noltri-shortcuts-changed';
export const AX_SELECTION_ACCEPTED_EVENT = 'noltri-ax-selection-accepted';

export interface AxSelectionOfferStatus {
  enabled: boolean;
  permission: 'not_checked' | 'granted' | 'denied' | 'unsupported' | 'unavailable';
}

export interface AxSelectionAccepted {
  kind: 'accepted';
  requestId: string;
  text: string;
  appName: string;
  bundleId: string;
}

export interface ShortcutBinding {
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}
export interface ShortcutBindings {
  screenshot: ShortcutBinding;
  openIntake: ShortcutBinding;
}
export interface RuntimeDiagnostics {
  appPid: number;
  generation: number;
  mode: 'unresolved' | 'managed' | 'external' | 'devManual';
  status: 'starting' | 'managed' | 'external' | 'devManual' | 'stopping' | 'stopped' | 'failed';
  shutdownConfirmed: boolean;
  children: Array<{
    role: 'core' | 'mcp';
    pid: number;
    generation: number;
    state: 'running' | 'stopRequested' | 'killFailed' | 'observationFailed' | 'terminated';
    exitCode?: number | null;
    exitSignal?: number | null;
    killOutcome?: 'accepted' | 'failed' | null;
  }>;
}

export type IntakeShortcutRegistration = 'registered' | 'conflict' | 'unavailable';

export interface IntakeShortcutStatus {
  screenshot: IntakeShortcutRegistration;
  openIntake: IntakeShortcutRegistration;
  bindings?: ShortcutBindings;
  configurationError?: string | null;
}

export type NativeCaptureResult =
  | { status: 'captured'; captureId: string; mimeType: 'image/png'; byteLength: number; capturedAt: string; clipboardCopied: boolean; source: null }
  | { status: 'cancelled' | 'permission_denied' | 'unsupported' | 'empty' | 'busy' | 'failed'; reason?: string };

export type NativeClipboardSnapshot =
  | { status: 'available'; snapshotId: string; text?: string; imageMimeType?: CaptureAssetMime; capturedAt: string; source: null }
  | { status: 'empty' | 'unsupported' | 'denied' | 'busy' | 'failed'; reason?: string };

export type CaptureTraceStage =
  | 'activation_received'
  | 'state_check'
  | 'native_call'
  | 'native_result'
  | 'queue_enqueue'
  | 'busy_release'
  | 'native_entry'
  | 'permission_preflight'
  | 'permission_request'
  | 'window_hide'
  | 'system_capture_start'
  | 'clipboard_write'
  | 'window_restore'
  | 'shortcut_received'
  | 'activation_emit'
  | 'native_busy_release';

export type CaptureTraceErrorCode =
  | 'busy'
  | 'invalid_request'
  | 'duplicate_request'
  | 'cancelled'
  | 'permission_denied'
  | 'unsupported'
  | 'empty'
  | 'native_failed'
  | 'queue_rejected'
  | 'unexpected';

export interface CaptureTraceEntry {
  requestId: string;
  stage: CaptureTraceStage;
  elapsedMs: number;
  errorCode?: CaptureTraceErrorCode;
}

export interface IntakeNativeCommands {
  beginScreenCapture(requestId: string): Promise<NativeCaptureResult>;
  takeScreenCaptureBytes(captureId: string): Promise<unknown>;
  snapshotSystemClipboard(requestId: string): Promise<NativeClipboardSnapshot>;
  takeClipboardSnapshot(snapshotId: string): Promise<unknown>;
  traceCaptureStage?(entry: CaptureTraceEntry): Promise<void>;
}

export interface IntakeNativeAdapters {
  screenshot: ScreenshotIntakeAdapter;
  clipboard: ClipboardIntakeAdapter;
}

function failureReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

type NativeCaptureFailureStatus = Exclude<NativeCaptureResult['status'], 'captured'>;
type NativeClipboardFailureStatus = Exclude<NativeClipboardSnapshot['status'], 'available'>;

function captureFailureStatus(status: unknown): NativeCaptureFailureStatus | null {
  switch (status) {
    case 'cancelled':
    case 'permission_denied':
    case 'unsupported':
    case 'empty':
    case 'busy':
    case 'failed':
      return status;
    default:
      return null;
  }
}

function clipboardFailureStatus(status: unknown): NativeClipboardFailureStatus | null {
  switch (status) {
    case 'empty':
    case 'unsupported':
    case 'denied':
    case 'busy':
    case 'failed':
      return status;
    default:
      return null;
  }
}

function nativeImageBytes(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_CAPTURE_ASSET_BYTES) return null;
    try {
      return value.slice(0);
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_CAPTURE_ASSET_BYTES) return null;
    try {
      const copy = new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(value);
      return copy;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const length: unknown = value.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 || length > MAX_CAPTURE_ASSET_BYTES) return null;

  try {
    const buffer = new ArrayBuffer(length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      const byte: unknown = value[index];
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 0xff) return null;
      bytes[index] = byte;
    }
    return buffer;
  } catch {
    return null;
  }
}

function imageFile(bytes: ArrayBuffer, name: string, mimeType: CaptureAssetMime): File {
  return new File([bytes], name, { type: mimeType });
}

function validImageBytes(bytes: ArrayBuffer, mimeType: CaptureAssetMime): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_ASSET_BYTES) return false;
  return captureAssetBytesMatchMime(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)), mimeType);
}

export function recordCaptureStage(
  requestId: string,
  stage: CaptureTraceStage,
  elapsedMs: number,
  errorCode?: CaptureTraceErrorCode,
  native: Pick<IntakeNativeCommands, 'traceCaptureStage'> = commands,
): void {
  if (!/^[A-Za-z0-9._~-]{1,200}$/.test(requestId) || native.traceCaptureStage === undefined) return;
  const entry: CaptureTraceEntry = {
    requestId,
    stage,
    elapsedMs: Math.max(0, Math.min(600_000, Math.round(elapsedMs))),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
  try {
    void native.traceCaptureStage(entry).catch(() => undefined);
  } catch {
    // Diagnostics must not affect capture, queueing, or retry behavior.
  }
}

export function createIntakeNativeAdapters(native: IntakeNativeCommands = commands): IntakeNativeAdapters {
  return {
    screenshot: {
      capture: async (requestId) => {
        const nativeStartedAt = performance.now();
        recordCaptureStage(requestId, 'native_call', 0, undefined, native);
        const finish = <T extends ScreenshotIntakeResult>(result: T): T => {
          const errorCode: CaptureTraceErrorCode | undefined = result.status === 'captured'
            ? undefined
            : result.status === 'failed' ? 'native_failed' : result.status;
          recordCaptureStage(requestId, 'native_result', performance.now() - nativeStartedAt, errorCode, native);
          return result;
        };
        try {
          const result: unknown = await native.beginScreenCapture(requestId);
          if (typeof result !== 'object' || result === null || !('status' in result)) {
            return finish({ status: 'failed', reason: '系统截图返回了无效结果。' });
          }
          const status = (result as { status?: unknown }).status;
          if (status !== 'captured') {
            const failure = captureFailureStatus(status);
            const reason = failureReason((result as { reason?: unknown }).reason);
            return finish(failure === null
              ? { status: 'failed', reason: '系统截图返回了无效状态。' }
              : { status: failure, ...(reason === undefined ? {} : { reason }) });
          }
          const capture = result as Extract<NativeCaptureResult, { status: 'captured' }>;
          if (typeof capture.captureId !== 'string' || capture.captureId.trim() === ''
            || capture.mimeType !== 'image/png'
            || !Number.isSafeInteger(capture.byteLength)
            || typeof capture.capturedAt !== 'string' || capture.capturedAt.trim() === ''
            || typeof capture.clipboardCopied !== 'boolean'
            || capture.source !== null) {
            return finish({ status: 'failed', reason: '系统截图返回了无效结果。' });
          }
          if (capture.byteLength === 0) return finish({ status: 'empty' });
          if (capture.byteLength <= 0 || capture.byteLength > MAX_CAPTURE_ASSET_BYTES) {
            return finish({ status: 'unsupported', reason: '截图大小超出单张图片限制；当前收集内容未改变。' });
          }
          const bytes = nativeImageBytes(await native.takeScreenCaptureBytes(capture.captureId));
          if (bytes === null || bytes.byteLength !== capture.byteLength || !validImageBytes(bytes, capture.mimeType)) {
            return finish({ status: 'unsupported', reason: '截图图片数据无效；当前收集内容未改变。' });
          }
          const name = 'screenshot-' + capture.capturedAt.replace(/[:.]/g, '-') + '.png';
          return finish({
            status: 'captured',
            image: imageFile(bytes, name, capture.mimeType),
            clipboardCopied: capture.clipboardCopied,
          });
        } catch (error) {
          recordCaptureStage(requestId, 'native_result', performance.now() - nativeStartedAt, 'native_failed', native);
          throw error;
        }
      },
    },
    clipboard: {
      snapshot: async (requestId) => {
        const result: unknown = await native.snapshotSystemClipboard(requestId);
        if (typeof result !== 'object' || result === null || !('status' in result)) {
          return { status: 'failed', reason: '剪贴板返回了无效结果。' };
        }
        const status = (result as { status?: unknown }).status;
        if (status !== 'available') {
          const failure = clipboardFailureStatus(status);
          const reason = failureReason((result as { reason?: unknown }).reason);
          return failure === null
            ? { status: 'failed', reason: '剪贴板返回了无效状态。' }
            : { status: failure, ...(reason === undefined ? {} : { reason }) };
        }
        const snapshot = result as Extract<NativeClipboardSnapshot, { status: 'available' }>;
        if (typeof snapshot.snapshotId !== 'string' || snapshot.snapshotId.trim() === ''
          || typeof snapshot.capturedAt !== 'string' || snapshot.capturedAt.trim() === ''
          || snapshot.source !== null
          || (snapshot.text !== undefined && typeof snapshot.text !== 'string')) {
          return { status: 'failed', reason: '剪贴板返回了无效结果。' };
        }
        if (snapshot.text !== undefined && snapshot.text.length > MAX_CAPTURE_TEXT_LENGTH) {
          return { status: 'unsupported', reason: '剪贴板文字超过 ' + MAX_CAPTURE_TEXT_LENGTH.toLocaleString() + ' 个字符限制。' };
        }
        const text = snapshot.text === undefined || snapshot.text.length === 0 ? undefined : snapshot.text;
        if (snapshot.imageMimeType === undefined) {
          return text === undefined
            ? { status: 'empty' }
            : { status: 'available', text };
        }
        const parsedMime = captureAssetMimeSchema.safeParse(snapshot.imageMimeType);
        if (!parsedMime.success) {
          return text === undefined
            ? { status: 'unsupported', reason: '剪贴板中的图片格式不受支持。' }
            : { status: 'available', text, reason: '剪贴板中的图片格式不受支持，已保留可读文字。' };
        }
        let bytes: ArrayBuffer | null;
        try {
          bytes = nativeImageBytes(await native.takeClipboardSnapshot(snapshot.snapshotId));
        } catch {
          return text === undefined || text.trim().length === 0
            ? { status: 'failed', reason: '剪贴板图片读取失败。' }
            : { status: 'available', text, reason: '剪贴板图片读取失败，已保留可读文字。' };
        }
        if (bytes === null || !validImageBytes(bytes, parsedMime.data)) {
          return text === undefined
            ? { status: 'unsupported', reason: '剪贴板图片数据无效或超出大小限制。' }
            : { status: 'available', text, reason: '剪贴板图片无效或超出大小限制，已保留可读文字。' };
        }
        const extension: Record<CaptureAssetMime, string> = {
          'image/png': 'png',
          'image/jpeg': 'jpg',
          'image/webp': 'webp',
          'image/gif': 'gif',
        };
        const name = 'clipboard-' + snapshot.capturedAt.replace(/[:.]/g, '-') + '.' + extension[parsedMime.data];
        return {
          status: 'available',
          ...(text === undefined ? {} : { text }),
          image: imageFile(bytes, name, parsedMime.data),
        };
      },
    },
  };
}

export type ProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: { text: boolean; image: boolean };
}

export interface ProviderView {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  models: ProviderModel[];
}

export interface ProviderDraft {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: ProviderModel[];
  /** Blank on edit means retain the saved key. The key is never returned by get_settings. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ModelSettings {
  providers: ProviderDraft[];
  activeProviderId: string | null;
  activeModelId: string | null;
}

export interface DesktopSettings extends Omit<ModelSettings, 'providers'> {
  readonly providers: ProviderView[];
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly mcpEndpoint: string;
  readonly runtimeStatus: 'starting' | 'external' | 'dev' | 'managed' | 'failed';
}

export interface SaveModelsResult {
  readonly applied: boolean;
  readonly runtimeStatus: DesktopSettings['runtimeStatus'];
  readonly message: string;
}

export interface FetchAvailableModelsInput {
  providerId?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
}

export const commands = {
  openProcessingConsole: () => createProcessingConsoleCommands().open(),
  getSettings: () => invoke<DesktopSettings>('get_settings'),
  saveModelSettings: (settings: Pick<ModelSettings, 'providers'> & { clearActive?: boolean }) =>
    invoke<SaveModelsResult>('save_model_settings', { settings }),
  useModel: (settings: Pick<ModelSettings, 'providers'> & { providerId: string; modelId: string }) =>
    invoke<SaveModelsResult>('use_model', { settings }),
  fetchAvailableModels: (input: FetchAvailableModelsInput) =>
    invoke<ProviderModel[]>('fetch_available_models', { input }),
  getIntakeShortcutStatus: () => invoke<IntakeShortcutStatus>('get_intake_shortcut_status'),
  saveIntakeShortcuts: (bindings: ShortcutBindings) => invoke<IntakeShortcutStatus>('save_intake_shortcuts', { bindings }),
  getAxSelectionOfferStatus: () => invoke<AxSelectionOfferStatus>('get_ax_selection_offer_status'),
  setAxSelectionOffersEnabled: (enabled: boolean) => invoke<AxSelectionOfferStatus>('set_ax_selection_offers_enabled', { enabled }),
  getRuntimeDiagnostics: () => invoke<RuntimeDiagnostics>('get_runtime_diagnostics'),
  traceCaptureStage: (entry: CaptureTraceEntry) => invoke<void>('trace_capture_stage', {
    requestId: entry.requestId,
    stage: entry.stage,
    elapsedMs: entry.elapsedMs,
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
  }),
  beginScreenCapture: (requestId: string) => invoke<NativeCaptureResult>('begin_screen_capture', { requestId }),
  takeScreenCaptureBytes: (captureId: string) => invoke<unknown>('take_screen_capture_bytes', { captureId }),
  snapshotSystemClipboard: (requestId: string) => invoke<NativeClipboardSnapshot>('snapshot_system_clipboard', { requestId }),
  takeClipboardSnapshot: (snapshotId: string) => invoke<unknown>('take_clipboard_snapshot', { snapshotId }),
};

export interface NativeUpdateStatus {
  status: 'up_to_date' | 'available' | 'downloaded' | 'installed' | 'uncertain';
  version?: string | null;
  notes?: string | null;
}
export interface NativeUpdateCommands {
  check(): Promise<NativeUpdateStatus>;
  download(): Promise<NativeUpdateStatus>;
  install(): Promise<NativeUpdateStatus>;
  restart(): Promise<void>;
}
export function createNativeUpdateCommands(ipc: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = invoke): NativeUpdateCommands {
  return {
    check: () => ipc<NativeUpdateStatus>('check_native_update'),
    download: () => ipc<NativeUpdateStatus>('download_native_update'),
    install: () => ipc<NativeUpdateStatus>('install_native_update', {confirmed: true}),
    restart: () => ipc<void>('restart_after_native_update', {confirmed: true}),
  };
}

export type NativeWindowRole = 'main' | 'processing-console';
export interface ProcessingConsoleBootstrap { apiBaseUrl: string; apiToken: string }
export function createProcessingConsoleCommands(ipc: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = invoke) {
  return {
    open: () => ipc<void>('open_processing_console'),
    role: () => ipc<NativeWindowRole>('get_native_window_role'),
    bootstrap: () => ipc<ProcessingConsoleBootstrap>('get_processing_console_bootstrap'),
  };
}
