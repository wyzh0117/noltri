import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CaptureResult,
  HealthResponse,
  LibraryItem,
  KnowledgeItem,
  KnowledgeNode,
  MoveNodeResponse,
  NodeContext,
  NodeDetail,
  NodeSourceSummary,
  SearchResponse,
  TreeResponse,
} from '@noltri/schema';

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

export interface FakeCore {
  readonly url: string;
  readonly calls: RecordedCall[];
  close(): Promise<void>;
}

const USER = 'user-fixture-00000000-0000-4000-8000-000000000001';

export const fixtureNode: KnowledgeNode = {
  id: 'node-tuple',
  userId: USER,
  title: 'Tuple',
  summary: 'Tuple 是不可变序列，可作为字典键。',
  nodeType: 'topic',
  parentId: 'node-data-structures',
  status: 'active',
  confidence: 0.82,
  embeddingModel: 'text-embedding-3-small',
  masteryLevel: 'understood',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

const fixtureItem: KnowledgeItem = {
  id: 'item-tuple-hashable',
  userId: USER,
  rawSourceId: 'raw-0001',
  normalizedText: 'Tuple 不可变，因此可哈希，能用作 dict 的键。',
  summary: '不可变 → 可哈希',
  confidence: 0.91,
  status: 'active',
  isAiDerived: true,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

const fixtureSource: NodeSourceSummary = {
  rawSourceId: 'raw-0001',
  sourceType: 'agent',
  sourcePlatform: null,
  sourceApp: 'Qoder',
  sourceTitle: 'Python 数据结构讨论',
  sourceUrl: null,
  capturedAt: '2026-09-20T00:00:00.000Z',
};

export const fixtureCaptureResult: CaptureResult = {
  rawSourceId: 'raw-0001',
  requestId: 'req-mcp-fixture-0001',
  stage: 'completed',
  duplicate: false,
  processingStatus: 'done',
  items: [
    {
      knowledgeItemId: 'item-tuple-hashable',
      text: 'Tuple 不可变，因此可哈希，能用作 dict 的键。',
      nodeId: 'node-tuple',
      nodePath: ['Python', '数据结构', 'Tuple'],
      action: 'attached',
      confidence: 0.91,
      confidenceTier: 'high',
    },
  ],
};

export const fixtureTree: TreeResponse = {
  rootId: null,
  totalNodes: 3,
  nodes: [
    {
      id: 'node-python',
      title: 'Python',
      nodeType: 'domain',
      status: 'active',
      confidence: null,
      summary: 'Python 语言知识',
      itemCount: 1,
      descendantItemCount: 4,
      childCount: 1,
      children: [
        {
          id: 'node-data-structures',
          title: '数据结构',
          nodeType: 'section',
          status: 'active',
          confidence: null,
          summary: null,
          itemCount: 1,
          descendantItemCount: 3,
          childCount: 1,
          children: [
            {
              id: 'node-tuple',
              title: 'Tuple',
              nodeType: 'topic',
              status: 'active',
              confidence: 0.82,
              summary: '不可变序列',
              itemCount: 2,
              descendantItemCount: 2,
              childCount: 0,
            },
          ],
        },
      ],
    },
  ],
};

export const fixtureNodeDetail: NodeDetail = {
  node: fixtureNode,
  path: [
    { id: 'node-python', title: 'Python' },
    { id: 'node-data-structures', title: '数据结构' },
    { id: 'node-tuple', title: 'Tuple' },
  ],
  items: [{ item: fixtureItem, sources: [fixtureSource] }],
  children: [{ ...fixtureNode, id: 'node-tuple-slicing', title: 'Tuple 切片', parentId: 'node-tuple' }],
  relatedNodes: [{ node: fixtureNode, relationType: 'similar_to', confidence: 0.64 }],
  stats: { itemCount: 1, sourceCount: 1, childCount: 1 },
};

const fixtureSearch: SearchResponse = {
  query: 'tuple 可哈希',
  mode: 'hybrid',
  hits: [
    {
      itemId: 'item-tuple-hashable',
      nodeId: 'node-tuple',
      title: 'Tuple',
      text: 'Tuple 不可变，因此可哈希，能用作 dict 的键。',
      score: 0.88,
      matchedBy: 'both',
      source: fixtureSource,
    },
    {
      itemId: null,
      nodeId: 'node-data-structures',
      title: '数据结构',
      text: '序列类型选择指南',
      score: 0.51,
      matchedBy: 'keyword',
      source: null,
    },
  ],
};

export const fixtureMove: MoveNodeResponse = {
  node: fixtureNode,
  versionRecordId: 'version-0001',
  path: [
    { id: 'node-python', title: 'Python' },
    { id: 'node-data-structures', title: '数据结构' },
  ],
  cycleDetected: false,
};

export const fixtureContext: NodeContext = {
  scope: 'current_node',
  rootNodeId: 'node-tuple',
  node: fixtureNode,
  ancestors: [{ ...fixtureNode, id: 'node-data-structures', title: '数据结构', parentId: 'node-python' }],
  children: [],
  relatedNodes: [{ node: fixtureNode, relationType: 'part_of', confidence: 0.7 }],
  items: [fixtureItem],
  sources: [
    {
      rawSourceId: 'raw-0001',
      label: 'Python 数据结构讨论',
      excerpt: 'Tuple 一旦创建就不能修改……',
      url: null,
      capturedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
  tokenBudget: 2000,
  estimatedTokens: 640,
  truncated: false,
  markdown: '## 节点：Tuple\n\n- Tuple 不可变，因此可哈希，能用作 dict 的键。',
};

export const fixtureHealth: HealthResponse = {
  status: 'ok',
  productId: 'noltri-knowledge-core',
  instanceId: 'fake-instance-0001',
  protocolVersion: '1',
  version: '0.1.0-fake',
  storageDriver: 'memory',
  storage: { driver: 'memory', ok: true, detail: { volatile: true, knowledgeItems: 0 } },
  aiProvider: 'offline',
  embeddingDim: 8,
  requiresAiKey: false,
};

export const fixtureLibraryItem: LibraryItem = {
  id: 'raw-library-0001',
  content: '原始论文摘录',
  summary: '论文摘录摘要',
  kind: 'paper_excerpt',
  source: {
    type: 'agent',
    title: '示例论文',
    url: 'https://example.org/paper',
    platform: null,
    appName: 'Codex',
    capturedAt: '2026-09-20T00:00:00.000Z',
    citation: '示例作者（2026）',
    page: '5',
    author: '示例作者',
    doi: null,
  },
  previewImageUrl: null,
  subjectPath: ['经济学', '平台经济'],
  researchPoint: '平台定价与网络效应',
  tags: ['论文'],
  aiStatus: 'ready',
  createdAt: '2026-09-20T00:00:00.000Z',
  archived: false,
};

export interface FakeCoreOptions {
  /** When true, POST /api/nodes/:id/move answers 409 conflict like a real cycle guard. */
  readonly moveConflict?: boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveStream, rejectStream) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveStream());
    req.on('error', rejectStream);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? null : (JSON.parse(raw) as unknown);
}

/** An offline stand-in for Knowledge Core: it only serves the frozen HTTP contract. */
export async function startFakeKnowledgeCore(options: FakeCoreOptions = {}): Promise<FakeCore> {
  const calls: RecordedCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'GET' ? null : await readBody(req);
      calls.push({ method: String(req.method), path: url.pathname + url.search, body, authorization: req.headers.authorization });

      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, fixtureHealth);

      if (req.method === 'GET' && url.pathname === '/api/items') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, {
          items: [{ ...fixtureLibraryItem, content: '平台经济的待整理原文。', subjectPath: [], aiStatus: 'pending' }],
          limit,
          offset,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/items') {
        const input = (body ?? {}) as Partial<LibraryItem>;
        return json(res, 200, {
          item: {
            ...fixtureLibraryItem,
            ...(typeof input.content === 'string' ? { content: input.content } : {}),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.source === undefined ? {} : { source: { ...fixtureLibraryItem.source, ...input.source } }),
            ...(input.subjectPath === undefined ? {} : { subjectPath: input.subjectPath }),
          },
        });
      }

      const relationCreateMatch = /^\/api\/items\/([^/]+)\/relations$/.exec(url.pathname);
      if (relationCreateMatch && req.method === 'POST') {
        const relationInput = (body ?? {}) as { targetId?: string; relation?: string };
        return json(res, 200, { relation: { targetId: relationInput.targetId, relation: relationInput.relation, direction: 'outgoing', createdAt: fixtureLibraryItem.createdAt } });
      }
      const relationMatch = /^\/api\/items\/([^/]+)\/relations\/([^/]+)$/.exec(url.pathname);
      if (relationMatch && req.method === 'DELETE') return json(res, 200, { ok: true });
      const itemMatch = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
      if (itemMatch && req.method === 'GET') return json(res, 200, { ...fixtureLibraryItem, id: decodeURIComponent(itemMatch[1] ?? '') });

      if (req.method === 'GET' && url.pathname === '/api/tree') {
        const rootId = url.searchParams.get('rootId');
        return json(res, 200, rootId === null ? fixtureTree : { ...fixtureTree, rootId, totalNodes: 1 });
      }

      if (req.method === 'POST' && url.pathname === '/api/search') {
        const query = typeof body === 'object' && body !== null && 'query' in body ? String((body as { query: unknown }).query) : '';
        return json(res, 200, { ...fixtureSearch, query });
      }

      if (req.method === 'POST' && url.pathname === '/api/node-context') {
        const scope =
          typeof body === 'object' && body !== null && 'scope' in body
            ? (body as { scope: NodeContext['scope'] }).scope
            : fixtureContext.scope;
        return json(res, 200, { ...fixtureContext, scope });
      }

      const nodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(url.pathname);
      if (nodeMatch && req.method === 'GET') {
        const id = decodeURIComponent(nodeMatch[1] ?? '');
        if (id === 'missing-node') {
          return json(res, 404, { error: { code: 'not_found', message: '节点不存在', retryable: false, traceId: 'fake-trace-404' } });
        }
        return json(res, 200, { ...fixtureNodeDetail, node: { ...fixtureNode, id } });
      }
      if (nodeMatch && req.method === 'PATCH') {
        const id = decodeURIComponent(nodeMatch[1] ?? '');
        const patch = (body ?? {}) as Partial<Pick<KnowledgeNode, 'title' | 'summary' | 'status'>>;
        return json(res, 200, {
          ...fixtureNode,
          id,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.summary === undefined ? {} : { summary: patch.summary }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
        });
      }
      const moveMatch = /^\/api\/nodes\/([^/]+)\/move$/.exec(url.pathname);
      if (moveMatch && req.method === 'POST') {
        const id = decodeURIComponent(moveMatch[1] ?? '');
        if (options.moveConflict === true) {
          return json(res, 409, {
            error: {
              code: 'conflict',
              message: '目标父节点会成为当前节点的子孙，移动会形成循环',
              retryable: false,
              traceId: 'fake-trace-409',
              details: { nodeId: id },
            },
          });
        }
        return json(res, 200, { ...fixtureMove, node: { ...fixtureNode, id } });
      }

      return json(res, 404, {
        error: { code: 'not_found', message: `Unknown route ${String(req.method)} ${url.pathname}`, retryable: false },
      });
    })().catch((error: unknown) => {
      json(res, 500, {
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : 'fake core failed',
          retryable: true,
        },
      });
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
