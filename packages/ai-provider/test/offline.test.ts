import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '@noltri/shared';
import { OfflineDeterministicProvider, createOfflineProvider } from '../src/offline';
import type { ClassificationCandidate } from '../src/types';

const CANDIDATES: ClassificationCandidate[] = [
  {
    id: 'node-python-list',
    title: 'Python 列表',
    summary: '可变序列，支持 append 原地修改',
    path: ['编程', 'Python'],
    itemCount: 4,
  },
  { id: 'node-rust-ownership', title: 'Rust 所有权', summary: null, path: ['编程', 'Rust'], itemCount: 1 },
];

describe('offline provider identity', () => {
  it('exposes a stable id and no structured-output claim', () => {
    const provider = new OfflineDeterministicProvider();
    expect(provider.id).toBe('offline');
    expect(provider.capabilities).toEqual({ embeddings: true, chat: true, structuredOutput: false });
  });

  it('defaults to the same 1536 dimensions as AI_EMBEDDING_DIM', async () => {
    expect((await new OfflineDeterministicProvider().embed(['任意知识点']))[0]).toHaveLength(1536);
    expect((await createOfflineProvider({ embeddingDim: 8 }).embed(['任意知识点']))[0]).toHaveLength(8);
  });
});

describe('embed determinism', () => {
  it('maps the same input to the same vector', async () => {
    const provider = new OfflineDeterministicProvider({ embeddingDim: 16 });
    const first = await provider.embed(['Python 的 list 是可变序列，支持 append 原地修改。']);
    const second = await provider.embed(['Python 的 list 是可变序列，支持 append 原地修改。']);
    expect(first).toEqual(second);
    const vector = first[0] ?? [];
    expect(vector).toHaveLength(16);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 6);
    expect(await provider.embed([])).toEqual([]);
  });

  it('is insensitive to case and whitespace but separates different topics', async () => {
    const provider = new OfflineDeterministicProvider({ embeddingDim: 32 });
    const [rust, python, pythonRephrased] = await provider.embed([
      'Rust 的所有权规则在编译期检查借用',
      'python 的 LIST 可变序列',
      'Python 的 list 可变序列',
    ]);
    expect(python).toEqual(pythonRephrased);
    expect(rust).not.toEqual(python);
    expect(cosineSimilarity(python ?? [], pythonRephrased ?? [])).toBeCloseTo(1, 6);
    expect(cosineSimilarity(rust ?? [], python ?? [])).toBeLessThan(0.5);
  });
});

describe('extractKnowledge', () => {
  const TEXT =
    '列表推导式是语法糖。生成器表达式用 yield 惰性产出值，适合处理 range(1000) 这样的大序列而不占用额外内存。async def stream(): await fetch(url)';

  it('splits the source into one item per sentence', async () => {
    const result = await new OfflineDeterministicProvider().extractKnowledge({
      text: TEXT,
      sourceLabel: '网页：Python 官方文档',
      sourceType: 'web',
    });
    expect(result.items.map((item) => item.text)).toEqual([
      '列表推导式是语法糖',
      '生成器表达式用 yield 惰性产出值，适合处理 range(1000) 这样的大序列而不占用额外内存',
      'async def stream(): await fetch(url)',
    ]);
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(['confidence', 'suggestedTitle', 'summary', 'text']);
      expect(item.summary).toBe(item.text);
      expect((item.suggestedTitle ?? '').length).toBeGreaterThan(0);
      expect((item.suggestedTitle ?? '').length).toBeLessThanOrEqual(28);
      expect(item.confidence).toBeGreaterThan(0);
      expect(item.confidence).toBeLessThanOrEqual(0.95);
      expect(item.confidence).toBe(Number(item.confidence.toFixed(2)));
    }
    const [short, long, code] = result.items;
    expect((long?.confidence ?? 0)).toBeGreaterThan(short?.confidence ?? 1);
    expect((code?.confidence ?? 0)).toBeGreaterThan(long?.confidence ?? 0);
  });

  it('honours maxItems', async () => {
    const result = await new OfflineDeterministicProvider().extractKnowledge({
      text: TEXT,
      sourceLabel: '手动录入',
      sourceType: 'manual',
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.text).toContain('yield');
  });

  it('returns no items for empty text', async () => {
    expect(
      (
        await new OfflineDeterministicProvider().extractKnowledge({
          text: '   ',
          sourceLabel: '手动录入',
          sourceType: 'manual',
        })
      ).items,
    ).toEqual([]);
  });
});

describe('classifyKnowledge', () => {
  const ITEM = 'Python 的 list 是可变序列，append 会原地修改同一个对象';

  it('attaches when the best similarity clears the threshold', async () => {
    const decision = await new OfflineDeterministicProvider().classifyKnowledge({
      itemText: ITEM,
      candidates: CANDIDATES,
      attachThreshold: 0.2,
    });
    expect(decision.action).toBe('attach');
    expect(decision.nodeId).toBe('node-python-list');
    expect(decision.reason).toContain('Python 列表');
    expect(decision.confidence).toBeGreaterThan(0.2);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('creates instead of attaching once the threshold rises above the similarity', async () => {
    const decision = await new OfflineDeterministicProvider().classifyKnowledge({
      itemText: ITEM,
      suggestedTitle: 'Python 列表可变性',
      candidates: CANDIDATES,
      attachThreshold: 0.99,
    });
    expect(decision.action).toBe('create');
    expect(decision.nodeId).toBeUndefined();
    expect(decision.newNodeTitle).toBe('Python 列表可变性');
    expect(decision.newNodePath?.at(-1)).toBe('Python 列表可变性');
    expect(decision.reason).toContain('低于归档阈值');
  });

  it('creates a node for an unrelated item and keeps the confidence low', async () => {
    const decision = await new OfflineDeterministicProvider().classifyKnowledge({
      itemText: '光栅扫描显示器的刷新率决定画面稳定性',
      candidates: CANDIDATES,
      attachThreshold: 0.5,
    });
    expect(decision.action).toBe('create');
    expect(decision.confidence).toBeLessThan(0.5);
    const path = decision.newNodePath ?? [];
    expect(path.length).toBeGreaterThanOrEqual(1);
    expect(path.at(-1)).toBe(decision.newNodeTitle);
  });

  it('picks the most similar candidate rather than the first one', async () => {
    const decision = await new OfflineDeterministicProvider().classifyKnowledge({
      itemText: 'Rust 的所有权规则在编译期检查借用',
      candidates: CANDIDATES,
      attachThreshold: 0.2,
    });
    expect(decision.action).toBe('attach');
    expect(decision.nodeId).toBe('node-rust-ownership');
    expect(decision.reason).toContain('Rust 所有权');
  });

  it('creates with a self-reported reason when no candidate exists', async () => {
    const decision = await new OfflineDeterministicProvider().classifyKnowledge({
      itemText: '任意知识点内容',
      candidates: [],
      attachThreshold: 0.5,
    });
    expect(decision.action).toBe('create');
    expect(decision.reason).toContain('还没有可比较的节点');
    expect(decision.confidence).toBe(0.2);
  });
});

describe('chat', () => {
  it('labels the offline reply and echoes the assembled context', async () => {
    const result = await new OfflineDeterministicProvider().chat({
      messages: [
        { role: 'user', content: '这个节点的核心结论是什么？' },
        { role: 'assistant', content: '列表可变，元组不可变。' },
        { role: 'user', content: '再举一个例子' },
      ],
      systemContext: 'abc',
      scope: 'tree',
    });
    expect(result.model).toBe('offline-deterministic');
    expect(result.text).toContain('本地离线 Provider');
    expect(result.text).toContain('已装载上下文：3 个字符');
    expect(result.text).toContain('作用域 tree');
    expect(result.text).toContain('再举一个例子');
  });

  it('marks a missing question and defaults the scope', async () => {
    const result = await new OfflineDeterministicProvider().chat({
      messages: [{ role: 'assistant', content: '只有助手发言' }],
    });
    expect(result.text).toContain('问题：(无)');
    expect(result.text).toContain('作用域 current_node');
  });
});
