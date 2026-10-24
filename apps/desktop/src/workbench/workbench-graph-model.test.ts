import { describe, expect, it } from 'vitest';
import type { VaultGraph } from '@noltri/schema';
import { buildGraphModel, graphNodeSize, graphQueryMatchFromResponse, tagNodeId } from './workbench-graph-model';
import type { GraphModelOptions } from './workbench-graph-model';

const options: GraphModelOptions = {
  mode: 'global', focusPath: null, depth: 1, showOutgoing: true, showIncoming: true, neighborLinks: false,
  showTags: false, showAttachments: false, existingFilesOnly: false, showOrphans: true,
  nodeSizeMultiplier: 1, lineSizeMultiplier: 1,
};

const graph: VaultGraph = {
  revision: 4,
  nodes: [
    { path: 'a.md', title: 'A', basename: 'A', type: 'note', tags: ['work', '#Project/Work'] },
    { path: 'b.md', title: 'B', basename: 'B', type: 'note', tags: ['project/work'] },
    { path: 'c.png', title: 'C', basename: 'C', extension: 'png', type: 'attachment', tags: [] },
    { path: 'dangling', title: 'Dangling', basename: 'Dangling', type: 'unresolved', tags: [] },
    { path: 'isolated.md', title: 'Isolated', basename: 'Isolated', type: 'note', tags: [] },
  ],
  edges: [
    { sourcePath: 'a.md', targetPath: 'b.md', count: 2, resolved: true },
    { sourcePath: 'a.md', targetPath: 'dangling', count: 1, resolved: false },
    { sourcePath: 'b.md', targetPath: 'c.png', count: 1, resolved: true },
    { sourcePath: 'b.md', targetPath: 'a.md', count: 1, resolved: true },
  ],
};

function match(paths: string[] = [], matchingTags: string[] = [], attachmentPaths: string[] = []) {
  return graphQueryMatchFromResponse({ revision: 4, paths, matchingTags, attachmentPaths });
}

describe('vault graph model', () => {
  it('applies attachment, unresolved, filter, and orphan options without parsing note text', () => {
    const filtered = buildGraphModel(graph, options, { filter: match(['a.md']), groups: [] });
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'dangling']);
    expect(filtered.edges).toHaveLength(1);
    expect(buildGraphModel(graph, { ...options, existingFilesOnly: true }, { filter: null, groups: [] }).nodes.some((node) => node.type === 'unresolved')).toBe(false);
    expect(buildGraphModel(graph, { ...options, showAttachments: true }, { filter: null, groups: [] }).nodes.some((node) => node.path === 'c.png')).toBe(true);
    expect(buildGraphModel(graph, { ...options, showOrphans: false }, { filter: null, groups: [] }).nodes.some((node) => node.path === 'isolated.md')).toBe(false);
  });

  it('builds tag nodes and colors them from the first matching group', () => {
    const model = buildGraphModel({ ...graph, edges: [] }, { ...options, showTags: true }, {
      filter: null,
      groups: [
        { query: 'tag:work', color: '#f00', match: match(['b.md'], ['project/work']) },
        { query: 'all', color: '#0f0', match: match(['a.md', 'b.md'], ['work', '#project/work']) },
      ],
    });
    const tag = model.nodes.find((node) => node.id === tagNodeId('project/work'));
    expect(tag).toMatchObject({ title: '#Project/Work', colorGroup: '#f00' });
    expect(model.edges.some((edge) => edge.source === 'a.md' && edge.target === tagNodeId('project/work'))).toBe(true);
  });

  it('extracts local depth, respects directions, and includes neighbor links only when enabled', () => {
    const local = buildGraphModel(graph, { ...options, mode: 'local', focusPath: 'b.md', depth: 1, showAttachments: true }, { filter: null, groups: [] });
    expect(local.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'b.md', 'c.png']);
    expect(local.edges.some((edge) => edge.source === 'a.md' && edge.target === 'b.md')).toBe(true);
    expect(local.edges.some((edge) => edge.source === 'a.md' && edge.target === 'dangling')).toBe(false);

    const withoutReverseEdge = { ...graph, edges: graph.edges.filter((edge) => !(edge.sourcePath === 'b.md' && edge.targetPath === 'a.md')) };
    const outgoing = buildGraphModel(withoutReverseEdge, { ...options, mode: 'local', focusPath: 'b.md', depth: 1, showAttachments: true, showIncoming: false }, { filter: null, groups: [] });
    expect(outgoing.nodes.map((node) => node.id).sort()).toEqual(['b.md', 'c.png']);
  });

  it('uses the specified clamped square-root size curve', () => {
    expect(graphNodeSize(0)).toBe(8);
    expect(graphNodeSize(99)).toBe(30);
    expect(graphNodeSize(99, 20)).toBe(150);
  });

  it('filters and colors tag nodes only from typed matchingTags, not every tag on a matching note', () => {
    const taggedGraph: VaultGraph = {
      revision: 4,
      nodes: [
        { path: 'a.md', title: 'A', basename: 'A', type: 'note', tags: ['science/math', 'math'] },
        { path: 'b.md', title: 'B', basename: 'B', type: 'note', tags: ['science/ethics', 'history'] },
      ],
      edges: [],
    };
    const typedMatch = match(['a.md', 'b.md'], ['#science/math', 'science/ethics']);
    const filtered = buildGraphModel(taggedGraph, { ...options, showTags: true }, { filter: typedMatch, groups: [] });
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'b.md', tagNodeId('science/ethics'), tagNodeId('science/math')]);
    expect(filtered.nodes.some((node) => node.id === tagNodeId('math') || node.id === tagNodeId('history'))).toBe(false);

    const grouped = buildGraphModel(taggedGraph, { ...options, showTags: true }, {
      filter: null,
      groups: [
        { query: 'tag:science', color: '#f00', match: match(['a.md', 'b.md'], ['science/math', 'science/ethics']) },
        { query: 'tag:math OR tag:history', color: '#0f0', match: match(['a.md', 'b.md'], ['math', 'history']) },
      ],
    });
    expect(grouped.nodes.find((node) => node.id === tagNodeId('science/math'))?.colorGroup).toBe('#f00');
    expect(grouped.nodes.find((node) => node.id === tagNodeId('science/ethics'))?.colorGroup).toBe('#f00');
    expect(grouped.nodes.find((node) => node.id === tagNodeId('math'))?.colorGroup).toBe('#0f0');
    expect(grouped.nodes.find((node) => node.id === tagNodeId('history'))?.colorGroup).toBe('#0f0');

    const notMatch = buildGraphModel(taggedGraph, { ...options, showTags: true }, {
      filter: match(['a.md', 'b.md'], ['math', 'history']), groups: [],
    });
    expect(notMatch.nodes.filter((node) => node.type === 'tag').map((node) => node.id).sort()).toEqual([tagNodeId('history'), tagNodeId('math')]);
  });
});
