import { nodeChatRequestSchema, type NodeChatRequest } from '@noltri/schema';
import { invalidRequestError, proxyCore, readJsonBody } from '@/lib/core';

/** POST /api/web/chat → Knowledge Core POST /api/chat (single-shot, no streaming in V1). */
export async function POST(request: Request): Promise<Response> {
  return proxyCore(request, async ({ client }) => {
    const parsed = nodeChatRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw invalidRequestError('对话请求不合法。', parsed.error.issues);
    const body: NodeChatRequest = parsed.data;
    return client.chat(body);
  });
}
