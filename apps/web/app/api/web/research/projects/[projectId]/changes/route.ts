import {
  changeListQuerySchema,
  createResearchChangeRequestSchema,
  type ChangeListQuery,
  type CreateResearchChangeRequest,
} from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema, queryOf } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/changes?changeType= → Knowledge Core GET …/changes */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const query: ChangeListQuery = parseWithSchema(
      changeListQuerySchema,
      queryOf(request, ['changeType']),
      '变更筛选参数不合法。',
    );
    return client.researchChanges(id, query);
  });
}

/** POST /api/web/research/projects/:projectId/changes → Knowledge Core POST …/changes (append-only) */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateResearchChangeRequest = parseWithSchema(
      createResearchChangeRequestSchema,
      await readJsonBody(request),
      'Change 内容不合法。',
    );
    return client.createResearchChange(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
