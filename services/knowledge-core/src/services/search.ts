/**
 * Search Engine (V1_DEVELOPMENT §8 POST /api/search): semantic + keyword, merged.
 *
 * Hybrid rule: the strongest single channel wins as the score (cosine and keyword overlap are both
 * normalised to 0..1), and a hit found by both channels is ordered above a single-channel hit at the
 * same score. Nodes are returned for keyword-only node matches, which is how an empty but real topic
 * stays findable.
 */
import type { NodeSourceSummary, SearchHit, SearchMode, SearchRequest, SearchResponse } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import { clamp01, capText, type ActorContext, type CoreDeps } from '../types';
import { callProvider } from '../pipeline/provider';

const MAX_SEARCH_LIMIT = 50;

interface Channel {
  semantic?: number;
  keyword?: number;
  itemId: string | null;
  nodeId: string | null;
  title: string;
  text: string;
}

function itemKey(itemId: string): string {
  return `item:${itemId}`;
}

function nodeKey(nodeId: string): string {
  return `node:${nodeId}`;
}

async function subtreeIds(deps: CoreDeps, actor: ActorContext, scopeNodeId: string): Promise<Set<string>> {
  const nodes = await deps.repository.listNodes(actor.userId);
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const bucket = childrenOf.get(node.parentId) ?? [];
    bucket.push(node.id);
    childrenOf.set(node.parentId, bucket);
  }
  const allowed = new Set<string>([scopeNodeId]);
  const queue = [scopeNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of childrenOf.get(current) ?? []) {
      if (allowed.has(child)) continue;
      allowed.add(child);
      queue.push(child);
    }
  }
  return allowed;
}

export async function search(deps: CoreDeps, actor: ActorContext, request: SearchRequest): Promise<SearchResponse> {
  const mode: SearchMode = request.mode ?? 'hybrid';
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, request.limit ?? deps.config.searchDefaultLimit));
  const query = request.query.trim();
  if (query.length === 0) {
    throw knowledgeError('invalid_request', '搜索词不能为空 / query must not be blank');
  }

  const allowed = request.scopeNodeId === undefined ? null : await subtreeIds(deps, actor, request.scopeNodeId);
  const merged = new Map<string, Channel>();

  if (deps.config.embeddingEnabled && (mode === 'semantic' || mode === 'hybrid')) {
    const vectors = await callProvider('embed', deps, () => deps.provider.embed([query]));
    const embedding = vectors[0];
    if (embedding === undefined) {
      throw knowledgeError('provider_error', 'embed 未返回查询向量 / embed returned no query vector');
    }
    const matches = await deps.repository.searchSimilarItems(actor.userId, embedding, {
      limit: MAX_SEARCH_LIMIT,
    });
    for (const match of matches) {
      const channel = merged.get(itemKey(match.itemId)) ?? { itemId: match.itemId, nodeId: match.nodeId, title: '', text: '' };
      channel.semantic = clamp01(match.score);
      if (match.nodeId !== null) channel.nodeId = match.nodeId;
      if (channel.text.length === 0) channel.text = match.text;
      merged.set(itemKey(match.itemId), channel);
    }
  }

  if (mode === 'keyword' || mode === 'hybrid' || !deps.config.embeddingEnabled) {
    const matches = await deps.repository.searchKeyword(actor.userId, query, { limit: MAX_SEARCH_LIMIT });
    for (const match of matches) {
      const key = match.itemId !== null ? itemKey(match.itemId) : nodeKey(String(match.nodeId));
      const channel = merged.get(key) ?? { itemId: match.itemId, nodeId: match.nodeId, title: '', text: '' };
      channel.keyword = clamp01(match.score);
      if (match.nodeId !== null) channel.nodeId = match.nodeId;
      if (channel.text.length === 0) channel.text = match.text;
      if (channel.title.length === 0) channel.title = match.title;
      // A node without a summary still needs something readable in the result row.
      if (channel.text.length === 0) channel.text = match.title;
      merged.set(key, channel);
    }
  }

  // Item summaries and sources are resolved in two batched reads, never per hit.
  const itemIds = [...merged.values()].map((channel) => channel.itemId).filter((id): id is string => id !== null);
  const items = await deps.repository.listKnowledgeItemsByIds(itemIds, actor.userId);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const sources = await deps.repository.listRawSourcesByIds(
    [...new Set(items.map((item) => item.rawSourceId))],
    actor.userId,
  );
  const sourceById = new Map<string, NodeSourceSummary>(
    sources.map((source) => [
      source.id,
      {
        rawSourceId: source.id,
        sourceType: source.sourceType,
        sourcePlatform: source.sourcePlatform,
        sourceApp: source.sourceApp,
        sourceTitle: source.sourceTitle,
        sourceUrl: source.sourceUrl,
        capturedAt: source.capturedAt,
      },
    ]),
  );

  const hits: SearchHit[] = [];
  for (const channel of merged.values()) {
    if (allowed !== null && (channel.nodeId === null || !allowed.has(channel.nodeId))) continue;

    const item = channel.itemId === null ? null : itemById.get(channel.itemId) ?? null;
    if (channel.itemId !== null && item === null) continue;

    const score = clamp01(Math.max(channel.semantic ?? 0, channel.keyword ?? 0));
    if (score <= 0) continue;

    const matchedBy: SearchHit['matchedBy'] =
      channel.semantic !== undefined && channel.keyword !== undefined
        ? 'both'
        : channel.semantic !== undefined
          ? 'semantic'
          : 'keyword';

    const text = capText(actor, item !== null ? item.normalizedText : channel.text);
    hits.push({
      itemId: channel.itemId,
      nodeId: channel.nodeId,
      title:
        item !== null
          ? item.summary ?? truncate(item.normalizedText, 40)
          : channel.title.length > 0
            ? channel.title
            : truncate(channel.text, 40),
      text,
      score: Number(score.toFixed(4)),
      matchedBy,
      source: item === null ? null : sourceById.get(item.rawSourceId) ?? null,
    });
  }

  const rank = (hit: SearchHit): number => (hit.matchedBy === 'both' ? 1 : 0);
  hits.sort((first, second) => {
    if (second.score !== first.score) return second.score - first.score;
    if (rank(second) !== rank(first)) return rank(second) - rank(first);
    const byTitle = first.title.localeCompare(second.title, 'zh-Hans-CN');
    if (byTitle !== 0) return byTitle;
    return String(first.itemId ?? first.nodeId ?? '').localeCompare(String(second.itemId ?? second.nodeId ?? ''));
  });

  return { query: request.query, mode, hits: hits.slice(0, limit) };
}
