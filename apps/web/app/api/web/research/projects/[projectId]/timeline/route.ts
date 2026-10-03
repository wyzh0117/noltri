import { createTimelineEventRequestSchema, type CreateTimelineEventRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/timeline → Knowledge Core GET …/timeline */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => client.researchTimeline(await projectId(ctx)));
}

/** POST /api/web/research/projects/:projectId/timeline → Knowledge Core POST …/timeline (milestones only) */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateTimelineEventRequest = parseWithSchema(
      createTimelineEventRequestSchema,
      await readJsonBody(request),
      '时间线事件内容不合法。',
    );
    return client.createResearchTimelineEvent(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
