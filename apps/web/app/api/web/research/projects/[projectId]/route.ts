import { patchResearchProjectRequestSchema, type PatchResearchProjectRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId → Knowledge Core GET /api/research/projects/:projectId */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchProject(await projectId(ctx)));
}

/** PATCH /api/web/research/projects/:projectId → Knowledge Core PATCH /api/research/projects/:projectId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: PatchResearchProjectRequest = parseWithSchema(
      patchResearchProjectRequestSchema,
      await readJsonBody(request),
      '研究项目修改内容不合法。',
    );
    return client.patchResearchProject(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
