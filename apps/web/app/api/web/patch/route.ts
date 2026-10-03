import { patchNodeRequestSchema, type PatchNodeRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

interface PatchEnvelope {
  id: string;
  patch: PatchNodeRequest;
}

/**
 * POST /api/web/patch — the same core PATCH with the node id in the body, so rename/summary edits
 * have one obvious endpoint from the browser.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { id, patch } = parseEnvelope(await readJsonBody(request));
    return client.patchNode(id, patch);
  });
}

function parseEnvelope(body: unknown): PatchEnvelope {
  if (typeof body !== 'object' || body === null) throw invalidRequestError('缺少要修改的节点。');
  const { id, ...rest } = body as Record<string, unknown>;
  if (typeof id !== 'string' || id.trim().length === 0) throw invalidRequestError('缺少节点 ID。');
  const parsed = patchNodeRequestSchema.safeParse(rest);
  if (!parsed.success) throw invalidRequestError('节点修改内容不合法。', parsed.error.issues);
  return { id, patch: parsed.data };
}
