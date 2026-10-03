/**
 * Search Engine + Conversation Context Engine (V1_DEVELOPMENT §8 POST /api/search, §14.3, §17.2).
 *
 * Search is hybrid and every score is 0..1; context is always localised to a scope and always budgeted.
 */
import { describe, expect, it } from 'vitest';
import { nodeContextSchema, searchResponseSchema } from '@noltri/schema';
import type { ContextScope } from '@noltri/schema';
import type { Harness } from './fakes';
import { attachItemRecord, createNodeRecord, makeHarness } from './fakes';

const TUPLE_ITEM = 'Python 的元组一旦创建就不能修改，因此可以作为字典的键使用。';
const LIST_ITEM = '列表可以随时追加元素，但它不能作为字典的键使用。';
const COFFEE_ITEM = '手冲咖啡的粉水比通常控制在一比十五左右，水温约九十二度。';

interface Library {
  harness: Harness;
  pythonId: string;
  structuresId: string;
  coffeeId: string;
  tupleItemId: string;
}

async function seedLibrary(): Promise<Library> {
  const harness = makeHarness();
  const pythonId = await createNodeRecord(harness, 'Python');
  const structuresId = await createNodeRecord(harness, '数据结构', pythonId);
  const coffeeId = await createNodeRecord(harness, '咖啡');

  const tuple = await attachItemRecord(harness, structuresId, TUPLE_ITEM, {
    sourceType: 'web',
    sourceTitle: 'Python 数据结构笔记',
    sourceUrl: 'https://example.com/python-structures',
  });
  await attachItemRecord(harness, structuresId, LIST_ITEM);
  await attachItemRecord(harness, coffeeId, COFFEE_ITEM);

  return { harness, pythonId, structuresId, coffeeId, tupleItemId: tuple.itemId };
}

describe('hybrid search', () => {
  it('merges the semantic and the keyword channel and marks a both-hit once', async () => {
    const { harness, structuresId, tupleItemId } = await seedLibrary();
    const response = searchResponseSchema.parse(
      await harness.core.search({ query: '元组 不能修改 字典 键', mode: 'hybrid' }, harness.actor),
    );

    expect(response.query).toBe('元组 不能修改 字典 键');
    expect(response.mode).toBe('hybrid');
    expect(response.hits.length).toBeGreaterThan(0);

    const tupleHit = response.hits.find((hit) => hit.itemId === tupleItemId);
    expect(tupleHit?.matchedBy).toBe('both');
    expect(tupleHit?.nodeId).toBe(structuresId);
    expect(tupleHit?.text).toBe(TUPLE_ITEM);
    expect(tupleHit?.source?.sourceUrl).toBe('https://example.com/python-structures');
    expect(tupleHit?.title.length).toBeGreaterThan(0);

    for (const hit of response.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    const scores = response.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((first, second) => second - first));
    // One row per knowledge item, never a duplicate from each channel.
    const itemIds = response.hits.map((hit) => hit.itemId).filter((id): id is string => id !== null);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  it('honours the mode: keyword-only never touches the embedding model, semantic-only never keywords', async () => {
    const { harness, structuresId } = await seedLibrary();

    const embedCallsBefore = harness.provider.embedInputs.length;
    const keyword = searchResponseSchema.parse(
      await harness.core.search({ query: '数据结构', mode: 'keyword' }, harness.actor),
    );
    expect(harness.provider.embedInputs).toHaveLength(embedCallsBefore);
    expect(keyword.hits.every((hit) => hit.matchedBy === 'keyword')).toBe(true);
    // An empty but real topic is findable by name alone.
    const nodeHit = keyword.hits.find((hit) => hit.itemId === null);
    expect(nodeHit?.nodeId).toBe(structuresId);
    expect(nodeHit?.title).toBe('数据结构');
    expect(nodeHit?.source).toBeNull();

    const semantic = searchResponseSchema.parse(
      await harness.core.search({ query: '数据结构', mode: 'semantic' }, harness.actor),
    );
    expect(harness.provider.embedInputs.length).toBeGreaterThan(embedCallsBefore);
    expect(semantic.hits.every((hit) => hit.matchedBy === 'semantic')).toBe(true);
    expect(semantic.hits.every((hit) => hit.itemId !== null)).toBe(true);
  });

  it('honours the limit and defaults to the configured page size', async () => {
    const { harness, structuresId } = await seedLibrary();
    for (let index = 0; index < 4; index += 1) {
      await attachItemRecord(harness, structuresId, `字典键的第 ${String(index)} 条补充笔记，围绕不可变对象的取舍。`);
    }
    const two = await harness.core.search({ query: '字典', limit: 2 }, harness.actor);
    expect(two.hits).toHaveLength(2);

    const all = await harness.core.search({ query: '字典' }, harness.actor);
    expect(all.hits.length).toBeGreaterThan(two.hits.length);
    expect(all.hits.length).toBeLessThanOrEqual(harness.config.searchDefaultLimit);
  });

  it('restricts results to a subtree when a scope node is given', async () => {
    const { harness, coffeeId, structuresId, tupleItemId } = await seedLibrary();
    const inCoffee = await harness.core.search({ query: '字典 键 粉水比', scopeNodeId: coffeeId }, harness.actor);
    expect(inCoffee.hits.length).toBeGreaterThan(0);
    expect(inCoffee.hits.every((hit) => hit.nodeId === coffeeId)).toBe(true);
    expect(inCoffee.hits.some((hit) => hit.itemId === tupleItemId)).toBe(false);

    const inPython = await harness.core.search({ query: '粉水比 字典', scopeNodeId: structuresId }, harness.actor);
    expect(inPython.hits.every((hit) => hit.nodeId === structuresId)).toBe(true);
  });

  it('refuses a blank query', async () => {
    const { harness } = await seedLibrary();
    await expect(harness.core.search({ query: '   ' }, harness.actor)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('node context builder', () => {
  async function contextFor(scope: ContextScope, harness: Harness, nodeId: string, tokenBudget?: number) {
    const built = await harness.core.buildNodeContext(
      { nodeId, scope, ...(tokenBudget === undefined ? {} : { tokenBudget }) },
      harness.actor,
    );
    return { built: nodeContextSchema.parse(built), raw: built };
  }

  it('describes the node and its own items, with a 来源 label per item', async () => {
    const { harness, pythonId, structuresId } = await seedLibrary();
    const { built } = await contextFor('current_node', harness, structuresId);

    expect(built.node.id).toBe(structuresId);
    expect(built.rootNodeId).toBe(pythonId);
    expect(built.ancestors.map((node) => node.title)).toEqual(['Python']);
    expect(built.items.map((item) => item.normalizedText)).toEqual([TUPLE_ITEM, LIST_ITEM]);
    expect(built.children.map((node) => node.title)).toEqual([]);
    expect(built.markdown).toContain('# 知识节点上下文（作用域：当前节点）');
    expect(built.markdown).toContain('路径：Python › 数据结构');
    expect(built.markdown).toContain('来源：网页 · Python 数据结构笔记');
    expect(built.markdown).toContain('## 来源摘录');
    expect(built.markdown).toContain('https://example.com/python-structures');
    expect(built.sources.map((source) => source.rawSourceId)).toHaveLength(2);
    expect(built.truncated).toBe(false);
    expect(built.estimatedTokens).toBeLessThanOrEqual(built.tokenBudget);
    expect(built.tokenBudget).toBeGreaterThan(0);
  });

  it('grows the context with the scope: node, section and tree carry different content', async () => {
    const { harness, pythonId, structuresId } = await seedLibrary();
    const node = await contextFor('current_node', harness, pythonId);
    const section = await contextFor('section', harness, pythonId);
    const tree = await contextFor('tree', harness, pythonId);
    const library = await contextFor('whole_library', harness, pythonId);

    expect(node.built.items).toHaveLength(0);
    expect(node.built.children.map((child) => child.title)).toEqual(['数据结构']);

    // section pulls the child nodes' items in and labels them by their own node.
    expect(section.built.items.map((item) => item.normalizedText)).toEqual([TUPLE_ITEM, LIST_ITEM]);
    expect(section.built.markdown).toContain('（属于：数据结构）');
    expect(section.built.markdown).toContain('## 章节内节点');

    // tree lists the whole tree as structure but keeps the selected node's evidence only.
    expect(tree.built.markdown).toContain('## 本知识树节点总览');
    expect(tree.built.children.map((child) => child.title).sort()).toEqual(['数据结构'].sort());
    expect(tree.built.items).toHaveLength(0);

    // whole_library is an overview, never an export of every item in the library.
    expect(library.built.children.map((child) => child.title).sort()).toEqual(['Python', '咖啡'].sort());
    expect(library.built.items).toHaveLength(0);
    expect(library.built.markdown).not.toContain(COFFEE_ITEM);
    expect(library.built.markdown).toContain('仅结构总览');
    expect(section.built.markdown).not.toBe(tree.built.markdown);
    expect(structuresId.length).toBeGreaterThan(0);
  });

  it('stops filling when the next block would cross the token budget', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, '咖啡');
    const long = '浓缩咖啡的萃取依赖研磨度、粉水比、水温与时间四个变量，任何一个变化都需要重新校准。';
    for (let index = 0; index < 12; index += 1) {
      await attachItemRecord(harness, nodeId, `${long}第 ${String(index)} 条记录。`);
    }

    const unlimited = nodeContextSchema.parse(await harness.core.buildNodeContext({ nodeId, scope: 'current_node' }, harness.actor));
    expect(unlimited.items).toHaveLength(12);
    expect(unlimited.truncated).toBe(false);

    const tight = nodeContextSchema.parse(
      await harness.core.buildNodeContext({ nodeId, scope: 'current_node', tokenBudget: 500 }, harness.actor),
    );
    expect(tight.truncated).toBe(true);
    expect(tight.items.length).toBeGreaterThan(0);
    expect(tight.items.length).toBeLessThan(unlimited.items.length);
    expect(tight.estimatedTokens).toBeLessThanOrEqual(500);
    expect(tight.tokenBudget).toBe(500);
    // The node itself is never dropped, whatever the budget.
    expect(tight.markdown).toContain('节点：咖啡');
    // What survived is the head of the same fill order, not an arbitrary slice.
    expect(unlimited.items.slice(0, tight.items.length).map((item) => item.id)).toEqual(
      tight.items.map((item) => item.id),
    );
  });

  it('keeps a node with no knowledge usable', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, '空节点');
    const built = nodeContextSchema.parse(
      await harness.core.buildNodeContext({ nodeId, scope: 'section' }, harness.actor),
    );
    expect(built.items).toHaveLength(0);
    expect(built.sources).toHaveLength(0);
    expect(built.markdown).toContain('节点：空节点');
    expect(built.truncated).toBe(false);
  });

  it('reports a missing node instead of building empty context', async () => {
    const { harness } = await seedLibrary();
    await expect(
      harness.core.buildNodeContext({ nodeId: 'missing', scope: 'current_node' }, harness.actor),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
