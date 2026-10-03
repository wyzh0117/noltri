import { searchRequestSchema, type SearchRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

/** POST /api/web/search → Knowledge Core POST /api/search */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const parsed = searchRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw invalidRequestError('搜索请求不合法。', parsed.error.issues);
    const body: SearchRequest = parsed.data;
    return client.search(body);
  });
}
