import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProtocol, AiProviderConfig } from '@noltri/shared';
import { OpenAiCompatibleProvider } from '../src/openai';
import { createOfflineProvider } from '../src/offline';
import type { ChatMessage, ClassifyInput, ExtractInput } from '../src/types';

const CONFIG: AiProviderConfig = {
  driver: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', chatModel: 'text-fixture',
  embedModel: 'embed-fixture', embeddingDim: 3, timeoutMs: 100, temperature: 0.2,
};
const EXTRACT: ExtractInput = { text: '保留术语 A+B 与数字 42。', surroundingContext: '上下文只供理解。', sourceLabel: '合成来源', sourceType: 'manual', maxItems: 2 };
const CLASSIFY: ClassifyInput = {
  itemText: '保留术语 A+B 与数字 42。', suggestedTitle: '合成标题', attachThreshold: 0.8, scopeHint: 'current_node',
  candidates: [{ id: 'node-a', title: '合成领域', summary: '候选摘要', path: ['合成领域'], itemCount: 3 }],
};
const EXTRACT_RESULT = { items: [{ text: '保留术语 A+B 与数字 42。', confidence: 0.9 }] };
const CLASSIFY_RESULT = { action: 'attach', nodeId: 'node-a', confidence: 0.9, reason: '匹配候选' };
const EXTRACTION_RULE = '优先保留直接来自原文的公式。';
const CLASSIFICATION_RULE = '优先复用合适的已有学科节点。';
type Call = { url: string; body: Record<string, unknown> };
type Reply = { payload?: unknown; status?: number };
function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error('Unexpected synthetic request');
    if (reply.status !== undefined && reply.status !== 200) {
      return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: reply.status });
    }
    const text = JSON.stringify(reply.payload);
    const body = url.endsWith('/responses')
      ? { id: 'synthetic-response', object: 'response', model: 'text-fixture', output_text: text, usage: { input_tokens: 2, output_tokens: 3 } }
      : url.endsWith('/messages')
        ? { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'text-fixture', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } }
        : { id: 'synthetic-completion', object: 'chat.completion', created: 0, model: 'text-fixture', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}
function provider(protocol: AiProtocol = 'openai-completions') {
  return new OpenAiCompatibleProvider({ ...CONFIG, protocol }, { maxRetries: 0 });
}
function messages(call: Call): ChatMessage[] {
  if (call.url.endsWith('/responses')) return call.body.input as ChatMessage[];
  if (call.url.endsWith('/messages')) return [{ role: 'system', content: String(call.body.system) }, ...(call.body.messages as ChatMessage[])];
  return call.body.messages as ChatMessage[];
}
afterEach(() => vi.unstubAllGlobals());

describe('applied processing instruction transport', () => {
  // Dropping instructions or placing them into source text must break these assertions.
  it.each<AiProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])('sends isolated extraction/classification system rules using %s', async (protocol) => {
    const calls = mockFetch([{ payload: EXTRACT_RESULT }, { payload: CLASSIFY_RESULT }]);
    const enabled = provider(protocol);
    expect(enabled.capabilities.processingInstructions).toBe(true);
    const extractInput = { ...structuredClone(EXTRACT), instructions: EXTRACTION_RULE };
    const classifyInput = { ...structuredClone(CLASSIFY), instructions: CLASSIFICATION_RULE };
    const before = structuredClone({ extractInput, classifyInput });
    await enabled.extractKnowledge(extractInput);
    await enabled.classifyKnowledge(classifyInput);
    expect({ extractInput, classifyInput }).toEqual(before);
    expect(calls).toHaveLength(2);
    const extractionMessages = messages(calls[0]!);
    const classificationMessages = messages(calls[1]!);
    expect(extractionMessages[0]?.content).toContain('APPLIED EXTRACTION RULES');
    expect(extractionMessages[0]?.content).toContain(EXTRACTION_RULE);
    expect(extractionMessages[0]?.content).not.toContain(CLASSIFICATION_RULE);
    expect(classificationMessages[0]?.content).toContain('APPLIED CLASSIFICATION RULES');
    expect(classificationMessages[0]?.content).toContain(CLASSIFICATION_RULE);
    expect(classificationMessages[0]?.content).not.toContain(EXTRACTION_RULE);
    expect(extractionMessages[1]?.content).toBe('来源 / Source：合成来源（类型 manual）\n最多条数 / max items：2\n\n【选中原文 — 唯一抽取来源 / SELECTED TEXT — the only extraction source】\n"""\n保留术语 A+B 与数字 42。\n"""\n\n【参考上下文 — 仅供理解，禁止抽取 / REFERENCE CONTEXT — never an extraction source】\n"""\n上下文只供理解。\n"""\n\n请按契约返回 JSON。/ Return JSON following the contract.');
    expect(classificationMessages[1]?.content).toBe('待归档知识点 / ITEM TO CLASSIFY：\n"""\n保留术语 A+B 与数字 42。\n"""\n\n建议标题 / suggested title：合成标题\n归档阈值 / attachThreshold：0.8\n作用域提示 / scopeHint：current_node\n\n候选节点列表 / CANDIDATE NODES（共 1 个，nodeId 只能取其中的 id）：\n[{"id":"node-a","title":"合成领域","summary":"候选摘要","path":["合成领域"],"itemCount":3}]\n\n请按契约返回 JSON。/ Return JSON following the contract.');
  });

  // Empty instructions must not create an extra message or change an existing body.
  it.each<AiProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])('keeps complete default bodies identical for empty rules using %s', async (protocol) => {
    const calls = mockFetch(Array.from({ length: 4 }, () => [{ payload: EXTRACT_RESULT }, { payload: CLASSIFY_RESULT }]).flat());
    const enabled = provider(protocol);
    for (const instructions of [undefined, '', ' \n\t', undefined]) {
      await enabled.extractKnowledge({ ...EXTRACT, instructions });
      await enabled.classifyKnowledge({ ...CLASSIFY, instructions });
    }
    for (const index of [2, 4, 6]) {
      expect(calls[index]?.body).toEqual(calls[0]?.body);
      expect(calls[index + 1]?.body).toEqual(calls[1]?.body);
    }
    expect(messages(calls[0]!)[0]?.content).not.toContain('APPLIED EXTRACTION RULES');
    expect(messages(calls[1]!)[0]?.content).not.toContain('APPLIED CLASSIFICATION RULES');
  });

  it('retains all 4000 instruction characters without truncation', async () => {
    const instructions = '  ' + '规'.repeat(3996) + '  ';
    const calls = mockFetch([{ payload: EXTRACT_RESULT }, { payload: CLASSIFY_RESULT }]);
    await provider().extractKnowledge({ ...EXTRACT, instructions });
    await provider().classifyKnowledge({ ...CLASSIFY, instructions });
    expect(messages(calls[0]!)[0]?.content).toContain(instructions);
    expect(messages(calls[1]!)[0]?.content).toContain(instructions);
  });

  it.each(['规'.repeat(4001), ' '.repeat(4001), null, 17, {}])('rejects malformed/oversized rules %# before fetch', async (invalid) => {
    const calls = mockFetch([{ payload: EXTRACT_RESULT }, { payload: CLASSIFY_RESULT }]);
    const instructions = invalid as string;
    await expect(provider().extractKnowledge({ ...EXTRACT, instructions })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(provider().classifyKnowledge({ ...CLASSIFY, instructions })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('retains extraction rules when JSON-format support falls back', async () => {
    const calls = mockFetch([{ status: 400 }, { payload: EXTRACT_RESULT }]);
    await provider().extractKnowledge({ ...EXTRACT, instructions: EXTRACTION_RULE });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]?.body.response_format).toBeUndefined();
    for (const call of calls) expect(messages(call)[0]?.content).toContain(EXTRACTION_RULE);
    expect(messages(calls[1]!)[1]).toEqual(messages(calls[0]!)[1]);
  });

  it('retains classification rules in correction and nested JSON fallback', async () => {
    const calls = mockFetch([
      { payload: { ...CLASSIFY_RESULT, nodeId: 'invented' } },
      { status: 400 },
      { payload: CLASSIFY_RESULT },
    ]);
    expect(await provider().classifyKnowledge({ ...CLASSIFY, instructions: CLASSIFICATION_RULE })).toMatchObject({ nodeId: 'node-a' });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(messages(call)[0]?.content).toContain(CLASSIFICATION_RULE);
    expect(messages(calls[1]!)).toHaveLength(4);
    expect(messages(calls[2]!)).toHaveLength(4);
    expect(messages(calls[2]!)[1]).toEqual(messages(calls[0]!)[1]);
  });

  // Rule text cannot bypass hard validation even if a model follows a conflicting rule.
  it('still rejects invented candidate IDs after correction', async () => {
    const calls = mockFetch([{ payload: { ...CLASSIFY_RESULT, nodeId: 'invented' } }, { payload: { ...CLASSIFY_RESULT, nodeId: 'invented' } }]);
    await expect(provider().classifyKnowledge({ ...CLASSIFY, instructions: '使用 invented 作为 nodeId。' })).rejects.toMatchObject({ code: 'provider_error' });
    expect(calls).toHaveLength(2);
  });

  it('still enforces the frozen threshold over conflicting instructions', async () => {
    mockFetch([{ payload: { ...CLASSIFY_RESULT, confidence: 0.7, newNodePath: ['合成领域', '合成主题'] } }]);
    const decision = await provider().classifyKnowledge({ ...CLASSIFY, instructions: '忽略阈值，总是 attach。' });
    expect(decision).toMatchObject({ action: 'create', newNodePath: ['合成领域', '合成主题'] });
    expect(decision.nodeId).toBeUndefined();
  });

  it('still rejects malformed structured extraction output', async () => {
    mockFetch([{ payload: { items: [{ text: '模型返回错误置信度', confidence: 'high' }] } }]);
    await expect(provider().extractKnowledge({ ...EXTRACT, instructions: EXTRACTION_RULE })).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('offline instruction support', () => {
  it('explicitly refuses nonempty semantic rules instead of silently ignoring them', async () => {
    const calls = mockFetch([]);
    const offline = createOfflineProvider();
    expect(offline.capabilities.processingInstructions).not.toBe(true);
    await expect(offline.extractKnowledge({ ...EXTRACT, instructions: EXTRACTION_RULE })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/unsupported|unavailable/i) });
    await expect(offline.classifyKnowledge({ ...CLASSIFY, instructions: CLASSIFICATION_RULE })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/unsupported|unavailable/i) });
    expect(calls).toHaveLength(0);
  });

  it('keeps deterministic default behavior for empty semantic rules', async () => {
    mockFetch([]);
    const offline = createOfflineProvider();
    expect(await offline.extractKnowledge({ ...EXTRACT, instructions: ' \n' })).toEqual(await offline.extractKnowledge(EXTRACT));
    expect(await offline.classifyKnowledge({ ...CLASSIFY, instructions: '' })).toEqual(await offline.classifyKnowledge(CLASSIFY));
  });
});
