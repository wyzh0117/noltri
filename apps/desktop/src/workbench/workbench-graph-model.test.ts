import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@noltri/schema';
import { buildGraphModel, graphContextAnchorId, graphContextPathIds, selectGraphWindow } from './workbench-graph-model';

function topic(id: string, parentId: string | null = null): GraphNode {
  return { id, title: id, nodeType: 'topic', parentId, summary: null };
}

function chapter(id: string, parentId: string): GraphNode {
  return { id, title: id, nodeType: 'chapter', parentId, summary: null };
}

function taxonomy(id: string, nodeType: 'discipline' | 'subdiscipline' | 'domain', parentId: string | null): GraphNode {
  return { id, title: id, nodeType, parentId, summary: null };
}

function edge(fromNodeId: string, toNodeId: string, relationType: GraphEdge['relationType'] = 'part_of'): GraphEdge {
  return { id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId, relationType, source: 'test' };
}

describe('semantic graph model', () => {
  it('keeps topic and chapter identity and applies semantic filter and query groups', () => {
    const nodes = [topic('root'), topic('child', 'root'), chapter('note', 'child'), topic('other')];
    const edges = [edge('root', 'child'), edge('child', 'note'), edge('other', 'note', 'wikilink')];
    const model = buildGraphModel(nodes, edges, {
      showOrphans: true,
      nodeSizeMultiplier: 1,
      lineSizeMultiplier: 1,
      preserveNodeIds: new Set(['root']),
    }, {
      filter: { nodeIds: new Set(['note']) },
      groups: [{ query: 'tag:method', color: '#ff0000', match: { nodeIds: new Set(['note']) } }],
    });

    expect(model.nodes.map(({ id }) => id)).toEqual(['note', 'root']);
    expect(model.nodes.find(({ id }) => id === 'note')).toMatchObject({ type: 'chapter', colorGroup: '#ff0000' });
    expect(model.edges).toEqual([]);
  });

  it('keeps the taxonomy scope root, selected path, and the 40-node window', () => {
    const nodes = [
      taxonomy('discipline-id', 'discipline', null),
      taxonomy('subdiscipline-id', 'subdiscipline', 'discipline-id'),
      topic('root-topic', 'subdiscipline-id'),
      ...Array.from({ length: 70 }, (_, index) => topic(`child-${String(index).padStart(2, '0')}`, 'root-topic')),
    ];
    const edges = nodes.slice(1).map((node) => edge(node.id, node.parentId!));
    const model = buildGraphModel(nodes, edges, { showOrphans: true, nodeSizeMultiplier: 1, lineSizeMultiplier: 1 });
    const anchor = graphContextAnchorId('discipline-id', nodes);
    const mini = selectGraphWindow(model, anchor ?? 'root', 'child-69', nodes, 40);

    expect(anchor).toBe('discipline-id');
    expect(mini.nodes).toHaveLength(40);
    expect(mini.nodes.map(({ id }) => id)).toContain('discipline-id');
    expect(mini.nodes.map(({ id }) => id)).toContain('child-69');
    expect(mini.hiddenCount).toBe(33);
    expect(mini.nodes.slice(0, 4).map(({ id }) => id)).toEqual(['discipline-id', 'subdiscipline-id', 'root-topic', 'child-69']);
    expect(graphContextPathIds('discipline-id', 'child-69', nodes)).toEqual(new Set(['discipline-id', 'subdiscipline-id', 'root-topic', 'child-69']));
  });

  it('anchors a subdiscipline/domain root exactly instead of substituting the first topic', () => {
    const nodes = [taxonomy('discipline-id', 'discipline', null), taxonomy('domain-id', 'domain', 'discipline-id'), topic('topic-id', 'domain-id')];
    expect(graphContextAnchorId('domain-id', nodes)).toBe('domain-id');
    expect(graphContextAnchorId('missing-root', nodes)).toBeNull();
  });

  it('keeps a chapter with its topic in the mini graph and retains explicit semantic edges', () => {
    const nodes = [topic('root'), topic('level-2', 'root'), topic('level-3', 'level-2'), chapter('chapter-a', 'level-3'), chapter('chapter-b', 'root')];
    const edges = [edge('root', 'level-2'), edge('level-2', 'level-3'), edge('level-3', 'chapter-a'), edge('root', 'chapter-b'), edge('chapter-a', 'chapter-b', 'wikilink')];
    const model = buildGraphModel(nodes, edges, { showOrphans: true, nodeSizeMultiplier: 1, lineSizeMultiplier: 1 });
    const mini = selectGraphWindow(model, 'root', 'chapter-a', nodes, 4);

    expect(mini.nodes.map(({ id }) => id)).toEqual(['root', 'level-2', 'level-3', 'chapter-a']);
    expect(mini.edges.some(({ relationType }) => relationType === 'wikilink')).toBe(false);
    const expanded = selectGraphWindow(model, 'root', 'chapter-a', nodes, 5000);
    expect(expanded.nodes).toHaveLength(model.nodes.length);
    expect(expanded.edges.some(({ relationType }) => relationType === 'wikilink')).toBe(true);
  });
});
