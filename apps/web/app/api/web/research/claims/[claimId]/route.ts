import { patchClaimRequestSchema, type PatchClaimRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ claimId: string }> };

/** PATCH /api/web/research/claims/:claimId → Knowledge Core PATCH /api/research/claims/:claimId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { claimId } = await ctx.params;
    const id = parseIdParam(claimId, '主张 ID 不合法。');
    const body: PatchClaimRequest = parseWithSchema(
      patchClaimRequestSchema,
      await readJsonBody(request),
      '主张修改内容不合法。',
    );
    return client.patchResearchClaim(id, body);
  });
}
