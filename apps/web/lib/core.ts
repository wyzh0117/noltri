/**
 * Server-side proxy plumbing for /api/web/*.
 *
 * The browser only ever calls /api/web/*; this module attaches the session's bearer token and calls
 * Knowledge Core through the shared ApiClient, so response validation and error envelopes stay in one
 * place for web, extension and desktop.
 */

import { ApiClient, ApiClientError } from '@noltri/api-client';
import { apiErrorCodes, type ApiErrorCode } from '@noltri/schema';
import { readSessionFromRequest, type SessionRecord } from './cookie';

export const DEFAULT_CORE_BASE_URL = 'http://localhost:8787';

export function coreBaseUrl(): string {
  return process.env.KNOWLEDGE_API_URL?.trim() || DEFAULT_CORE_BASE_URL;
}

export interface ProxyFailure {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export class ProxyError extends Error {
  readonly failure: ProxyFailure;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ProxyError';
    this.failure = { status, code, message, details };
  }
}

export function unauthorizedError(message = '会话已失效，请重新登录。'): ProxyError {
  return new ProxyError(401, 'unauthorized', message);
}

export function invalidRequestError(message: string, details?: unknown): ProxyError {
  return new ProxyError(400, 'invalid_request', message, details);
}

export function requireSession(request: Request): SessionRecord {
  const session = readSessionFromRequest(request);
  if (!session) throw unauthorizedError();
  return session;
}

export function createCoreClient(session: SessionRecord): ApiClient {
  return new ApiClient({
    baseUrl: coreBaseUrl(),
    token: session.token.length > 0 ? session.token : undefined,
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw invalidRequestError('请求体不是合法 JSON。', error instanceof Error ? error.message : undefined);
  }
}

/** Run a core call with an authenticated session; the core payload is forwarded verbatim. */
export async function proxyCore(
  request: Request,
  handler: (context: { session: SessionRecord; client: ApiClient }) => Promise<unknown>,
): Promise<Response> {
  try {
    const session = requireSession(request);
    const data = await handler({ session, client: createCoreClient(session) });
    return Response.json(data);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Handlers that do not touch the core (auth) still need the frozen error envelope. */
export async function runHandler(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return toErrorResponse(error);
  }
}

function toErrorResponse(error: unknown): Response {  const failure = describeFailure(error);
  return Response.json(
    { error: { code: failure.code, message: failure.message, ...optionalDetails(failure.details) } },
    { status: failure.status },
  );
}

function describeFailure(error: unknown): ProxyFailure {
  if (error instanceof ProxyError) return error.failure;
  if (error instanceof ApiClientError) {
    return {
      status: mapStatus(error.status),
      code: mapCode(error.code),
      message: error.message || '知识服务请求失败。',
      details: error.details,
    };
  }
  return { status: 500, code: 'internal_error', message: '服务内部错误。' };
}

/** A core error without an HTTP status (network failure, timeout) is a bad gateway from the browser's view. */
function mapStatus(status: number): number {
  if (status >= 400 && status <= 599) return status;
  return 502;
}

function mapCode(code: string): ApiErrorCode {
  return (apiErrorCodes as readonly string[]).includes(code) ? (code as ApiErrorCode) : 'internal_error';
}

function optionalDetails(details: unknown): Record<string, unknown> {
  return details === undefined ? {} : { details };
}
