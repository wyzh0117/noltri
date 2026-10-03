import { buildCaptureRequest } from '@noltri/api-client';
import type { CaptureRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

interface PastePayload {
  text: string;
  surroundingContext?: string;
  title?: string;
  url?: string;
}

/**
 * POST /api/web/capture — paste-to-capture fallback for the first capture, before any client is
 * installed. It goes through the same core pipeline as the extension and desktop entries.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.capture(buildCaptureRequest(toInput(parsePayload(await readJsonBody(request))))));
}

function toInput(payload: PastePayload): Parameters<typeof buildCaptureRequest>[0] {
  return {
    text: payload.text,
    ...(payload.surroundingContext ? { surroundingContext: payload.surroundingContext } : {}),
    source: {
      type: 'manual',
      platform: 'web_app',
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.url ? { url: payload.url } : {}),
    } satisfies CaptureRequest['source'],
    client: 'web_app',
  };
}

function parsePayload(body: unknown): PastePayload {
  if (typeof body !== 'object' || body === null) throw invalidRequestError('缺少要收录的内容。');
  const record = body as Record<string, unknown>;
  if (typeof record.text !== 'string') throw invalidRequestError('收录内容必须是文本。');
  return {
    text: record.text,
    ...(typeof record.surroundingContext === 'string' ? { surroundingContext: record.surroundingContext } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
  };
}
