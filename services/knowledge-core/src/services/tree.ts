/**
 * Tree Engine (V1_DEVELOPMENT §8 GET /api/tree).
 *
 * The tree is the product's primary surface (PROJECT_MASTER §2.1), so it is built from node
 * structure first: a node with zero items is still structure and must be returned.
 */
import type { KnowledgeNode, TreeQuery, TreeResponse, TreeNode } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { taxonomyNodeType } from '../node-taxonomy';

/** Structural limit, not a knowledge threshold: V1 never renders more than six levels. */
export const MAX_TREE_DEPTH = 6;

function compareStable(first: KnowledgeNode, second: KnowledgeNode): number {
  const byTitle = first.title.localeCompare(second.title, 'zh-Hans-CN');
  if (byTitle !== 0) return byTitle;
  const byCreated = first.createdAt.localeCompare(second.createdAt);
  if (byCreated !== 0) return byCreated;
  return first.id.localeCompare(second.id);
}

export async function getTree(deps: CoreDeps, actor: ActorContext, query: TreeQuery = {}): Promise<TreeResponse> {
  const requestedDepth = query.depth ?? deps.config.treeDefaultDepth;
  const depth = Math.min(MAX_TREE_DEPTH, Math.max(1, Math.trunc(requestedDepth)));

  const nodes = await deps.repository.listNodes(actor.userId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts = await deps.repository.countItemsForNodes(
    actor.userId,
    nodes.map((node) => node.id),
  );

  const childMap = new Map<string | null, KnowledgeNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const bucket = childMap.get(parentId) ?? [];
    bucket.push(node);
    childMap.set(parentId, bucket);
  }
  for (const bucket of childMap.values()) bucket.sort(compareStable);

  const visited = new Set<string>();
  let totalNodes = 0;

  const build = (node: KnowledgeNode, level: number): TreeNode => {
    totalNodes += 1;
    const children = (childMap.get(node.id) ?? []).filter((child) => !visited.has(child.id));
    const direct = counts[node.id] ?? 0;
    const treeNode: TreeNode = {
      id: node.id,
      title: node.title,
      nodeType: taxonomyNodeType(node, byId),
      status: node.status,
      confidence: node.confidence,
      summary: node.summary,
      itemCount: direct,
      descendantItemCount: direct,
      childCount: (childMap.get(node.id) ?? []).length,
    };

    if (level >= depth || children.length === 0) {
      // At the cut level the children are summarised in descendantItemCount below: report the
      // descendants this response does not carry.
      if (level >= depth) treeNode.descendantItemCount = direct + countHiddenDescendants(node.id, childMap, counts);
      return treeNode;
    }

    visited.add(node.id);
    const built = children.map((child) => build(child, level + 1));
    treeNode.children = built;
    treeNode.descendantItemCount = direct + built.reduce((sum, child) => sum + child.descendantItemCount, 0);
    visited.delete(node.id);
    return treeNode;
  };

  if (query.rootId !== undefined) {
    const root = byId.get(query.rootId) ?? (await deps.repository.findNode(query.rootId, actor.userId));
    if (root === undefined || root === null) {
      throw knowledgeError('not_found', `节点 ${query.rootId} 不存在 / node not found`);
    }
    totalNodes = 0;
    const single = build(root, 1);
    return { rootId: root.id, nodes: [single], totalNodes };
  }

  const roots = (childMap.get(null) ?? []).slice().sort(compareStable);
  const built = roots.map((node) => build(node, 1));
  return { rootId: null, nodes: built, totalNodes };
}

function countHiddenDescendants(
  nodeId: string,
  childMap: Map<string | null, KnowledgeNode[]>,
  counts: Record<string, number>,
): number {
  let total = 0;
  const stack = [...(childMap.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current.id)) continue;
    seen.add(current.id);
    total += counts[current.id] ?? 0;
    stack.push(...(childMap.get(current.id) ?? []));
  }
  return total;
}
