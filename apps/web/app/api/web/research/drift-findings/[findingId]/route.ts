import { patchDriftFindingRequestSchema, type PatchDriftFindingRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ findingId: string }> };

/** PATCH /api/web/research/drift-findings/:findingId → Knowledge Core PATCH /api/research/drift-findings/:findingId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { findingId } = await ctx.params;
    const id = parseIdParam(findingId, 'Drift Finding ID 不合法。');
    const body: PatchDriftFindingRequest = parseWithSchema(
      patchDriftFindingRequestSchema,
      await readJsonBody(request),
      'Drift Finding 修改内容不合法。',
    );
    return client.patchResearchDriftFinding(id, body);
  });
}
