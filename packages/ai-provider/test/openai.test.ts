import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderConfig } from '@noltri/shared';
import { OpenAiCompatibleProvider } from '../src/openai';

type JsonMap = Record<string, unknown>;

interface ChatWireMessage {
  role: string;
  content: string;
}

interface Reply {
  status?: number;
  body?: unknown;
  /** Sent verbatim: lets a test answer with a non-JSON body. */
  rawBody?: string;
  delayMs?: number;
}

interface RecordedCall {
  path: string;
  body: JsonMap;
  authorization?: string;
  apiKey?: string;
  anthropicVersion?: string;
}

interface Fake {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

type Responder = (call: RecordedCall, index: number) => Reply;

function asCaught(error: unknown): { code?: string; message: string; details?: unknown } {
  const shape = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  return {
    code: typeof shape.code === 'string' ? shape.code : undefined,
    message: error instanceof Error ? error.message : String(error),
    details: shape.details,
  };
}

async function expectRejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return asCaught(error);
  }
  throw new Error('expected the provider call to reject');
}

function chatReply(content: string, model = 'gpt-test'): Reply {
  return {
    body: {
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      model,
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    },
  };
}

function jsonReply(payload: unknown): Reply {
  return chatReply(JSON.stringify(payload));
}

function embeddingReply(texts: unknown[], dim: number): Reply {
  return {
    body: {
      // Deliberately reversed: the adapter must restore the request order via `index`.
      data: texts
        .map((_, position) => ({
          index: position,
          embedding: Array.from({ length: dim }, (_, axis) => position * 100 + axis),
        }))
        .reverse(),
    },
  };
}

const BASE_CONFIG: AiProviderConfig = {
  driver: 'openai',
  apiKey: 'sk-test-key',
  baseUrl: 'http://127.0.0.1:1',
  chatModel: 'gpt-test',
  embedModel: 'embed-test',
  embeddingDim: 3,
  timeoutMs: 5_000,
  temperature: 0.2,
};

const CANDIDATES = [
  { id: 'node-python', title: 'Python 语法', summary: '容器与推导式', path: ['编程', 'Python'], itemCount: 12 },
  { id: 'node-rust', title: 'Rust 所有权', summary: null, path: ['编程', 'Rust'], itemCount: 3 },
];

function providerFor(baseUrl: string, overrides: Partial<AiProviderConfig> = {}) {
  return new OpenAiCompatibleProvider(
    { ...BASE_CONFIG, baseUrl, ...overrides },
    { maxRetries: 2, backoffBaseMs: 1 },
  );
}

const open: Fake[] = [];

async function startFake(respond: Responder): Promise<Fake> {
  const calls: RecordedCall[] = [];
  const server: Server = createServer((request, response) => {
    response.on('error', () => undefined);
    const chunks: Buffer[] = [];
    request.on('data', (piece: Buffer) => chunks.push(piece));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: JsonMap = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) body = parsed as JsonMap;
      } catch {
        body = {};
      }
      const call: RecordedCall = {
        path: (request.url ?? '/').split('?')[0],
        body,
        authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        anthropicVersion: typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : undefined,
      };
      calls.push(call);
      const reply = respond(call, calls.length - 1);
      const send = () => {
        if (response.writableEnded) return;
        const payload = reply.rawBody ?? (reply.body === undefined ? '{}' : JSON.stringify(reply.body));
        response.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          connection: 'close',
        });
        response.end(payload);
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  server.on('clientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const fake: Fake = {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === null || error === undefined ? resolve() : reject(error)));
      });
    },
  };
  open.push(fake);
  return fake;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fake of open.splice(0)) await fake.close();
});

function messagesOf(call: RecordedCall | undefined): ChatWireMessage[] {
  return (call?.body.messages ?? []) as ChatWireMessage[];
}

describe('constructor guards (BYOK config)', () => {
  const required: [keyof AiProviderConfig, string][] = [
    ['apiKey', 'AI_API_KEY'],
    ['baseUrl', 'AI_BASE_URL'],
    ['chatModel', 'AI_CHAT_MODEL'],
    ['embedModel', 'AI_EMBED_MODEL'],
  ];

  for (const [field, envVar] of required) {
    it(`rejects a missing ${field} naming ${envVar}`, () => {
      let caught: unknown;
      try {
        new OpenAiCompatibleProvider({
          ...BASE_CONFIG,
          ...(field === 'apiKey' ? { baseUrl: 'https://api.openai.com/v1' } : {}),
          [field]: '  ',
        } as AiProviderConfig);
      } catch (error) {
        caught = error;
      }
      expect(asCaught(caught).code).toBe('invalid_request');
      expect(asCaught(caught).message).toContain(envVar);
    });
  }

  it('allows a keyless local endpoint', () => {
    const provider = new OpenAiCompatibleProvider({ ...BASE_CONFIG, apiKey: '' });
    expect(provider.capabilities.chat).toBe(true);
  });

  it('rejects a non-numeric embedding dim naming AI_EMBEDDING_DIM', () => {
    let caught: unknown;
    try {
      new OpenAiCompatibleProvider({ ...BASE_CONFIG, embeddingDim: 0 });
    } catch (error) {
      caught = error;
    }
    expect(asCaught(caught).code).toBe('invalid_request');
    expect(asCaught(caught).message).toContain('AI_EMBEDDING_DIM');
  });

  it('exposes a stable id and full capabilities', async () => {
    const fake = await startFake(() => ({ body: {} }));
    const provider = providerFor(fake.baseUrl);
    expect(provider.id).toBe('openai-compatible');
    expect(provider.capabilities).toEqual({ embeddings: true, chat: true, structuredOutput: true });
  });
});

describe('extractKnowledge', () => {
  it('splits selected text into atomic items with one JSON-mode chat call', async () => {
    const fake = await startFake(() =>
      jsonReply({
        items: [
          { text: 'Python 的 list 是可变序列', summary: 'list 支持原地修改', confidence: 0.91, suggestedTitle: 'Python list 可变性' },
          { text: 'tuple 一旦创建就不可修改', confidence: 0.7 },
        ],
      }),
    );
    const provider = providerFor(fake.baseUrl);
    const result = await provider.extractKnowledge({
      text: 'Python 的 list 是可变序列。tuple 一旦创建就不可修改。',
      surroundingContext: '上文讨论容器类型',
      sourceLabel: '网页：Python 官方文档',
      sourceType: 'web',
      maxItems: 3,
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.path).toBe('/chat/completions');
    expect(call?.authorization).toBe('Bearer sk-test-key');
    expect(call?.body.model).toBe('gpt-test');
    expect(call?.body.response_format).toEqual({ type: 'json_object' });
    expect(call?.body.temperature).toBe(0.2);

    const messages = messagesOf(call);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('原子');
    expect(messages[0]?.content).toContain('atomic');
    expect(messages[0]?.content).toContain('Never invent facts');
    expect(messages[0]?.content).toContain('navigation');
    expect(messages[0]?.content).toContain('confidence is a number in 0..1');
    expect(messages[0]?.content).toContain('最多 3 条');
    expect(messages[1]?.content).toContain('唯一抽取来源');
    expect(messages[1]?.content).toContain('REFERENCE CONTEXT — never an extraction source');
    expect(messages[1]?.content.indexOf('上文讨论容器类型')).toBeGreaterThan(
      messages[1]?.content.indexOf('REFERENCE CONTEXT') ?? -1,
    );

    expect(result.items[0]).toEqual({
      text: 'Python 的 list 是可变序列',
      summary: 'list 支持原地修改',
      confidence: 0.91,
      suggestedTitle: 'Python list 可变性',
    });
    // Mirrors the offline provider's output conventions for missing fields.
    expect(result.items[1]?.summary).toBe('tuple 一旦创建就不可修改');
    expect((result.items[1]?.suggestedTitle ?? '').length).toBeGreaterThan(0);
  });

  it('honours maxItems', async () => {
    const fake = await startFake(() =>
      jsonReply({
        items: [
          { text: '第一条知识点内容', confidence: 0.8 },
          { text: '第二条知识点内容', confidence: 0.8 },
          { text: '第三条知识点内容', confidence: 0.8 },
          { text: '第四条知识点内容', confidence: 0.8 },
        ],
      }),
    );
    const result = await providerFor(fake.baseUrl).extractKnowledge({
      text: '四条内容',
      sourceLabel: '手动录入',
      sourceType: 'manual',
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
  });

  it('rejects empty selected text as invalid_request', async () => {
    const fake = await startFake(() => ({ body: {} }));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).extractKnowledge({ text: '   ', sourceLabel: 'x', sourceType: 'web' }),
    );
    expect(caught.code).toBe('invalid_request');
    expect(fake.calls).toHaveLength(0);
  });

  it('raises provider_error with a raw snippet when the model replies in prose', async () => {
    const fake = await startFake(() => chatReply('抱歉，这段文本没有可抽取的知识点。'));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).extractKnowledge({ text: '随便一句话', sourceLabel: '网页', sourceType: 'web' }),
    );
    expect(caught.code).toBe('provider_error');
    expect(JSON.stringify(caught.details)).toContain('抱歉');
  });

  it('never returns a partially parsed item: missing confidence is provider_error', async () => {
    const fake = await startFake(() => jsonReply({ items: [{ text: '只有文本没有置信度' }] }));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).extractKnowledge({ text: '内容', sourceLabel: '网页', sourceType: 'web' }),
    );
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('契约');
  });

  it('raises provider_error when the HTTP body itself is not JSON', async () => {
    const fake = await startFake(() => ({ rawBody: '<html>bad gateway proxy</html' }));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).extractKnowledge({ text: '内容', sourceLabel: '网页', sourceType: 'web' }),
    );
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('JSON');
  });

  it('falls back once without response_format and parses a fenced block', async () => {
    const fake = await startFake((call, index) =>
      index === 0
        ? { status: 400, body: { error: { message: "Unsupported response_format: 'json_object'" } } }
        : chatReply(`这是结果：\n\`\`\`json\n{"items":[{"text":"退相干时间随温度上升而缩短","confidence":0.78}]}\n\`\`\``),
    );
    const result = await providerFor(fake.baseUrl).extractKnowledge({
      text: '退相干时间随温度上升而缩短',
      sourceLabel: '论文',
      sourceType: 'web',
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(fake.calls[1]?.body.response_format).toBeUndefined();
    expect(messagesOf(fake.calls[1])[0]?.content).toContain('无法启用 response_format');
    expect(result.items[0]?.text).toBe('退相干时间随温度上升而缩短');
  });
});

describe('classifyKnowledge', () => {
  it('attaches to a supplied candidate in one call', async () => {
    const fake = await startFake(() =>
      jsonReply({ action: 'attach', nodeId: 'node-python', confidence: 0.88, reason: '与 Python 容器主题一致' }),
    );
    const decision = await providerFor(fake.baseUrl).classifyKnowledge({
      itemText: 'Python 的 list 是可变序列',
      suggestedTitle: 'Python list 可变性',
      candidates: CANDIDATES,
      attachThreshold: 0.7,
      scopeHint: 'current_node',
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.path).toBe('/chat/completions');
    const user = messagesOf(fake.calls[0])[1]?.content ?? '';
    expect(user).toContain('node-python');
    expect(user).toContain('Python 语法');
    expect(user).toContain('itemCount');
    expect(user).toContain('attachThreshold：0.7');
    expect(messagesOf(fake.calls[0])[0]?.content).toContain('禁止编造');
    expect(decision).toEqual({
      action: 'attach',
      nodeId: 'node-python',
      confidence: 0.88,
      reason: '与 Python 容器主题一致',
    });
  });

  it('creates a node and keeps the title as the leaf of the path', async () => {
    const fake = await startFake(() =>
      jsonReply({
        action: 'create',
        newNodeTitle: 'Python 推导式',
        newNodePath: ['编程'],
        confidence: 0.61,
        reason: '没有匹配的现有节点',
      }),
    );
    const decision = await providerFor(fake.baseUrl).classifyKnowledge({
      itemText: '推导式比 map 更易读',
      candidates: CANDIDATES,
      attachThreshold: 0.7,
    });
    expect(decision.action).toBe('create');
    expect(decision.newNodeTitle).toBe('Python 推导式');
    expect(decision.newNodePath).toEqual(['编程', 'Python 推导式']);
    expect(decision.confidence).toBe(0.61);
  });

  it('rejects an unknown nodeId after one corrective retry without inventing a category', async () => {
    const fake = await startFake(() =>
      jsonReply({ action: 'attach', nodeId: 'node-that-does-not-exist', confidence: 0.9, reason: '看起来相关' }),
    );
    const caught = await expectRejection(() => providerFor(fake.baseUrl).classifyKnowledge({
      itemText: 'Rust 的所有权规则在编译期检查',
      suggestedTitle: 'Rust 所有权',
      candidates: CANDIDATES,
      attachThreshold: 0.7,
    }));
    expect(fake.calls).toHaveLength(2);
    const retryMessages = messagesOf(fake.calls[1]);
    expect(retryMessages).toHaveLength(4);
    expect(retryMessages[2]?.role).toBe('assistant');
    expect(retryMessages[3]?.content).toContain('不在候选节点列表中');
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('有效知识体系路径');
  });

  it('asks the model again when create only repeats the excerpt title', async () => {
    const fake = await startFake((_call, index) => jsonReply(index === 0
      ? { action: 'create', newNodeTitle: 'Rust 所有权', confidence: 0.8, reason: '新内容' }
      : { action: 'create', newNodePath: ['计算机科学', 'Rust', '所有权'], confidence: 0.8, reason: '编程语言中的内存管理' }));
    const decision = await providerFor(fake.baseUrl).classifyKnowledge({
      itemText: 'Rust 的所有权规则在编译期检查',
      suggestedTitle: 'Rust 所有权',
      candidates: [],
      attachThreshold: 0.7,
    });
    expect(fake.calls).toHaveLength(2);
    expect(decision.newNodePath).toEqual(['计算机科学', 'Rust', '所有权']);
  });

  it('turns a below-threshold attach into create instead of trusting the model', async () => {
    const fake = await startFake(() =>
      jsonReply({
        action: 'attach',
        nodeId: 'node-rust',
        confidence: 0.4,
        reason: '勉强相关',
        newNodeTitle: 'Rust 借用检查',
        newNodePath: ['编程', 'Rust'],
      }),
    );
    const decision = await providerFor(fake.baseUrl).classifyKnowledge({
      itemText: '借用检查器拒绝悬垂引用',
      candidates: CANDIDATES,
      attachThreshold: 0.7,
    });
    expect(fake.calls).toHaveLength(1);
    expect(decision.action).toBe('create');
    expect(decision.newNodeTitle).toBe('Rust 借用检查');
    expect(decision.newNodePath).toEqual(['编程', 'Rust', 'Rust 借用检查']);
    expect(decision.reason).toContain('低于归档阈值');
  });

  it('reports provider_error when the model never produces contract JSON', async () => {
    const fake = await startFake(() => chatReply('我不确定该放哪里。'));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).classifyKnowledge({
        itemText: '任意知识点',
        candidates: CANDIDATES,
        attachThreshold: 0.7,
      }),
    );
    expect(caught.code).toBe('provider_error');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('DeepSeek JSON compatibility', () => {
  it('disables default thinking for extraction, JSON fallback and classification correction, but preserves chat', async () => {
    const fake = await startFake((_call, index) => {
      if (index === 0) return { status: 400, body: { error: { message: 'Unsupported response_format' } } };
      if (index === 1) return jsonReply({ items: [{ text: 'Rust 在编译期检查所有权', confidence: 0.9 }] });
      if (index === 2) return jsonReply({ action: 'attach', nodeId: 'unknown', confidence: 0.9, reason: '需纠正' });
      if (index === 3) return jsonReply({ action: 'attach', nodeId: 'node-rust', confidence: 0.9, reason: '所有权主题一致' });
      return chatReply('好的');
    });
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) =>
      originalFetch(`${fake.baseUrl}${new URL(String(url)).pathname}`, options),
    );
    const provider = providerFor('https://api.deepseek.com/v1', { chatModel: 'deepseek-v4-pro' });
    await provider.extractKnowledge({ text: 'Rust 在编译期检查所有权', sourceLabel: '代码节选', sourceType: 'manual' });
    await provider.classifyKnowledge({ itemText: 'Rust 在编译期检查所有权', candidates: CANDIDATES, attachThreshold: 0.7 });
    await provider.chat({ messages: [{ role: 'user', content: '你好' }] });
    expect(fake.calls).toHaveLength(5);
    for (const call of fake.calls.slice(0, 4)) {
      expect(call.path).toBe('/v1/chat/completions');
      expect(call.body.thinking).toEqual({ type: 'disabled' });
    }
    expect(fake.calls[1]?.body.response_format).toBeUndefined();
    expect(fake.calls[4]?.body.thinking).toBeUndefined();
  });

  it('does not send DeepSeek-only fields to other origins, even with a DeepSeek model name', async () => {
    const fake = await startFake(() => jsonReply({ items: [] }));
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => originalFetch(`${fake.baseUrl}/chat/completions`, options));
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://api.deepseek.com.example.com/v1',
      'https://example.com/api.deepseek.com',
      'https://api.deepseek.com:444/v1',
      'http://api.deepseek.com',
    ]) {
      await providerFor(baseUrl, { chatModel: 'deepseek-v4-pro' }).extractKnowledge({
        text: 'Rust 在编译期检查所有权', sourceLabel: '代码节选', sourceType: 'manual',
      });
    }
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls.every((call) => call.body.thinking === undefined)).toBe(true);
  });
});

describe('embed', () => {
  it('posts dimensions + input and preserves request order', async () => {
    const fake = await startFake((call) => embeddingReply((call.body.input as unknown[]) ?? [], 3));
    const vectors = await providerFor(fake.baseUrl).embed(['甲知识点', '乙知识点']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.path).toBe('/embeddings');
    expect(fake.calls[0]?.body.model).toBe('embed-test');
    expect(fake.calls[0]?.body.dimensions).toBe(3);
    expect(fake.calls[0]?.body.input).toEqual(['甲知识点', '乙知识点']);
    expect(vectors).toEqual([
      [0, 1, 2],
      [100, 101, 102],
    ]);
  });

  it('chunks at 100 texts per request', async () => {
    const fake = await startFake((call) => embeddingReply((call.body.input as unknown[]) ?? [], 3));
    const texts = Array.from({ length: 250 }, (_, index) => `知识点 ${String(index)}`);
    const vectors = await providerFor(fake.baseUrl).embed(texts);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((call) => (call.body.input as unknown[]).length)).toEqual([100, 100, 50]);
    expect(vectors).toHaveLength(250);
    expect(vectors[0]).toEqual([0, 1, 2]);
    expect(vectors[100]).toEqual([0, 1, 2]);
    expect(vectors[249]).toEqual([4900, 4901, 4902]);
  });

  it('returns [] for an empty input without calling the endpoint', async () => {
    const fake = await startFake(() => ({ body: { data: [] } }));
    expect(await providerFor(fake.baseUrl).embed([])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('raises provider_error on a vector length mismatch', async () => {
    const fake = await startFake(() => ({ body: { data: [{ index: 0, embedding: [0.1, 0.2] }] } }));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲知识点']));
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('AI_EMBEDDING_DIM');
  });

  it('raises provider_error when a batch is missing an entry', async () => {
    const fake = await startFake(() => ({ body: { data: [{ index: 0, embedding: [1, 2, 3] }] } }));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲', '乙']));
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('缺少');
  });
});

describe('chat', () => {
  it('injects systemContext as a labelled leading system message', async () => {
    const fake = await startFake(() => chatReply('list 可变，tuple 不可变。', 'gpt-answer'));
    const result = await providerFor(fake.baseUrl).chat({
      systemContext: '当前节点：Python 语法\n- list 是可变序列',
      scope: 'current_node',
      messages: [
        { role: 'user', content: '它们的核心区别是什么？' },
        { role: 'assistant', content: '可变性不同。' },
        { role: 'user', content: '再举一个例子' },
      ],
      maxOutputTokens: 256,
    });
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]?.body ?? {};
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toBeUndefined();
    const messages = messagesOf(fake.calls[0]);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('节点上下文');
    expect(messages[0]?.content).toContain('current_node');
    expect(messages[0]?.content).toContain('list 是可变序列');
    expect(messages[1]?.content).toBe('它们的核心区别是什么？');
    expect(messages).toHaveLength(4);
    expect(result).toEqual({
      text: 'list 可变，tuple 不可变。',
      model: 'gpt-answer',
      promptTokens: 11,
      completionTokens: 7,
    });
  });

  it('sends no synthetic system message without context', async () => {
    const fake = await startFake(() => chatReply('好的'));
    await providerFor(fake.baseUrl).chat({ messages: [{ role: 'user', content: '你好' }] });
    const messages = messagesOf(fake.calls[0]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('requires at least one message', async () => {
    const fake = await startFake(() => chatReply('好的'));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).chat({ messages: [] }));
    expect(caught.code).toBe('invalid_request');
    expect(fake.calls).toHaveLength(0);
  });

  it('raises provider_error when the model returns empty content', async () => {
    const fake = await startFake(() => chatReply('   '));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl).chat({ messages: [{ role: 'user', content: '你好' }] }),
    );
    expect(caught.code).toBe('provider_error');
  });

  it('uses OpenAI Responses path, model and capped output tokens', async () => {
    const fake = await startFake(() => ({
      body: { output_text: 'Responses 已解析', model: 'gpt-responses', usage: { input_tokens: 9, output_tokens: 4 } },
    }));
    const provider = providerFor(fake.baseUrl, { protocol: 'openai-responses', maxTokens: 64 });
    const result = await provider.chat({ messages: [{ role: 'user', content: '你好' }], maxOutputTokens: 512 });
    expect(fake.calls[0]?.path).toBe('/responses');
    expect(fake.calls[0]?.authorization).toBe('Bearer sk-test-key');
    expect(fake.calls[0]?.body.model).toBe('gpt-test');
    expect(fake.calls[0]?.body.max_output_tokens).toBe(64);
    expect(fake.calls[0]?.body.input).toEqual([{ role: 'user', content: '你好' }]);
    expect(result).toEqual({ text: 'Responses 已解析', model: 'gpt-responses', promptTokens: 9, completionTokens: 4 });
  });

  it('uses Anthropic Messages path and headers, maps system and output limit', async () => {
    const fake = await startFake(() => ({
      body: { content: [{ type: 'text', text: 'Anthropic 已解析' }], model: 'claude-test', usage: { input_tokens: 8, output_tokens: 3 } },
    }));
    const provider = providerFor(fake.baseUrl, { protocol: 'anthropic-messages', maxTokens: 96 });
    const result = await provider.chat({
      messages: [{ role: 'system', content: '请简短回答' }, { role: 'user', content: '你好' }],
      maxOutputTokens: 512,
    });
    expect(fake.calls[0]?.path).toBe('/v1/messages');
    expect(fake.calls[0]?.apiKey).toBe('sk-test-key');
    expect(fake.calls[0]?.authorization).toBeUndefined();
    expect(fake.calls[0]?.anthropicVersion).toBe('2023-06-01');
    expect(fake.calls[0]?.body.model).toBe('gpt-test');
    expect(fake.calls[0]?.body.max_tokens).toBe(96);
    expect(fake.calls[0]?.body.system).toBe('请简短回答');
    expect(fake.calls[0]?.body.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(result).toEqual({ text: 'Anthropic 已解析', model: 'claude-test', promptTokens: 8, completionTokens: 3 });
  });
});

describe('transport robustness', () => {
  it('succeeds after one HTTP 429', async () => {
    const fake = await startFake((call, index) =>
      index === 0
        ? { status: 429, body: { error: { message: 'Too Many Requests' } } }
        : embeddingReply((call.body.input as unknown[]) ?? [], 3),
    );
    const vectors = await providerFor(fake.baseUrl).embed(['甲知识点']);
    expect(fake.calls).toHaveLength(2);
    expect(vectors).toEqual([[0, 1, 2]]);
  });

  it('maps a sustained 429 to rate_limited', async () => {
    const fake = await startFake(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲知识点']));
    expect(caught.code).toBe('rate_limited');
    expect(fake.calls).toHaveLength(3);
  });

  it('retries 5xx then reports provider_error', async () => {
    const fake = await startFake(() => ({ status: 503, body: { error: { message: 'upstream busy' } } }));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲知识点']));
    expect(caught.code).toBe('provider_error');
    expect(fake.calls).toHaveLength(3);
  });

  it('maps 401 and 403 to unauthorized without retrying', async () => {
    for (const status of [401, 403]) {
      const fake = await startFake(() => ({ status, body: { error: { message: 'Invalid API key' } } }));
      const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲知识点']));
      expect(caught.code).toBe('unauthorized');
      expect(caught.message).toContain('AI_API_KEY');
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('maps a non-retryable 404 to provider_error', async () => {
    const fake = await startFake(() => ({ status: 404, body: { error: { message: 'model not found' } } }));
    const caught = await expectRejection(() => providerFor(fake.baseUrl).embed(['甲知识点']));
    expect(caught.code).toBe('provider_error');
    expect(fake.calls).toHaveLength(1);
  });

  it('maps a timeout to provider_error after the retries', async () => {
    const fake = await startFake(() => ({ status: 200, body: { data: [] }, delayMs: 400 }));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl, { timeoutMs: 40 }).embed(['甲知识点']),
    );
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('超时');
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces AI_REQUEST_TIMEOUT_MS in the timeout message', async () => {
    const fake = await startFake(() => ({ status: 200, body: {}, delayMs: 300 }));
    const caught = await expectRejection(() =>
      providerFor(fake.baseUrl, { timeoutMs: 30 }).chat({
        messages: [{ role: 'user', content: '你好' }],
      }),
    );
    expect(caught.code).toBe('provider_error');
    expect(caught.message).toContain('AI_REQUEST_TIMEOUT_MS');
  });
});
