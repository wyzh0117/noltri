import { createResearchDecisionRequestSchema, type CreateResearchDecisionRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/decisions → Knowledge Core GET …/decisions */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchDecisions(await projectId(ctx)));
}

/** POST /api/web/research/projects/:projectId/decisions → Knowledge Core POST …/decisions (append-only) */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateResearchDecisionRequest = parseWithSchema(
      createResearchDecisionRequestSchema,
      await readJsonBody(request),
      'Decision 内容不合法。',
    );
    return client.createResearchDecision(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
