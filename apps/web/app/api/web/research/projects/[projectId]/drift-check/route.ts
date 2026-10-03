import { driftCheckRequestSchema, type DriftCheckRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * POST /api/web/research/projects/:projectId/drift-check → Knowledge Core POST …/drift-check.
 * The request body is optional: `{ manuscriptText? }` enables the RQ / contribution scanning rules.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: DriftCheckRequest = parseWithSchema(
      driftCheckRequestSchema,
      await readJsonBody(request),
      'Drift 检查参数不合法。',
    );
    return client.runResearchDriftCheck(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
