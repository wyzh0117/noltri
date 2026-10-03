import { patchEvidenceRequestSchema, type PatchEvidenceRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema } from '@/lib/research-route';

type RouteContext = { params: Promise<{ evidenceId: string }> };

/** PATCH /api/web/research/evidence/:evidenceId → Knowledge Core PATCH /api/research/evidence/:evidenceId */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const { evidenceId } = await ctx.params;
    const id = parseIdParam(evidenceId, '证据 ID 不合法。');
    const body: PatchEvidenceRequest = parseWithSchema(
      patchEvidenceRequestSchema,
      await readJsonBody(request),
      '证据修改内容不合法。',
    );
    return client.patchResearchEvidence(id, body);
  });
}
