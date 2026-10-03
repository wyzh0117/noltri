import { createResearchProjectRequestSchema, type CreateResearchProjectRequest } from '@noltri/schema';
import { proxyCore, readJsonBody } from '@/lib/core';
import { parseWithSchema } from '@/lib/research-route';

/** GET /api/web/research/projects → Knowledge Core GET /api/research/projects */
export async function GET(request: Request): Promise<Response> {
  return proxyCore(request, ({ client }) => client.researchProjects());
}

/** POST /api/web/research/projects → Knowledge Core POST /api/research/projects */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const body: CreateResearchProjectRequest = parseWithSchema(
      createResearchProjectRequestSchema,
      await readJsonBody(request),
      '研究项目创建内容不合法。',
    );
    return client.createResearchProject(body);
  });
}
