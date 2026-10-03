/**
 * Step 1 of the pipeline: validation.
 *
 * The same zod contract the HTTP layer uses is enforced here, so a caller that bypasses HTTP
 * (MCP tool, embedded Desktop Core, test) can never reach the provider with an unchecked payload.
 */
import { captureRequestSchema, type CaptureRequest, type RawSource } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import { ERROR_REASON_MAX_CHARS } from '../types';

export function validateCaptureRequest(input: unknown): CaptureRequest {
  const parsed = captureRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw knowledgeError(
      'invalid_request',
      'Capture 请求校验失败 / capture payload failed validation',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/**
 * Human label handed to the extraction prompt (PROJECT_MASTER §3.2 provenance).
 * Built only from the stored RawSource so a retry labels identically to the first run.
 */
export function sourceLabelFor(source: RawSource): string {
  const byType: Record<string, string> = {
    web: '网页',
    desktop_app: '桌面客户端',
    agent: 'Agent',
    manual: '手动录入',
  };
  const kind = byType[source.sourceType] ?? source.sourceType;
  const origin = source.sourceTitle ?? source.sourceApp ?? source.sourcePlatform;
  const base = origin ? `${kind}：${truncate(origin, 80)}` : kind;
  return source.sourceUrl ? `${base} · ${truncate(source.sourceUrl, 120)}` : base;
}

/** One-line, stack-free reason for raw_sources.error_reason. */
export function errorReasonOf(error: unknown): string {
  if (error instanceof Error) return truncate(error.message.trim() || error.name, 500);
  if (typeof error === 'string') return truncate(error.trim(), 500);
  return truncate(String(error), 500);
}
