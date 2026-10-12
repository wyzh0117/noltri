import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { silentLogger } from '@noltri/shared';
import { createMcpApp, loadMcpConfig, type McpHttpConfig } from '../src/index';
import { startFakeKnowledgeCore, type FakeCore } from './fake-core';
import { MCP_SERVER_NAME } from '../src/server';

const SERVER_TOKEN = 'sekret-mcp-token-2f6b';
const PROTOCOL_VERSION = '2025-06-18';

interface RpcReply {
  readonly status: number;
  readonly raw: string;
  readonly json: Record<string, unknown>;
  readonly contentType: string | null;
  readonly allow: string | null;
  readonly wwwAuthenticate: string | null;
}

let core: FakeCore;
let app: Server | undefined;

async function startApp(config: McpHttpConfig): Promise<number> {
  const server = createMcpApp(config, silentLogger);
  app = server;
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as AddressInfo).port;
}

function endpoint(port: number, path = '/mcp'): string {
  return `http://127.0.0.1:${String(port)}${path}`;
}

async function reply(response: Response): Promise<RpcReply> {
  const raw = await response.text();
  const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
  return {
    status: response.status,
    raw,
    json: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
    contentType: response.headers.get('content-type'),
    allow: response.headers.get('allow'),
    wwwAuthenticate: response.headers.get('www-authenticate'),
  };
}

async function postRpc(port: number, body: unknown, token?: string): Promise<RpcReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint(port), { method: 'POST', headers, body: JSON.stringify(body) });
  return await reply(response);
}

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vitest-http-client', version: '0.0.0' },
    },
  };
}

async function toolsList(port: number, token?: string): Promise<RpcReply> {
  return await postRpc(
    port,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    token,
  );
}

describe('MCP Streamable HTTP endpoint', () => {
  beforeAll(async () => {
    core = await startFakeKnowledgeCore();
  });

  afterEach(async () => {
    if (app !== undefined) {
      const current = app;
      app = undefined;
      current.closeAllConnections();
      await new Promise<void>((resolveClose) => current.close(() => resolveClose()));
    }
  });

  it('serves initialize and tools/list as JSON-RPC over POST /mcp', async () => {
    const port = await startApp(loadMcpConfig({ KNOWLEDGE_API_URL: core.url, NOLTRI_ACCESS_TOKEN: SERVER_TOKEN, MCP_VERSION: '9.9.9-test' }));

    const initialized = await postRpc(port, initializeRequest(1), SERVER_TOKEN);
    expect(initialized.status).toBe(200);
    expect(initialized.contentType).toContain('application/json');
    expect(initialized.json.jsonrpc).toBe('2.0');
    expect(initialized.json.id).toBe(1);
    const initResult = initialized.json.result as Record<string, unknown>;
    expect((initResult.serverInfo as Record<string, unknown>).name).toBe(MCP_SERVER_NAME);
    expect((initResult.serverInfo as Record<string, unknown>).version).toBe('9.9.9-test');
    expect(initResult.capabilities).toHaveProperty('tools');
    expect(typeof initResult.protocolVersion).toBe('string');

    const listed = await toolsList(port, SERVER_TOKEN);
    expect(listed.status).toBe(200);
    expect(listed.json.jsonrpc).toBe('2.0');
    expect(listed.json.id).toBe(2);
    const tools = (listed.json.result as Record<string, unknown>).tools as { name: string }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_knowledge_item',
      'get_knowledge_tree',
      'relate_knowledge',
      'remove_knowledge_relation',
      'save_knowledge',
      'search_knowledge',
    ].sort());
  });

  it('rejects unauthenticated and mis-authenticated callers with 401', async () => {
    const port = await startApp(loadMcpConfig({ KNOWLEDGE_API_URL: core.url, NOLTRI_ACCESS_TOKEN: SERVER_TOKEN }));

    const anonymous = await postRpc(port, initializeRequest(1));
    expect(anonymous.status).toBe(401);
    expect(anonymous.wwwAuthenticate).toContain('Bearer');
    const errorBody = (anonymous.json as Record<string, unknown>).error as Record<string, unknown>;
    expect(errorBody.code).toBe('unauthorized');

    const wrong = await postRpc(port, initializeRequest(1), `${SERVER_TOKEN}x`);
    expect(wrong.status).toBe(401);

    const listed = await toolsList(port);
    expect(listed.status).toBe(401);
  });

  it('answers 405 for GET /mcp with a usable hint', async () => {
    const port = await startApp(loadMcpConfig({ KNOWLEDGE_API_URL: core.url }));
    const response = await fetch(endpoint(port), {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${SERVER_TOKEN}` },
    });
    const got = await reply(response);
    expect(got.status).toBe(405);
    expect(got.allow).toBe('POST, OPTIONS');
    expect(got.raw).toContain('POST /mcp');
  });

  it('reports configuration on /healthz without ever leaking the token', async () => {
    const port = await startApp(loadMcpConfig({ KNOWLEDGE_API_URL: core.url, NOLTRI_ACCESS_TOKEN: SERVER_TOKEN, AUTH_REQUIRED: 'true' }));
    const response = await fetch(endpoint(port, '/healthz'));
    const got = await reply(response);
    expect(got.status).toBe(200);
    expect(got.json.raw ?? got.raw).toBeTruthy();
    expect(got.json.server).toBe(MCP_SERVER_NAME);
    expect(got.json.knowledgeApiConfigured).toBe(true);
    expect(got.json.accessTokenConfigured).toBe(true);
    expect(got.json.authRequired).toBe(true);
    expect(got.json.sessionMode).toBe('stateless');
    expect(got.raw).not.toContain(SERVER_TOKEN);

    const unauthenticated = await fetch(endpoint(port, '/healthz'));
    expect((await unauthenticated.text()).length).toBeGreaterThan(0);
    expect(unauthenticated.status).toBe(200);
  });

  it('runs open in dev mode and forwards the caller token to Knowledge Core', async () => {
    const port = await startApp(loadMcpConfig({ KNOWLEDGE_API_URL: core.url }));
    const callerToken = 'device-token-from-caller';

    const initialized = await postRpc(port, initializeRequest(1));
    expect(initialized.status).toBe(200);

    const called = await postRpc(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_knowledge_tree', arguments: {} },
      },
      callerToken,
    );
    expect(called.status).toBe(200);
    expect(called.json.id).toBe(3);
    const result = called.json.result as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).totalNodes).toBe(3);

    const treeCall = core.calls.find((entry) => entry.path === '/api/tree');
    if (treeCall === undefined) throw new Error('fake core never received the tree request');
    expect(treeCall.authorization).toBe(`Bearer ${callerToken}`);
  });

  it('refuses to load a config that requires auth without a token', () => {
    expect(() => loadMcpConfig({ AUTH_REQUIRED: 'true' })).toThrow(/NOLTRI_ACCESS_TOKEN/);
  });
});
