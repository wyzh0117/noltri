import { createResearchQuestionRequestSchema, type CreateResearchQuestionRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/questions → Knowledge Core GET …/questions */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchQuestions(await projectId(ctx)));
}

/** POST /api/web/research/projects/:projectId/questions → Knowledge Core POST …/questions */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateResearchQuestionRequest = parseWithSchema(
      createResearchQuestionRequestSchema,
      await readJsonBody(request),
      '研究问题内容不合法。',
    );
    return client.createResearchQuestion(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
