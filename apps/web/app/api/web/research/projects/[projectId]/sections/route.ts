import { createSectionRequestSchema, type CreateSectionRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/sections → Knowledge Core GET …/sections */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchSections(await projectId(ctx)));
}

/** POST /api/web/research/projects/:projectId/sections → Knowledge Core POST …/sections */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateSectionRequest = parseWithSchema(
      createSectionRequestSchema,
      await readJsonBody(request),
      '论文章节内容不合法。',
    );
    return client.createResearchSection(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
