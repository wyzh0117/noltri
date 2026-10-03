import { charterRequestSchema, type CharterRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/charter → Knowledge Core GET …/charter */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchCharter(await projectId(ctx)));
}

/** PUT /api/web/research/projects/:projectId/charter → Knowledge Core PUT …/charter (full upsert) */
export async function PUT(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CharterRequest = parseWithSchema(
      charterRequestSchema,
      await readJsonBody(request),
      'Research Charter 内容不合法。',
    );
    return client.putResearchCharter(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
