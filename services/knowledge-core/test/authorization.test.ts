/**
 * 本地客户端授权 (V1 §12, M01/M04).
 *
 * Two halves: the grant model on its own, and the same model seen from the wire, because the acceptance
 * rows are about what a *connection* can do — including after the user presses 撤销 while that connection
 * is still open.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, captureResultSchema, treeResponseSchema } from '@noltri/schema';
import { resolveIdentity } from '../src/auth';
import {
  FileGrantStore,
  InMemoryGrantStore,
  createGrantResolver,
  findGrant,
  hashSecret,
  issueGrant,
  listGrants,
  requireNodeAccess,
  requireScope,
  revokeGrant,
  scopeForAction,
  type ClientGrant,
  type GrantScope,
  type GrantStore,
} from '../src/authorization';
import { createRequestHandler, type RequestHandler } from '../src/http/router';
import type { CoreConfig } from '../src/config';
import { captureOf, CHINESE_TEXT, attachItemRecord, createNodeRecord, makeHarness, testConfig, type Harness } from './fakes';

async function errorOf(response: Response): Promise<{ status: number; code: string; message: string; retryable: boolean; reason: string }> {
  const body = apiErrorSchema.parse(await response.json());
  return {
    status: response.status,
    code: String(body.error.code),
    message: body.error.message,
    retryable: body.error.retryable,
    reason: String((body.error.details as { reason?: unknown } | undefined)?.reason ?? ''),
  };
}

function request(method: string, path: string, secret?: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://core.local${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('grant model', () => {
  it('returns the credential once and keeps only its digest', async () => {
    const store = new InMemoryGrantStore();
    const { grant, secret } = await issueGrant(store, { label: 'Claude Desktop', scopes: ['read'] });

    expect(secret.length).toBeGreaterThan(20);
    expect(grant.secretHash).toBe(hashSecret(secret));
    expect(grant.revokedAt).toBeNull();
    // The store is a file someone could read over your shoulder; the credential must not be in it.
    expect(JSON.stringify(await store.read())).not.toContain(secret);

    const [listed] = await listGrants(store);
    expect(listed?.label).toBe('Claude Desktop');
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain(grant.secretHash);
  });

  it('requires a label, at least one scope and a non-empty project list', async () => {
    const store = new InMemoryGrantStore();
    await expect(issueGrant(store, { label: '  ', scopes: ['read'] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(issueGrant(store, { label: 'x', scopes: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(issueGrant(store, { label: 'x', scopes: ['nope' as GrantScope] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(issueGrant(store, { label: 'x', scopes: ['read'], nodeIds: ['  '] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await store.read()).toHaveLength(0);
  });

  it('defaults a missing client label so version records never say empty', async () => {
    const store = new InMemoryGrantStore();
    const blank = await issueGrant(store, { label: 'a', client: '   ', scopes: ['read'] });
    const none = await issueGrant(store, { label: 'b', scopes: ['read'] });
    expect(blank.grant.client).toBe('mcp');
    expect(none.grant.client).toBe('mcp');
  });

  it('revokes by timestamp instead of deleting, so 连接中心 still sees the connection', async () => {
    const store = new InMemoryGrantStore();
    const { grant } = await issueGrant(store, { label: 'Cursor', scopes: ['read', 'capture'] });

    const revoked = await revokeGrant(store, grant.id, '2026-10-05T09:00:00.000Z');
    expect(revoked?.revokedAt).toBe('2026-10-05T09:00:00.000Z');
    expect((await listGrants(store)).map((item) => item.label)).toEqual(['Cursor']);
    expect(await revokeGrant(store, 'no-such-grant')).toBeNull();
  });

  it('tells a live credential from a revoked one and from nothing at all', async () => {
    const store = new InMemoryGrantStore();
    const live = await issueGrant(store, { label: 'live', scopes: ['read'] });
    const dead = await issueGrant(store, { label: 'dead', scopes: ['read'] });
    await revokeGrant(store, dead.grant.id);

    expect((await findGrant(store, live.secret)).kind).toBe('live');
    expect((await findGrant(store, dead.secret)).kind).toBe('revoked');
    expect((await findGrant(store, 'whatever-else')).kind).toBe('unknown');
    expect((await findGrant(store, '')).kind).toBe('unknown');
  });

  it('resolves a grant to its own client, never to the header hint', async () => {
    const store = new InMemoryGrantStore();
    const { grant, secret } = await issueGrant(store, { label: 'Hermes', client: 'hermes', scopes: ['read'] });
    const config = testConfig({ devTokenRequired: true, devToken: 'device-token' });
    const resolve = createGrantResolver(store, (request, cfg) => resolveIdentity(request, cfg));

    const identity = await resolve(request('GET', '/api/tree', secret, undefined, { 'x-noltri-client': 'desktop' }), config);
    expect(identity).toMatchObject({ userId: config.devUser, actor: 'hermes', via: 'grant' });
    expect(identity.grant?.id).toBe(grant.id);
    // The header could have claimed any of the five known clients; a grant overrules it either way.
    expect(identity.actor).not.toBe('desktop');
  });

  it('falls through to the configured mode for a credential that is not a grant', async () => {
    const store = new InMemoryGrantStore();
    await issueGrant(store, { label: 'a', scopes: ['read'] });
    const config = testConfig({ devTokenRequired: true, devToken: 'device-token' });
    const resolve = createGrantResolver(store, (request, cfg) => resolveIdentity(request, cfg));

    expect((await resolve(request('GET', '/api/tree', 'device-token'), config)).via).toBe('dev-token');
    await expect(resolve(request('GET', '/api/tree', 'not-a-grant'), config)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(resolve(request('GET', '/api/tree'), config)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses a revoked credential where it stands, with a reason the UI can show', async () => {
    const store = new InMemoryGrantStore();
    const { grant, secret } = await issueGrant(store, { label: '试用连接', scopes: ['read'] });
    await revokeGrant(store, grant.id);
    const resolve = createGrantResolver(store, (request, cfg) => resolveIdentity(request, cfg));

    await expect(resolve(request('GET', '/api/tree', secret), testConfig())).rejects.toMatchObject({
      code: 'unauthorized',
      details: { reason: 'grant_revoked' },
    });
  });
});

describe('FileGrantStore', () => {
  const scratch: string[] = [];

  async function freshDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'noltri-grants-test-'));
    scratch.push(dir);
    return dir;
  }

  it('persists owner-only and reads the same grants back', async () => {
    const dir = await freshDir();
    const store = new FileGrantStore(join(dir, 'grants.json'));
    const { grant, secret } = await issueGrant(store, { label: 'NotebookLM', scopes: ['read', 'capture'], nodeIds: ['n1', 'n2'] });

    expect((await store.read()).map((item) => item.id)).toEqual([grant.id]);
    expect((await findGrant(store, secret)).kind).toBe('live');
    expect((await stat(join(dir, 'grants.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'grants.json'), 'utf8')).not.toContain(secret);
  });

  it('treats a missing file as an empty store', async () => {
    const dir = await freshDir();
    expect(await new FileGrantStore(join(dir, 'nothing-here.json')).read()).toEqual([]);
  });

  it('fails closed on a store it cannot make sense of, instead of skipping entries', async () => {
    const dir = await freshDir();
    const path = join(dir, 'grants.json');
    const store = new FileGrantStore(path);

    await writeFile(path, 'not json', { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: 'internal_error' });

    await writeFile(path, JSON.stringify({ grants: [{ id: 'half-a-record' }] }), { mode: 0o600 });
    // An unreadable record could be a revocation, so ignoring it would silently widen access.
    await expect(store.read()).rejects.toMatchObject({ code: 'internal_error' });
    await expect(findGrant(store, 'anything')).rejects.toMatchObject({ code: 'internal_error' });

    await writeFile(path, JSON.stringify({ grants: [] }), { mode: 0o600 });
    await expect(store.read()).resolves.toEqual([]);
  });

  it('leaves no scratch file behind and keeps every grant it was told to write', async () => {
    const dir = await freshDir();
    const store = new FileGrantStore(join(dir, 'grants.json'));
    const issued: string[] = [];
    for (const label of ['a', 'b', 'c']) issued.push((await issueGrant(store, { label, scopes: ['read'] })).grant.id);

    expect(new Set(issued).size).toBe(3);
    expect((await store.read()).map((grant) => grant.id).sort()).toEqual([...issued].sort());
    expect(await readdir(dir)).toEqual(['grants.json']);
    expect((await readFile(join(dir, 'grants.json'), 'utf8')).endsWith('\n')).toBe(true);
  });

  it.skipIf(process.getuid === undefined)('keeps the store readable only by its owner', async () => {
    const dir = await freshDir();
    await new FileGrantStore(join(dir, 'grants.json')).write([]);
    expect((await stat(join(dir, 'grants.json'))).mode & 0o077).toBe(0);
  });

  afterAll(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });
});

function grantOf(scopes: readonly GrantScope[], nodeIds: readonly string[] | null = null): ClientGrant {
  return {
    id: 'grant-1',
    label: '测试连接',
    client: 'mcp',
    scopes,
    secretHash: hashSecret('unused'),
    nodeIds,
    createdAt: '2026-10-05T00:00:00.000Z',
    revokedAt: null,
  };
}

describe('scope and project rules', () => {
  it('maps every routed action to exactly one scope, and leaves health unrouted', () => {
    expect(scopeForAction('POST', 'api/capture')).toBe('capture');
    expect(scopeForAction('GET', 'api/tree')).toBe('read');
    expect(scopeForAction('PATCH', 'api/nodes/:id')).toBe('mutate');
    expect(scopeForAction('POST', 'api/nodes/:id/move')).toBe('mutate');
    expect(scopeForAction('POST', 'api/inbox/:id/assign')).toBe('mutate');
    expect(scopeForAction('POST', 'api/capture/:id/retry')).toBe('mutate');
    expect(scopeForAction('GET', 'api/health')).toBeUndefined();
  });

  it('refuses an endpoint the grant never named, and never restricts the legacy path', () => {
    const readOnly = grantOf(['read']);
    expect(() => requireScope(readOnly, 'GET', 'api/tree')).not.toThrow();
    expect(() => requireScope(readOnly, 'POST', 'api/capture')).toThrowError(/不含/);
    expect(() => requireScope(readOnly, 'GET', 'api/undocumented')).toThrowError(/不在本地授权范围/);
    expect(() => requireScope(undefined, 'GET', 'api/anything')).not.toThrow();
  });

  it('reads a node list as exactly those projects, and a broader request as a refusal', () => {
    const scoped = grantOf(['read', 'mutate'], ['n1']);
    expect(() => requireNodeAccess(scoped, 'n1', '节点')).not.toThrow();
    expect(() => requireNodeAccess(scoped, 'n2', '节点')).toThrowError(/没有被授权访问该项目/);
    expect(() => requireNodeAccess(scoped, null, '整棵知识树')).toThrowError(/只授权了指定项目/);
    expect(() => requireNodeAccess(scoped, '', '整棵知识树')).toThrowError(/只授权了指定项目/);
    expect(() => requireNodeAccess(grantOf(['read']), null, '整棵知识树')).not.toThrow();
    expect(() => requireNodeAccess(undefined, null, '整棵知识树')).not.toThrow();
  });
});

function handlerOf(harness: Harness, store: GrantStore, config: CoreConfig = harness.config): RequestHandler {
  return createRequestHandler({
    core: harness.core,
    config,
    identityResolver: createGrantResolver(store, (request, cfg) => resolveIdentity(request, cfg)),
  });
}

describe('authorization over the wire', () => {
  it('lets a read-only connection read, and refuses its write before the body is read', async () => {
    const harness = makeHarness();
    const store = new InMemoryGrantStore();
    const { secret } = await issueGrant(store, { label: '只读 Agent', scopes: ['read'] });
    const handle = handlerOf(harness, store);

    const tree = await handle(request('GET', '/api/tree', secret));
    expect(tree.status).toBe(200);
    expect(treeResponseSchema.parse(await tree.json()).totalNodes).toBe(0);

    const write = await handle(request('POST', '/api/capture', secret, captureOf(CHINESE_TEXT, 'web_app')));
    expect(await errorOf(write)).toMatchObject({ status: 401, code: 'unauthorized', retryable: false, reason: 'scope_not_granted' });
    // Refused, not half-applied: the capture pipeline never ran.
    expect(treeResponseSchema.parse(await (await handle(request('GET', '/api/tree', secret))).json()).totalNodes).toBe(0);
  });

  it('lets a capture-only connection write and refuses it the library', async () => {
    const harness = makeHarness();
    const store = new InMemoryGrantStore();
    const { secret } = await issueGrant(store, { label: '浏览器采集', client: 'extension', scopes: ['capture'] });
    const handle = handlerOf(harness, store);

    const captured = await handle(request('POST', '/api/capture', secret, captureOf(CHINESE_TEXT, 'extension')));
    expect(captured.status).toBe(200);
    expect(captureResultSchema.parse(await captured.json()).processingStatus).toBe('done');

    expect((await handle(request('GET', '/api/tree', secret))).status).toBe(401);
    expect(await errorOf(await handle(request('POST', '/api/search', secret, { query: '元组' })))).toMatchObject({
      reason: 'scope_not_granted',
    });
  });

  it('stops a connection the moment its grant is revoked, with the same credential', async () => {
    const harness = makeHarness();
    const store = new InMemoryGrantStore();
    const { grant, secret } = await issueGrant(store, { label: '临时调试', scopes: ['read'] });
    const handle = handlerOf(harness, store);

    expect((await handle(request('GET', '/api/tree', secret))).status).toBe(200);
    await revokeGrant(store, grant.id);
    expect(await errorOf(await handle(request('GET', '/api/tree', secret)))).toMatchObject({
      status: 401,
      reason: 'grant_revoked',
      message: expect.stringContaining('临时调试'),
    });
    // Health still answers: a dead credential must not look like a dead service.
    expect((await handle(new Request('http://core.local/api/health'))).status).toBe(200);
  });

  it('keeps the device credential working beside grants, so migration is not a lockout', async () => {
    const harness = makeHarness({ config: testConfig({ devTokenRequired: true, devToken: 'device-token' }) });
    const store = new InMemoryGrantStore();
    await issueGrant(store, { label: 'Agent', scopes: ['read'] });
    const handle = handlerOf(harness, store);

    expect((await handle(request('GET', '/api/tree', 'device-token'))).status).toBe(200);
    expect((await handle(request('GET', '/api/tree'))).status).toBe(401);
  });

  it('confines a project-limited connection to the projects it was given', async () => {
    const harness = makeHarness();
    const python = await createNodeRecord(harness, 'Python');
    const rust = await createNodeRecord(harness, 'Rust');
    await attachItemRecord(harness, python, '元组一旦创建就不能修改。');
    await attachItemRecord(harness, rust, '所有权规则在编译期检查。');

    const store = new InMemoryGrantStore();
    const { secret } = await issueGrant(store, { label: '只看 Python', scopes: ['read', 'mutate'], nodeIds: [python] });
    const handle = handlerOf(harness, store);

    expect((await handle(request('GET', `/api/nodes/${python}`, secret))).status).toBe(200);
    expect(await errorOf(await handle(request('GET', `/api/nodes/${rust}`, secret)))).toMatchObject({ reason: 'node_not_granted' });

    expect(treeResponseSchema.parse(await (await handle(request('GET', `/api/tree?rootId=${python}`, secret))).json()).rootId).toBe(python);
    expect(await errorOf(await handle(request('GET', '/api/tree', secret)))).toMatchObject({ reason: 'listing_not_scoped' });
    expect(await errorOf(await handle(request('GET', '/api/inbox', secret)))).toMatchObject({ reason: 'listing_not_scoped' });
    expect(await errorOf(await handle(request('POST', '/api/search', secret, { query: '元组' })))).toMatchObject({
      reason: 'listing_not_scoped',
    });
    expect(
      (await handle(request('POST', '/api/search', secret, { query: '元组', scopeNodeId: python }))).status,
    ).toBe(200);
    // 自动归类 chooses the node, so a limited grant cannot capture at all even though it holds `capture`.
    const limitedCapture = await issueGrant(store, { label: '限定项目采集', scopes: ['capture'], nodeIds: [python] });
    expect(await errorOf(await handle(request('POST', '/api/capture', limitedCapture.secret, captureOf(CHINESE_TEXT, 'extension'))))).toMatchObject(
      { reason: 'listing_not_scoped' },
    );
    // It may still file a known source into its own project.
    expect((await handle(request('PATCH', `/api/nodes/${python}`, secret, { summary: '不可变序列' }))).status).toBe(200);
    expect((await handle(request('POST', `/api/nodes/${python}/move`, secret, { targetParentId: rust }))).status).toBe(401);
  });

  it('checks a conversation against the projects its rows actually point at', async () => {
    const harness = makeHarness();
    const python = await createNodeRecord(harness, 'Python');
    const rust = await createNodeRecord(harness, 'Rust');
    await harness.core.chat({ nodeId: python, scope: 'current_node', messages: [{ role: 'user', content: '元组能改吗' }] }, harness.actor);
    const foreign = await harness.core.chat(
      { nodeId: rust, scope: 'current_node', messages: [{ role: 'user', content: '所有权是什么' }] },
      harness.actor,
    );
    const mine = (await harness.core.listConversations(harness.actor, python))[0];

    const store = new InMemoryGrantStore();
    const { secret } = await issueGrant(store, { label: 'Python 对话', scopes: ['read'], nodeIds: [python] });
    const handle = handlerOf(harness, store);

    expect((await handle(request('GET', '/api/conversations?nodeId=' + python, secret))).status).toBe(200);
    expect(await errorOf(await handle(request('GET', '/api/conversations', secret)))).toMatchObject({ reason: 'listing_not_scoped' });
    expect((await handle(request('GET', `/api/conversations/${mine?.id}/messages`, secret))).status).toBe(200);
    expect(await errorOf(await handle(request('GET', `/api/conversations/${foreign.conversationId}/messages`, secret)))).toMatchObject({
      reason: 'node_not_granted',
    });
  });
});
