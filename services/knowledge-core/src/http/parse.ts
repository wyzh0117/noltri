/**
 * The two payload rules every route shares, kept out of the router so a handler in its own module can
 * refuse a body the same way the rest of the API does.
 */
import type { z } from 'zod';
import { knowledgeError } from '@noltri/shared';

export function parseWith<Output>(schema: z.ZodType<Output>, body: unknown, label: string): Output {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw knowledgeError('invalid_request', `${label} 请求体校验失败 / ${label} payload failed validation`, parsed.error.issues);
  }
  return parsed.data;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw knowledgeError('invalid_request', '请求体必须是 JSON 对象 / an empty body is not accepted');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw knowledgeError('invalid_request', '请求体不是合法 JSON / body is not valid JSON');
  }
}
