/**
 * Wire contract for the calls the desktop workbench makes: 收件箱, capture retry and the stored node
 * transcripts. A stubbed `fetch` is enough here — the point is the URL, the headers and the schema both
 * ways, not a live server.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError, apiRoutes } from '../src/client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(response: { status: number; payload: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(response.payload), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ENTRY = {
  id: 'src-1',
  sourceType: 'manual',
  sourcePlatform: null,
  sourceApp: null,
  sourceTitle: '网页粘贴收录',
  sourceUrl: null,
  capturedAt: '2026-03-01T08:00:00.000Z',
  processingStatus: 'pending',
  errorReason: null,
  textPreview: '元组一旦创建就不能修改。',
  rawTextLength: 12,
} as const;

const RAW_SOURCE = {
  id: 'src-1',
  userId: 'user-1',
  rawText: '元组一旦创建就不能修改。这是一条完整原文。',
  surroundingContext: null,
  sourceType: 'manual',
  sourcePlatform: null,
  sourceApp: null,
  sourceTitle: '网页粘贴收录',
  sourceUrl: null,
  capturedAt: '2026-03-01T08:00:00.000Z',
  metadata: {},
  processingStatus: 'pending',
  errorReason: null,
  createdAt: '2026-03-01T08:00:00.000Z',
} as const;

const ITEM = {
  id: 'item-1',
  userId: 'user-1',
  rawSourceId: 'src-1',
  normalizedText: '元组一旦创建就不能修改。',
  summary: null,
  confidence: 1,
  status: 'active',
  isAiDerived: false,
  createdAt: '2026-03-01T08:05:00.000Z',
  updatedAt: '2026-03-01T08:05:00.000Z',
} as const;

function clientFor(fetchImpl: typeof fetch) {
  return new ApiClient({ baseUrl: 'http://127.0.0.1:8787/', token: 'device-token', clientHint: 'desktop', fetchImpl });
}

describe('ApiClient inbox calls', () => {
  it('sends the feed query with the bearer token and the client hint', async () => {
    const { calls, fetchImpl } = stub({
      status: 200,
      payload: { entries: [ENTRY], counts: { pending: 1, processing: 0, done: 0, failed: 0 }, limit: 5, offset: 10 },
    });

    const result = await clientFor(fetchImpl).inbox({ status: 'pending,failed', limit: 5, offset: 10 });

    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.inbox}?status=pending%2Cfailed&limit=5&offset=10`);
    expect(calls[0]?.headers.authorization).toBe('Bearer device-token');
    expect(calls[0]?.headers['x-noltri-client']).toBe('desktop');
    expect(result.entries[0]?.textPreview).toBe('元组一旦创建就不能修改。');
    expect(result.counts.pending).toBe(1);
  });

  it('omits an empty query string when no filter is asked for', async () => {
    const { calls, fetchImpl } = stub({
      status: 200,
      payload: { entries: [], counts: { pending: 0, processing: 0, done: 0, failed: 0 }, limit: 50, offset: 0 },
    });
    await clientFor(fetchImpl).inbox();
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.inbox}`);
  });

  it('reads one capture back in full', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: RAW_SOURCE });
    const source = await clientFor(fetchImpl).rawSource('src 1');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.inboxSource('src 1')}`);
    expect(source.rawText).toContain('完整原文');
  });

  it('files a capture and returns the created item with its path', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { item: ITEM, path: [{ id: 'n-1', title: '数据结构' }] } });
    const result = await clientFor(fetchImpl).assignSource('src-1', { nodeId: 'n-1', text: '元组一旦创建就不能修改。' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.inboxAssign('src-1')}`);
    expect(calls[0]?.body).toContain('"nodeId":"n-1"');
    expect(result.item.isAiDerived).toBe(false);
    expect(result.path[0]?.title).toBe('数据结构');
  });

  it('refuses an unsendable assign payload before touching the network', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { item: ITEM, path: [] } });
    // Validation happens before the request is built, so this throws synchronously rather than rejecting.
    expect(() => clientFor(fetchImpl).assignSource('src-1', { nodeId: '' } as never)).toThrow(ApiClientError);
    expect(calls).toEqual([]);
  });

  it('re-runs the pipeline for a saved capture with a body-less POST', async () => {
    const { calls, fetchImpl } = stub({
      status: 200,
      payload: {
        rawSourceId: 'src-1',
        processingStatus: 'done',
        items: [
          {
            knowledgeItemId: 'item-1',
            text: '元组一旦创建就不能修改。',
            nodeId: 'n-1',
            nodePath: ['数据结构', '元组'],
            action: 'created',
            confidence: 0.9,
            confidenceTier: 'high',
          },
        ],
      },
    });

    const result = await clientFor(fetchImpl).retryCapture('src/1');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.captureRetry('src/1')}`);
    // No body means no content-type, so the server never has to parse a payload it did not ask for.
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(result.processingStatus).toBe('done');
    expect(result.items[0]?.nodePath).toEqual(['数据结构', '元组']);
  });

  it('maps a server error envelope onto ApiClientError', async () => {
    const { fetchImpl } = stub({ status: 404, payload: { error: { code: 'not_found', message: '原文不存在' } } });
    const error = await clientFor(fetchImpl)
      .rawSource('absent')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('not_found');
    expect((error as ApiClientError).message).toBe('原文不存在');
  });
});

describe('ApiClient stored transcripts', () => {
  it('lists conversations for one node and unwraps the envelope', async () => {
    const { calls, fetchImpl } = stub({
      status: 200,
      payload: {
        conversations: [
          {
            id: 'conv-1',
            userId: 'user-1',
            nodeId: 'n/1',
            scope: 'current_node',
            title: '数据结构',
            createdAt: '2026-03-01T08:00:00.000Z',
            updatedAt: '2026-03-01T08:04:00.000Z',
          },
        ],
      },
    });

    const conversations = await clientFor(fetchImpl).conversations('n/1');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.conversations}?nodeId=n%2F1`);
    expect(conversations[0]?.id).toBe('conv-1');
  });

  it('lists every conversation when no node is given', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { conversations: [] } });
    await clientFor(fetchImpl).conversations();
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.conversations}`);
  });

  it('reads a stored transcript back in order', async () => {
    const { calls, fetchImpl } = stub({
      status: 200,
      payload: {
        messages: [
          {
            id: 'msg-1',
            conversationId: 'conv-1',
            role: 'user',
            content: '这个节点还缺什么？',
            contextNodeId: 'n-1',
            createdAt: '2026-03-01T08:03:00.000Z',
          },
          {
            id: 'msg-2',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '缺少一个反例。',
            contextNodeId: 'n-1',
            createdAt: '2026-03-01T08:03:05.000Z',
          },
        ],
      },
    });

    const messages = await clientFor(fetchImpl).conversationMessages('conv 1');

    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.conversationMessages('conv 1')}`);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
