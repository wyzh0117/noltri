import type { KnowledgeNode } from '@noltri/schema';

/** Present legacy root/branch domains using the discipline vocabulary without changing storage. */
export function taxonomyNodeType(node: KnowledgeNode, nodesById: ReadonlyMap<string, KnowledgeNode>): string {
  if (node.nodeType !== 'domain') return node.nodeType;
  if (node.parentId === null) return 'discipline';

  const parent = nodesById.get(node.parentId);
  return parent?.nodeType === 'discipline' || (parent?.nodeType === 'domain' && parent.parentId === null)
    ? 'subdiscipline'
    : 'domain';
}

/** Keep one-level paths as root topics; deeper paths use discipline, subdiscipline, then domains. */
export function nodeTypeForPath(index: number, length: number): string {
  if (index === length - 1) return 'topic';
  if (index === 0) return 'discipline';
  if (index === 1) return 'subdiscipline';
  return 'domain';
}
