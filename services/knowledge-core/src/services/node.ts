/**
 * Node Engine (V1_DEVELOPMENT §8 GET /api/nodes/:id, PATCH /api/nodes/:id and §17.2).
 *
 * V1 node detail is deliberately small — title, summary, item count, source count, related nodes —
 * conflicts / gaps / history / provenance detail stay in V2.
 */
import type {
  JsonValue,
  KnowledgeItem,
  KnowledgeNode,
  NodeDetail,
  NodeKnowledgeItem,
  NodeSourceSummary,
  PatchNodeRequest,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import { capText, type ActorContext, type CoreDeps } from '../types';

/** Shape of `relatedNodeSchema`; the contract exports the schema but not an alias for it. */
export type RelatedNodeView = NodeDetail['relatedNodes'][number];

function toSourceSummary(source: {
  id: string;
  sourceType: NodeSourceSummary['sourceType'];
  sourcePlatform: string | null;
  sourceApp: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  capturedAt: string;
}): NodeSourceSummary {
  return {
    rawSourceId: source.id,
    sourceType: source.sourceType,
    sourcePlatform: source.sourcePlatform,
    sourceApp: source.sourceApp,
    sourceTitle: source.sourceTitle,
    sourceUrl: source.sourceUrl,
    capturedAt: source.capturedAt,
  };
}

export async function getNodeDetail(deps: CoreDeps, actor: ActorContext, nodeId: string): Promise<NodeDetail> {
  const node = await deps.repository.findNode(nodeId, actor.userId);
  if (node === null) {
    throw knowledgeError('not_found', `节点 ${nodeId} 不存在 / node not found`);
  }

  const [path, items, children, edges, stats] = await Promise.all([
    deps.repository.nodePath(actor.userId, nodeId),
    deps.repository.listKnowledgeItemsForNode(nodeId, actor.userId),
    deps.repository.listChildNodes(actor.userId, nodeId),
    deps.repository.listEdgesForNode(actor.userId, nodeId),
    deps.repository.nodeStats(actor.userId, nodeId),
  ]);

  // One batched read for every source this node touches; sources are deduped by rawSourceId.
  const sourceIds = [...new Set(items.map((item) => item.rawSourceId))];
  const sources = await deps.repository.listRawSourcesByIds(sourceIds, actor.userId);
  const summaryById = new Map(sources.map((source) => [source.id, toSourceSummary(source)]));

  const nodeItems: NodeKnowledgeItem[] = items.map((item) => {
    const summary = summaryById.get(item.rawSourceId);
    // §435: a capped client reads a node detail whose text is capped, not the stored row.
    const visible: KnowledgeItem = {
      ...item,
      normalizedText: capText(actor, item.normalizedText),
      summary: item.summary === null ? null : capText(actor, item.summary),
    };
    return { item: visible, sources: summary === undefined ? [] : [summary] };
  });

  const relatedNodes: RelatedNodeView[] = [];
  for (const edge of edges) {
    const otherId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
    if (otherId === nodeId) continue;
    const other = await deps.repository.findNode(otherId, actor.userId);
    if (other === null || other.status === 'archived') continue;
    if (relatedNodes.some((entry) => entry.node.id === other.id && entry.relationType === edge.relationType)) continue;
    relatedNodes.push({ node: other, relationType: edge.relationType, confidence: edge.confidence });
  }
  relatedNodes.sort((first, second) => {
    const byConfidence = (second.confidence ?? 0) - (first.confidence ?? 0);
    if (byConfidence !== 0) return byConfidence;
    return first.node.title.localeCompare(second.node.title, 'zh-Hans-CN');
  });

  return { node, path, items: nodeItems, children, relatedNodes, stats };
}

/**
 * PATCH applies title / summary / status only — the frozen V1 contract.
 * A title change is a rename and writes a VersionRecord, so it stays reversible (§2.4).
 *
 * Archiving also has to answer for research (R03): 证据 that cite this node keep pointing at it — the id
 * is never re-bound to other text — and get a 复核标记 along with the 论点 they support. Restoring does
 * *not* clear those marks; a 证据 whose 出处 came back still needs the user's second look, and 「恢复不误报为
 * 已核验」 is what the mark staying `pending` means.
 */
export async function patchNode(
  deps: CoreDeps,
  actor: ActorContext,
  nodeId: string,
  patch: PatchNodeRequest,
): Promise<KnowledgeNode> {
  const existing = await deps.repository.findNode(nodeId, actor.userId);
  if (existing === null) {
    throw knowledgeError('not_found', `节点 ${nodeId} 不存在 / node not found`);
  }

  const title = patch.title?.trim();
  const nextTitle = title === undefined || title.length === 0 ? existing.title : title;
  const renamed = nextTitle !== existing.title;
  const statusChanged = patch.status !== undefined && patch.status !== existing.status;

  // Before the write, because the alternative is an archived node whose 引用 were never marked — and a
  // mark raised twice is one refreshed row, so a retry after a failed archive costs nothing. A host with
  // no research wiring has nothing to mark and archives anyway (contract §2).
  if (statusChanged && patch.status === 'archived' && deps.research !== undefined) {
    await deps.research.markSourceArchived(actor.userId, { nodeId, sourceTitle: nextTitle });
  }

  const updated = await deps.repository.updateNode({
    id: nodeId,
    userId: actor.userId,
    ...(patch.title === undefined ? {} : { title: nextTitle }),
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
  });

  const operation = renamed
    ? 'rename'
    : statusChanged
      ? updated.status === 'archived'
        ? 'archive'
        : 'restore'
      : null;

  if (operation !== null) {
    const before: JsonValue = { title: existing.title, summary: existing.summary, status: existing.status };
    const after: JsonValue = { title: updated.title, summary: updated.summary, status: updated.status };
    await deps.repository.createVersionRecord({
      userId: actor.userId,
      entityType: 'knowledge_node',
      entityId: updated.id,
      operation,
      before,
      after,
      actor: actor.actor,
    });
  } else {
    deps.logger.debug('summary-only patch: no structure operation to version', { nodeId });
  }

  return updated;
}
