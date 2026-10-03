import { nodeContextRequestSchema, type NodeContextRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

/**
 * POST /api/web/node-context → Knowledge Core POST /api/node-context.
 * Context is built by the server; the browser only ever chooses nodeId and scope.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const parsed = nodeContextRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw invalidRequestError('上下文请求不合法。', parsed.error.issues);
    const body: NodeContextRequest = parsed.data;
    return client.nodeContext(body);
  });
}
