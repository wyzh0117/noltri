/**
 * Step 6 of the pipeline: similarity search over existing knowledge.
 *
 * Two searches per point: nearest KnowledgeItems (the merge signal) and nearest KnowledgeNodes
 * (the classification candidates). Both exclude the RawSource currently being processed, otherwise a
 * capture would match the items it just wrote and merge into itself.
 */
import type { ProcessingStatus } from '@noltri/schema';
import type { ItemVectorMatch, NodeVectorMatch, VectorSearchOptions } from '@noltri/storage';
import type { CoreDeps } from '../types';

export interface PointSimilarity {
  readonly itemMatches: ItemVectorMatch[];
  readonly nodeMatches: NodeVectorMatch[];
  readonly nearestItem: ItemVectorMatch | null;
  readonly nearestNode: NodeVectorMatch | null;
}

const EMPTY: PointSimilarity = { itemMatches: [], nodeMatches: [], nearestItem: null, nearestNode: null };

/** A failed capture must not shadow a later retry with the half-written rows of its own attempt. */
const STATUS_EXCLUDE: ProcessingStatus[] = ['failed'];

export async function findSimilarForPoint(
  deps: CoreDeps,
  userId: string,
  embedding: number[],
  excludeRawSourceId: string,
): Promise<PointSimilarity> {
  const { thresholds } = deps.config;
  const options: VectorSearchOptions = {
    limit: thresholds.similaritySearchLimit,
    excludeRawSourceId,
    statusExclude: STATUS_EXCLUDE,
  };

  const itemMatches = await deps.repository.searchSimilarItems(userId, embedding, options);
  const nodeMatches = await deps.repository.searchSimilarNodes(userId, embedding, options);

  const items = itemMatches.filter((match) => match.score >= 0);
  const nodes = nodeMatches.filter((match) => match.score >= 0);

  return {
    itemMatches: items,
    nodeMatches: nodes,
    nearestItem: items[0] ?? null,
    nearestNode: nodes[0] ?? null,
  };
}

export function emptySimilarity(): PointSimilarity {
  return EMPTY;
}
