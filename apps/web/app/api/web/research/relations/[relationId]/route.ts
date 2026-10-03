import { proxyCore } from '@/lib/core';
import { parseIdParam } from '@/lib/research-route';

type RouteContext = { params: Promise<{ relationId: string }> };

/** DELETE /api/web/research/relations/:relationId → Knowledge Core DELETE /api/research/relations/:relationId */
export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { relationId } = await ctx.params;
    const id = parseIdParam(relationId, '关系 ID 不合法。');
    return client.deleteResearchRelation(id);
  });
}
