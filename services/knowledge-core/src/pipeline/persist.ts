/**
 * Step 8 of the pipeline: persist.
 *
 * Invariants enforced here:
 *  - a node title is reused when the same (trimmed, case-insensitive) title already exists under the
 *    same parent, so the tree never duplicates a concept because of a capitalisation difference;
 *  - every created node gets a VersionRecord, so structural growth is auditable and reversible
 *    (PROJECT_MASTER §2.4);
 *  - an existing KnowledgeItem and its RawSource are never rewritten: a near-duplicate produces a
 *    new item row that is *linked* to the same node (PROJECT_MASTER §2.2, §3.3).
 */
import type {
  CaptureAction,
  CaptureResultItem,
  ItemLinkRelation,
  JsonValue,
  KnowledgeItem,
  KnowledgeNode,
  NodeStatus,
} from '@noltri/schema';
import { tierForConfidence } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { MAX_NODE_PATH_DEPTH, roundConfidence } from '../types';
import type { NormalizedPoint } from './normalize';

export interface EmbedSeed {
  readonly embedding: number[];
  readonly model: string;
}

export interface ResolvedNode {
  readonly node: KnowledgeNode;
  /** Nodes actually created while resolving this chain (empty when every level was reused). */
  readonly createdNodeIds: string[];
  readonly pathTitles: string[];
}

/**
 * Title identity for the dedupe rule: trimmed, inner whitespace collapsed. The repository matches on
 * trim + lowercase; normalising here as well means a model that answers `  brewing   ratio ` reuses the
 * `Brewing Ratio` node instead of duplicating it (PROJECT_MASTER §3.3 "同层同名去重").
 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/gu, ' ');
}

/** Keeps a provider-supplied path usable: strings only, normalised, depth-capped. */
export function sanitizePath(rawTitles: readonly string[], fallbackTitle: string): string[] {
  const cleaned = rawTitles
    .map((title) => (typeof title === 'string' ? normalizeTitle(title) : ''))
    .filter((title) => title.length > 0)
    .slice(0, MAX_NODE_PATH_DEPTH);
  if (cleaned.length > 0) return cleaned;
  const single = normalizeTitle(fallbackTitle);
  return single.length > 0 ? [single] : [];
}

/**
 * Find-or-create one node per path level, root first, so a multi-level classification answer grows a
 * correct ancestor chain instead of dropping an orphan leaf.
 */
export async function resolveNodeChain(
  deps: CoreDeps,
  actor: ActorContext,
  titles: readonly string[],
  seed: EmbedSeed,
  confidence: number,
): Promise<ResolvedNode> {
  if (titles.length === 0) {
    throw knowledgeError('provider_error', '分类结果没有可用的节点路径 / classification returned an empty node path');
  }

  const createdNodeIds: string[] = [];
  let parentId: string | null = null;

  for (const [index, rawTitle] of titles.entries()) {
    const title = truncate(rawTitle, 200).trim();
    const isLeaf = index === titles.length - 1;
    const existing = await deps.repository.findNodeByTitle(actor.userId, title, parentId);

    if (existing !== null) {
      if (isLeaf) {
        return { node: existing, createdNodeIds, pathTitles: await pathTitlesFor(deps, actor, existing.id) };
      }
      parentId = existing.id;
      continue;
    }

    const created = await deps.repository.createNode({
      userId: actor.userId,
      title,
      // Ancestors are the domains the model named; the leaf is the new topic.
      summary: null,
      nodeType: isLeaf ? 'topic' : 'domain',
      parentId,
      confidence: roundConfidence(confidence),
      embedding: seed.embedding,
      embeddingModel: seed.model,
      embeddingStatus: 'ready',
    });

    if (parentId !== null) {
      await deps.repository.createEdge({
        userId: actor.userId,
        fromNodeId: created.id,
        toNodeId: parentId,
        relationType: 'part_of',
        confidence: 1,
        source: 'tree_structure',
      });
    }

    const before: JsonValue = {};
    const after: JsonValue = { title: created.title, parentId: created.parentId, nodeType: created.nodeType };
    await deps.repository.createVersionRecord({
      userId: actor.userId,
      entityType: 'knowledge_node',
      entityId: created.id,
      operation: 'create',
      before,
      after,
      actor: actor.actor,
    });

    createdNodeIds.push(created.id);
    if (isLeaf) {
      return { node: created, createdNodeIds, pathTitles: await pathTitlesFor(deps, actor, created.id) };
    }
    parentId = created.id;
  }

  throw knowledgeError('internal_error', '节点链解析未到达叶子节点 / node chain resolution did not reach a leaf');
}

export async function pathTitlesFor(deps: CoreDeps, actor: ActorContext, nodeId: string): Promise<string[]> {
  const path = await deps.repository.nodePath(actor.userId, nodeId);
  return path.map((segment) => segment.title);
}

export interface PersistArgs {
  readonly rawSourceId: string;
  readonly point: NormalizedPoint;
  readonly embedding: number[];
  readonly targetNodeId: string;
  readonly action: CaptureAction;
  readonly linkConfidence: number;
  /** Existing node holding the nearest similar item; written as `derived_from`. */
  readonly provenanceNodeId: string | null;
  /** Nearest existing node above the related-edge bar; written as `similar_to`. */
  readonly relatedNodeId: string | null;
}

export interface PersistedPoint {
  readonly item: KnowledgeItem;
  readonly result: CaptureResultItem;
}

export async function persistPoint(
  deps: CoreDeps,
  actor: ActorContext,
  args: PersistArgs,
): Promise<PersistedPoint> {
  const { config } = deps;
  const confidence = roundConfidence(args.linkConfidence);

  const item = await deps.repository.createKnowledgeItem({
    userId: actor.userId,
    rawSourceId: args.rawSourceId,
    normalizedText: args.point.text,
    summary: args.point.summary,
    confidence: args.point.confidence,
    embedding: args.embedding,
    embeddingModel: config.ai.embedModel,
    embeddingStatus: 'ready',
    isAiDerived: true,
  });

  const relationType: ItemLinkRelation = args.action === 'merged' ? 'supports' : 'primary';
  await deps.repository.linkItemToNode({
    userId: actor.userId,
    itemId: item.id,
    nodeId: args.targetNodeId,
    relationType,
    confidence,
  });

  await writeEdge(deps, actor, args.targetNodeId, args.provenanceNodeId, 'derived_from', confidence);
  await writeEdge(deps, actor, args.targetNodeId, args.relatedNodeId, 'similar_to', confidence);

  return {
    item,
    result: {
      knowledgeItemId: item.id,
      text: item.normalizedText,
      nodeId: args.targetNodeId,
      nodePath: await pathTitlesFor(deps, actor, args.targetNodeId),
      action: args.action,
      confidence,
      confidenceTier: tierForConfidence(confidence, config.thresholds),
    },
  };
}

/** Edges are the V2 graph seam: they carry relations that `parent_id` alone cannot express. */
async function writeEdge(
  deps: CoreDeps,
  actor: ActorContext,
  fromNodeId: string,
  toNodeId: string | null,
  relationType: 'derived_from' | 'similar_to',
  confidence: number,
): Promise<void> {
  if (toNodeId === null || toNodeId === fromNodeId) return;
  const target = await deps.repository.findNode(toNodeId, actor.userId);
  if (target === null || target.status !== 'active') return;
  await deps.repository.createEdge({
    userId: actor.userId,
    fromNodeId,
    toNodeId,
    relationType,
    confidence,
    source: relationType === 'similar_to' ? 'similarity_engine' : 'capture_provenance',
  });
}

export function statusIsUsable(status: NodeStatus): boolean {
  return status !== 'archived';
}
