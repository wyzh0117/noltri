import type { GraphEdge, GraphNode } from '@noltri/schema';

export type VaultGraphRenderKind = 'note' | 'attachment' | 'unresolved' | 'tag';

export interface VaultGraphRenderNode extends Omit<GraphNode, 'nodeType'> {
  nodeType: VaultGraphRenderKind;
  graphTarget:
    | { kind: 'note' | 'attachment' | 'unresolved'; path: string }
    | { kind: 'tag'; tag: string };
}

export type GraphRenderNode = GraphNode | VaultGraphRenderNode;
export type GraphRenderEdge = GraphEdge | (Omit<GraphEdge, 'relationType'> & { relationType: 'tagged' });

export function isVaultGraphRenderNode(node: GraphRenderNode): node is VaultGraphRenderNode {
  return node.nodeType === 'note' || node.nodeType === 'attachment' || node.nodeType === 'unresolved' || node.nodeType === 'tag';
}
