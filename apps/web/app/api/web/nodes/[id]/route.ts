import { nodeIdParamsSchema, patchNodeRequestSchema, type PatchNodeRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/web/nodes/:id → Knowledge Core GET /api/nodes/:id */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.nodeDetail(await nodeId(ctx)));
}

/** PATCH /api/web/nodes/:id → Knowledge Core PATCH /api/nodes/:id */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await nodeId(ctx);
    return client.patchNode(id, parsePatch(await readJsonBody(request)));
  });
}

function parsePatch(body: unknown): PatchNodeRequest {
  const parsed = patchNodeRequestSchema.safeParse(body);
  if (!parsed.success) throw invalidRequestError('节点修改内容不合法。', parsed.error.issues);
  return parsed.data;
}

async function nodeId(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  const parsed = nodeIdParamsSchema.safeParse({ id });
  if (!parsed.success) throw invalidRequestError('节点 ID 不合法。', parsed.error.issues);
  return parsed.data.id;
}
