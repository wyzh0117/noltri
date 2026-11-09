import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, VaultGraph } from '@noltri/schema';
import { buildAdvancedGraphView } from './workbench-advanced-graph-view';
import { DEFAULT_ADVANCED_GRAPH_FILTERS } from './workbench-advanced-graph-view';

const semanticNodes: GraphNode[] = [
  { id: 'topic-python', title: 'Python', nodeType: 'topic', parentId: null, summary: null, notePath: 'Python.md', notePaths: ['Python.md'] },
  { id: 'chapter-variable', title: '变量', nodeType: 'chapter', parentId: 'topic-python', summary: null, notePath: 'Python.md', notePaths: ['Python.md'] },
];
const semanticEdges: GraphEdge[] = [{ id: 'chapter-topic', fromNodeId: 'chapter-variable', toNodeId: 'topic-python', relationType: 'part_of', source: 'fixture' }];
const vaultGraph: VaultGraph = {
  revision: 4,
  nodes: [
    { path: 'Python.md', title: 'Python', basename: 'Python', type: 'note', tags: ['#lang/python'] },
    { path: 'Inbox/orphan.md', title: '孤立笔记', basename: 'orphan', type: 'note', tags: ['#draft'] },
    { path: 'Other/unused.md', title: '未关联笔记', basename: 'unused', type: 'note', tags: [] },
    { path: 'assets/plot.png', title: 'plot.png', basename: 'plot', type: 'attachment', tags: [] },
    { path: 'unresolved:C++', title: 'C++', basename: 'C++', type: 'unresolved', tags: [] },
  ],
  edges: [
    { sourcePath: 'Python.md', targetPath: 'Inbox/orphan.md', count: 1, resolved: true },
    { sourcePath: 'Python.md', targetPath: 'assets/plot.png', count: 1, resolved: true },
    { sourcePath: 'Python.md', targetPath: 'unresolved:C++', count: 1, resolved: false },
  ],
};

describe('advanced graph view projection', () => {
  it('keeps the subject node identity and adds directly related orphan notes without a second file graph', () => {
    const view = buildAdvancedGraphView({
      semanticNodes, semanticEdges, vaultGraph, scope: { kind: 'discipline', disciplineId: 'cs' },
      contextNodeId: 'topic-python', advancedScope: 'focus',
    });
    expect(view.nodes.filter((node) => node.id === 'topic-python')).toHaveLength(1);
    expect(view.nodes.map((node) => node.id)).toContain('vault:Inbox%2Forphan.md');
    expect(view.nodes.map((node) => node.id)).not.toContain('vault:Other%2Funused.md');
    expect(view.nodes.some((node) => node.nodeType === 'attachment')).toBe(false);
    expect(view.nodes.some((node) => node.nodeType === 'unresolved')).toBe(false);
    expect(view.nodes.filter((node) => node.nodeType === 'tag').map((node) => node.title).sort()).toEqual(['#draft', '#lang/python']);
    expect(view.edges.some((edge) => edge.fromNodeId === 'topic-python' && edge.toNodeId === 'vault:Inbox%2Forphan.md')).toBe(true);
  });

  it('adds attachment and unresolved nodes only after their advanced filters are enabled', () => {
    const view = buildAdvancedGraphView({
      semanticNodes, semanticEdges, vaultGraph, scope: null, contextNodeId: 'topic-python', advancedScope: 'all',
      filters: { ...DEFAULT_ADVANCED_GRAPH_FILTERS, showAttachments: true, showUnresolved: true },
    });
    expect(view.nodes.some((node) => node.nodeType === 'attachment')).toBe(true);
    expect(view.nodes.some((node) => node.nodeType === 'unresolved')).toBe(true);
    expect(view.nodes.map((node) => node.id)).toContain('vault:Other%2Funused.md');
    expect(view.edges.some((edge) => edge.source === 'vault_graph_unresolved')).toBe(true);
  });

  it('keeps advanced discipline scope inside the active discipline and is empty without one', () => {
    const nodes: GraphNode[] = [
      { id: 'cs', title: '计算机', nodeType: 'discipline', parentId: null, summary: null },
      { id: 'topic-python', title: 'Python', nodeType: 'topic', parentId: 'cs', summary: null },
      { id: 'humanities', title: '人文', nodeType: 'discipline', parentId: null, summary: null },
      { id: 'topic-history', title: '历史', nodeType: 'topic', parentId: 'humanities', summary: null },
    ];
    const edges: GraphEdge[] = [
      { id: 'python-part', fromNodeId: 'topic-python', toNodeId: 'cs', relationType: 'part_of', source: 'fixture' },
      { id: 'history-part', fromNodeId: 'topic-history', toNodeId: 'humanities', relationType: 'part_of', source: 'fixture' },
    ];
    const view = buildAdvancedGraphView({
      semanticNodes: nodes, semanticEdges: edges, vaultGraph: null,
      scope: { kind: 'discipline', disciplineId: 'cs' }, contextNodeId: 'topic-python', advancedScope: 'discipline',
    });
    expect(view.nodes.map((node) => node.id).sort()).toEqual(['cs', 'topic-python']);
    expect(view.edges).toHaveLength(1);

    const noDiscipline = buildAdvancedGraphView({
      semanticNodes: nodes, semanticEdges: edges, vaultGraph: null,
      scope: null, contextNodeId: 'topic-python', advancedScope: 'discipline',
    });
    expect(noDiscipline.nodes).toEqual([]);
    expect(noDiscipline.edges).toEqual([]);
  });
});
