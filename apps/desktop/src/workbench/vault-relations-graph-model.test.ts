import { describe, expect, it } from 'vitest';
import type { VaultGraph } from '@noltri/schema';
import { projectVaultGraph, vaultGraphNodeId, vaultGraphOpenPath, vaultGraphMatchIds } from './vault-relations-graph-model';

const graph: VaultGraph = {
  revision: 7,
  nodes: [
    { path: 'a.md', title: 'A', basename: 'a', type: 'note', tags: [] },
    { path: 'b.md', title: 'B', basename: 'b', type: 'note', tags: [] },
    { path: 'pic.png', title: 'Picture', basename: 'pic', type: 'attachment', tags: [] },
    { path: 'missing.md', title: 'Missing', basename: 'missing', type: 'unresolved', tags: [] },
  ],
  edges: [{ sourcePath: 'a.md', targetPath: 'b.md', count: 2, resolved: true }, { sourcePath: 'a.md', targetPath: 'missing.md', count: 1, resolved: false }],
};

describe('read-only Vault graph projection', () => {
  it('uses stable path IDs, preserves actual kinds, and never produces parent/topic relationships', () => {
    const view = projectVaultGraph(graph, 'a.md');
    const reordered = projectVaultGraph({ ...graph, nodes: [...graph.nodes].reverse() }, 'a.md');
    expect(view.nodes).toEqual(reordered.nodes);
    expect(view.nodes.map(node => node.id)).toContain(vaultGraphNodeId('a.md'));
    expect(view.metadata.get(vaultGraphNodeId('pic.png'))?.type).toBe('attachment');
    expect(view.nodes.find(node => node.id === vaultGraphNodeId('pic.png'))?.title).toContain('附件');
    expect(view.nodes.find(node => node.id === vaultGraphNodeId('missing.md'))?.title).toContain('未解析');
    expect(view.nodes.every(node => node.parentId === null)).toBe(true);
    expect(view.edges.every(edge => edge.relationType === 'wikilink')).toBe(true);
  });
  it('opens only actual safe Markdown nodes from the current projection', () => {
    const view = projectVaultGraph({ ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], path: '../outside.md' }, { ...graph.nodes[0], path: 'not-markdown.txt' }] }, 'a.md');
    expect(vaultGraphOpenPath(view, vaultGraphNodeId('a.md'))).toBe('a.md');
    for (const path of ['pic.png', 'missing.md', '../outside.md', 'not-markdown.txt', 'invented.md']) expect(vaultGraphOpenPath(view, vaultGraphNodeId(path))).toBeNull();
  });
  it('bounds nodes and edges, keeps the anchor and its neighbours, and removes dangling edges', () => {
    const view = projectVaultGraph(graph, 'missing.md', { nodes: 2, edges: 1 });
    expect(view.nodes.map(node => node.id)).toEqual([vaultGraphNodeId('missing.md'), vaultGraphNodeId('a.md')]);
    expect(view.edges).toHaveLength(1);
    expect(view.omittedNodes).toBe(2);
    expect(view.edges.every(edge => view.metadata.has(edge.fromNodeId) && view.metadata.has(edge.toNodeId))).toBe(true);
  });
  it('projects both note and attachment matches, ignores tags as paths and unknown results', () => {
    const view = projectVaultGraph(graph, 'a.md');
    expect([...vaultGraphMatchIds(view, { revision: 7, paths: ['a.md', 'unknown.md'], attachmentPaths: ['pic.png'], matchingTags: ['b.md'] })].sort()).toEqual([vaultGraphNodeId('a.md'), vaultGraphNodeId('pic.png')].sort());
  });
});
