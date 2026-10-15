/**
 * The capture pipeline — V1_DEVELOPMENT §9, in this exact order:
 *
 *   validate -> dedupe on (clientId, requestId) -> save RawSource -> mark processing -> extract
 *          -> normalize -> embed (one batch call) -> similarity search -> classify -> persist
 *          -> CaptureResult
 *
 * The RawSource write is the first repository call of the whole run and happens before any provider
 * touch, so an AI failure can never lose the user's material. Any provider throw after that point is
 * recorded as processing_status = "failed" with a trimmed error_reason and answered with a CaptureResult
 * instead of an exception.
 *
 * A resend of the same key never re-enters the provider and never writes a second row: it reports the
 * stage the stored source reached (本地桌面版开发文档 §7.4).
 */
import type {
  CaptureRequest,
  CaptureResult,
  CaptureResultItem,
  CaptureStage,
  ProcessingStatus,
  RawSource,
} from '@noltri/schema';
import { libraryMetadataSchema, tierForConfidence } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { clamp01, ERROR_REASON_MAX_CHARS, roundConfidence } from '../types';
import type { ClassifyResult } from '@noltri/ai-provider';
import { assertDecisionUsable, buildCandidates, classifyPoint } from './classify';
import { normalizePoints, type NormalizedPoint } from './normalize';
import { callProvider, isProviderFailure } from './provider';
import { persistPoint, resolveNodeChain, sanitizePath, type EmbedSeed } from './persist';
import { errorReasonOf, sourceLabelFor, validateCaptureRequest } from './validate';
import { emptySimilarity, findSimilarForPoint, type PointSimilarity } from './similarity';

const RESULT_REASON_MAX_CHARS = 2000;

interface ResultInput {
  source: RawSource;
  stage: CaptureStage;
  processingStatus: ProcessingStatus;
  duplicate: boolean;
  items?: readonly CaptureResultItem[];
  errorReason?: string;
}

/**
 * One place builds the reply so no branch can return a CaptureResult that the schema would reject.
 * A row written before P3 has no key to echo, and an empty string says exactly that — the alternative,
 * inventing an id for a capture that never stated one, would let a later resend look like a replay.
 */
function captureResult(input: ResultInput): CaptureResult {
  return {
    rawSourceId: input.source.id,
    requestId: input.source.requestId ?? '',
    stage: input.stage,
    duplicate: input.duplicate,
    items: [...(input.items ?? [])],
    processingStatus: input.processingStatus,
    ...(input.errorReason === undefined
      ? {}
      : { errorReason: truncate(input.errorReason, RESULT_REASON_MAX_CHARS) }),
  };
}

/** The client half of the idempotency key: an install id when the entry point has one, else its kind. */
function clientIdOf(request: CaptureRequest): string {
  return request.capture.deviceId ?? request.capture.client;
}

/**
 * 需要复核 is a threshold statement, not a model confession: any filed link that fell below the medium
 * bar is a placement a human should look at. Read off the tiers the pipeline itself named, so the stage
 * and the per-item tiers can never disagree.
 */
function stageOfItems(items: readonly CaptureResultItem[]): CaptureStage {
  return items.some((item) => item.confidenceTier === 'low') ? 'needs_review' : 'completed';
}

/**
 * The same judgement for a replay, rebuilt from the links that are stored rather than from the decisions
 * that are not: `action` never was persisted and `knowledge_items.confidence` holds the extraction
 * confidence, not the placement confidence the tier was named from, so the links are the only numbers
 * that reproduce what the fresh run reported. A replay therefore states the outcome and points at the
 * source instead of echoing items.
 */
async function stageOfStoredLinks(deps: CoreDeps, actor: ActorContext, source: RawSource): Promise<CaptureStage> {
  const items = await deps.repository.listKnowledgeItemsForSource(source.id, actor.userId);
  for (const item of items) {
    const links = await deps.repository.listLinksForItem(item.id, actor.userId);
    for (const link of links) {
      if (tierForConfidence(link.confidence, deps.config.thresholds) === 'low') return 'needs_review';
    }
  }
  return 'completed';
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
  const requestId = request.requestId;
  const clientId = clientIdOf(request);

  const stored = await deps.repository.findRawSourceByIdempotencyKey(actor.userId, clientId, requestId);
  if (stored !== null) return replaySource(deps, actor, stored);

  let source: RawSource;
  try {
    source = await deps.repository.createRawSource({
      userId: actor.userId,
      rawText: request.text,
      surroundingContext: request.surroundingContext ?? null,
      sourceType: request.source.type,
      sourcePlatform: request.source.platform ?? null,
      sourceApp: request.source.appName ?? null,
      sourceTitle: request.source.title ?? null,
      sourceUrl: request.source.url ?? null,
      capturedAt: request.capture.capturedAt,
      requestId,
      clientId,
      metadata: {
        client: request.capture.client,
        deviceId: request.capture.deviceId ?? null,
        entryPoint: 'knowledge-core',
        ...(request.library ? { library: request.library } : {}),
      },
    });
  } catch (error) {
    // Two entry points raced on one key: the loser adopts the winner's row instead of failing the user.
    const raced = await deps.repository.findRawSourceByIdempotencyKey(actor.userId, clientId, requestId);
    if (raced === null) throw error;
    deps.logger.warn('capture key raced onto an existing source, replaying it', { rawSourceId: raced.id, clientId });
    return replaySource(deps, actor, raced);
  }

  return processSource(deps, actor, source, false);
}

export async function retryCapture(deps: CoreDeps, actor: ActorContext, rawSourceId: string): Promise<CaptureResult> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  if (source === null) {
    throw knowledgeError('not_found', `原始来源 ${rawSourceId} 不存在 / RawSource not found`);
  }
  // Re-runs extraction onward from the stored raw text; the original row is never duplicated. A retry is
  // an explicit human action on a known row, so it is not a replay of a key and says so.
  return processSource(deps, actor, source, false);
}

/**
 * What a resend of a key that already landed gets: no provider call, no second row, and the stage the
 * stored source really reached. A failed row is the one case worth working on again, so it re-enters the
 * pipeline on the same row rather than reporting the old failure.
 */
async function replaySource(deps: CoreDeps, actor: ActorContext, source: RawSource): Promise<CaptureResult> {
  deps.logger.info('capture replayed from the idempotency key', {
    rawSourceId: source.id,
    processingStatus: source.processingStatus,
  });
  switch (source.processingStatus) {
    case 'pending':
      return captureResult({ source, stage: 'saved', processingStatus: 'pending', duplicate: true });
    case 'processing':
      return captureResult({ source, stage: 'processing', processingStatus: 'processing', duplicate: true });
    case 'failed':
      return processSource(deps, actor, source, true);
    default:
      return captureResult({
        source,
        stage: await stageOfStoredLinks(deps, actor, source),
        processingStatus: 'done',
        duplicate: true,
      });
  }
}

async function processSource(
  deps: CoreDeps,
  actor: ActorContext,
  source: RawSource,
  duplicate: boolean,
): Promise<CaptureResult> {
  if (deps.provider.id === 'offline') {
    // ponytail: offline extraction made whole sentences look like academic categories; keep the source pending for a human path instead.
    deps.logger.info('capture saved for manual organization; offline provider does not classify', { rawSourceId: source.id });
    return captureResult({ source, stage: 'saved', processingStatus: 'pending', duplicate });
  }
  try {
    return await compileSource(deps, actor, source, duplicate);
  } catch (error) {
    const reason = errorReasonOf(error);
    await markFailed(deps, actor.userId, source.id, reason);
    if (isProviderFailure(error)) {
      deps.logger.warn('capture processing failed, RawSource preserved', {
        rawSourceId: source.id,
        reason,
      });
      return captureResult({
        source,
        stage: 'failed',
        processingStatus: 'failed',
        duplicate,
        errorReason: reason,
      });
    }
    throw error;
  }
}

async function compileSource(
  deps: CoreDeps,
  actor: ActorContext,
  source: RawSource,
  duplicate: boolean,
): Promise<CaptureResult> {
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
    // Nothing was extractable is a finished run, not a pending one: the row is done, and the empty item
    // list is the answer. Marking it 需要复核 would flag every punctuation-only capture.
    await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'done');
    return captureResult({ source, stage: 'completed', processingStatus: 'done', duplicate });
  }

  // Step 6: embeddings are optional; chat-only providers still extract and classify into root domains.
  const vectors = deps.config.embeddingEnabled ? await embedPoints(deps, points) : points.map(() => undefined);

  // Steps 7-9 run per point and in order, so a later point can reuse a node an earlier point created.
  const items: CaptureResultItem[] = [];
  for (const [index, point] of points.entries()) {
    const embedding = vectors[index];
    if (deps.config.embeddingEnabled && embedding === undefined) {
      throw knowledgeError('provider_error', `embed 未返回第 ${String(index + 1)} 个向量 / embedding missing`);
    }
    const similarity = embedding === undefined
      ? emptySimilarity()
      : await findSimilarForPoint(deps, actor.userId, embedding, source.id);
    items.push(await placePoint(deps, actor, source.id, point, embedding, similarity));
  }

  // Step 10.
  await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'done');
  return captureResult({ source, stage: stageOfItems(items), processingStatus: 'done', duplicate, items });
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
  embedding: number[] | undefined,
  similarity: PointSimilarity,
): Promise<CaptureResultItem> {
  const { thresholds } = deps.config;
  const attachBar = thresholds.similarityAttachThreshold;
  const seed: EmbedSeed = {
    ...(embedding === undefined ? {} : { embedding, model: deps.config.ai.embedModel }),
  };

  const manual = await placeInManualPath(deps, actor, rawSourceId, point, seed);
  if (manual !== undefined) return manual;

  // Dedupe rule first: a near-duplicate of an existing item joins that item's node and is reported as
  // "merged". The pre-existing item and its RawSource are left untouched (PROJECT_MASTER §2.2, §3.3).
  const nearestItem = similarity.nearestItem;
  if (nearestItem !== null && nearestItem.nodeId !== null && nearestItem.score >= attachBar) {
    const persisted = await persistPoint(deps, actor, {
      rawSourceId,
      point,
      ...(embedding === undefined ? {} : { embedding }),
      targetNodeId: nearestItem.nodeId,
      action: 'merged',
      linkConfidence: roundConfidence(Math.max(point.confidence, nearestItem.score)),
      provenanceNodeId: null,
      relatedNodeId: null,
    });
    return persisted.result;
  }

  const { candidates } = await buildCandidates(deps, actor.userId, similarity.nodeMatches);
  let decision: ClassifyResult;
  try {
    decision = await classifyPoint(deps, { itemText: point.text, suggestedTitle: point.title, candidates });
  } catch (error) {
    const corrected = await placeInManualPath(deps, actor, rawSourceId, point, seed);
    if (corrected !== undefined) return corrected;
    throw error;
  }
  // A person may correct the path while the model request is in flight.
  const corrected = await placeInManualPath(deps, actor, rawSourceId, point, seed);
  if (corrected !== undefined) return corrected;
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
        ...(embedding === undefined ? {} : { embedding }),
        targetNodeId: target.id,
        action: 'attached',
        linkConfidence: roundConfidence(clamp01(decision.confidence)),
        provenanceNodeId: provenanceNodeId === target.id ? null : provenanceNodeId,
        relatedNodeId: relatedNodeId === target.id ? null : relatedNodeId,
      });
      return persisted.result;
    }
    throw knowledgeError('provider_error', '分类结果关联的节点已不存在，请重试 / classification target is unavailable');
  }

  const titles = sanitizePath(pathOf(decision), '');
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
    ...(embedding === undefined ? {} : { embedding }),
    targetNodeId: resolved.node.id,
    // Nothing was created when the whole path already existed: that is an attach, not a create.
    action: resolved.createdNodeIds.length > 0 ? 'created' : 'attached',
    linkConfidence: roundConfidence(Math.min(clamp01(point.confidence), clamp01(decision.confidence))),
    provenanceNodeId: provenanceNodeId === resolved.node.id ? null : provenanceNodeId,
    relatedNodeId: relatedNodeId === resolved.node.id ? null : relatedNodeId,
  });
  return persisted.result;
}

async function placeInManualPath(
  deps: CoreDeps,
  actor: ActorContext,
  rawSourceId: string,
  point: NormalizedPoint,
  seed: EmbedSeed,
): Promise<CaptureResultItem | undefined> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  const library = libraryMetadataSchema.safeParse(source?.metadata.library);
  const path = library.success ? library.data.subjectPath : undefined;
  if (!path?.length) return undefined;
  const resolved = await resolveNodeChain(deps, actor, path, seed, 1);
  return (await persistPoint(deps, actor, {
    rawSourceId,
    point,
    ...(seed.embedding === undefined ? {} : { embedding: seed.embedding }),
    targetNodeId: resolved.node.id,
    action: resolved.createdNodeIds.length > 0 ? 'created' : 'attached',
    linkConfidence: 1,
    provenanceNodeId: null,
    relatedNodeId: null,
  })).result;
}

function pathOf(decision: ClassifyResult): string[] {
  const provided = decision.newNodePath ?? [];
  return provided.length > 0 ? [...provided] : [decision.newNodeTitle ?? ''];
}
