/**
 * HTTP contract tests: the same handler node:http serves in the local build (V1 §8).
 * Responses are parsed with the schema package so the wire contract holds in both directions.
 */
import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  assignSourceResponseSchema,
  captureResultSchema,
  healthResponseSchema,
  inboxResponseSchema,
  knowledgeNodeSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
  rawSourceSchema,
  searchResponseSchema,
  treeResponseSchema,
} from '@noltri/schema';
import { attachItemRecord, captureOf, CHINESE_TEXT, createNodeRecord, makeHarness, testConfig, type Harness } from './fakes';
import { createRequestHandler, type RequestHandler } from '../src/http/router';

function handlerOf(harness: Harness): RequestHandler {
  return createRequestHandler({ core: harness.core, config: harness.config });
}

async function jsonOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function seedWorkspace(): Promise<Harness> {
  const harness = makeHarness();
  const rootId = await createNodeRecord(harness, 'Python');
  const childId = await createNodeRecord(harness, '数据结构', rootId);
  await attachItemRecord(harness, childId, '元组一旦创建就不能修改。');
  return harness;
}

describe('http router', () => {
  it('serves health without any credential', async () => {
    const handle = handlerOf(makeHarness());
    const response = await handle(new Request('http://core.local/api/health'));
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await jsonOf(response)).status).toBe('ok');
  });

  /**
   * A loopback port that answers JSON is not proof of *which* service is listening — entry points must
   * distinguish Noltri's Core from anything else on 127.0.0.1.
   */
  it('identifies the product, the running instance and the protocol in health', async () => {
    const handle = handlerOf(makeHarness());
    const first = healthResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/health'))));
    const second = healthResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/health'))));

    expect(first.productId).toBe('noltri-knowledge-core');
    expect(first.protocolVersion.length).toBeGreaterThan(0);
    expect(first.instanceId.length).toBeGreaterThan(0);
    expect(first.instanceId).toBe(second.instanceId);

    const otherHandle = handlerOf(makeHarness());
    const other = healthResponseSchema.parse(await jsonOf(await otherHandle(new Request('http://core.local/api/health'))));
    expect(other.instanceId).not.toBe(first.instanceId);
    // Health is also the place a caller learns what the storage driver really believes about itself.
    expect(first.storage.driver).toBe('memory');
    expect(first.storage.ok).toBe(true);
  });

  it('answers CORS preflight before identity exists', async () => {
    const handle = handlerOf(makeHarness());
    const response = await handle(new Request('http://core.local/api/capture', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('runs the full capture loop over the wire and the result satisfies CaptureResult', async () => {
    const harness = await seedWorkspace();
    const handle = handlerOf(harness);
    const response = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noltri-client': 'extension' },
        body: JSON.stringify(captureOf(CHINESE_TEXT, 'extension', { title: 'Python 教程', url: 'https://example.com/py' })),
      }),
    );
    expect(response.status).toBe(200);
    const result = captureResultSchema.parse(await jsonOf(response));
    expect(result.processingStatus).toBe('done');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.nodePath.length).toBeGreaterThan(0);

    const tree = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    expect(tree.totalNodes).toBeGreaterThanOrEqual(2);
  });

  it('rejects an invalid payload with the shared error envelope', async () => {
    const handle = handlerOf(makeHarness());
    const response = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '短', source: { type: 'web' }, capture: { capturedAt: '2026-01-01T00:00:00Z', client: 'extension' } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(response)).error.code).toBe('invalid_request');
  });

  /**
   * A client deciding whether to resend needs more than a code: `retryable` says whether retrying can ever
   * help, and `traceId` ties the answer to the line the server logged.
   */
  it('labels retryable failures and carries a trace id, per code', async () => {
    const handle = handlerOf(makeHarness());
    const refused = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: CHINESE_TEXT,
          source: { type: 'web' },
          capture: { capturedAt: '2026-01-01T00:00:00Z', client: 'extension' },
        }),
      }),
    );
    expect(refused.status).toBe(400);
    const refusal = apiErrorSchema.parse(await jsonOf(refused));
    expect(refusal.error.code).toBe('invalid_request');
    // The unified request shape is mandatory: a missing requestId is a client bug, not a transient failure.
    expect(refusal.error.retryable).toBe(false);
    expect(refusal.error.traceId).toBeTruthy();

    const providerDown = handlerOf(makeHarness({ script: { fail: ['embed'] } }));
    const upstream = await providerDown(
      new Request('http://core.local/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '元组', mode: 'semantic', limit: 5 }),
      }),
    );
    expect(upstream.status).toBe(502);
    const failure = apiErrorSchema.parse(await jsonOf(upstream));
    expect(failure.error.code).toBe('provider_error');
    expect(failure.error.retryable).toBe(true);
    expect(failure.error.traceId).toBeTruthy();

    const gated = handlerOf(makeHarness({ config: testConfig({ devTokenRequired: true, devToken: 'secret-dev-token' }) }));
    const anonymous = await gated(new Request('http://core.local/api/tree'));
    expect(anonymous.status).toBe(401);
    expect(apiErrorSchema.parse(await jsonOf(anonymous)).error.retryable).toBe(false);
  });

  it('distinguishes 404 unknown endpoint from 405 wrong method', async () => {
    const handle = handlerOf(makeHarness());
    const missing = await handle(new Request('http://core.local/api/definitely-not-here'));
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await jsonOf(missing)).error.code).toBe('not_found');

    const wrongMethod = await handle(new Request('http://core.local/api/capture'));
    expect(wrongMethod.status).toBe(405);
    expect(apiErrorSchema.parse(await jsonOf(wrongMethod)).error.code).toBe('invalid_request');
  });

  it('serves node detail, patch, search, context and chat over the wire', async () => {
    const harness = await seedWorkspace();
    const handle = handlerOf(harness);
    const tree = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    const child = tree.nodes[0]?.children?.[0];
    expect(child).toBeDefined();
    const nodeId = child?.id ?? '';

    const detail = await handle(new Request(`http://core.local/api/nodes/${nodeId}`));
    expect(detail.status).toBe(200);
    const parsedDetail = nodeDetailSchema.parse(await jsonOf(detail));
    expect(parsedDetail.stats.itemCount).toBe(1);
    expect(parsedDetail.items[0]?.sources.length).toBeGreaterThan(0);

    const patched = await handle(
      new Request(`http://core.local/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '数据结构与元组' }),
      }),
    );
    expect(patched.status).toBe(200);
    expect(knowledgeNodeSchema.parse(await jsonOf(patched)).title).toBe('数据结构与元组');

    const search = await handle(
      new Request('http://core.local/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '元组', mode: 'keyword' }),
      }),
    );
    expect(search.status).toBe(200);
    expect(searchResponseSchema.parse(await jsonOf(search)).hits.length).toBeGreaterThan(0);

    const context = await handle(
      new Request('http://core.local/api/node-context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, scope: 'current_node' }),
      }),
    );
    expect(nodeContextSchema.parse(await jsonOf(context)).node.id).toBe(nodeId);

    const chat = await handle(
      new Request('http://core.local/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, scope: 'current_node', messages: [{ role: 'user', content: '元组能变吗' }] }),
      }),
    );
    expect(nodeChatResponseSchema.parse(await jsonOf(chat)).context.scope).toBe('current_node');
  });

  it('moving a parent under its own child is a 409 and leaves the tree untouched', async () => {
    const harness = await seedWorkspace();
    const handle = handlerOf(harness);
    const tree = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    const rootId = tree.nodes[0]?.id ?? '';
    const childId = tree.nodes[0]?.children?.[0]?.id ?? '';

    const response = await handle(
      new Request(`http://core.local/api/nodes/${rootId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetParentId: childId }),
      }),
    );
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await jsonOf(response)).error.code).toBe('conflict');

    const after = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    expect(after.nodes[0]?.id).toBe(rootId);
  });

  it('a legal move returns the new path and writes a version record attributed to the client', async () => {
    const harness = await seedWorkspace();
    const handle = handlerOf(harness);
    const tree = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    const rootId = tree.nodes[0]?.id ?? '';
    const childId = tree.nodes[0]?.children?.[0]?.id ?? '';

    const response = await handle(
      new Request(`http://core.local/api/nodes/${childId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noltri-client': 'desktop' },
        body: JSON.stringify({ targetParentId: null }),
      }),
    );
    expect(response.status).toBe(200);
    const moved = moveNodeResponseSchema.parse(await jsonOf(response));
    expect(moved.node.parentId).toBeNull();
    expect(moved.path).toHaveLength(1);
    expect(moved.versionRecordId.length).toBeGreaterThan(0);

    const records = await harness.repository.listVersionRecords(harness.actor.userId, childId);
    expect(records[0]?.actor).toBe('desktop');
    expect(records[0]?.before).toMatchObject({ parentId: rootId });
    expect(records[0]?.after).toMatchObject({ parentId: null });
  });

  it('enforces the dev token when NOLTRI_DEV_REQUIRE_TOKEN is on', async () => {
    const harness = makeHarness({ config: testConfig({ devTokenRequired: true, devToken: 'secret-dev-token' }) });
    const handle = handlerOf(harness);

    const without = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(captureOf(CHINESE_TEXT, 'web_app')),
      }),
    );
    expect(without.status).toBe(401);
    expect(apiErrorSchema.parse(await jsonOf(without)).error.code).toBe('unauthorized');

    const wrong = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
        body: JSON.stringify(captureOf(CHINESE_TEXT, 'web_app')),
      }),
    );
    expect(wrong.status).toBe(401);

    const correct = await handle(
      new Request('http://core.local/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-dev-token' },
        body: JSON.stringify(captureOf(CHINESE_TEXT, 'web_app')),
      }),
    );
    expect(correct.status).toBe(200);
  });

  it('serves the inbox feed, one source and a manual filing over the wire', async () => {
    const harness = await seedWorkspace();
    const handle = handlerOf(harness);
    const captured = await harness.repository.createRawSource({
      userId: harness.actor.userId,
      rawText: '列表推导式比 for 循环更紧凑。',
      sourceType: 'manual',
      capturedAt: '2026-02-02T02:00:00.000Z',
      metadata: {},
    });

    const list = inboxResponseSchema.parse(
      await jsonOf(await handle(new Request('http://core.local/api/inbox?status=pending&limit=10'))),
    );
    expect(list.entries.map((entry) => entry.id)).toContain(captured.id);
    expect(list.counts.pending).toBeGreaterThanOrEqual(1);
    expect(list.limit).toBe(10);

    const detail = rawSourceSchema.parse(
      await jsonOf(await handle(new Request(`http://core.local/api/inbox/${captured.id}`))),
    );
    expect(detail.rawText).toBe('列表推导式比 for 循环更紧凑。');

    const tree = treeResponseSchema.parse(await jsonOf(await handle(new Request('http://core.local/api/tree'))));
    const nodeId = String(tree.nodes[0]?.id);
    const assigned = assignSourceResponseSchema.parse(
      await jsonOf(
        await handle(
          new Request(`http://core.local/api/inbox/${captured.id}/assign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-noltri-client': 'desktop' },
            body: JSON.stringify({ nodeId, text: '列表推导式更紧凑。' }),
          }),
        ),
      ),
    );
    expect(assigned.item.isAiDerived).toBe(false);
    expect(assigned.path.length).toBeGreaterThan(0);

    const afterAssign = inboxResponseSchema.parse(
      await jsonOf(await handle(new Request('http://core.local/api/inbox?status=pending'))),
    );
    expect(afterAssign.entries.map((entry) => entry.id)).not.toContain(captured.id);
  });

  it('requires the dev token for inbox reads when it is switched on', async () => {
    const handle = handlerOf(
      makeHarness({ config: testConfig({ devTokenRequired: true, devToken: 'secret-dev-token' }) }),
    );
    const without = await handle(new Request('http://core.local/api/inbox'));
    expect(without.status).toBe(401);
    expect(apiErrorSchema.parse(await jsonOf(without)).error.code).toBe('unauthorized');
    const withToken = await handle(
      new Request('http://core.local/api/inbox', { headers: { authorization: 'Bearer secret-dev-token' } }),
    );
    expect(withToken.status).toBe(200);
  });

  it('keeps the shared envelope for a bad status filter and a wrong method', async () => {
    const handle = handlerOf(makeHarness());
    const badFilter = await handle(new Request('http://core.local/api/inbox?status=unknown-state'));
    expect(badFilter.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(badFilter)).error.code).toBe('invalid_request');

    const wrongMethod = await handle(new Request('http://core.local/api/inbox', { method: 'DELETE' }));
    expect(wrongMethod.status).toBe(405);
  });

  it('never echoes internals on an unexpected failure', async () => {
    const handle = handlerOf(makeHarness());
    const response = await handle(
      new Request('http://core.local/api/nodes/%2e%2e%2fetc', { method: 'GET' }),
    );
    const body = apiErrorSchema.parse(await jsonOf(response));
    expect(JSON.stringify(body).toLowerCase()).not.toContain('stack');
    expect(response.status).toBe(404);
  });
});
