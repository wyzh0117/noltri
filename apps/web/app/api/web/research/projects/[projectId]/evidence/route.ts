import {
  createEvidenceRequestSchema,
  evidenceListQuerySchema,
  type CreateEvidenceRequest,
  type EvidenceListQuery,
} from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseIdParam, parseWithSchema, queryOf } from '@/lib/research-route';

type RouteContext = { params: Promise<{ projectId: string }> };

/** GET /api/web/research/projects/:projectId/evidence?type= → Knowledge Core GET …/evidence */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const query: EvidenceListQuery = parseWithSchema(
      evidenceListQuerySchema,
      queryOf(request, ['type']),
      '证据筛选参数不合法。',
    );
    return client.researchEvidence(id, query);
  });
}

/** POST /api/web/research/projects/:projectId/evidence → Knowledge Core POST …/evidence */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const id = await projectId(ctx);
    const body: CreateEvidenceRequest = parseWithSchema(
      createEvidenceRequestSchema,
      await readJsonBody(request),
      '证据内容不合法。',
    );
    return client.createResearchEvidence(id, body);
  });
}

async function projectId(ctx: RouteContext): Promise<string> {
  const { projectId } = await ctx.params;
  return parseIdParam(projectId, '研究项目 ID 不合法。');
}
