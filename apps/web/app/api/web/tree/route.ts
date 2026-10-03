import { treeQuerySchema, type TreeQuery } from '@noltri/schema';
import { invalidRequestError, proxyCore } from '@/lib/core';

/** GET /api/web/tree?rootId=&depth= → Knowledge Core GET /api/tree */
export async function GET(request: Request): Promise<Response> {
  return proxyCore(request, ({ client }) => client.tree(parseTreeQuery(searchOf(request))));
}

function searchOf(request: Request): Record<string, string | undefined> {
  const params = new URL(request.url).searchParams;
  return {
    rootId: params.get('rootId') ?? undefined,
    depth: params.get('depth') ?? undefined,
  };
}

function parseTreeQuery(raw: Record<string, string | undefined>): TreeQuery {
  const parsed = treeQuerySchema.safeParse(raw);
  if (!parsed.success) throw invalidRequestError('树查询参数不合法。', parsed.error.issues);
  return parsed.data;
}
