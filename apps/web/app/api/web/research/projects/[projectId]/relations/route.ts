import {
  createEntityRelationRequestSchema,
  relationListQuerySchema,
  type CreateEntityRelationRequest,
  type RelationListQuery,
} from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema, queryOf } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * GET /api/web/research/projects/:projectId/relations?sourceType=&sourceId=&targetType=&targetId=&relationType=
 * → Knowledge Core GET …/relations
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const query: RelationListQuery = parseWithSchema(
      relationListQuerySchema,
      queryOf(request, ['sourceType', 'sourceId', 'targetType', 'targetId', 'relationType']),
      '关系筛选参数不合法。',
    );
    return client.researchRelations(id, query);
  });
}

/** POST /api/web/research/projects/:projectId/relations → Knowledge Core POST …/relations */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateEntityRelationRequest = parseWithSchema(
      createEntityRelationRequestSchema,
      await readJsonBody(request),
      '关系内容不合法。',
    );
    return client.createResearchRelation(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
