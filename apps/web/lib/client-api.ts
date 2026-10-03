/**
 * Browser-side caller for the /api/web/* proxies only. The Knowledge Core URL and its bearer token are
 * never reachable from the client bundle.
 */

import type { ApiErrorCode } from '@noltri/schema';

export const clientErrorCodes: readonly ApiErrorCode[] = [
  'invalid_request',
  'unauthorized',
  'not_found',
  'conflict',
  'provider_error',
  'storage_error',
  'rate_limited',
  'internal_error',
];

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ClientApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface QueryInput {
  [key: string]: string | number | undefined;
}

export async function apiGet<T>(path: string, query?: QueryInput): Promise<T> {
  return send<T>(path, { method: 'GET' }, query);
}

export async function apiPost<T>(path: string, body: unknown, query?: QueryInput): Promise<T> {
  return send<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, query);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return send<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return send<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return send<T>(path, { method: 'DELETE' });
}

async function send<T>(path: string, init: RequestInit, query?: QueryInput): Promise<T> {
  const url = withQuery(path, query);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) },
      credentials: 'same-origin',
    });
  } catch {
    throw new ClientApiError(0, 'internal_error', '无法连接知序服务，请稍后重试。');
  }

  const payload: unknown = await readPayload(response);

  if (response.status === 204) return undefined as T;

  const failure = asErrorEnvelope(payload);
  if (!response.ok || failure) {
    throw new ClientApiError(
      response.status,
      failure?.code ?? 'internal_error',
      failure?.message ?? `请求失败（${response.status}）。`,
      failure?.details,
    );
  }
  return payload as T;
}

function withQuery(path: string, query?: QueryInput): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix.length > 0 ? `${path}?${suffix}` : path;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

interface ErrorEnvelopeShape {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

function asErrorEnvelope(payload: unknown): ErrorEnvelopeShape | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' && (clientErrorCodes as readonly string[]).includes(record.code)
    ? (record.code as ApiErrorCode)
    : 'internal_error';
  return {
    code,
    message: typeof record.message === 'string' ? record.message : '请求失败。',
    details: record.details,
  };
}

export function describeError(error: unknown): string {
  if (error instanceof ClientApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误。';
}
