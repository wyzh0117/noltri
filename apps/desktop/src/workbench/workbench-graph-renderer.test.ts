import { describe, expect, it } from 'vitest';
import { uniqueGraphLineEdges } from './workbench-graph-renderer';
import type { GraphViewEdge } from './workbench-graph-model';

const edge = (source: string, target: string, width = 1): GraphViewEdge => ({
  id: `${source}\0${target}`, source, target, count: 1, resolved: true, width,
});

describe('graph edge rendering', () => {
  it('draws reciprocal links as one shared stroke while leaving directed arrows to the caller', () => {
    const directed = [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')];
    expect(uniqueGraphLineEdges(directed)).toEqual([directed[0], directed[2]]);
    expect(directed).toHaveLength(3);
  });

  it('keeps the widest stroke for duplicate undirected links', () => {
    expect(uniqueGraphLineEdges([edge('a', 'b', 0.1), edge('b', 'a', 2)])).toEqual([edge('b', 'a', 2)]);
  });
});
