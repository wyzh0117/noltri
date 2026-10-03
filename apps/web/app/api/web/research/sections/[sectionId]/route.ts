import { patchSectionRequestSchema, type PatchSectionRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ sectionId: string }> };

/** PATCH /api/web/research/sections/:sectionId → Knowledge Core PATCH /api/research/sections/:sectionId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { sectionId } = await ctx.params;
    const id = parseIdParam(sectionId, '论文章节 ID 不合法。');
    const body: PatchSectionRequest = parseWithSchema(
      patchSectionRequestSchema,
      await readJsonBody(request),
      '论文章节修改内容不合法。',
    );
    return client.patchResearchSection(id, body);
  });
}
