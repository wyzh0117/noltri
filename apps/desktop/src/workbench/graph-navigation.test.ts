import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, GraphNoteIndexEntry, NodeDetail, TreeNode } from '@noltri/schema';
import { ChapterChoicePanel, GraphNotebook } from './GraphNotebook';
import type { GraphNotebookProps } from './GraphNotebook';
import { addTopicPathReference, commitLatestNavigation, contentIdentity, contextualChapterPath, contextualChapterSelectionId, contextualTopicPath, disciplineScopesForTopics, findTreePath, graphChapterAttachment, graphChapterTitle, graphContextScopeForTopic, graphPanelScopeIdentity, graphScopeForContent, NavigationIntentClock, searchGraphNodes, selectionForTreeNode, shouldReuseActiveNote } from './graph-navigation';

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
  it('routes discipline, subdiscipline, and deeper domain roots into their own scopes', () => {
    const tree = [treeNode('d1', 'discipline', [treeNode('s1', 'subdiscipline', [
      treeNode('domain-3', 'domain', [treeNode('t1', 'topic')]),
    ])])];

    expect(selectionForTreeNode(tree, 'd1')?.scope).toEqual({ kind: 'discipline', disciplineId: 'd1' });
    expect(selectionForTreeNode(tree, 's1')?.scope).toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's1' });
    expect(selectionForTreeNode(tree, 'domain-3')?.scope).toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 'domain-3' });
    expect(selectionForTreeNode(tree, 'domain-3')?.content).toEqual({ kind: 'cards', scope: { kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 'domain-3' }, selectedNodeId: 'domain-3' });
  });

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

  it('keeps a two-level topic path as a topic-scoped card page while reserving subdiscipline scope for actual branches', () => {
    const tree = [treeNode('d1', 'discipline', [
      treeNode('manual-topic', 'topic'),
      treeNode('s1', 'subdiscipline', [treeNode('branch-topic', 'topic')]),
    ])];

    const topicRoute = selectionForTreeNode(tree, 'manual-topic');
    const branchRoute = selectionForTreeNode(tree, 's1');
    const nestedTopicRoute = selectionForTreeNode(tree, 'branch-topic');
    expect(topicRoute).toMatchObject({
      scope: { kind: 'topic', disciplineId: 'd1', anchorTopicId: 'manual-topic' },
      content: { kind: 'cards', selectedNodeId: 'manual-topic' },
    });
    expect(topicRoute === null ? null : graphScopeForContent(topicRoute.content, null, tree)).toEqual(topicRoute?.scope);
    expect(branchRoute?.scope).toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's1' });
    expect(nestedTopicRoute?.scope).toEqual({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 'branch-topic' });
  });

  it('restores the local Graph focus from the current content after whole-discipline navigation', () => {
    const tree = [treeNode('d1', 'discipline', [treeNode('s1', 'subdiscipline', [
      treeNode('t1', 'topic', [treeNode('c1', 'chapter')]), treeNode('t2', 'topic'),
    ])])];
    const wholeScope = { kind: 'discipline', disciplineId: 'd1' } as const;

    expect(graphScopeForContent({ kind: 'topic', topicId: 't2' }, wholeScope, tree))
      .toEqual({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 't2' });
    expect(graphScopeForContent({ kind: 'chapter', topicId: 't1', chapterId: 'c1' }, wholeScope, tree))
      .toEqual({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' });
    expect(graphScopeForContent({ kind: 'topic', topicId: 't1' }, { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't2' }, tree))
      .toEqual({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' });
    expect(graphScopeForContent({ kind: 'cards', scope: { kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's1' }, selectedNodeId: 's1' }, wholeScope, tree))
      .toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's1' });
    expect(graphScopeForContent({ kind: 'library' }, wholeScope, tree)).toBeNull();
  });

  it('adds a display reference for the same shared topic only when the active scope confirms that path', () => {
    const tree = [treeNode('d1', 'discipline', [
      treeNode('s1', 'subdiscipline', [treeNode('shared-topic', 'topic')]),
      treeNode('s2', 'subdiscipline'),
    ])];
    const edge: GraphEdge = { id: 'shared-s2', fromNodeId: 'shared-topic', toNodeId: 's2', relationType: 'part_of', source: 'fixture' };
    const activeScope = { kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's2' } as const;

    const referenced = addTopicPathReference(tree, activeScope, 'shared-topic', [edge]);
    const reference = referenced[0]?.children?.[1]?.children?.[0];
    expect(reference).toMatchObject({ id: 'shared-topic', referenceScope: activeScope });
    expect(reference?.children).toBeUndefined();
    expect(findTreePath(tree, 'shared-topic')?.map(({ id }) => id)).toEqual(['d1', 's1', 'shared-topic']);
    expect(findTreePath([referenced[0]!.children![1]!], 'shared-topic')?.map(({ id }) => id)).toEqual(['s2', 'shared-topic']);
    expect(addTopicPathReference(tree, activeScope, 'shared-topic', [])).toBe(tree);
    expect(addTopicPathReference(tree, { kind: 'discipline', disciplineId: 'd1' }, 'shared-topic', [edge])).toBe(tree);
  });

  it('keeps the deepest visible direction as context for a topic', () => {
    const tree = [treeNode('d1', 'discipline', [
      treeNode('s1', 'subdiscipline', [treeNode('t1', 'topic')]),
      treeNode('s2', 'subdiscipline', [treeNode('domain', 'domain', [treeNode('t2', 'topic')])]),
      treeNode('t3', 'topic'),
    ])];

    expect(graphContextScopeForTopic(tree, 't1')).toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's1' });
    expect(graphContextScopeForTopic(tree, 't2')).toEqual({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 'domain' });
    expect(graphContextScopeForTopic(tree, 't3')).toEqual({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 't3' });
  });

  it('uses the confirmed reference path consistently for topic and chapter notes', () => {
    const tree = [treeNode('d1', 'discipline', [
      treeNode('s1', 'subdiscipline', [treeNode('shared-topic', 'topic')]),
      treeNode('s2', 'subdiscipline'),
    ])];

    expect(contextualTopicPath(tree, 'shared-topic', 's2')).toEqual(['d1', 's2', 'shared-topic']);
    expect(contextualChapterPath(tree, 'shared-topic', 'shared-chapter', 's2')).toEqual(['d1', 's2', 'shared-topic', 'shared-chapter']);
    expect(contextualTopicPath(tree, 'shared-topic', 'missing-scope')).toEqual(['d1', 's1', 'shared-topic']);
    expect(contextualChapterPath(tree, 'shared-topic', 'shared-chapter')).toEqual(['d1', 's1', 'shared-topic', 'shared-chapter']);
  });

  it('isolates whole, local, and advanced Graph camera identities', () => {
    const discipline = { kind: 'discipline', disciplineId: 'd1' } as const;
    const topic = { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' } as const;
    const whole = graphPanelScopeIdentity(discipline, 'subject', 'whole-discipline', topic, 'focus');
    const local = graphPanelScopeIdentity(discipline, 'subject', 'local', discipline, 'focus');

    expect(whole).toBe('subject:whole:discipline:d1');
    expect(graphPanelScopeIdentity(discipline, 'subject', 'whole-discipline', topic, 'focus')).toBe(whole);
    expect(local).not.toBe(whole);
    expect(graphPanelScopeIdentity(discipline, 'advanced', 'local', topic, 'focus')).not.toBe(whole);
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

  it('keeps shared chapters in the active topic breadcrumb when the tree stores another primary parent', () => {
    const tree = [
      treeNode('d1', 'discipline', [treeNode('s1', 'subdiscipline', [
        treeNode('topic-a', 'topic', [treeNode('shared-chapter', 'chapter')]),
        treeNode('topic-b', 'topic'),
      ])]),
    ];

    expect(contextualChapterPath(tree, 'topic-b', 'Shared chapter')).toEqual(['d1', 's1', 'topic-b', 'Shared chapter']);
    expect(contextualChapterSelectionId(tree, 'topic-b', 'shared-chapter')).toBe('topic-b');
    expect(contextualChapterSelectionId(tree, 'topic-a', 'shared-chapter')).toBe('shared-chapter');
  });

  it('selects the existing shared-topic alias while a chapter has no node under that reference', () => {
    const tree = [treeNode('d1', 'discipline', [
      treeNode('s1', 'subdiscipline', [treeNode('shared-topic', 'topic', [treeNode('shared-chapter', 'chapter')])]),
      treeNode('s2', 'subdiscipline'),
    ])];
    const scope = { kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 's2' } as const;
    const edge: GraphEdge = { id: 'shared-s2', fromNodeId: 'shared-topic', toNodeId: 's2', relationType: 'part_of', source: 'fixture' };
    const referenced = addTopicPathReference(tree, scope, 'shared-topic', [edge]);

    expect(referenced[0]?.children?.[1]?.children?.[0]?.children).toBeUndefined();
    expect(contextualChapterSelectionId(referenced, 'shared-topic', 'shared-chapter')).toBe('shared-chapter');
    expect(contextualChapterSelectionId(referenced, 'shared-topic', 'shared-chapter', 's2')).toBe('shared-topic');
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

  it('keeps an unassigned Markdown file path distinct from a semantic topic identity', () => {
    const semanticTopic = contentIdentity({ kind: 'topic', topicId: 'topic-t' });
    const markdownFile = contentIdentity({ kind: 'file', path: 'Unassigned/Topic T.md' });

    expect(markdownFile).toBe('file:"Unassigned/Topic T.md"');
    expect(markdownFile).not.toBe(semanticTopic);
    expect(contentIdentity({ kind: 'file', path: 'Other/Topic T.md' })).not.toBe(markdownFile);
  });

  it('renders shared-chapter candidates in the intermediate choice panel', () => {
    const html = renderToStaticMarkup(createElement(ChapterChoicePanel, {
      chapterTitle: '变量',
      candidates: [{ id: 'python', title: 'Python' }, { id: 'cpp', title: 'C++' }],
      action: 'open',
      onChoose: () => {},
    }));
    const moreHtml = renderToStaticMarkup(createElement(ChapterChoicePanel, {
      chapterTitle: '变量', candidates: [{ id: 'python', title: 'Python' }], action: 'more', onChoose: () => {},
    }));

    expect(html).toContain('选择章节正文所属主题');
    expect(html).toContain('Python');
    expect(html).toContain('C++');
    expect(html).not.toContain('Graph 面板');
    expect(moreHtml).toContain('选择一个关联主题以查看更多信息');
    expect(moreHtml).toContain('查看「Python」更多信息');
  });

  it('keeps the More pane visible in the cards view without replacing its content', () => {
    const scope = { kind: 'discipline', disciplineId: 'cs' } as const;
    const detail: NodeDetail = {
      node: {
        id: 'python', userId: 'test', title: 'Python', summary: '主题摘要', nodeType: 'topic', parentId: 'programming',
        status: 'active', confidence: null, embeddingModel: null, masteryLevel: 'collected', createdAt: '', updatedAt: '',
      },
      path: [], items: [], children: [], relatedNodes: [], stats: { itemCount: 4, sourceCount: 2, childCount: 1 },
    };
    const props: GraphNotebookProps = {
      content: { kind: 'cards', scope, selectedNodeId: 'cs' }, scope,
      nodes: [{ id: 'python', title: 'Python', nodeType: 'topic', parentId: 'programming', summary: '主题摘要' }], edges: [],
      pathLabel: '计算机科学', loading: false, error: null, note: null, notes: [], connectableTopics: [],
      historyAvailable: false, choice: null, moreOpen: true, moreDetail: detail, scrollRef: { current: null },
      search: '', searchError: null, searchLoading: false, searchHits: [], classificationOptions: [],
      onSearch: () => {}, renderTopicCard: (node) => createElement('article', { key: node.id }, node.title),
      onOpenTopic: () => {}, onOpenChapter: () => {}, onOpenOrphan: () => {}, onChooseTopic: () => {}, onBack: () => {},
      onChangeNote: () => {}, onRetrySave: () => {}, onMore: () => {}, onCloseMore: () => {}, onMoveTopic: () => {},
      onCreateChapter: () => {}, onChapterTitleChange: () => {}, newChapterOpen: false, newChapterTitle: '', actionBusy: false,
      onToggleNewChapter: () => {}, onDetachChapter: () => {}, onConnectChapter: () => {}, onOpenSearchHit: () => {},
      onOpenSearchItem: () => {}, onCollect: () => {}, onToggleTheme: () => {}, theme: 'dark',
    };
    const html = renderToStaticMarkup(createElement(GraphNotebook, props));

    expect(html).toContain('class="topic-more-pane"');
    expect(html).toContain('主题摘要');
    expect(html).toContain('选择一张主题卡片');
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
