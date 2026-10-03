import { proxyCore } from '@/lib/core';
import { parseIdParam } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/context-pack → Knowledge Core GET …/context-pack */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { projectId } = await ctx.params;
    return client.researchContextPack(parseIdParam(projectId, '研究项目 ID 不合法。'));
  });
}
