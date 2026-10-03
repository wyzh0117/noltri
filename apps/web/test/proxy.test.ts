/**
 * Proxy integration tests: the real /api/web/* route handlers are imported as plain exported functions
 * and driven against a local fake Knowledge Core on an ephemeral port. No Next.js runtime, no browser.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as captureRoute } from '../app/api/web/capture/route';
import { GET as healthRoute } from '../app/api/web/health/route';
import { POST as chatRoute } from '../app/api/web/chat/route';
import { POST as nodeContextRoute } from '../app/api/web/node-context/route';
import { GET as nodeDetailRoute, PATCH as nodePatchRoute } from '../app/api/web/nodes/[id]/route';
import { POST as nodeMoveRoute } from '../app/api/web/nodes/[id]/move/route';
import { POST as patchRoute } from '../app/api/web/patch/route';
import { POST as searchRoute } from '../app/api/web/search/route';
import { GET as treeRoute } from '../app/api/web/tree/route';
import { startFakeCore, type FakeCoreHandle } from './fake-core';
import type {
  CaptureResult,
  HealthResponse,
  KnowledgeNode,
  MoveNodeResponse,
  NodeChatResponse,
  NodeContext,
  NodeDetail,
  SearchResponse,
  TreeResponse,
} from '@noltri/schema';
import { serializeSessionValue } from '../lib/cookie';

const TOKEN = 'test-token';
const GUARD_TOKEN = 'expected-token';

let core: FakeCoreHandle;

function sessionCookie(token = TOKEN): string {
  return `noltri_session=${encodeURIComponent(serializeSessionValue({ strategy: 'dev-token', token }))}`;
}

function authorized(path: string, init: RequestInit = {}): Request {
  return withSession(TOKEN, path, init);
}

function withSession(token: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set('cookie', sessionCookie(token));
  return new Request(`http://web.local${path}`, { ...init, headers });
}

function unauthenticated(path: string, init: RequestInit = {}): Request {
  return new Request(`http://web.local${path}`, init);
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

async function readEnvelope(response: Response): Promise<{ code?: string; message?: string }> {
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  return payload.error ?? {};
}

const ctx = (id: string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) });

before(async () => {
  core = await startFakeCore();
  process.env.KNOWLEDGE_API_URL = core.baseUrl;
});

after(async () => {
  await core.close();
});

test('tree: 401 envelope without a session cookie', async () => {
  const response = await treeRoute(unauthenticated('/api/web/tree'));
  assert.equal(response.status, 401);
  assert.equal((await readEnvelope(response)).code, 'unauthorized');
});

test('tree: forwards verbatim and attaches the bearer token', async () => {
  const response = await treeRoute(authorized('/api/web/tree'));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as TreeResponse;
  assert.equal(payload.rootId, null);
  assert.deepEqual(
    payload.nodes.map((node) => node.title),
    ['Python', '个人管理'],
  );
  assert.equal(payload.totalNodes, 10);
  assert.equal(core.lastAuthorization(), `Bearer ${TOKEN}`);
});

test('tree: rootId filters to one subtree', async () => {
  const response = await treeRoute(authorized('/api/web/tree?rootId=domain-python'));
  const payload = (await response.json()) as TreeResponse;
  assert.equal(payload.rootId, 'domain-python');
  assert.equal(payload.nodes.length, 1);
  assert.equal(payload.nodes[0]?.title, 'Python');
});

test('tree: depth limits how far the subtree is expanded', async () => {
  const response = await treeRoute(authorized('/api/web/tree?rootId=domain-python&depth=2'));
  const payload = (await response.json()) as TreeResponse;
  const structures = payload.nodes[0]?.children?.find((child) => child.id === 'topic-structures');
  assert.ok(structures, '数据结构 should still be present at depth 2');
  assert.equal(structures.children, undefined);
});

test('tree: invalid depth is rejected before reaching the core', async () => {
  const response = await treeRoute(authorized('/api/web/tree?depth=99'));
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('node detail: 4 items across 2 sources, related nodes, breadcrumb path', async () => {
  const response = await nodeDetailRoute(authorized('/api/web/nodes/concept-tuple'), ctx('concept-tuple'));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as NodeDetail;
  assert.equal(payload.node.title, 'Tuple 元组');
  assert.equal(payload.items.length, 4);
  assert.equal(payload.stats.itemCount, 4);
  assert.equal(payload.stats.sourceCount, 2);
  assert.deepEqual(
    payload.path.map((segment) => segment.title),
    ['Python', '数据结构', 'Tuple 元组'],
  );
  assert.equal(payload.relatedNodes.length, 2);
});

test('node detail: a zero-item node still resolves with empty lists', async () => {
  const response = await nodeDetailRoute(authorized('/api/web/nodes/concept-dict-comprehension'), ctx('concept-dict-comprehension'));
  const payload = (await response.json()) as NodeDetail;
  assert.equal(payload.items.length, 0);
  assert.equal(payload.stats.itemCount, 0);
  assert.equal(payload.stats.sourceCount, 0);
});

test('node detail: a core 404 becomes the not_found envelope', async () => {
  const response = await nodeDetailRoute(authorized('/api/web/nodes/nope'), ctx('nope'));
  assert.equal(response.status, 404);
  assert.equal((await readEnvelope(response)).code, 'not_found');
});

test('node detail: 401 without a session', async () => {
  const response = await nodeDetailRoute(unauthenticated('/api/web/nodes/concept-tuple'), ctx('concept-tuple'));
  assert.equal(response.status, 401);
});

test('node patch: rename returns the updated node', async () => {
  const response = await nodePatchRoute(
    authorized('/api/web/nodes/concept-task-cancel', jsonInit({ title: '任务取消', status: 'needs_review' }, 'PATCH')),
    ctx('concept-task-cancel'),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as KnowledgeNode;
  assert.equal(payload.title, '任务取消');
  assert.equal(payload.status, 'needs_review');
});

test('node patch: an empty patch is invalid', async () => {
  const response = await nodePatchRoute(authorized('/api/web/nodes/concept-task-cancel', jsonInit({}, 'PATCH')), ctx('concept-task-cancel'));
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('patch endpoint: summary edit through /api/web/patch', async () => {
  const response = await patchRoute(authorized('/api/web/patch', jsonInit({ id: 'concept-zettel', summary: '用链接沉淀问题。' })));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as KnowledgeNode;
  assert.equal(payload.summary, '用链接沉淀问题。');
});

test('patch endpoint: missing node id is invalid', async () => {
  const response = await patchRoute(authorized('/api/web/patch', jsonInit({ summary: 'x' })));
  assert.equal(response.status, 400);
});

test('move: returns the version record id and re-parents the node', async () => {
  const response = await nodeMoveRoute(
    authorized('/api/web/nodes/concept-zettel/move', jsonInit({ targetParentId: 'topic-async' })),
    ctx('concept-zettel'),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as MoveNodeResponse;
  assert.ok(payload.versionRecordId.length > 0);
  assert.equal(payload.node.parentId, 'topic-async');
  assert.deepEqual(
    payload.path.map((segment) => segment.title),
    ['Python', '异步编程', '卡片笔记法'],
  );
  assert.equal(payload.cycleDetected, false);
});

test('move: a cycle from the core becomes the conflict envelope', async () => {
  const response = await nodeMoveRoute(
    authorized('/api/web/nodes/domain-python/move', jsonInit({ targetParentId: 'concept-tuple' })),
    ctx('domain-python'),
  );
  assert.equal(response.status, 409);
  assert.equal((await readEnvelope(response)).code, 'conflict');
});

test('search: hits keep the matchedBy signal', async () => {
  const response = await searchRoute(authorized('/api/web/search', jsonInit({ query: 'tuple', limit: 5 })));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as SearchResponse;
  assert.ok(payload.hits.length > 0);
  for (const hit of payload.hits) {
    assert.ok(['semantic', 'keyword', 'both'].includes(hit.matchedBy));
  }
});

test('search: an empty query never reaches the core', async () => {
  const response = await searchRoute(authorized('/api/web/search', jsonInit({ query: '' })));
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('node context: an oversized node truncates and refits the budget', async () => {
  const response = await nodeContextRoute(
    authorized('/api/web/node-context', jsonInit({ nodeId: 'concept-event-loop', scope: 'current_node', tokenBudget: 900 })),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as NodeContext;
  assert.equal(payload.truncated, true);
  assert.ok(payload.estimatedTokens <= payload.tokenBudget, 'estimated tokens must fit the budget after truncation');
  assert.ok(payload.markdown.includes('事件循环'));
});

test('node context: whole-library scope is anchored at the knowledge domain root', async () => {
  const response = await nodeContextRoute(
    authorized('/api/web/node-context', jsonInit({ nodeId: 'concept-tuple', scope: 'whole_library' })),
  );
  const payload = (await response.json()) as NodeContext;
  assert.equal(payload.rootNodeId, 'domain-python');
  assert.equal(payload.scope, 'whole_library');
});

test('node context: a small node fits its budget untouched', async () => {
  const response = await nodeContextRoute(
    authorized('/api/web/node-context', jsonInit({ nodeId: 'concept-task-cancel', scope: 'current_node' })),
  );
  const payload = (await response.json()) as NodeContext;
  assert.equal(payload.truncated, false);
  assert.equal(payload.scope, 'current_node');
  assert.equal(payload.items.length, 1);
});

test('chat: reply carries conversation id and citations', async () => {
  const response = await chatRoute(
    authorized(
      '/api/web/chat',
      jsonInit({
        nodeId: 'concept-tuple',
        scope: 'current_node',
        messages: [{ role: 'user', content: '元组什么时候不该用？' }],
      }),
    ),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as NodeChatResponse;
  assert.equal(payload.conversationId, 'conv-concept-tuple');
  assert.equal(payload.context.citedItemIds.length, 2);
  assert.ok(payload.reply.includes('Tuple 元组'));
});

test('chat: invalid scope is rejected locally', async () => {
  const response = await chatRoute(
    authorized('/api/web/chat', jsonInit({ nodeId: 'concept-tuple', scope: 'everything', messages: [{ role: 'user', content: 'hi' }] })),
  );
  assert.equal(response.status, 400);
});

test('capture: paste fallback returns the classification path', async () => {
  const response = await captureRoute(
    authorized(
      '/api/web/capture',
      jsonInit({ text: 'namedtuple 让位置记录同时拥有字段名，可读性明显好于裸索引。', title: '网页粘贴收录' }),
    ),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as CaptureResult;
  assert.equal(payload.processingStatus, 'done');
  assert.deepEqual(payload.items[0]?.nodePath, ['Python', '数据结构', 'Tuple 元组']);
});

test('capture: text shorter than the contract minimum is rejected', async () => {
  const response = await captureRoute(authorized('/api/web/capture', jsonInit({ text: '短' })));
  assert.equal(response.status, 400);
});

test('health: connection state is forwarded', async () => {
  const response = await healthRoute(authorized('/api/web/health'));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as HealthResponse;
  assert.equal(payload.status, 'ok');
  assert.equal(payload.storageDriver, 'memory');
});

test('health: 401 without a session', async () => {
  const response = await healthRoute(unauthenticated('/api/web/health'));
  assert.equal(response.status, 401);
});

test('dev session with an empty token is accepted and sends no bearer', async () => {
  const response = await treeRoute(withSession('', '/api/web/tree'));
  assert.equal(response.status, 200);
  assert.equal(core.lastAuthorization(), null);
});

test('a core that demands a token turns an empty session into the unauthorized envelope', async () => {
  const guarded = await startFakeCore({ requiredToken: GUARD_TOKEN });
  try {
    process.env.KNOWLEDGE_API_URL = guarded.baseUrl;
    const rejected = await treeRoute(withSession('', '/api/web/tree'));
    assert.equal(rejected.status, 401);
    assert.equal((await readEnvelope(rejected)).code, 'unauthorized');

    const accepted = await treeRoute(withSession(GUARD_TOKEN, '/api/web/tree'));
    assert.equal(accepted.status, 200);
    assert.equal(guarded.lastAuthorization(), `Bearer ${GUARD_TOKEN}`);
  } finally {
    await guarded.close();
    process.env.KNOWLEDGE_API_URL = core.baseUrl;
  }
});
