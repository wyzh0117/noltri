import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiClient } from '@noltri/api-client';
import { buildServer } from '../src/server';
import { LIBRARY_TOOL_NAMES } from '../src/tools';
import { fixtureLibraryItem, startFakeKnowledgeCore, type FakeCore, type RecordedCall } from './fake-core';

const CALLER_TOKEN = 'caller-token-abc';
const EXPECTED_TOOLS = [
  'save_knowledge',
  'search_knowledge',
  'get_knowledge_tree',
  'get_knowledge_item',
  'relate_knowledge',
  'remove_knowledge_relation',
] as const;

let core: FakeCore;
let client: Client;
let closePair: () => Promise<void>;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
}

function onlyCall(pathname: string, method?: string): RecordedCall {
  const matches = core.calls.filter((call) => call.path.split('?')[0] === pathname && (method === undefined || call.method === method));
  if (matches.length !== 1) throw new Error(`expected one ${pathname} call, got ${matches.length}`);
  return matches[0]!;
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block,
    )
    .map((block) => block.text)
    .join('\n');
}

beforeAll(async () => {
  core = await startFakeKnowledgeCore();
  const api = new ApiClient({ baseUrl: core.url, token: CALLER_TOKEN });
  const server = buildServer({ apiClient: api, config: { version: '0.1.0-test' } });
  client = new Client({ name: 'noltri-library-test', version: '0.1.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closePair = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await closePair();
  await core.close();
});

describe('Noltri library MCP tools', () => {
  it('exposes only the collection, search, tree, read, and comparison tools', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect([...LIBRARY_TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(listed.tools.map((tool) => tool.name).join(',')).not.toMatch(/move_knowledge_node|node_context|bulk_delete|sql/i);
    for (const tool of listed.tools) expect(tool.description).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('saves a paper excerpt and its citation through the shared library API', async () => {
    const result = await client.callTool({
      name: 'save_knowledge',
      arguments: {
        content: '文献摘录内容与原文出处一同保存。',
        kind: 'paper_excerpt',
        source: { type: 'agent', title: '研究论文', url: 'https://example.org/paper', citation: '作者（2026）', page: '5' },
        researchPoint: '研究点一',
        subjectPath: ['经济学', '平台经济'],
      },
    });
    expect(result.isError).toBeUndefined();
    const call = onlyCall('/api/items');
    expect(call.method).toBe('POST');
    expect(call.authorization).toBe(`Bearer ${CALLER_TOKEN}`);
    expect(asRecord(call.body)).toMatchObject({ kind: 'paper_excerpt', content: '文献摘录内容与原文出处一同保存。' });
    expect(asRecord(asRecord(call.body).source)).toMatchObject({ citation: '作者（2026）', page: '5' });
    expect(JSON.stringify(call.body)).not.toMatch(/userId|user_id/);
    expect(textOf(result)).toContain('经济学 / 平台经济');
    expect(asRecord(result.structuredContent).item).toMatchObject({ kind: 'paper_excerpt', aiStatus: 'ready' });
  });

  it('reads a saved item by id', async () => {
    const result = await client.callTool({ name: 'get_knowledge_item', arguments: { itemId: fixtureLibraryItem.id } });
    expect(result.isError).toBeUndefined();
    expect(onlyCall(`/api/items/${fixtureLibraryItem.id}`).method).toBe('GET');
    expect(asRecord(result.structuredContent).item).toMatchObject({ content: fixtureLibraryItem.content, source: fixtureLibraryItem.source });
  });

  it('searches and loads the knowledge tree using Core', async () => {
    const search = await client.callTool({ name: 'search_knowledge', arguments: { query: '平台经济', limit: 5 } });
    expect(search.isError).toBeUndefined();
    const itemSearch = onlyCall('/api/items', 'GET');
    expect(itemSearch.method).toBe('GET');
    expect(new URL(`http://core${itemSearch.path}`).searchParams.get('query')).toBe('平台经济');
    expect(textOf(search)).toContain('待整理');
    const searchItems = asRecord(search.structuredContent).items;
    expect(Array.isArray(searchItems)).toBe(true);
    if (!Array.isArray(searchItems)) throw new Error('expected search result items');
    expect(asRecord(searchItems[0]).aiStatus).toBe('pending');

    const tree = await client.callTool({ name: 'get_knowledge_tree', arguments: {} });
    expect(tree.isError).toBeUndefined();
    expect(onlyCall('/api/tree').method).toBe('GET');
    expect(textOf(tree)).toContain('Python');
  });

  it('creates and removes a bidirectional item relation through Core', async () => {
    const related = await client.callTool({
      name: 'relate_knowledge',
      arguments: { itemId: 'raw-library-0001', targetId: 'raw-library-0002', relation: 'contradicts' },
    });
    expect(related.isError).toBeUndefined();
    const create = onlyCall('/api/items/raw-library-0001/relations');
    expect(create.method).toBe('POST');
    expect(asRecord(create.body)).toEqual({ targetId: 'raw-library-0002', relation: 'contradicts' });

    const removed = await client.callTool({
      name: 'remove_knowledge_relation',
      arguments: { itemId: 'raw-library-0001', targetId: 'raw-library-0002' },
    });
    expect(removed.isError).toBeUndefined();
    expect(onlyCall('/api/items/raw-library-0001/relations/raw-library-0002').method).toBe('DELETE');
  });
});
