import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphNoteIndexEntry, TreeNode } from '@noltri/schema';
import { GraphNotebook } from './GraphNotebook';
import { commitLatestNavigation, contentIdentity, disciplineScopesForTopics, graphChapterAttachment, graphChapterTitle, NavigationIntentClock, searchGraphNodes, selectionForTreeNode, shouldReuseActiveNote } from './graph-navigation';

function treeNode(id: string, nodeType: string, children: TreeNode[] = []): TreeNode {
  return {
    id,
    title: id,
    nodeType,
    status: 'active',
    confidence: null,
    summary: null,
    itemCount: 0,
    descendantItemCount: 0,
    childCount: children.length,
    children,
  };
}

describe('graph navigation mapping', () => {
  it('routes chapters to their actual parent topic and keeps its discipline scope', () => {
    const tree = [treeNode('d1', 'discipline', [treeNode('s1', 'subdiscipline', [
      treeNode('t1', 'topic', [treeNode('c1', 'chapter')]),
    ])])];

    expect(selectionForTreeNode(tree, 'c1')).toEqual({
      path: [tree[0], tree[0]!.children![0], tree[0]!.children![0]!.children![0], tree[0]!.children![0]!.children![0]!.children![0]],
      scope: { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' },
      content: { kind: 'chapter', topicId: 't1', chapterId: 'c1' },
    });
  });

  it('maps parentless shared-chapter associations back to one existing discipline scope', () => {
    const tree = [treeNode('cs', 'discipline', [treeNode('programming', 'subdiscipline', [
      treeNode('python', 'topic'), treeNode('cpp', 'topic'), treeNode('c', 'topic'),
    ])]), treeNode('shared', 'chapter')];

    expect(selectionForTreeNode(tree, 'shared')).toBeNull();
    expect(disciplineScopesForTopics(tree, ['python', 'cpp', 'c'])).toEqual([
      { kind: 'discipline', disciplineId: 'cs' },
    ]);
  });

  it('uses the real title for a parentless chapter and scopes detached status to its topic', () => {
    const tree = [treeNode('cs', 'discipline', [treeNode('programming', 'subdiscipline', [
      treeNode('cpp', 'topic'), treeNode('c', 'topic'),
    ])]), treeNode('variable', 'chapter')];
    const notes: GraphNoteIndexEntry[] = [
      { topicId: 'cpp', chapterId: 'variable', chapterTitle: '变量', updatedAt: '2026-10-20T00:00:00.000Z', attached: true },
      { topicId: 'c', chapterId: 'variable', chapterTitle: '变量', updatedAt: '2026-10-20T00:00:00.000Z', attached: false },
    ];

    expect(graphChapterTitle('cpp', 'variable', [], tree, notes)).toBe('变量');
    expect(graphChapterAttachment(notes, 'cpp', 'variable')).toBe('attached');
    expect(graphChapterAttachment(notes, 'c', 'variable')).toBe('detached');
    expect(graphChapterAttachment(notes, 'python', 'variable')).toBeNull();
    expect(graphChapterTitle('python', 'missing', [], [], [])).toBe('章节正文');
  });

  it('uses stable identities for per-scope cards and per-note history', () => {
    expect(contentIdentity({ kind: 'cards', scope: { kind: 'discipline', disciplineId: 'd1' }, selectedNodeId: 'd1' })).toBe('cards:discipline:d1');
    expect(contentIdentity({ kind: 'topic', topicId: 't1' })).toBe('note:["t1",null]');
    expect(contentIdentity({ kind: 'chapter', topicId: 't1', chapterId: 'c1' })).toBe('note:["t1","c1"]');
  });

  it('renders one continuous course without an independent chapter directory', () => {
    const html=renderToStaticMarkup(createElement(GraphNotebook,{markdown:'# Python\n\n## 变量\n\n课程正文\n\n### 动态类型\n\n独立内容',mode:'reading',onChange:()=>{},onSelect:()=>{},onComposition:()=>{},onLink:()=>{},completions:[],offset:0}));
    expect(html).toContain('<h1>Python</h1>');
    expect(html).toContain('<h2>变量</h2>');
    expect(html).toContain('<h3>动态类型</h3>');
    expect(html).not.toContain('chapter-directory');
    expect(html).not.toContain('note-writing-area');
  });

  it('does not reload a note with the same identity unless an explicit retry asks for it', () => {
    const identity = { topicId: 'topic-a', chapterId: 'chapter-a' };
    expect(shouldReuseActiveNote(identity, { ...identity })).toBe(true);
    expect(shouldReuseActiveNote(identity, { ...identity, chapterId: 'chapter-b' })).toBe(false);
    expect(shouldReuseActiveNote(identity, { ...identity }, true)).toBe(false);
  });

  it('drops an older async navigation result after a newer navigation intent begins', async () => {
    const clock = new NavigationIntentClock();
    const olderIntent = clock.begin();
    let finish: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const committed: string[] = [];
    const completion = commitLatestNavigation(clock, olderIntent, pending, (value) => { committed.push(value); });

    clock.begin();
    finish?.('chapter-a');

    await expect(completion).resolves.toBe(false);
    expect(committed).toEqual([]);
  });

  it('finds a shared chapter from the complete scoped graph even when its tree parent is elsewhere', () => {
    const graphSelectionNodes: GraphNode[] = [
      { id: 'topic-a', title: '范围 A', nodeType: 'topic', parentId: 'sub-a', summary: null },
      { id: 'shared-chapter', title: '跨范围章节', nodeType: 'chapter', parentId: 'sub-b', summary: '由真实 part_of 关系纳入范围 A' },
    ];
    const renderedGraphWindow = graphSelectionNodes.slice(0, 1);

    expect(searchGraphNodes(graphSelectionNodes, '跨范围')).toMatchObject([
      { nodeId: 'shared-chapter', title: '跨范围章节', itemId: null },
    ]);
    expect(searchGraphNodes(renderedGraphWindow, '跨范围')).toEqual([]);
  });
});
