import { ApiClient, ApiClientError } from '@noltri/api-client';
import { captureResultSchema, type CaptureRequest, type CaptureResult, type HealthResponse } from '@noltri/schema';
import { truncate } from '@noltri/shared';
import type { ExtensionSettings } from '../settings/storage';

export interface ExtensionApiOptions {
  readonly settings: Pick<ExtensionSettings, 'apiBaseUrl' | 'accessToken'>;
  /** Injected so tests can stub the network without a browser. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export type CaptureOutcome = { readonly ok: true; readonly result: CaptureResult } | { readonly ok: false; readonly message: string };

export type ConnectionState = { readonly connected: true; readonly detail: string } | { readonly connected: false; readonly detail: string };

export const OFFLINE_MESSAGE = '未连接 Knowledge Core，内容未保存';

const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  invalid_request: '这段内容不符合采集要求（至少 8 个字），没有发送',
  unauthorized: 'Knowledge Core 拒绝了访问，请在设置中更新访问令牌',
  not_found: '没有找到 Knowledge Core 的接口，请检查 API 地址',
  conflict: '这条知识与已有知识冲突，原始内容已保存',
  provider_error: 'AI 服务暂时不可用，原始内容已保存',
  storage_error: 'Knowledge Core 存储异常，内容未保存',
  rate_limited: '操作过于频繁，请稍后再试',
};

export function createExtensionApiClient(options: ExtensionApiOptions): ApiClient {
  return new ApiClient({
    baseUrl: options.settings.apiBaseUrl,
    token: options.settings.accessToken.length > 0 ? options.settings.accessToken : undefined,
    timeoutMs: options.timeoutMs ?? 20_000,
    fetchImpl: options.fetchImpl,
  });
}

/** ApiClient throws typed errors; the UI only ever gets a Chinese sentence and never a stack. */
export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'internal_error' && error.status === 0) return OFFLINE_MESSAGE;
    if (error.code === 'internal_error' && error.status >= 500) return `Knowledge Core 暂时不可用（${error.status}），内容未保存`;
    const mapped = MESSAGE_BY_CODE[error.code];
    if (mapped) return mapped;
    return truncate(sanitizeServerMessage(error.message), 120);
  }
  if (error instanceof Error && error.name === 'AbortError') return OFFLINE_MESSAGE;
  return OFFLINE_MESSAGE;
}

function sanitizeServerMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  if (/[A-Za-z0-9_$.<>=-]+\s+\S+\s*\(.*:\d+:\d+\)/.test(firstLine) || /(^|\s|at )Error:/.test(firstLine)) return OFFLINE_MESSAGE;
  return firstLine.trim().length > 0 ? firstLine.trim() : OFFLINE_MESSAGE;
}

export interface CaptureCallOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function captureIntent(
  settings: ExtensionSettings,
  request: CaptureRequest,
  options: CaptureCallOptions = {},
): Promise<CaptureOutcome> {
  try {
    const client = createExtensionApiClient({ settings, ...options });
    const result = await client.capture(request);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function probeConnection(settings: ExtensionSettings, options: CaptureCallOptions = {}): Promise<ConnectionState> {
  try {
    const client = createExtensionApiClient({ settings, timeoutMs: options.timeoutMs ?? 8_000, fetchImpl: options.fetchImpl });
    const health: HealthResponse = await client.health();
    if (health.status === 'degraded') return { connected: true, detail: '已连接，但 Knowledge Core 处于降级状态' };
    return { connected: true, detail: `已连接 ${health.storageDriver} / ${health.aiProvider}` };
  } catch (error) {
    return { connected: false, detail: describeError(error) };
  }
}

/** The service worker broadcasts results; a page must never trust an unparsed object. */
export function parseCaptureResult(payload: unknown): CaptureOutcome | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { ok?: unknown; result?: unknown; message?: unknown };
  if (record.ok === true) {
    const parsed = captureResultSchema.safeParse(record.result);
    if (parsed.success) return { ok: true, result: parsed.data };
    return { ok: false, message: 'Knowledge Core 的返回不符合契约，未能确认收纳结果' };
  }
  if (record.ok === false) {
    return { ok: false, message: typeof record.message === 'string' ? record.message : OFFLINE_MESSAGE };
  }
  return undefined;
}
