import { moveNodeRequestSchema, nodeIdParamsSchema, type MoveNodeRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

type RouteContext = { params: Promise<{ id: string }> };

/** POST /api/web/nodes/:id/move → Knowledge Core, which answers with the VersionRecord id. */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { id } = await ctx.params;
    const parsedId = nodeIdParamsSchema.safeParse({ id });
    if (!parsedId.success) throw invalidRequestError('节点 ID 不合法。', parsedId.error.issues);
    const parsed = moveNodeRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw invalidRequestError('移动参数不合法。', parsed.error.issues);
    const body = parsed.data as MoveNodeRequest;
    return client.moveNode(parsedId.data.id, { ...body, actor: body.actor ?? 'web-app' });
  });
}
