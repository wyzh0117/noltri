import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentEnv } from '@noltri/shared';
import { createAiService } from '../src/service';

type JsonMap = Record<string, unknown>;

let server: Server;
let origin: string;

const ENV_KEYS = ['AI_PROVIDER', 'AI_EMBEDDING_DIM', 'AI_API_KEY', 'AI_BASE_URL', 'CORS_ORIGIN'] as const;
const saved: Record<string, string | undefined> = {};

async function call(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body,
  });
  const text = await response.text();
  let json: JsonMap | undefined;
  try {
    json = JSON.parse(text) as JsonMap;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.AI_PROVIDER = 'offline';
  process.env.AI_EMBEDDING_DIM = '16';
  delete process.env.AI_API_KEY;
  const service = createAiService(currentEnv());
  server = createServer(service.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /health', () => {
  it('reports driver and models without leaking a key', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    expect(response.json?.status).toBe('ok');
    expect(response.json?.driver).toBe('offline');
    expect(response.json?.provider).toBe('offline');
    expect(typeof response.json?.chatModel).toBe('string');
    expect(typeof response.json?.embedModel).toBe('string');
    expect(response.json?.embeddingDim).toBe(16);
    expect(response.json?.hasApiKey).toBe(false);
    expect(response.json?.requiresApiKey).toBe(false);
    expect(response.json).not.toHaveProperty('apiKey');
  });
});

describe('POST /extract', () => {
  it('returns atomic items from the offline provider', async () => {
    const response = await call(
      '/extract',
      {
        method: 'POST',
        body: JSON.stringify({
          text: '列表推导式是语法糖。生成器表达式用 yield 惰性产出值，适合处理大序列。',
          sourceLabel: '网页：Python 官方文档',
          sourceType: 'web',
          maxItems: 2,
        }),
      },
    );
    expect(response.status).toBe(200);
    const items = response.json?.items as JsonMap[] | undefined;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.text).toBe('列表推导式是语法糖');
    expect(typeof items?.[0]?.confidence).toBe('number');
    expect(typeof items?.[0]?.suggestedTitle).toBe('string');
  });

  it('rejects a body without text as invalid_request', async () => {
    const response = await call('/extract', { method: 'POST', body: JSON.stringify({ sourceLabel: 'x' }) });
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });

  it('rejects a stringified maxItems instead of coercing it', async () => {
    const response = await call(
      '/extract',
      {
        method: 'POST',
        body: JSON.stringify({ text: '知识点内容', sourceLabel: 'x', sourceType: 'web', maxItems: '2' }),
      },
    );
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });

  it('rejects a non-JSON body', async () => {
    const response = await call('/extract', { method: 'POST', body: 'text=hello' });
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });

  it('rejects an empty body', async () => {
    const response = await call('/extract', { method: 'POST', body: '' });
    expect(response.status).toBe(400);
  });
});

describe('POST /embed', () => {
  it('returns deterministic vectors of the configured dimension', async () => {
    const payload = JSON.stringify({ texts: ['Python 的 list 可变', 'Rust 的所有权'] });
    const first = await call('/embed', { method: 'POST', body: payload });
    const second = await call('/embed', { method: 'POST', body: payload });
    expect(first.status).toBe(200);
    expect(first.json?.count).toBe(2);
    expect(first.json?.dim).toBe(16);
    expect(typeof first.json?.model).toBe('string');
    const vectors = first.json?.vectors as number[][] | undefined;
    expect(vectors?.[0]).toHaveLength(16);
    expect(vectors).toEqual(second.json?.vectors);
    expect(vectors?.[0]).not.toEqual(vectors?.[1]);
  });

  it('rejects an empty texts array', async () => {
    const response = await call('/embed', { method: 'POST', body: JSON.stringify({ texts: [] }) });
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });
});

describe('POST /classify and /chat', () => {
  const candidates = [
    { id: 'n-list', title: 'Python 列表', summary: '可变序列', path: ['编程', 'Python'], itemCount: 4 },
  ];

  it('classifies an item against supplied candidates', async () => {
    const attached = await call('/classify', {
      method: 'POST',
      body: JSON.stringify({
        itemText: 'Python 列表 可变序列',
        candidates,
        attachThreshold: 0.1,
      }),
    });
    expect(attached.status).toBe(200);
    expect(attached.json?.action).toBe('attach');
    expect(attached.json?.nodeId).toBe('n-list');

    const created = await call('/classify', {
      method: 'POST',
      body: JSON.stringify({
        itemText: '光栅显示器的刷新率决定画面稳定性',
        candidates,
        attachThreshold: 0.99,
      }),
    });
    expect(created.status).toBe(200);
    expect(created.json?.action).toBe('create');
    expect(typeof created.json?.newNodeTitle).toBe('string');
  });

  it('rejects a missing attachThreshold', async () => {
    const response = await call('/classify', { method: 'POST', body: JSON.stringify({ itemText: 'x', candidates }) });
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });

  it('answers chat and labels the offline provider', async () => {
    const response = await call('/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: '这个节点的核心结论是什么？' }],
        systemContext: '当前节点：Python 列表',
        scope: 'current_node',
      }),
    });
    expect(response.status).toBe(200);
    expect(String(response.json?.text)).toContain('本地离线 Provider');
    expect(String(response.json?.text)).toContain('已装载上下文：');
    expect(String(response.json?.text)).toContain('作用域 current_node');
    expect(String(response.json?.text)).toContain('问题：这个节点的核心结论是什么？');
  });
});

describe('routing and CORS', () => {
  it('answers preflight with CORS headers', async () => {
    const response = await fetch(`${origin}/extract`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('sends CORS headers on ordinary responses', async () => {
    const response = await call('/health');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 404 for unknown endpoints', async () => {
    const response = await call('/nope', { method: 'POST', body: JSON.stringify({}) });
    expect(response.status).toBe(404);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('not_found');
  });

  it('rejects non-POST on provider endpoints', async () => {
    const response = await call('/extract');
    expect(response.status).toBe(400);
    expect((response.json?.error as JsonMap | undefined)?.code).toBe('invalid_request');
  });
});
