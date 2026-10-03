import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiClient } from '@noltri/api-client';
import { buildServer } from '../src/server';
import { V1_TOOL_NAMES } from '../src/tools';
import { startFakeKnowledgeCore, type FakeCore, type RecordedCall } from './fake-core';

const CALLER_TOKEN = 'caller-token-abc';

const EXPECTED_TOOLS = [
  'capture_knowledge',
  'search_knowledge',
  'get_knowledge_tree',
  'get_knowledge_node',
  'update_knowledge_node',
  'move_knowledge_node',
  'get_node_context',
] as const;

interface ConnectedPair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

async function connectPair(apiBaseUrl: string): Promise<ConnectedPair> {
  const apiClient = new ApiClient({ baseUrl: apiBaseUrl, token: CALLER_TOKEN });
  const server = buildServer({ apiClient, config: { version: '0.0.0-test' } });
  const client = new Client({ name: 'vitest-mcp-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// callTool returns CallToolResult | CompatibilityCallToolResult; narrow structurally instead of coupling to SDK types.
function textOf(result: unknown): string {
  const content: unknown = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const blocks = content.filter(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text',
  );
  return blocks.map((block) => block.text).join('\n');
}

function structuredOf(result: unknown): Record<string, unknown> {
  const value: unknown = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected structured content, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

function onlyCall(core: FakeCore, pathname: string): RecordedCall {
  const found = core.calls.filter((call) => call.path.split('?')[0] === pathname);
  if (found.length !== 1) throw new Error(`expected exactly one call to ${pathname}, got ${String(found.length)}`);
  const call = found[0];
  if (call === undefined) throw new Error(`missing call to ${pathname}`);
  return call;
}

describe('noltri-knowledge MCP tools', () => {
  let core: FakeCore;
  let pair: ConnectedPair;

  beforeAll(async () => {
    core = await startFakeKnowledgeCore();
    pair = await connectPair(core.url);
  });

  afterAll(async () => {
    await pair.close();
    await core.close();
  });

  it('exposes exactly the seven V1 tools and nothing else', async () => {
    const listed = await pair.client.listTools();
    expect(listed.tools).toHaveLength(7);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect([...V1_TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());

    for (const tool of listed.tools) {
      const description = tool.description ?? '';
      expect(description).toMatch(/[\u4e00-\u9fa5]/);
      expect(description).toMatch(/[A-Za-z]{4,}/);
      expect(Object.keys(asRecord(tool.inputSchema))).toContain('properties');
    }
  });

  it('refuses raw database style tools', async () => {
    const listed = await pair.client.listTools();
    expect(listed.tools.map((tool) => tool.name).join(',')).not.toMatch(/sql|database|table|bulk|prune|purge/i);
  });

  it('capture_knowledge forwards a mcp-client capture request without any user identity', async () => {
    const source = { type: 'agent', appName: 'Qoder', title: 'Python 数据结构讨论' };
    const result = await pair.client.callTool({
      name: 'capture_knowledge',
      arguments: {
        text: 'Tuple 是不可变序列，因此可以作为字典的键。',
        source,
        surroundingContext: '上文：list 与 tuple 的差异',
        capturedAt: '2026-09-20T00:00:00.000Z',
      },
    });

    expect(result.isError).toBeUndefined();
    const call = onlyCall(core, '/api/capture');
    expect(call.method).toBe('POST');
    expect(call.authorization).toBe(`Bearer ${CALLER_TOKEN}`);

    const body = asRecord(call.body);
    expect(body.text).toBe('Tuple 是不可变序列，因此可以作为字典的键。');
    expect(body.surroundingContext).toBe('上文：list 与 tuple 的差异');
    expect(asRecord(body.source)).toEqual(source);
    expect(asRecord(body.capture)).toEqual({ capturedAt: '2026-09-20T00:00:00.000Z', client: 'mcp' });
    expect(collectKeys(call.body)).not.toContain('userId');
    expect(collectKeys(call.body)).not.toContain('user_id');

    const structured = structuredOf(result);
    const items = structured.items;
    expect(Array.isArray(items)).toBe(true);
    const first = asRecord((items as unknown[])[0]);
    expect(first.nodePath).toEqual(['Python', '数据结构', 'Tuple']);
    expect(first.action).toBe('attached');
    expect(first.confidenceTier).toBe('high');
    expect(textOf(result)).toContain('Python / 数据结构 / Tuple');
    expect(textOf(result)).toContain('置信度');
  });

  it('search_knowledge posts to /api/search', async () => {
    const result = await pair.client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'tuple 可哈希', mode: 'hybrid', limit: 5 },
    });
    expect(result.isError).toBeUndefined();

    const call = onlyCall(core, '/api/search');
    expect(call.method).toBe('POST');
    expect(asRecord(call.body)).toEqual({ query: 'tuple 可哈希', mode: 'hybrid', limit: 5 });

    const hits = structuredOf(result).hits;
    expect(Array.isArray(hits)).toBe(true);
    expect((hits as unknown[]).length).toBe(2);
    expect(textOf(result)).toContain('nodeId=node-tuple');
  });

  it('get_knowledge_tree renders an indented tree and structured nodes', async () => {
    const result = await pair.client.callTool({ name: 'get_knowledge_tree', arguments: {} });
    expect(result.isError).toBeUndefined();

    const call = onlyCall(core, '/api/tree');
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/api/tree');

    const text = textOf(result);
    expect(text).toContain('└── Python');
    expect(text).toContain('    └── 数据结构');
    expect(text).toContain('Tuple');
    expect(structuredOf(result).totalNodes).toBe(3);
  });

  it('get_knowledge_tree passes rootId and depth through to the tree query', async () => {
    const scoped = await pair.client.callTool({
      name: 'get_knowledge_tree',
      arguments: { rootId: 'node-data-structures', depth: 2 },
    });
    expect(scoped.isError).toBeUndefined();
    const call = core.calls.filter((entry) => entry.path.startsWith('/api/tree?')).at(-1);
    if (call === undefined) throw new Error('missing tree query call');
    expect(call.path).toBe('/api/tree?rootId=node-data-structures&depth=2');
  });

  it('get_knowledge_node reads the node detail endpoint', async () => {
    const result = await pair.client.callTool({ name: 'get_knowledge_node', arguments: { nodeId: 'node-tuple' } });
    expect(result.isError).toBeUndefined();

    const call = onlyCall(core, '/api/nodes/node-tuple');
    expect(call.method).toBe('GET');
    expect(asRecord(structuredOf(result).node).id).toBe('node-tuple');
    expect(textOf(result)).toContain('路径：Python / 数据结构 / Tuple');
  });

  it('get_knowledge_node surfaces a 404 as a clean tool error', async () => {
    const result = await pair.client.callTool({ name: 'get_knowledge_node', arguments: { nodeId: 'missing-node' } });
    expect(result.isError).toBe(true);
    const structured = structuredOf(result);
    expect(structured.code).toBe('not_found');
    expect(structured.status).toBe(404);
    expect(textOf(result)).toContain('目标知识节点不存在');
  });

  it('update_knowledge_node patches only the provided fields', async () => {
    const result = await pair.client.callTool({
      name: 'update_knowledge_node',
      arguments: { nodeId: 'node-tuple', title: 'Tuple（不可变序列）' },
    });
    expect(result.isError).toBeUndefined();

    const calls = core.calls.filter((call) => call.path === '/api/nodes/node-tuple');
    const patch = calls.find((call) => call.method === 'PATCH');
    if (patch === undefined) throw new Error('missing PATCH call');
    expect(asRecord(patch.body)).toEqual({ title: 'Tuple（不可变序列）' });
    expect(structuredOf(result).title).toBe('Tuple（不可变序列）');
    expect(textOf(result)).toContain('已更新节点');
  });

  it('update_knowledge_node rejects an empty patch before touching Knowledge Core', async () => {
    const before = core.calls.length;
    const result = await pair.client.callTool({ name: 'update_knowledge_node', arguments: { nodeId: 'node-tuple' } });
    expect(result.isError).toBe(true);
    expect(structuredOf(result).code).toBe('invalid_request');
    expect(core.calls.length).toBe(before);
  });

  it('move_knowledge_node posts the move request and reports the version record', async () => {
    const result = await pair.client.callTool({
      name: 'move_knowledge_node',
      arguments: { nodeId: 'node-tuple', targetParentId: 'node-python' },
    });
    expect(result.isError).toBeUndefined();

    const call = onlyCall(core, '/api/nodes/node-tuple/move');
    expect(call.method).toBe('POST');
    expect(asRecord(call.body)).toEqual({ targetParentId: 'node-python', actor: 'mcp' });
    expect(textOf(result)).toContain('版本记录 id=version-0001');
  });

  it('move_knowledge_node surfaces a core 409 conflict as an MCP tool error', async () => {
    const conflicted = await startFakeKnowledgeCore({ moveConflict: true });
    const second = await connectPair(conflicted.url);
    try {
      const result = await second.client.callTool({
        name: 'move_knowledge_node',
        arguments: { nodeId: 'node-tuple', targetParentId: 'node-tuple' },
      });
      expect(result.isError).toBe(true);
      const structured = structuredOf(result);
      expect(structured.code).toBe('conflict');
      expect(structured.status).toBe(409);
      const text = textOf(result);
      expect(text).toContain('结构冲突');
      expect(text).toContain('移动会形成循环');
      expect(onlyCall(conflicted, '/api/nodes/node-tuple/move').method).toBe('POST');

      const listed = await second.client.listTools();
      expect(listed.tools).toHaveLength(7);
    } finally {
      await second.close();
      await conflicted.close();
    }
  });

  it('get_node_context returns the markdown context pack', async () => {
    const result = await pair.client.callTool({
      name: 'get_node_context',
      arguments: { nodeId: 'node-tuple', scope: 'section', tokenBudget: 3000 },
    });
    expect(result.isError).toBeUndefined();

    const call = onlyCall(core, '/api/node-context');
    expect(call.method).toBe('POST');
    expect(asRecord(call.body)).toEqual({ nodeId: 'node-tuple', scope: 'section', tokenBudget: 3000 });

    expect(structuredOf(result).scope).toBe('section');
    expect(textOf(result)).toContain('## 节点：Tuple');
    expect(textOf(result)).toContain('上下文作用域=section');
  });

  it('a Knowledge Core outage yields a tool error, not a crashed session', async () => {
    const dead = await startFakeKnowledgeCore();
    const deadUrl = dead.url;
    await dead.close();

    const pairToDead = await connectPair(deadUrl);
    try {
      for (const name of EXPECTED_TOOLS) {
        const result = await pairToDead.client.callTool({
          name,
          arguments: {
            nodeId: 'node-tuple',
            text: 'Tuple 是不可变序列，因此可以作为字典的键。',
            source: { type: 'agent' },
            query: 'tuple',
            scope: 'current_node',
            targetParentId: null,
            title: 'x',
          },
        });
        expect(result.isError).toBe(true);
        const structured = structuredOf(result);
        expect(structured.code).toBe('internal_error');
        expect(textOf(result)).toContain('Knowledge Core');
      }

      const listed = await pairToDead.client.listTools();
      expect(listed.tools).toHaveLength(7);
    } finally {
      await pairToDead.close();
    }
  });
});
