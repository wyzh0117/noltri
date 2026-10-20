import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@noltri/schema';
import { layoutGraph, selectGraphWindow } from './workbench-graph-layout';

function topic(id: string): GraphNode {
  return { id, title: id, nodeType: 'topic', parentId: null, summary: null };
}

function chapter(id: string, topicId: string): GraphNode {
  return { id, title: id, nodeType: 'chapter', parentId: topicId, summary: null };
}

function edge(id: string, fromNodeId: string, toNodeId: string): GraphEdge {
  return { id, fromNodeId, toNodeId, relationType: 'part_of', source: 'explicit' };
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

describe('graph window and layout', () => {
  it('keeps the selected node and its connected nodes when applying a render cap', () => {
    const nodes = [topic('selected'), ...Array.from({ length: 300 }, (_, index) => chapter(`chapter-${index}`, 'selected'))];
    const edges = nodes.slice(1).map((node) => edge(`edge-${node.id}`, node.id, 'selected'));
    const window = selectGraphWindow(nodes, edges, 'selected', 20);

    expect(window.nodes).toHaveLength(20);
    expect(window.nodes[0]?.id).toBe('selected');
    expect(window.nodes.slice(1).every((node) => node.nodeType === 'chapter')).toBe(true);
    expect(window.edges.every((entry) => window.nodes.some((node) => node.id === entry.fromNodeId) && window.nodes.some((node) => node.id === entry.toNodeId))).toBe(true);
    expect(window.hiddenCount).toBe(281);
  });

  it('produces repeatable force positions and honors saved positions for existing nodes', () => {
    const nodes = [topic('topic-a'), chapter('chapter-a', 'topic-a'), chapter('chapter-b', 'topic-a')];
    const edges = [edge('edge-a', 'chapter-a', 'topic-a'), edge('edge-b', 'chapter-b', 'topic-a')];
    const first = layoutGraph(nodes, edges);
    const second = layoutGraph(nodes, edges);
    expect(second).toEqual(first);

    const saved = { ...first, 'chapter-a': { x: 123, y: 234 } };
    expect(layoutGraph(nodes, edges, saved)['chapter-a']).toEqual({ x: 123, y: 234 });
    expect(layoutGraph(nodes, edges, saved)).toEqual(saved);
  });

  it('includes a late search hit and its real adjacent nodes and edges in a 1,200-node range', () => {
    const topics = Array.from({ length: 400 }, (_, index) => topic(`topic-${String(index).padStart(3, '0')}`));
    const chapters = Array.from({ length: 800 }, (_, index) => chapter(`chapter-${String(index).padStart(3, '0')}`, topics[Math.floor(index / 2)]!.id));
    const nodes = [...topics, ...chapters];
    const edges = chapters.map((node) => edge(`edge-${node.id}`, node.id, node.parentId!));
    const selectedNodeId = 'topic-399';
    const targetEdges = edges.filter((entry) => entry.fromNodeId === selectedNodeId || entry.toNodeId === selectedNodeId);
    const window = selectGraphWindow(nodes, edges, selectedNodeId);

    expect(nodes).toHaveLength(1200);
    expect(window.nodes).toHaveLength(260);
    expect(window.nodes.some((node) => node.id === selectedNodeId)).toBe(true);
    expect(window.nodes.some((node) => node.id === 'chapter-798')).toBe(true);
    expect(window.nodes.some((node) => node.id === 'chapter-799')).toBe(true);
    expect(window.edges.filter((entry) => entry.fromNodeId === selectedNodeId || entry.toNodeId === selectedNodeId)).toEqual(targetEdges);
    expect(window.nodes.every((node) => nodes.some((source) => source.id === node.id))).toBe(true);
    expect(window.hiddenCount).toBe(940);
    expect(nodes).toHaveLength(1200);
    expect(edges).toHaveLength(800);
  });

  it('keeps a 260-node graph of real disconnected relationship clusters off hard canvas bounds', () => {
    const topics = Array.from({ length: 87 }, (_, index) => topic(`topic-${index}`));
    const chapters = Array.from({ length: 173 }, (_, index) => {
      const parent = topics[Math.floor(index * topics.length / 173)]!;
      return chapter(`chapter-${index}`, parent.id);
    });
    const nodes = [...topics, ...chapters];
    const edges = chapters.map((node) => edge(`edge-${node.id}`, node.id, node.parentId!));
    const positions = layoutGraph(nodes, edges);
    const points = Object.values(positions);
    const edgePacked = points.filter((point) => point.x <= 21 || point.x >= 979 || point.y <= 21 || point.y >= 679);

    expect(nodes).toHaveLength(260);
    expect(edges).toHaveLength(173);
    expect(points).toHaveLength(260);
    expect(edgePacked.length).toBeLessThan(nodes.length * 0.1);
    expect(Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))).toBeGreaterThan(500);
    expect(Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))).toBeGreaterThan(300);

    const linkedPairs = new Set(edges.map((entry) => [entry.fromNodeId, entry.toNodeId].sort().join('\0')));
    const connectedDistances = edges.map((entry) => {
      const from = positions[entry.fromNodeId]!;
      const to = positions[entry.toNodeId]!;
      return Math.hypot(from.x - to.x, from.y - to.y);
    });
    const unrelatedDistances: number[] = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const pair = [nodes[left]!.id, nodes[right]!.id].sort().join('\0');
        if (linkedPairs.has(pair)) continue;
        const from = positions[nodes[left]!.id]!;
        const to = positions[nodes[right]!.id]!;
        unrelatedDistances.push(Math.hypot(from.x - to.x, from.y - to.y));
      }
    }
    expect(median(connectedDistances)).toBeLessThan(median(unrelatedDistances) * 0.65);
  });
});
