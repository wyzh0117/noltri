import { z } from 'zod';
import { captureRequestSchema, type CaptureResult, type StorageHealthPayload } from '@noltri/schema';

/**
 * The only messages a browser is allowed to ask this host for.
 *
 * §16 is explicit that a connected client's default scope is 采集, and that text arriving from a page,
 * a document or a model is never a tool instruction. So the host has no verb for exporting the library,
 * reading files, running a command or listing nodes: a message that asks for one is refused by the shape
 * of this schema, before any code path that could honour it exists.
 */

export const HOST_NAME = 'com.noltri.knowledge_host';
export const HOST_PROTOCOL_VERSION = '1';

export const MAX_CAPTURES_PER_MESSAGE = 4;

const helloRequest = z.object({ type: z.literal('hello') });
const healthRequest = z.object({ type: z.literal('health') });
const captureRequest = z.object({
  type: z.literal('capture'),
  request: captureRequestSchema,
});
const batchRequest = z.object({
  type: z.literal('capture_batch'),
  requests: z.array(captureRequestSchema).min(1).max(MAX_CAPTURES_PER_MESSAGE),
});

export const hostRequestSchema = z.discriminatedUnion('type', [helloRequest, healthRequest, captureRequest, batchRequest]);
export type HostRequest = z.infer<typeof hostRequestSchema>;

export type HostErrorCode =
  | 'forbidden_scope'
  | 'invalid_request'
  | 'invalid_frame'
  | 'core_unreachable'
  | 'core_identity_mismatch'
  | 'protocol_mismatch'
  | 'capture_failed';

export interface HostCoreIdentity {
  readonly productId: string;
  readonly instanceId: string;
  readonly protocolVersion: string;
  readonly version: string;
}

export type HostFailure = {
  readonly ok: false;
  readonly code: HostErrorCode;
  readonly message: string;
  readonly retryable: boolean;
};

export type CaptureEntryResult = CaptureResult | HostFailure;

export type HostResponse =
  | { readonly ok: true; readonly kind: 'hello'; readonly hostProtocol: string; readonly core: HostCoreIdentity }
  | { readonly ok: true; readonly kind: 'health'; readonly core: HostCoreIdentity; readonly storage: StorageHealthPayload }
  /** A batch can half-fail: entries that reached the Core keep their reply, the one that broke becomes a per-entry failure. */
  | { readonly ok: true; readonly kind: 'capture'; readonly results: readonly CaptureEntryResult[] }
  | HostFailure;

export function failure(code: HostErrorCode, message: string, retryable: boolean): HostFailure {
  return { ok: false, code, message, retryable };
}

/**
 * A message the host will not act on, described without echoing its payload: an extension's arbitrary
 * request body can contain the user's selected text, and a log line is not where that belongs.
 * Even the `type` token is treated as untrusted input — it is capped and shape-checked before it is
 * named back, so a hostile extension cannot use our own error message as a carrier.
 */
const KNOWN_TYPES: readonly string[] = ['hello', 'health', 'capture', 'capture_batch'];

/** §7.5: a refusal has to say what was wrong, or the user cannot tell a rule from a bug. */
export const INVALID_REQUEST_MESSAGE = `这条消息不符合采集要求：正文至少 8 个字，requestId 至少 8 位，一条消息最多 ${String(MAX_CAPTURES_PER_MESSAGE)} 条采集`;

export function parseHostRequest(raw: unknown): { readonly request: HostRequest } | { readonly refusal: HostFailure } {
  const parsed = hostRequestSchema.safeParse(raw);
  if (parsed.success) return { request: parsed.data };
  // A verb the host does have, but a body it cannot use, is a different answer from a verb it will never have.
  if (KNOWN_TYPES.includes(typeOf(raw) ?? '')) return { refusal: failure('invalid_request', INVALID_REQUEST_MESSAGE, false) };
  return { refusal: forbiddenScope(raw) };
}

function typeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

export function forbiddenScope(raw: unknown): HostFailure {
  const type = typeOf(raw);
  const named = type !== undefined && /^[a-z][a-z0-9_]{0,23}$/.test(type) ? ` ${type}` : '';
  return failure('forbidden_scope', `Native Host 只接受采集与健康检查，不执行${named}请求`, false);
}
