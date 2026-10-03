import {
  claimListQuerySchema,
  createClaimRequestSchema,
  type ClaimListQuery,
  type CreateClaimRequest,
} from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema, queryOf } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/claims?status=&claimType= → Knowledge Core GET …/claims */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const query: ClaimListQuery = parseWithSchema(
      claimListQuerySchema,
      queryOf(request, ['status', 'claimType']),
      '主张筛选参数不合法。',
    );
    return client.researchClaims(id, query);
  });
}

/** POST /api/web/research/projects/:projectId/claims → Knowledge Core POST …/claims */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateClaimRequest = parseWithSchema(
      createClaimRequestSchema,
      await readJsonBody(request),
      '主张内容不合法。',
    );
    return client.createResearchClaim(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
