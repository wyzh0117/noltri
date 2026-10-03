/**
 * Pure unit tests for the knowledge tree view model: flattening, expand/collapse, keyboard
 * navigation, descendant counts and node-detail derivation. No DOM, no server, no React.
 *
 * The fixture is deliberately two-level-deep in places and has a zero-item node, because the panel
 * must render both a full node and an empty one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeItem, KnowledgeNode, NodeDetail, NodeSourceSummary, TreeNode } from '@noltri/schema';
import {
  countDistinctSources,
  deriveDetail,
  domainRoots,
  findNodePath,
  flattenTree,
  initialExpandedIds,
  isEmptyTree,
  moveTargetOptions,
  navigateKeyboard,
  sourceLabel,
  subtreeIds,
  subtreeItemCount,
  summarizeTree,
  toExpandedSet,
  toggleExpanded,
  treeStats,
  walkTree,
  withExpanded,
} from '../lib/tree-view';

const NOW = '2026-10-01T08:00:00.000Z';

function node(id: string, title: string, itemCount: number, children: TreeNode[] = [], nodeType = 'concept'): TreeNode {
  return {
    id,
    title,
    nodeType,
    status: 'active',
    confidence: 0.8,
    summary: null,
    itemCount,
    childCount: children.length,
    descendantItemCount: itemCount + children.reduce((total, child) => total + child.descendantItemCount, 0),
    ...(children.length > 0 ? { children } : {}),
  };
}

const TREE: TreeNode[] = [
  node(
    'domain-python',
    'Python',
    0,
    [
      node('topic-structures', '数据结构', 0, [
        node('concept-tuple', 'Tuple 元组', 4),
        // Zero-item node: collapsing counts must not erase it from the tree.
        node('concept-dict-comprehension', '字典推导式', 0),
      ]),
      node('topic-async', '异步编程', 0, [
        node('concept-event-loop', 'asyncio 事件循环', 2),
        node('concept-task-cancel', '协程取消', 1),
      ]),
    ],
    'section',
  ),
  node(
    'domain-management',
    '个人管理',
    0,
    [node('section-reading', '阅读方法', 0, [node('concept-zettel', '卡片笔记法', 2)], 'section')],
    'section',
  ),
];

/** The state these tests start from: both 知识领域 open, every 章节 closed. */
const BASE = toExpandedSet(['domain-python', 'domain-management']);
const BASE_ROWS = ['domain-python', 'topic-structures', 'topic-async', 'domain-management', 'section-reading'];

/* ---------------------------------- flatten ---------------------------------- */

test('flatten: only expanded branches contribute rows', () => {
  assert.deepEqual(flattenTree(TREE, BASE).map((entry) => entry.id), BASE_ROWS);
});

test('flatten: the app default opens domains and sections, hiding nothing in this fixture', () => {
  const appDefault = toExpandedSet(initialExpandedIds(TREE, 1));
  assert.deepEqual(flattenTree(TREE, appDefault).length, walkTree(TREE).length);
  assert.deepEqual(initialExpandedIds(TREE, 0), ['domain-python', 'domain-management']);
});

test('flatten: depth, trail and parent come from the nesting, not the id', () => {
  const opened = toExpandedSet([...BASE, 'topic-structures']);
  const tuple = flattenTree(TREE, opened).find((entry) => entry.id === 'concept-tuple');
  assert.ok(tuple);
  assert.equal(tuple.depth, 2);
  assert.equal(tuple.parentId, 'topic-structures');
  assert.deepEqual(tuple.trail, ['domain-python', 'topic-structures', 'concept-tuple']);
  assert.equal(tuple.hasChildren, false);
  assert.equal(tuple.itemCount, 4);
  assert.equal(tuple.descendantItemCount, 4);
});

test('flatten: a collapsed subtree contributes no rows', () => {
  assert.deepEqual(
    flattenTree(TREE, new Set<string>(['domain-python'])).map((entry) => entry.id),
    ['domain-python', 'topic-structures', 'topic-async', 'domain-management'],
  );
});

test('flatten: an empty tree flattens to nothing and reports empty', () => {
  assert.deepEqual(flattenTree([], new Set<string>()), []);
  assert.equal(isEmptyTree({ nodes: [] }), true);
  assert.equal(isEmptyTree({ nodes: TREE }), false);
});

/* ------------------------------ expand / collapse ---------------------------- */

test('collapse: toggling a section adds and removes only its own children', () => {
  const opened = toggleExpanded(BASE, 'topic-structures');
  const rows = flattenTree(TREE, opened).map((entry) => entry.id);
  assert.ok(rows.includes('concept-tuple'));
  assert.ok(rows.includes('concept-dict-comprehension'));
  assert.ok(!rows.includes('concept-event-loop'), 'sibling subtree must stay closed');
  assert.deepEqual([...toggleExpanded(opened, 'topic-structures')], [...BASE]);
});

test('collapse: withExpanded is idempotent in both directions', () => {
  assert.deepEqual([...withExpanded(BASE, 'domain-python', true)], [...BASE]);
  assert.ok(!withExpanded(BASE, 'domain-python', false).has('domain-python'));
});

/* -------------------------------- keyboard nav ------------------------------- */

test('keyboard: ArrowDown walks visible rows and stops at the last one', () => {
  const rows = flattenTree(TREE, BASE);
  let state = navigateKeyboard(rows, null, 'ArrowDown', BASE);
  assert.equal(state.selectedId, BASE_ROWS[0]);
  for (let step = 0; step < rows.length; step += 1) {
    state = navigateKeyboard(rows, state.selectedId, 'ArrowDown', state.expanded);
  }
  assert.equal(state.selectedId, BASE_ROWS[BASE_ROWS.length - 1]);
});

test('keyboard: ArrowUp mirrors ArrowDown', () => {
  const rows = flattenTree(TREE, BASE);
  const last = rows[rows.length - 1];
  assert.ok(last);
  assert.equal(navigateKeyboard(rows, last.id, 'ArrowUp', BASE).selectedId, rows[rows.length - 2]?.id);
});

test('keyboard: ArrowRight expands in place first, then steps into the first child', () => {
  const rows = flattenTree(TREE, BASE);
  const opened = navigateKeyboard(rows, 'topic-structures', 'ArrowRight', BASE);
  assert.equal(opened.selectedId, 'topic-structures', 'selection must not jump while expanding');
  assert.ok(opened.expanded.has('topic-structures'));

  const stepped = navigateKeyboard(flattenTree(TREE, opened.expanded), 'topic-structures', 'ArrowRight', opened.expanded);
  assert.equal(stepped.selectedId, 'concept-tuple');
});

test('keyboard: ArrowLeft collapses an expanded section before leaving it', () => {
  const opened = toExpandedSet([...BASE, 'topic-structures']);
  const collapsed = navigateKeyboard(flattenTree(TREE, opened), 'topic-structures', 'ArrowLeft', opened);
  assert.equal(collapsed.selectedId, 'topic-structures');
  assert.ok(!collapsed.expanded.has('topic-structures'));
});

test('keyboard: ArrowLeft on a leaf moves to its parent and collapses it', () => {
  const opened = toExpandedSet([...BASE, 'topic-structures']);
  const state = navigateKeyboard(flattenTree(TREE, opened), 'concept-tuple', 'ArrowLeft', opened);
  assert.equal(state.selectedId, 'topic-structures');
  assert.ok(!state.expanded.has('topic-structures'));
});

test('keyboard: a leaf ignores ArrowRight and a closed root ignores ArrowLeft', () => {
  // A visible true leaf: topic-structures opened so concept-tuple is in the rows.
  const opened = toExpandedSet([...BASE, 'topic-structures']);
  const leaf = navigateKeyboard(flattenTree(TREE, opened), 'concept-tuple', 'ArrowRight', opened);
  assert.equal(leaf.selectedId, 'concept-tuple');
  assert.deepEqual([...leaf.expanded].sort(), [...opened].sort());

  const closedRoot = navigateKeyboard(flattenTree(TREE, new Set<string>()), 'domain-python', 'ArrowLeft', new Set<string>());
  assert.equal(closedRoot.selectedId, 'domain-python');
  assert.equal(closedRoot.expanded.size, 0);
});

test('keyboard: Enter keeps the selection and an empty tree stays empty', () => {
  const rows = flattenTree(TREE, BASE);
  assert.equal(navigateKeyboard(rows, 'topic-async', 'Enter', BASE).selectedId, 'topic-async');
  assert.equal(navigateKeyboard(rows, null, 'Enter', BASE).selectedId, 'domain-python');
  assert.equal(navigateKeyboard([], null, 'ArrowDown', new Set<string>()).selectedId, null);
});

/* ---------------------------------- counts --------------------------------- */

test('counts: descendants are summed through collapsed branches', () => {
  const python = findNodePath(TREE, 'domain-python')[0];
  assert.ok(python);
  // 4 (Tuple) + 0 (字典推导式) + 2 (事件循环) + 1 (协程取消)
  assert.equal(subtreeItemCount(python), 7);
  assert.equal(python.descendantItemCount, 7);
  assert.equal((findNodePath(TREE, 'topic-async').at(-1) as TreeNode).descendantItemCount, 3);
  assert.deepEqual(subtreeIds(python), [
    'domain-python',
    'topic-structures',
    'concept-tuple',
    'concept-dict-comprehension',
    'topic-async',
    'concept-event-loop',
    'concept-task-cancel',
  ]);
});

test('counts: summary totals cover hidden nodes too', () => {
  const summary = summarizeTree(TREE);
  assert.equal(summary.nodeCount, 10);
  assert.equal(summary.itemCount, 9);
  assert.equal(summary.domainCount, 2);
});

test('counts: totalNodes from the core wins, otherwise the local walk is used', () => {
  assert.deepEqual(treeStats({ rootId: null, nodes: TREE, totalNodes: 42 }), { nodes: 42, items: 9 });
  assert.equal(treeStats({ rootId: null, nodes: TREE, totalNodes: 0 }).nodes, 10);
});

test('counts: the zero-item node keeps its place in the tree', () => {
  const zero = findNodePath(TREE, 'concept-dict-comprehension').at(-1);
  assert.ok(zero);
  assert.equal(zero.itemCount, 0);
  assert.equal(subtreeItemCount(zero), 0);
  const opened = toExpandedSet([...BASE, 'topic-structures']);
  assert.ok(flattenTree(TREE, opened).some((entry) => entry.id === 'concept-dict-comprehension'));
});

test('rail: 知识领域 is exactly the root nodes', () => {
  assert.deepEqual(domainRoots(TREE).map((entry) => entry.id), ['domain-python', 'domain-management']);
});

/* -------------------------------- move targets ------------------------------- */

test('move targets: the moving subtree is excluded, the current parent is disabled', () => {
  const options = moveTargetOptions(TREE, 'topic-structures', 'domain-python');
  const ids = options.map((option) => option.id);
  assert.ok(ids.includes(null), 'must offer 作为知识领域（顶级）');
  assert.equal(options[0]?.title, '作为知识领域（顶级）');
  assert.equal(options[0]?.disabled, false);
  assert.ok(!ids.includes('concept-tuple'), 'own child must not be a valid parent');
  assert.ok(!ids.includes('concept-dict-comprehension'));
  assert.ok(!ids.includes('topic-structures'), 'the node itself must not be its own parent');
  assert.equal(options.find((option) => option.id === 'domain-python')?.disabled, true);
  assert.ok(ids.includes('topic-async'));
});

test('move targets: a root node cannot be moved to the top level again', () => {
  const options = moveTargetOptions(TREE, 'domain-python', null);
  assert.equal(options[0]?.disabled, true);
  assert.ok(!options.map((option) => option.id).includes('domain-python'));
  assert.equal(options.find((option) => option.id === 'domain-management')?.disabled, false);
});

test('move targets: an unknown node still lists every real node once', () => {
  assert.equal(moveTargetOptions(TREE, 'missing-node', 'missing-parent').length, walkTree(TREE).length + 1);
});

/* ------------------------------- node detail VM ------------------------------ */

function knowledgeNode(id: string, title: string, parentId: string | null): KnowledgeNode {
  return {
    id,
    userId: 'u1',
    title,
    summary: parentId === null ? '从语法到运行时的个人知识库。' : null,
    nodeType: 'concept',
    parentId,
    status: 'active',
    confidence: 0.8,
    embeddingModel: 'offline-v1',
    masteryLevel: 'organized',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function item(id: string, text: string): KnowledgeItem {
  return {
    id,
    userId: 'u1',
    rawSourceId: `source-${id}`,
    normalizedText: text,
    summary: null,
    confidence: 0.74,
    status: 'active',
    isAiDerived: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function source(rawSourceId: string, overrides: Partial<NodeSourceSummary> = {}): NodeSourceSummary {
  return {
    rawSourceId,
    sourceType: 'web',
    sourcePlatform: 'docs.python.org',
    sourceApp: null,
    sourceTitle: 'tuple — Python 官方文档',
    sourceUrl: 'https://docs.python.org/3/library/stdtypes.html#tuple',
    capturedAt: NOW,
    ...overrides,
  };
}

const TUPLE_DETAIL: NodeDetail = {
  node: knowledgeNode('concept-tuple', 'Tuple 元组', 'topic-structures'),
  path: [
    { id: 'domain-python', title: 'Python' },
    { id: 'topic-structures', title: '数据结构' },
    { id: 'concept-tuple', title: 'Tuple 元组' },
  ],
  items: [
    { item: item('item-1', 'tuple 是不可变序列。'), sources: [source('source-docs')] },
    { item: item('item-2', 'tuple 可哈希，能当 dict 的键。'), sources: [source('source-docs')] },
    {
      item: item('item-3', '不可变记录优先用 tuple。'),
      sources: [source('source-chat', { sourcePlatform: null, sourceApp: 'ChatGPT', sourceUrl: null })],
    },
    { item: item('item-4', '单元素 tuple 要写成 (value,)。'), sources: [] },
  ],
  children: [knowledgeNode('concept-tuple-child', '子节点示例', 'concept-tuple')],
  relatedNodes: [
    {
      node: knowledgeNode('concept-dict-comprehension', '字典推导式', 'topic-structures'),
      relationType: 'prerequisite_of',
      confidence: 0.71,
    },
    { node: knowledgeNode('concept-event-loop', 'asyncio 事件循环', 'topic-async'), relationType: 'similar_to', confidence: null },
  ],
  stats: { itemCount: 4, sourceCount: 2, childCount: 1 },
};

const EMPTY_DETAIL: NodeDetail = {
  node: knowledgeNode('concept-dict-comprehension', '字典推导式', 'topic-structures'),
  path: [
    { id: 'domain-python', title: 'Python' },
    { id: 'topic-structures', title: '数据结构' },
    { id: 'concept-dict-comprehension', title: '字典推导式' },
  ],
  items: [],
  children: [],
  relatedNodes: [],
  stats: { itemCount: 0, sourceCount: 0, childCount: 0 },
};

test('detail: counts, breadcrumb and item sources come straight from the contract', () => {
  const view = deriveDetail(TUPLE_DETAIL);
  assert.equal(view.title, 'Tuple 元组');
  assert.equal(view.breadcrumbText, 'Python / 数据结构 / Tuple 元组');
  assert.equal(view.itemCount, 4);
  assert.equal(view.sourceCount, 2);
  assert.equal(view.childCount, 1);
  assert.equal(view.hasItems, true);
  assert.equal(view.items.length, 4);
  assert.equal(view.items[0]?.text, 'tuple 是不可变序列。');
  assert.equal(view.items[0]?.sources[0]?.label, 'tuple — Python 官方文档');
  assert.equal(view.items[3]?.sources.length, 0, 'an item without sources must still render');
  assert.equal(view.status, 'active');
  assert.equal(view.hasSummary, false);
});

test('detail: related nodes carry a readable relation label', () => {
  const view = deriveDetail(TUPLE_DETAIL);
  assert.deepEqual(
    view.related.map((entry) => `${entry.title}·${entry.relationLabel}`),
    ['字典推导式·是…的前置', 'asyncio 事件循环·相似'],
  );
  assert.equal(view.related[1]?.confidence, null);
});

test('detail: a zero-item node yields a renderable view, never a blank panel', () => {
  const view = deriveDetail(EMPTY_DETAIL);
  assert.equal(view.hasItems, false);
  assert.equal(view.itemCount, 0);
  assert.equal(view.sourceCount, 0);
  assert.equal(view.items.length, 0);
  assert.equal(view.children.length, 0);
  assert.equal(view.related.length, 0);
  assert.equal(view.title, '字典推导式');
  assert.equal(view.breadcrumb.length, 3);
  assert.equal(view.hasSummary, false, 'a null summary must not render as the string null');
  assert.equal(view.summary, '');
});

test('detail: 来源数 equals the distinct sources behind the items', () => {
  assert.equal(countDistinctSources(TUPLE_DETAIL), TUPLE_DETAIL.stats.sourceCount);
  assert.equal(countDistinctSources(EMPTY_DETAIL), 0);
});

test('detail: source label falls back to platform, then to an honest placeholder', () => {
  assert.equal(sourceLabel(source('s1')), 'tuple — Python 官方文档');
  assert.equal(
    sourceLabel(source('s2', { sourceTitle: '   ', sourcePlatform: null, sourceApp: 'ChatGPT' })),
    'ChatGPT 来源',
  );
  assert.equal(sourceLabel(source('s3', { sourceTitle: null, sourcePlatform: null, sourceApp: null })), '未命名来源');
});
