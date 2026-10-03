import { driftFindingListQuerySchema, type DriftFindingListQuery } from '@noltri/schema';
import { proxyCore } from '@/lib/core';
import { parseIdParam, parseWithSchema, queryOf } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * GET /api/web/research/projects/:projectId/drift-findings?status=&driftType=&severity=
 * → Knowledge Core GET …/drift-findings
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const query: DriftFindingListQuery = parseWithSchema(
      driftFindingListQuerySchema,
      queryOf(request, ['status', 'driftType', 'severity']),
      'Drift 筛选参数不合法。',
    );
    return client.researchDriftFindings(id, query);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
