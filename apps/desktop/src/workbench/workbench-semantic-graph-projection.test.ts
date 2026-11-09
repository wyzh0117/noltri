import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, GraphScope, GraphSelection } from '@noltri/schema';
import { buildSubjectGraphView, mergeSemanticGraphSelections, projectLocalSubjectGraph, projectWholeDisciplineGraph } from './workbench-semantic-graph-projection';

const node = (id: string, nodeType: GraphNode['nodeType'], parentId: string | null = null): GraphNode => ({
  id, title: id, nodeType, parentId, summary: null,
});
const edge = (id: string, fromNodeId: string, toNodeId: string): GraphEdge => ({
  id, fromNodeId, toNodeId, relationType: 'part_of', source: 'fixture',
});

const nodes: GraphNode[] = [
  node('d1', 'discipline'), node('d2', 'discipline'),
  node('sub-a', 'subdiscipline', 'd1'), node('sub-b', 'subdiscipline', 'd1'), node('sub-c', 'subdiscipline', 'd2'),
  node('t-shared', 'topic', 'sub-a'), node('t-b-only', 'topic', 'sub-b'), node('t-c', 'topic', 'sub-c'),
  node('chapter-shared', 'chapter', 't-shared'), node('chapter-private', 'chapter', 't-shared'),
];
const edges: GraphEdge[] = [
  edge('sub-a-d1', 'sub-a', 'd1'), edge('sub-b-d1', 'sub-b', 'd1'), edge('sub-a-d2', 'sub-a', 'd2'),
  edge('t-shared-sub-a', 't-shared', 'sub-a'), edge('t-shared-sub-b', 't-shared', 'sub-b'),
  edge('t-b-only-sub-b', 't-b-only', 'sub-b'), edge('t-c-sub-c', 't-c', 'sub-c'),
  edge('chapter-shared-t1', 'chapter-shared', 't-shared'), edge('chapter-shared-t2', 'chapter-shared', 't-c'),
  edge('chapter-private-t1', 'chapter-private', 't-shared'),
];
const data = { nodes, edges };

function ids(scope: GraphScope): string[] {
  return projectLocalSubjectGraph(data, scope).nodes.map(({ id }) => id).sort();
}

describe('semantic subject graph projection', () => {
  it('shows only a discipline, direct subdisciplines, and shared discipline boundaries', () => {
    expect(ids({ kind: 'discipline', disciplineId: 'd1' })).toEqual(['d1', 'd2', 'sub-a', 'sub-b']);
  });

  it('shows a subdiscipline, its direct topics, and only shared same-level boundaries', () => {
    expect(ids({ kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 'sub-a' }))
      .toEqual(['sub-a', 'sub-b', 't-shared']);
  });

  it('shows a topic, its chapters, and topics sharing those chapters without importing their chapters', () => {
    expect(ids({ kind: 'topic', disciplineId: 'd1', anchorTopicId: 't-shared' }))
      .toEqual(['chapter-private', 'chapter-shared', 't-c', 't-shared']);
    expect(projectLocalSubjectGraph(data, { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't-shared' }).edges.map(({ id }) => id).sort())
      .toEqual(['chapter-private-t1', 'chapter-shared-t1', 'chapter-shared-t2']);
  });

  it('keeps the active direction selection while focusing its shared topic locally', () => {
    expect(buildSubjectGraphView(
      data,
      { kind: 'subdiscipline', disciplineId: 'd1', subdisciplineId: 'sub-b' },
      'local',
      { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't-shared' },
    ).nodes.map(({ id }) => id).sort()).toEqual(['chapter-private', 'chapter-shared', 't-c', 't-shared']);
  });

  it('keeps a whole discipline subtree intact and unions per-discipline selections by stable identity', () => {
    const selection = (disciplineId: string, selectionNodes: GraphNode[], selectionEdges: GraphEdge[]): GraphSelection => ({
      scope: { kind: 'discipline', disciplineId }, scopeGraphNodeId: disciplineId, nodes: selectionNodes, edges: selectionEdges,
    });
    const merged = mergeSemanticGraphSelections([
      selection('d1', [nodes[0]!, nodes[2]!, nodes[5]!], [edges[0]!, edges[3]!]),
      selection('d2', [nodes[1]!, nodes[2]!, nodes[7]!], [edges[2]!, edges[3]!]),
    ]);
    expect(merged.nodes.map(({ id }) => id).sort()).toEqual(['d1', 'd2', 'sub-a', 't-c', 't-shared']);
    expect(merged.edges).toHaveLength(3);
    expect(projectWholeDisciplineGraph(data, 'd1').nodes.map(({ id }) => id).sort())
      .toEqual(['chapter-private', 'chapter-shared', 'd1', 'sub-a', 'sub-b', 't-b-only', 't-shared']);
  });

  it('uses a full discipline projection for whole scope and leaves null subject scope empty', () => {
    const topicScope: GraphScope = { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't-shared' };
    expect(buildSubjectGraphView(data, topicScope, 'whole-discipline').nodes.map(({ id }) => id).sort())
      .toEqual(['chapter-private', 'chapter-shared', 'd1', 'sub-a', 'sub-b', 't-b-only', 't-shared']);
    expect(buildSubjectGraphView(data, null, 'local')).toEqual({ nodes: [], edges: [] });
  });
});
