import { patchResearchQuestionRequestSchema, type PatchResearchQuestionRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ questionId: string }> };

/** PATCH /api/web/research/questions/:questionId → Knowledge Core PATCH /api/research/questions/:questionId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { questionId } = await ctx.params;
    const id = parseIdParam(questionId, '研究问题 ID 不合法。');
    const body: PatchResearchQuestionRequest = parseWithSchema(
      patchResearchQuestionRequestSchema,
      await readJsonBody(request),
      '研究问题修改内容不合法。',
    );
    return client.patchResearchQuestion(id, body);
  });
}
