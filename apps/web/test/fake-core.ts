/**
 * Local fake Knowledge Core for the web app integration tests.
 *
 * Deliberately independent from services/knowledge-core: the app is built against the frozen HTTP
 * contract only, so this server re-implements the endpoints the web app calls. Every payload is typed
 * with the shared schema types (compile-time) and re-validated with the shared Zod schemas
 * (runtime) — a fixture that drifts from the contract fails the test run instead of the browser.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  captureRequestSchema,
  captureResultSchema,
  healthResponseSchema,
  moveNodeRequestSchema,
  moveNodeResponseSchema,
  nodeChatRequestSchema,
  nodeChatResponseSchema,
  nodeContextRequestSchema,
  nodeContextSchema,
  nodeDetailSchema,
  patchNodeRequestSchema,
  searchRequestSchema,
  searchResponseSchema,
  treeResponseSchema,
  type CaptureRequest,
  type CaptureResult,
  type ContextScope,
  type EdgeRelation,
  type HealthResponse,
  type KnowledgeItem,
  type KnowledgeNode,
  type MoveNodeRequest,
  type MoveNodeResponse,
  type NodeChatRequest,
  type NodeChatResponse,
  type NodeContext,
  type NodeDetail,
  type NodeSourceSummary,
  type PatchNodeRequest,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
  type TreeNode,
  type TreeResponse,
} from '@noltri/schema';
import { ApiClientError } from '@noltri/api-client';
import { estimateTokens, normalizeKnowledgeText, tokenOverlap, truncate } from '@noltri/shared';

const USER_ID = 'fake-user';
const FIXED_ISO = '2026-10-01T08:00:00.000Z';
const DEFAULT_TOKEN_BUDGET = 900;

export interface FakeCoreHandle {
  baseUrl: string;
  /** Authorization header of the most recent request, for proxy forwarding assertions. */
  lastAuthorization(): string | null;
  close(): Promise<void>;
}

export interface FakeCoreOptions {
  /** When set, requests without this bearer token are rejected with 401 unauthorized. */
  requiredToken?: string;
}

interface FakeEdge {
  fromNodeId: string;
  toNodeId: string;
  relationType: EdgeRelation;
  confidence: number | null;
}

/**
 * The frozen contract keeps item→node membership in a join table, so `KnowledgeItem` carries no
 * `nodeId`. The fake core owns that link itself, and Zod strips the extra key on validation.
 */
type FakeItem = KnowledgeItem & { nodeId: string };

interface FakeState {
  nodes: KnowledgeNode[];
  items: FakeItem[];
  sources: Record<string, NodeSourceSummary>;
  edges: FakeEdge[];
}

/**
 * Fixture shape required by the acceptance brief: two 知识领域, a three-level tree, one node with
 * 4 items across 2 sources, one node with zero items, and one oversized node whose context truncates.
 */
export function createFixtures(): FakeState {
  const node = (
    id: string,
    title: string,
    parentId: string | null,
    nodeType: string,
    summary: string | null,
  ): KnowledgeNode => ({
    id,
    userId: USER_ID,
    title,
    summary,
    nodeType,
    parentId,
    status: 'active',
    confidence: 0.8,
    embeddingModel: 'offline-v1',
    masteryLevel: 'organized',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  });

  const item = (
    id: string,
    nodeId: string,
    rawSourceId: string,
    normalizedText: string,
    confidence = 0.74,
  ): FakeItem => ({
    id,
    userId: USER_ID,
    rawSourceId,
    nodeId,
    normalizedText,
    summary: null,
    confidence,
    status: 'active',
    isAiDerived: true,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  });

  const nodes: KnowledgeNode[] = [
    node('domain-python', 'Python', null, 'domain', '从语法到运行时的个人知识库。'),
    node('topic-structures', '数据结构', 'domain-python', 'section', '列表、字典、元组的取舍。'),
    node('concept-tuple', 'Tuple 元组', 'topic-structures', 'concept', '不可变记录的首选容器。'),
    // Zero-item node: it must still render in the tree and in the detail panel.
    node('concept-dict-comprehension', '字典推导式', 'topic-structures', 'concept', null),
    node('topic-async', '异步编程', 'domain-python', 'section', '事件循环与任务取消。'),
    node('concept-event-loop', 'asyncio 事件循环', 'topic-async', 'concept', '单线程并发的调度核心。'),
    node('concept-task-cancel', '协程取消', 'topic-async', 'concept', 'CancelledError 的传播边界。'),
    node('domain-management', '个人管理', null, 'domain', '阅读、笔记与复盘。'),
    node('section-reading', '阅读方法', 'domain-management', 'section', '输入到输出的路径。'),
    node('concept-zettel', '卡片笔记法', 'section-reading', 'concept', '以链接代替分类的笔记法。'),
  ];

  const sources: Record<string, NodeSourceSummary> = {
    'source-docs': {
      rawSourceId: 'source-docs',
      sourceType: 'web',
      sourcePlatform: 'docs.python.org',
      sourceApp: null,
      sourceTitle: 'tuple — Python 官方文档',
      sourceUrl: 'https://docs.python.org/3/library/stdtypes.html#tuple',
      capturedAt: FIXED_ISO,
    },
    'source-chat': {
      rawSourceId: 'source-chat',
      sourceType: 'agent',
      sourcePlatform: null,
      sourceApp: 'ChatGPT',
      sourceTitle: '与 AI 讨论元组不可变性的会话',
      sourceUrl: null,
      capturedAt: FIXED_ISO,
    },
    'source-book': {
      rawSourceId: 'source-book',
      sourceType: 'manual',
      sourcePlatform: null,
      sourceApp: '桌面 Companion',
      sourceTitle: '《卡片笔记写作法》选段',
      sourceUrl: null,
      capturedAt: FIXED_ISO,
    },
    'source-blog': {
      rawSourceId: 'source-blog',
      sourceType: 'web',
      sourcePlatform: 'journal.dev',
      sourceApp: null,
      sourceTitle: 'Understanding the asyncio event loop',
      sourceUrl: 'https://journal.dev/asyncio-event-loop',
      capturedAt: FIXED_ISO,
    },
  };

  const items: FakeItem[] = [
    // 4 items from 2 distinct sources -> the node's 来源数 must read 2.
    item('item-tuple-1', 'concept-tuple', 'source-docs', 'tuple 是不可变序列，创建后不能增删元素。'),
    item('item-tuple-2', 'concept-tuple', 'source-docs', 'tuple 可哈希，因此能当作 dict 的键。'),
    item('item-tuple-3', 'concept-tuple', 'source-chat', '需要不可变记录时优先用 tuple 或 namedtuple，而不是自定义类。'),
    item('item-tuple-4', 'concept-tuple', 'source-chat', '单元素 tuple 必须写成 (value,)，否则只是括号表达式。'),
    item('item-loop-1', 'concept-event-loop', 'source-blog', '事件循环在同一线程内通过回调调度协程。'),
    item('item-loop-2', 'concept-event-loop', 'source-blog', '阻塞调用会冻结整个事件循环。'),
    item('item-zettel-1', 'concept-zettel', 'source-book', '卡片笔记以链接为主，分类为辅。'),
    item('item-zettel-2', 'concept-zettel', 'source-book', '写卡片时要用自己的话重述原文。'),
    item('item-cancel-1', 'concept-task-cancel', 'source-chat', 'await 处才会真正响应任务取消。'),
  ];

  // Enough content on the event-loop node that a real token budget is exceeded -> truncated: true.
  for (let index = 0; index < 26; index += 1) {
    items.push(
      item(
        `item-loop-extra-${index}`,
        'concept-event-loop',
        index % 2 === 0 ? 'source-blog' : 'source-chat',
        `补充说明 ${index}：事件循环在同一线程内调度协程、回调与传输层，任何长时间阻塞都会推迟其它任务的就绪时间，因此必须把阻塞调用交给 to_thread 或独立进程处理。`,
        0.6,
      ),
    );
  }

  const edges: FakeEdge[] = [
    { fromNodeId: 'concept-tuple', toNodeId: 'concept-dict-comprehension', relationType: 'prerequisite_of', confidence: 0.71 },
    { fromNodeId: 'concept-tuple', toNodeId: 'concept-event-loop', relationType: 'similar_to', confidence: 0.55 },
    { fromNodeId: 'concept-zettel', toNodeId: 'concept-tuple', relationType: 'part_of', confidence: null },
  ];

  return { nodes, items, sources, edges };
}

export async function startFakeCore(options: FakeCoreOptions = {}): Promise<FakeCoreHandle> {
  const state = createFixtures();
  let lastAuthorization: string | null = null;

  const server: Server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      const failure =
        error instanceof ApiClientError
          ? { status: error.status, code: error.code, message: error.message }
          : { status: 500, code: 'internal_error', message: error instanceof Error ? error.message : 'fake core failed' };
      send(response, failure.status >= 400 ? failure.status : 500, {
        error: { code: failure.code, message: failure.message },
      });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake-core.local');
    const method = request.method ?? 'GET';
    lastAuthorization = request.headers.authorization ?? null;

    if (options.requiredToken !== undefined && options.requiredToken.length > 0) {
      if (lastAuthorization !== `Bearer ${options.requiredToken}`) {
        send(response, 401, { error: { code: 'unauthorized', message: 'Missing or wrong bearer token' } });
        return;
      }
    }

    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);

    if (method === 'GET' && url.pathname === '/api/health') {
      const payload: HealthResponse = {
        status: 'ok',
        version: '0.1.0-fake',
        storageDriver: 'memory',
        storage: { driver: 'memory', ok: true, detail: { volatile: true, knowledgeItems: 0 } },
        aiProvider: 'offline',
        embeddingDim: 8,
        requiresAiKey: false,
      };
      sendValid(response, healthResponseSchema, payload);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/tree') {
      const rootId = url.searchParams.get('rootId');
      const depthRaw = url.searchParams.get('depth');
      const depth = depthRaw === null || Number.isNaN(Number.parseInt(depthRaw, 10)) ? undefined : Number.parseInt(depthRaw, 10);
      const roots = rootId === null ? state.nodes.filter((entry) => entry.parentId === null) : [searchNode(rootId)];
      const nodes: TreeNode[] = roots.map((entry) => treeNode(entry, depth));
      const payload: TreeResponse = { rootId, nodes, totalNodes: walkNodes(nodes).length };
      sendValid(response, treeResponseSchema, payload);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'nodes' && segments[2] !== undefined) {
      const id = decodeURIComponent(segments[2]);
      if (method === 'GET' && segments.length === 3) {
        sendValid(response, nodeDetailSchema, nodeDetail(id));
        return;
      }
      if (method === 'PATCH' && segments.length === 3) {
        const body = (await parseBody(request, patchNodeRequestSchema)) as PatchNodeRequest;
        const target = searchNode(id);
        if (body.title !== undefined) target.title = body.title;
        if (body.summary !== undefined) target.summary = body.summary;
        if (body.status !== undefined) target.status = body.status;
        target.updatedAt = new Date().toISOString();
        send(response, 200, target);
        return;
      }
      if (method === 'POST' && segments[3] === 'move') {
        const body = (await parseBody(request, moveNodeRequestSchema)) as MoveNodeRequest;
        const target = searchNode(id);
        const parentId = body.targetParentId;
        if (parentId !== null) {
          const parent = searchNode(parentId);
          // A cycle appears when the new parent is the node itself or one of its own descendants.
          if (target.id === parent.id || subtreeIds(target.id).includes(parent.id)) {
            send(response, 409, { error: { code: 'conflict', message: 'Move would create a cycle' } });
            return;
          }
        }
        target.parentId = parentId;
        target.updatedAt = new Date().toISOString();
        const payload: MoveNodeResponse = {
          node: target,
          versionRecordId: `ver-${target.id}-1`,
          path: pathOf(target.id).map((entry) => ({ id: entry.id, title: entry.title })),
          cycleDetected: false,
        };
        sendValid(response, moveNodeResponseSchema, payload);
        return;
      }
    }

    if (method === 'POST' && url.pathname === '/api/search') {
      const body = (await parseBody(request, searchRequestSchema)) as SearchRequest;
      sendValid(response, searchResponseSchema, search(body.query, body.limit ?? 10));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/node-context') {
      const body = nodeContextRequestSchema.parse(await readJson(request));
      sendValid(response, nodeContextSchema, nodeContext(body.nodeId, body.scope, body.tokenBudget ?? DEFAULT_TOKEN_BUDGET));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/chat') {
      const body = nodeChatRequestSchema.parse(await readJson(request)) as NodeChatRequest;
      sendValid(response, nodeChatResponseSchema, chat(body));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/capture') {
      const body = captureRequestSchema.parse(await readJson(request)) as CaptureRequest;
      sendValid(response, captureResultSchema, capture(body));
      return;
    }

    send(response, 404, { error: { code: 'not_found', message: `No fake route for ${method} ${url.pathname}` } });
  }

  function searchNode(id: string): KnowledgeNode {
    const found = state.nodes.find((entry) => entry.id === id);
    if (!found) throw new ApiClientError(404, 'not_found', `Node ${id} does not exist`);
    return found;
  }

  function childrenOf(id: string): KnowledgeNode[] {
    return state.nodes.filter((entry) => entry.parentId === id);
  }

  function itemsOf(id: string): FakeItem[] {
    return state.items.filter((entry) => entry.nodeId === id);
  }

  function pathOf(id: string): KnowledgeNode[] {
    const chain: KnowledgeNode[] = [];
    const visited = new Set<string>();
    let current: KnowledgeNode | undefined = searchNode(id);
    // Guarded against re-parenting bugs: a parent cycle must fail the run, never hang it.
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      chain.unshift(current);
      const parentId: string | null = current.parentId;
      current = parentId === null ? undefined : state.nodes.find((entry) => entry.id === parentId);
    }
    return chain;
  }

  function subtreeIds(id: string, visited: Set<string> = new Set()): string[] {
    if (visited.has(id)) return [];
    visited.add(id);
    return [id, ...childrenOf(id).flatMap((child) => subtreeIds(child.id, visited))];
  }

  function treeNode(node: KnowledgeNode, depth?: number): TreeNode {
    const children = depth === undefined || depth > 1 ? childrenOf(node.id).map((child) => treeNode(child, decrement(depth))) : [];
    const ownItems = itemsOf(node.id).length;
    return {
      id: node.id,
      title: node.title,
      nodeType: node.nodeType,
      status: node.status,
      confidence: node.confidence,
      summary: node.summary,
      itemCount: ownItems,
      childCount: childrenOf(node.id).length,
      descendantItemCount: ownItems + children.reduce((total, child) => total + child.descendantItemCount, 0),
      ...(children.length > 0 ? { children } : {}),
    };
  }

  function nodeDetail(id: string): NodeDetail {
    const node = searchNode(id);
    const items = itemsOf(node.id);
    const children = childrenOf(node.id);
    return {
      node,
      path: pathOf(id).map((entry) => ({ id: entry.id, title: entry.title })),
      items: items.map((entry) => {
        const source = state.sources[entry.rawSourceId];
        return { item: entry, sources: source === undefined ? [] : [source] };
      }),
      children,
      relatedNodes: state.edges
        .filter((edge) => edge.fromNodeId === id)
        .map((edge) => ({
          node: searchNode(edge.toNodeId),
          relationType: edge.relationType,
          confidence: edge.confidence,
        })),
      stats: {
        itemCount: items.length,
        sourceCount: new Set(items.map((entry) => entry.rawSourceId)).size,
        childCount: children.length,
      },
    };
  }

  function nodeContext(nodeId: string, scope: ContextScope, tokenBudget: number): NodeContext {
    const node = searchNode(nodeId);
    const detail = nodeDetail(nodeId);
    const scopeRoot =
      scope === 'current_node'
        ? node
        : scope === 'section'
          ? node.parentId === null
            ? node
            : searchNode(node.parentId)
          : (pathOf(nodeId)[0] as KnowledgeNode);
    const sections = scope === 'current_node' ? [detail] : [detail, ...subtreeDetails(scopeRoot.id, scope)];

    let markdown = `# ${node.title}\n\n`;
    for (const entry of sections) {
      markdown += `## ${entry.node.title}\n\n`;
      if (entry.node.summary !== null) markdown += `${entry.node.summary}\n\n`;
      for (const item of entry.items) markdown += `- ${item.item.normalizedText}\n`;
      markdown += '\n';
    }

    let estimatedTokens = estimateTokens(markdown);
    const truncated = estimatedTokens > tokenBudget;
    if (truncated) {
      // Cut down until the budget actually fits, so the UI warning is earned rather than hardcoded.
      let candidate = markdown;
      while (estimateTokens(candidate) > tokenBudget && candidate.length > 400) {
        candidate = candidate.slice(0, Math.floor(candidate.length * 0.85));
      }
      markdown = `${candidate}\n\n…（上下文超出预算，已截断）`;
      estimatedTokens = estimateTokens(markdown);
    }

    return {
      scope,
      rootNodeId: scopeRoot.id,
      node,
      ancestors: pathOf(nodeId).slice(0, -1),
      children: childrenOf(nodeId),
      relatedNodes: detail.relatedNodes,
      items: detail.items.map((entry) => entry.item),
      sources: detail.items.flatMap((entry) =>
        entry.sources.map((source) => ({
          rawSourceId: source.rawSourceId,
          label: source.sourceTitle ?? source.sourcePlatform ?? source.sourceApp ?? '未命名来源',
          excerpt: truncate(entry.item.normalizedText, 120),
          url: source.sourceUrl,
          capturedAt: source.capturedAt,
        })),
      ),
      tokenBudget,
      estimatedTokens,
      truncated,
      markdown,
    };
  }

  function subtreeDetails(id: string, scope: ContextScope): NodeDetail[] {
    if (scope === 'current_node') return [];
    return childrenOf(id).flatMap((child) => [nodeDetail(child.id), ...subtreeDetails(child.id, scope)]);
  }

  function chat(body: NodeChatRequest): NodeChatResponse {
    const node = searchNode(body.nodeId);
    const cited = itemsOf(node.id).slice(0, 2).map((entry) => entry.id);
    return {
      conversationId: body.conversationId ?? `conv-${node.id}`,
      reply: `围绕「${node.title}」（范围 ${body.scope}）的回应：该节点已有 ${itemsOf(node.id).length} 条知识点，收到 ${body.messages.length} 条消息。建议补一个真实使用例子，并说明适用边界。`,
      context: { scope: body.scope, usedTokens: 420, citedItemIds: cited },
    };
  }

  function capture(body: CaptureRequest): CaptureResult {
    const target = searchNode('concept-tuple');
    const id = `item-captured-${state.items.length + 1}`;
    const normalized = normalizeKnowledgeText(body.text);
    state.items.push({
      id,
      userId: USER_ID,
      rawSourceId: 'source-book',
      nodeId: target.id,
      normalizedText: normalized,
      summary: null,
      confidence: 0.81,
      status: 'active',
      isAiDerived: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      rawSourceId: 'source-book',
      items: [
        {
          knowledgeItemId: id,
          text: normalized,
          nodeId: target.id,
          nodePath: pathOf(target.id).map((entry) => entry.title),
          action: 'attached',
          confidence: 0.81,
          confidenceTier: 'high',
        },
      ],
      processingStatus: 'done',
    };
  }

  function search(query: string, limit: number): SearchResponse {
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const entry of state.items) {
      const node = state.nodes.find((candidate) => candidate.id === entry.nodeId);
      if (node === undefined) continue;
      const keyword =
        entry.normalizedText.toLowerCase().includes(needle) || node.title.toLowerCase().includes(needle);
      const semantic = tokenOverlap(query, entry.normalizedText) >= 0.2 || tokenOverlap(query, node.title) >= 0.34;
      if (!keyword && !semantic) continue;
      const source = state.sources[entry.rawSourceId] ?? null;
      hits.push({
        itemId: entry.id,
        nodeId: node.id,
        title: node.title,
        text: truncate(entry.normalizedText, 160),
        score: keyword ? 0.9 : 0.65,
        matchedBy: keyword && semantic ? 'both' : keyword ? 'keyword' : 'semantic',
        source,
      });
    }
    hits.sort((first, second) => second.score - first.score);
    return { query, mode: 'hybrid', hits: hits.slice(0, limit) };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lastAuthorization: () => lastAuthorization,
    close: async () => {
      // fetch keeps its sockets alive, so close() alone would wait forever on the idle connections.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function decrement(depth: number | undefined): number | undefined {
  return depth === undefined ? undefined : depth - 1;
}

function walkNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...walkNodes(node.children ?? [])]);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function parseBody(request: IncomingMessage, schema: SchemaLike): Promise<unknown> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw new ApiClientError(400, 'invalid_request', 'Fake core rejected the request payload', parsed.error?.issues);
  }
  return parsed.data;
}

/** Structural stand-in for z.ZodType so this file does not need a direct zod dependency. */
interface SchemaLike {
  safeParse(data: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: readonly { message: string }[] };
  };
}

function sendValid(response: ServerResponse, schema: SchemaLike, payload: unknown): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    send(response, 500, {
      error: {
        code: 'internal_error',
        message: `Fake core broke the shared contract: ${parsed.error?.issues.map((issue) => issue.message).join('; ') ?? 'unknown'}`,
      },
    });
    return;
  }
  send(response, 200, payload);
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
