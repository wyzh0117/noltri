/**
 * The capture pipeline — V1_DEVELOPMENT §9, in this exact order:
 *
 *   validate -> save RawSource -> mark processing -> extract -> normalize -> embed (one batch call)
 *          -> similarity search -> classify -> persist -> CaptureResult
 *
 * The RawSource write is the first repository call of the whole run and happens before any provider
 * touch, so an AI failure can never lose the user's material. Any provider throw after that point is
 * recorded as processing_status = "failed" with a trimmed error_reason and answered with a CaptureResult
 * instead of an exception.
 */
import type { CaptureRequest, CaptureResult, CaptureResultItem, RawSource } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { clamp01, ERROR_REASON_MAX_CHARS, roundConfidence } from '../types';
import type { ClassifyResult } from '@noltri/ai-provider';
import { assertDecisionUsable, buildCandidates, classifyPoint } from './classify';
import { normalizePoints, type NormalizedPoint } from './normalize';
import { callProvider, isProviderFailure } from './provider';
import { persistPoint, resolveNodeChain, sanitizePath, type EmbedSeed } from './persist';
import { errorReasonOf, sourceLabelFor, validateCaptureRequest } from './validate';
import { findSimilarForPoint, type PointSimilarity } from './similarity';

const RESULT_REASON_MAX_CHARS = 2000;

function failedResult(rawSourceId: string, reason: string): CaptureResult {
  return {
    rawSourceId,
    items: [],
    processingStatus: 'failed',
    errorReason: truncate(reason, RESULT_REASON_MAX_CHARS),
  };
}

async function markFailed(deps: CoreDeps, userId: string, rawSourceId: string, reason: string): Promise<void> {
  try {
    await deps.repository.updateRawSourceProcessing(
      rawSourceId,
      userId,
      'failed',
      truncate(reason, ERROR_REASON_MAX_CHARS),
    );
  } catch (error) {
    // The RawSource row itself is already safe; a bookkeeping failure must not replace the cause.
    deps.logger.error('could not mark RawSource as failed', { rawSourceId, reason: errorReasonOf(error) });
  }
}

export async function runCapture(deps: CoreDeps, actor: ActorContext, input: CaptureRequest): Promise<CaptureResult> {
  // Step 1: validate. Step 2: save the RawSource FIRST — before any AI call exists in this function.
  const request = validateCaptureRequest(input);
  const source = await deps.repository.createRawSource({
    userId: actor.userId,
    rawText: request.text.trim(),
    surroundingContext: request.surroundingContext ?? null,
    sourceType: request.source.type,
    sourcePlatform: request.source.platform ?? null,
    sourceApp: request.source.appName ?? null,
    sourceTitle: request.source.title ?? null,
    sourceUrl: request.source.url ?? null,
    capturedAt: request.capture.capturedAt,
    metadata: {
      client: request.capture.client,
      deviceId: request.capture.deviceId ?? null,
      entryPoint: 'knowledge-core',
    },
  });

  return processSource(deps, actor, source);
}

export async function retryCapture(deps: CoreDeps, actor: ActorContext, rawSourceId: string): Promise<CaptureResult> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  if (source === null) {
    throw knowledgeError('not_found', `原始来源 ${rawSourceId} 不存在 / RawSource not found`);
  }
  // Re-runs extraction onward from the stored raw text; the original row is never duplicated.
  return processSource(deps, actor, source);
}

async function processSource(deps: CoreDeps, actor: ActorContext, source: RawSource): Promise<CaptureResult> {
  try {
    return await compileSource(deps, actor, source);
  } catch (error) {
    const reason = errorReasonOf(error);
    await markFailed(deps, actor.userId, source.id, reason);
    if (isProviderFailure(error)) {
      deps.logger.warn('capture processing failed, RawSource preserved', {
        rawSourceId: source.id,
        reason,
      });
      return failedResult(source.id, reason);
    }
    throw error;
  }
}

async function compileSource(deps: CoreDeps, actor: ActorContext, source: RawSource): Promise<CaptureResult> {
  // Step 3.
  await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'processing');

  // Step 4: extraction. The provider only ever reads the text; it is never written back.
  const extracted = await callProvider('extractKnowledge', deps, () =>
    deps.provider.extractKnowledge({
      text: source.rawText,
      ...(source.surroundingContext ? { surroundingContext: source.surroundingContext } : {}),
      sourceLabel: sourceLabelFor(source),
      sourceType: source.sourceType,
      maxItems: deps.config.maxItemsPerCapture,
    }),
  );

  // Step 5.
  const points = normalizePoints(extracted.items ?? [], deps.config.maxItemsPerCapture);
  if (points.length === 0) {
    await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'done');
    return { rawSourceId: source.id, items: [], processingStatus: 'done' };
  }

  // Step 6: one batched embed call for every point of this capture.
  const vectors = await embedPoints(deps, points);

  // Steps 7-9 run per point and in order, so a later point can reuse a node an earlier point created.
  const items: CaptureResultItem[] = [];
  for (const [index, point] of points.entries()) {
    const embedding = vectors[index];
    if (embedding === undefined) {
      throw knowledgeError('provider_error', `embed 未返回第 ${String(index + 1)} 个向量 / embedding missing`);
    }
    items.push(await placePoint(deps, actor, source.id, point, embedding, await findSimilarForPoint(deps, actor.userId, embedding, source.id)));
  }

  // Step 10.
  await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'done');
  return { rawSourceId: source.id, items, processingStatus: 'done' };
}

async function embedPoints(deps: CoreDeps, points: readonly NormalizedPoint[]): Promise<number[][]> {
  const texts = points.map((point) => point.text);
  const vectors = await callProvider('embed', deps, () => deps.provider.embed(texts));

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw knowledgeError('provider_error', 'embed 返回数量与文本数量不一致 / embed returned a mismatched vector count');
  }

  return vectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((axis) => !Number.isFinite(axis))) {
      throw knowledgeError('provider_error', `第 ${String(index + 1)} 个向量无效 / embedding is not a finite vector`);
    }
    if (vector.length !== deps.config.embeddingDim) {
      deps.logger.warn('embedding dimension differs from AI_EMBEDDING_DIM', {
        received: vector.length,
        configured: deps.config.embeddingDim,
      });
    }
    return vector;
  });
}

async function placePoint(
  deps: CoreDeps,
  actor: ActorContext,
  rawSourceId: string,
  point: NormalizedPoint,
  embedding: number[],
  similarity: PointSimilarity,
): Promise<CaptureResultItem> {
  const { thresholds } = deps.config;
  const attachBar = thresholds.similarityAttachThreshold;
  const seed: EmbedSeed = { embedding, model: deps.config.ai.embedModel };

  // Dedupe rule first: a near-duplicate of an existing item joins that item's node and is reported as
  // "merged". The pre-existing item and its RawSource are left untouched (PROJECT_MASTER §2.2, §3.3).
  const nearestItem = similarity.nearestItem;
  if (nearestItem !== null && nearestItem.nodeId !== null && nearestItem.score >= attachBar) {
    const persisted = await persistPoint(deps, actor, {
      rawSourceId,
      point,
      embedding,
      targetNodeId: nearestItem.nodeId,
      action: 'merged',
      linkConfidence: roundConfidence(Math.max(point.confidence, nearestItem.score)),
      provenanceNodeId: null,
      relatedNodeId: null,
    });
    return persisted.result;
  }

  const { candidates } = await buildCandidates(deps, actor.userId, similarity.nodeMatches);
  const decision = await classifyPoint(deps, { itemText: point.text, suggestedTitle: point.title, candidates });
  assertDecisionUsable(deps, decision);

  const provenanceNodeId =
    nearestItem !== null && nearestItem.score >= deps.config.similarEdgeThreshold ? nearestItem.nodeId : null;
  const nearestNode = similarity.nearestNode;
  const relatedNodeId =
    nearestNode !== null && nearestNode.score >= deps.config.similarEdgeThreshold ? nearestNode.nodeId : null;

  if (decision.action === 'attach') {
    const target = await deps.repository.findNode(String(decision.nodeId), actor.userId);
    if (target !== null && target.status !== 'archived') {
      const persisted = await persistPoint(deps, actor, {
        rawSourceId,
        point,
        embedding,
        targetNodeId: target.id,
        action: 'attached',
        linkConfidence: roundConfidence(clamp01(decision.confidence)),
        provenanceNodeId: provenanceNodeId === target.id ? null : provenanceNodeId,
        relatedNodeId: relatedNodeId === target.id ? null : relatedNodeId,
      });
      return persisted.result;
    }
    deps.logger.warn('classification pointed at a missing node, creating from the suggested path', {
      nodeId: String(decision.nodeId),
    });
  }

  const titles = sanitizePath(pathOf(decision, point), point.title);
  const resolved = await resolveNodeChain(
    deps,
    actor,
    titles,
    seed,
    roundConfidence(clamp01(point.confidence)),
  );

  const persisted = await persistPoint(deps, actor, {
    rawSourceId,
    point,
    embedding,
    targetNodeId: resolved.node.id,
    // Nothing was created when the whole path already existed: that is an attach, not a create.
    action: resolved.createdNodeIds.length > 0 ? 'created' : 'attached',
    linkConfidence: roundConfidence(Math.min(clamp01(point.confidence), clamp01(decision.confidence))),
    provenanceNodeId: provenanceNodeId === resolved.node.id ? null : provenanceNodeId,
    relatedNodeId: relatedNodeId === resolved.node.id ? null : relatedNodeId,
  });
  return persisted.result;
}

function pathOf(decision: ClassifyResult, point: NormalizedPoint): string[] {
  const provided = decision.newNodePath ?? [];
  const fallback = decision.newNodeTitle ?? point.title;
  return provided.length > 0 ? [...provided] : [fallback];
}
