import { proxyCore } from '@/lib/core';
import { parseIdParam } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/map → Knowledge Core GET …/map (layered research map) */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { projectId } = await ctx.params;
    return client.researchMap(parseIdParam(projectId, '研究项目 ID 不合法。'));
  });
}
