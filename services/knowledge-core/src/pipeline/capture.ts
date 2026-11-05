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
  CreateRawSourceInput,
  CaptureResult,
  CaptureResultItem,
  CaptureStage,
  ProcessingStatus,
  RawSource,
} from '@noltri/schema';
import { libraryMetadataSchema, tierForConfidence, type ProcessingRecord } from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import type { CapturePlanDecision, CapturePlanPlacement, CaptureProcessingPlan, CaptureProcessingPlanPoint, CaptureReviewAuthority } from '@noltri/storage';
import type { ActorContext, CoreDeps } from '../types';
import { clamp01, roundConfidence } from '../types';
import type { ClassifyResult } from '@noltri/ai-provider';
import { assertDecisionUsable, buildCandidates, classifyPoint } from './classify';
import { normalizePoints, type NormalizedPoint } from './normalize';
import { callProvider, isProviderFailure } from './provider';
import { persistPoint, resolveNodeChain, sanitizePath, type EmbedSeed } from './persist';
import { errorReasonOf, sourceLabelFor, validateCaptureRequest } from './validate';
import { imageProcessingInput } from './image-input';
import { beginCaptureAnalysis, recordCaptureAnalysis, taskDeps, type CaptureAnalysis } from './task-rules';
import { emptySimilarity, findSimilarForPoint } from './similarity';

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
  const plan = await deps.repository.getCaptureProcessingPlan(actor.userId, source.id);
  deps = taskDeps(deps, plan);
  const allItems = await deps.repository.listKnowledgeItemsForSource(source.id, actor.userId);
  const items = plan?.rulesSnapshot ? allItems.filter(item => plan.points.some(point => point.knowledgeItemId === item.id)) : allItems;
  for (const item of items) {
    const links = await deps.repository.listLinksForItem(item.id, actor.userId);
    for (const link of links) {
      if (tierForConfidence(link.confidence, deps.config.thresholds) === 'low') return 'needs_review';
    }
  }
  return 'completed';
}

/** Both typed intake paths persist their immutable original through the same pipeline-owned writer. */
export function saveCaptureSource(deps: CoreDeps, input: CreateRawSourceInput): Promise<RawSource> {
  return deps.repository.createRawSource(input);
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
    source = await saveCaptureSource(deps, {
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

  return processSource(deps, actor, source, false, false, true);
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
        stage: source.reviewStatus === 'confirmed' ? 'completed' : await stageOfStoredLinks(deps, actor, source),
        processingStatus: 'done',
        duplicate: true,
      });
  }
}


async function embedPoints(deps: CoreDeps, points: readonly NormalizedPoint[]): Promise<number[][]> {
  const texts = points.map((point) => point.text);
  const vectors = await callProvider('embed', deps, () => deps.provider.embed(texts));

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw knowledgeError('provider_error', 'embed 返回数量与文本数量不一致 / embed returned a mismatched vector count');
  }

  return vectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((axis) => !Number.isFinite(axis))) {
      throw knowledgeError('provider_error', '第 ' + String(index + 1) + ' 个向量无效 / embedding is not a finite vector');
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

async function processSource(
  deps: CoreDeps, actor: ActorContext, source: RawSource, duplicate: boolean,
  reanalysis = false, _freshSource = false,
): Promise<CaptureResult> {
  if (!reanalysis && source.processingStatus === 'done') return replaySource(deps, actor, source);
  if (!reanalysis && deps.provider.id !== 'offline' && (source.reviewStatus === 'deferred' || source.reviewStatus === 'rejected')) return captureResult({ source, stage: 'needs_review', processingStatus: source.processingStatus, duplicate });
  const existing = await deps.repository.getCaptureProcessingPlan(actor.userId, source.id);
  if (!reanalysis && !_freshSource && existing === null && deps.provider.id === 'offline' && source.metadata.entryPoint !== 'capture-image') return captureResult({ source, stage: 'saved', processingStatus: 'pending', duplicate });
  if (!reanalysis && ((existing !== null && existing.rulesSnapshot === null)
    || (existing === null && (await deps.repository.listKnowledgeItemsForSource(source.id, actor.userId)).length > 0))) {
    await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'pending', null, source.reviewRevision);
    return captureResult({ source, stage: 'saved', processingStatus: 'pending', duplicate, errorReason: '历史冻结分析规则未知；请人工复核或明确重新分析 / historical analysis rules unknown' });
  }
  const analysis = await beginCaptureAnalysis(deps, source, reanalysis);
  return processBoundCaptureSource(analysis, actor, duplicate);
}

export async function cancelledCapture(analysis: CaptureAnalysis, actor: ActorContext, duplicate: boolean): Promise<CaptureResult> {
  analysis.cancelled = true;
  // The observed revision identifies this claim. A newer review releases it in its own transaction;
  // never use a newer revision here to release processing that may belong to a newer task.
  let source = await analysis.deps.repository.findRawSource(analysis.source.id, actor.userId);
  if (source === null) throw knowledgeError('not_found', 'Saved capture source not found');
  if (source.processingStatus === 'processing' && source.reviewRevision === analysis.source.reviewRevision) {
    source = (await analysis.deps.repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: source.id, expectedReviewRevision: analysis.source.reviewRevision, status: 'pending' })).source;
  }
  await recordCaptureAnalysis(analysis, 'completed', 'cancelled', 'cancelled');
  source = await analysis.deps.repository.findRawSource(source.id, actor.userId) ?? source;
  analysis.acceptedReviewRevision = source.reviewRevision;
  return captureResult({ source, stage: source.processingStatus === 'processing' ? 'processing' : source.reviewStatus === 'confirmed' ? 'completed' : 'needs_review', processingStatus: source.processingStatus, duplicate });
}

/** Record-file I/O can yield to review; publish only the source revision actually accepted by SQL. */
export async function publishCaptureRecord(analysis: CaptureAnalysis, actor: ActorContext, result: CaptureResult, phase: ProcessingRecord['phase'], status: ProcessingRecord['status'], errorCode?: ProcessingRecord['errorCode']): Promise<CaptureResult> {
  if (analysis.cancelled) return result;
  await recordCaptureAnalysis(analysis, phase, status, errorCode);
  const current = await analysis.deps.repository.findRawSource(analysis.source.id, actor.userId);
  if (current === null) throw knowledgeError('not_found', 'Saved capture source not found');
  if (current.reviewRevision !== (analysis.acceptedReviewRevision ?? analysis.source.reviewRevision)) return cancelledCapture(analysis, actor, result.duplicate);
  return result;
}

export async function pendingCapture(analysis: CaptureAnalysis, actor: ActorContext, stage: 'saved' | 'needs_review', duplicate = false, errorReason?: string): Promise<CaptureResult> {
  const outcome = await analysis.deps.repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: analysis.source.id, expectedReviewRevision: analysis.source.reviewRevision, status: 'pending' });
  if (!outcome.applied) return cancelledCapture(analysis, actor, duplicate);
  analysis.acceptedReviewRevision = outcome.source.reviewRevision;
  return publishCaptureRecord(analysis, actor, captureResult({ source: outcome.source, stage, processingStatus: outcome.source.processingStatus, duplicate, ...(errorReason ? { errorReason } : {}) }), 'queued', 'pending');
}

function authorityFor(analysis: CaptureAnalysis, pointIndex: number): CaptureReviewAuthority {
  return { rawSourceId: analysis.source.id, expectedReviewRevision: analysis.source.reviewRevision, analysisVersion: analysis.plan.analysisVersion, pointIndex, actor: 'capture' };
}

/** Image intake keeps this exact reservation across OCR and extraction; it never reselects latest. */
export async function processBoundCaptureSource(analysis: CaptureAnalysis, actor: ActorContext, duplicate = false): Promise<CaptureResult> {
  const { deps, source } = analysis;
  try {
    const current = await deps.repository.findRawSource(source.id, actor.userId);
    if (current !== null && current.reviewRevision !== source.reviewRevision) return cancelledCapture(analysis, actor, duplicate);
    const image = await imageProcessingInput(deps, source);
    if ((image !== null && image.reason !== undefined) || deps.provider.id === 'offline') {
      return pendingCapture(analysis, actor, image?.reason && image.snapshot?.results.length ? 'needs_review' : 'saved', duplicate, image?.reason);
    }
    const result = await compileSource(analysis, actor, duplicate, image?.processingText ?? source.rawText);
    return publishCaptureRecord(analysis, actor, result, 'completed', 'succeeded');
  } catch (error) {
    const current = await deps.repository.findRawSource(source.id, actor.userId);
    if (current !== null && current.reviewRevision !== source.reviewRevision) return cancelledCapture(analysis, actor, duplicate);
    const reason = errorReasonOf(error);
    const outcome = await deps.repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: source.id, expectedReviewRevision: source.reviewRevision, status: 'failed', errorReason: reason });
    if (!outcome.applied) return cancelledCapture(analysis, actor, duplicate);
    analysis.acceptedReviewRevision = outcome.source.reviewRevision;
    const failed = await publishCaptureRecord(analysis, actor, captureResult({ source: outcome.source, stage: 'failed', processingStatus: outcome.source.processingStatus, duplicate, errorReason: reason }), analysis.phase, 'failed', analysis.phase === 'extracting' ? 'extraction_failed' : analysis.phase === 'classifying' ? 'classification_failed' : 'persistence_failed');
    if (analysis.cancelled || isProviderFailure(error)) return failed;
    throw error;
  }
}

async function compileSource(analysis: CaptureAnalysis, actor: ActorContext, duplicate: boolean, processingText: string): Promise<CaptureResult> {
  const { deps, source } = analysis;
  let plan = analysis.plan;
  if (!plan.extractionReady) {
    await recordCaptureAnalysis(analysis, 'extracting', 'running');
    const extracted = await callProvider('extractKnowledge', deps, () => deps.provider.extractKnowledge({
      text: processingText,
      ...(source.surroundingContext ? { surroundingContext: source.surroundingContext } : {}),
      sourceLabel: sourceLabelFor(source), sourceType: source.sourceType, maxItems: deps.config.maxItemsPerCapture,
      ...(plan.rulesSnapshot?.rules.extractionInstructions ? { instructions: plan.rulesSnapshot.rules.extractionInstructions } : {}),
    }));
    const points = normalizePoints(extracted.items ?? [], deps.config.maxItemsPerCapture);
    const snapshot = points.map((point, pointIndex): CaptureProcessingPlanPoint => ({ pointIndex,
      point: { text: point.text, summary: point.summary, confidence: point.confidence, title: point.title },
      embedding: null, embeddingModel: null, decision: null, placement: null, knowledgeItemId: null, status: 'pending' }));
    plan = await deps.repository.completeCaptureProcessingPlanExtraction(actor.userId, source.id, plan.analysisVersion, snapshot, source.reviewRevision);
    analysis.plan = plan;
  }
  await recordCaptureAnalysis(analysis, 'classifying', 'running');
  return resumeFrozenPlan(deps, actor, source, duplicate, plan, analysis);
}

async function resumeFrozenPlan(
  deps: CoreDeps,
  actor: ActorContext,
  source: RawSource,
  duplicate: boolean,
  initialPlan: CaptureProcessingPlan,
  analysis: CaptureAnalysis,
): Promise<CaptureResult> {
  let plan = initialPlan;
  const items: CaptureResultItem[] = [];

  if (plan.points.length === 0) {
    const outcome = await deps.repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: source.id, expectedReviewRevision: source.reviewRevision, status: 'done' });
    if (!outcome.applied) return cancelledCapture(analysis, actor, duplicate);
    analysis.acceptedReviewRevision = outcome.source.reviewRevision;
    return captureResult({ source: outcome.source, stage: 'completed', processingStatus: outcome.source.processingStatus, duplicate });
  }

  const unembedded = deps.config.embeddingEnabled
    ? plan.points.filter((point) => point.embedding === null)
    : [];
  if (unembedded.length > 0) {
    const vectors = await embedPoints(deps, unembedded.map((entry) => normalizedPoint(entry.point)));
    for (const [index, entry] of unembedded.entries()) {
      plan = await deps.repository.updateCaptureProcessingPlanPoint(
        actor.userId,
        source.id,
        plan.analysisVersion,
        entry.pointIndex,
        { embedding: vectors[index]!, embeddingModel: deps.config.ai.embedModel }, authorityFor(analysis, entry.pointIndex),
      );
    }
  }

  for (const pointIndex of plan.points.map((point) => point.pointIndex).sort((a, b) => a - b)) {
    const current = await deps.repository.findRawSource(source.id, actor.userId);
    if (current !== null && current.reviewRevision !== source.reviewRevision) return cancelledCapture(analysis, actor, duplicate);
    let frozen = plan.points.find((point) => point.pointIndex === pointIndex)!;
    if (frozen.status === 'complete') {
      items.push(await resultFromFrozenPoint(deps, actor, frozen));
      continue;
    }

    const point = normalizedPoint(frozen.point);
    const embedding = frozen.embedding ?? undefined;
    if (deps.config.embeddingEnabled && embedding === undefined) {
      throw knowledgeError('provider_error', 'embed 未返回第 ' + String(pointIndex + 1) + ' 个向量 / embedding missing');
    }

    if (frozen.decision === null) {
      await recordCaptureAnalysis(analysis, 'classifying', 'running');
      const decision = await decideFrozenPoint(deps, actor, source, frozen, point, embedding, plan.rulesSnapshot?.rules.classificationInstructions);
      plan = await deps.repository.updateCaptureProcessingPlanPoint(
        actor.userId, source.id, plan.analysisVersion, pointIndex,
        { decision, status: 'decision_saved' }, authorityFor(analysis, pointIndex),
      );
      frozen = plan.points.find((entry) => entry.pointIndex === pointIndex)!;
    }

    if (frozen.placement === null) {
      const placement = await resolveFrozenPlacement(deps, actor, frozen, point, embedding, authorityFor(analysis, pointIndex));
      plan = await deps.repository.updateCaptureProcessingPlanPoint(
        actor.userId, source.id, plan.analysisVersion, pointIndex,
        { placement, status: 'placement_saved' }, authorityFor(analysis, pointIndex),
      );
      frozen = plan.points.find((entry) => entry.pointIndex === pointIndex)!;
    }

    const placement = frozen.placement;
    if (frozen.decision === null || placement === null) {
      throw knowledgeError('storage_error', '冻结计划缺少决策或放置结果 / frozen plan is missing its decision or placement');
    }
    const progress = {
      status: frozen.status as 'placement_saved' | 'item_saved' | 'linked',
      knowledgeItemId: frozen.knowledgeItemId,
      onItemSaved: async (knowledgeItemId: string) => {
        plan = await deps.repository.updateCaptureProcessingPlanPoint(
          actor.userId, source.id, plan.analysisVersion, pointIndex,
          { knowledgeItemId, status: 'item_saved' }, authorityFor(analysis, pointIndex),
        );
      },
      onLinked: async () => {
        plan = await deps.repository.updateCaptureProcessingPlanPoint(
          actor.userId, source.id, plan.analysisVersion, pointIndex,
          { status: 'linked' }, authorityFor(analysis, pointIndex),
        );
      },
      onComplete: async () => {
        plan = await deps.repository.updateCaptureProcessingPlanPoint(
          actor.userId, source.id, plan.analysisVersion, pointIndex,
          { status: 'complete' }, authorityFor(analysis, pointIndex),
        );
      },
    };
    const reviewed = await deps.repository.findRawSource(source.id, actor.userId);
    if (reviewed && reviewed.reviewRevision !== source.reviewRevision) return cancelledCapture(analysis, actor, duplicate);
    await recordCaptureAnalysis(analysis, 'persisting', 'running');
    const persisted = await persistPoint(deps, actor, {
      captureAuthority: { ...authorityFor(analysis, pointIndex), actor: actor.actor },
      rawSourceId: source.id,
      capturePointIndex: pointIndex,
      captureAnalysisVersion: plan.analysisVersion,
      point,
      progress,
      ...(embedding === undefined ? {} : { embedding }),
      targetNodeId: placement.targetNodeId,
      action: placement.action,
      linkConfidence: placement.linkConfidence,
      provenanceNodeId: placement.provenanceNodeId,
      relatedNodeId: placement.relatedNodeId,
    });
    items.push(persisted.result);
  }

  const confirmIfInitial = items.length > 0 && items.every((item) => item.confidenceTier === 'high') && plan.points.every((entry) => tierForConfidence(entry.point.confidence, deps.config.thresholds) === 'high');
  const outcome = await deps.repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: source.id, expectedReviewRevision: source.reviewRevision, status: 'done', confirmIfInitial });
  if (!outcome.applied) return cancelledCapture(analysis, actor, duplicate);
  analysis.acceptedReviewRevision = outcome.source.reviewRevision;
  return captureResult({ source: outcome.source, stage: stageOfItems(items), processingStatus: outcome.source.processingStatus, duplicate, items });
}

function normalizedPoint(point: CaptureProcessingPlanPoint['point']): NormalizedPoint {
  return { text: point.text, summary: point.summary, confidence: point.confidence, title: point.title };
}

async function resultFromFrozenPoint(
  deps: CoreDeps,
  actor: ActorContext,
  point: CaptureProcessingPlanPoint,
): Promise<CaptureResultItem> {
  if (point.knowledgeItemId === null || point.placement === null) {
    throw knowledgeError('storage_error', '已完成的冻结点位缺少知识条目或放置结果 / completed frozen point is incomplete');
  }
  const item = await deps.repository.findKnowledgeItem(point.knowledgeItemId, actor.userId);
  if (item === null) throw knowledgeError('storage_error', '冻结点位引用的知识条目不存在 / frozen KnowledgeItem is missing');
  const nodePath = await deps.repository.nodePath(actor.userId, point.placement.targetNodeId);
  return {
    knowledgeItemId: item.id,
    text: item.normalizedText,
    nodeId: point.placement.targetNodeId,
    nodePath: nodePath.map((part) => part.title),
    action: point.placement.action,
    confidence: point.placement.linkConfidence,
    confidenceTier: tierForConfidence(point.placement.linkConfidence, deps.config.thresholds),
  };
}

async function decideFrozenPoint(
  deps: CoreDeps,
  actor: ActorContext,
  source: RawSource,
  frozen: CaptureProcessingPlanPoint,
  point: NormalizedPoint,
  embedding: number[] | undefined,
  instructions?: string,
): Promise<CapturePlanDecision> {
  const manual = await manualDecision(deps, actor, source.id, point);
  if (manual !== undefined) return manual;

  const similarity = embedding === undefined
    ? emptySimilarity()
    : await findSimilarForPoint(deps, actor.userId, embedding, source.id);
  const nearestItem = similarity.nearestItem;
  if (nearestItem !== null && nearestItem.nodeId !== null &&
    nearestItem.score >= deps.config.thresholds.similarityAttachThreshold) {
    return {
      strategy: 'merge',
      nodeId: nearestItem.nodeId,
      path: [],
      action: 'merged',
      linkConfidence: roundConfidence(Math.max(point.confidence, nearestItem.score)),
      nodeConfidence: point.confidence,
      provenanceNodeId: null,
      relatedNodeId: null,
    };
  }

  const { candidates } = await buildCandidates(deps, actor.userId, similarity.nodeMatches);
  let decision: ClassifyResult;
  try {
    decision = await classifyPoint(deps, { itemText: point.text, suggestedTitle: point.title, candidates, ...(instructions ? { instructions } : {}) });
  } catch (error) {
    const corrected = await manualDecision(deps, actor, source.id, point);
    if (corrected !== undefined) return corrected;
    throw error;
  }
  const corrected = await manualDecision(deps, actor, source.id, point);
  if (corrected !== undefined) return corrected;
  assertDecisionUsable(deps, decision);

  const nearestNode = similarity.nearestNode;
  const provenanceNodeId =
    nearestItem !== null && nearestItem.score >= deps.config.similarEdgeThreshold ? nearestItem.nodeId : null;
  const relatedNodeId =
    nearestNode !== null && nearestNode.score >= deps.config.similarEdgeThreshold ? nearestNode.nodeId : null;

  if (decision.action === 'attach') {
    const target = await deps.repository.findNode(String(decision.nodeId), actor.userId);
    if (target === null || target.status === 'archived') {
      throw knowledgeError('provider_error', '分类结果关联的节点已不存在，请重试 / classification target is unavailable');
    }
    return {
      strategy: 'attach',
      nodeId: target.id,
      path: [],
      action: 'attached',
      linkConfidence: roundConfidence(clamp01(decision.confidence)),
      nodeConfidence: clamp01(decision.confidence),
      provenanceNodeId: provenanceNodeId === target.id ? null : provenanceNodeId,
      relatedNodeId: relatedNodeId === target.id ? null : relatedNodeId,
    };
  }

  const path = sanitizePath(pathOf(decision), point.title);
  return {
    strategy: 'create',
    nodeId: null,
    path,
    action: await actionForPath(deps, actor.userId, path),
    linkConfidence: roundConfidence(Math.min(clamp01(point.confidence), clamp01(decision.confidence))),
    nodeConfidence: point.confidence,
    provenanceNodeId,
    relatedNodeId,
  };
}

async function manualDecision(
  deps: CoreDeps,
  actor: ActorContext,
  rawSourceId: string,
  point: NormalizedPoint,
): Promise<CapturePlanDecision | undefined> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  const library = libraryMetadataSchema.safeParse(source?.metadata.library);
  const path = library.success ? library.data.subjectPath : undefined;
  if (!path?.length) return undefined;
  const titles = sanitizePath(path, point.title);
  return {
    strategy: 'manual',
    nodeId: null,
    path: titles,
    action: await actionForPath(deps, actor.userId, titles),
    linkConfidence: 1,
    nodeConfidence: point.confidence,
    provenanceNodeId: null,
    relatedNodeId: null,
  };
}

async function actionForPath(deps: CoreDeps, userId: string, path: readonly string[]): Promise<'created' | 'attached'> {
  let parentId: string | null = null;
  for (const title of path) {
    const node = await deps.repository.findNodeByTitle(userId, title, parentId);
    if (node === null) return 'created';
    parentId = node.id;
  }
  return 'attached';
}

async function resolveFrozenPlacement(
  deps: CoreDeps,
  actor: ActorContext,
  frozen: CaptureProcessingPlanPoint,
  point: NormalizedPoint,
  embedding: number[] | undefined,
  captureAuthority: CaptureReviewAuthority,
): Promise<CapturePlanPlacement> {
  const decision = frozen.decision;
  if (decision === null) throw knowledgeError('storage_error', '冻结计划尚无分类决策 / frozen point has no saved decision');
  const seed: EmbedSeed = {
    ...(embedding === undefined ? {} : { embedding, model: frozen.embeddingModel ?? deps.config.ai.embedModel }),
  };

  if (decision.strategy === 'merge' || decision.strategy === 'attach') {
    if (decision.nodeId === null) throw knowledgeError('storage_error', '冻结关联缺少节点 ID / frozen target is missing');
    const target = await deps.repository.findNode(decision.nodeId, actor.userId);
    if (target === null || target.status === 'archived') {
      throw knowledgeError('provider_error', '分类结果关联的节点已不存在，请重试 / classification target is unavailable');
    }
    return {
      targetNodeId: target.id,
      action: decision.action,
      linkConfidence: decision.linkConfidence,
      provenanceNodeId: decision.provenanceNodeId,
      relatedNodeId: decision.relatedNodeId,
    };
  }

  const resolved = await resolveNodeChain(deps, actor, decision.path, seed, decision.nodeConfidence, { ...captureAuthority, actor: actor.actor });
  return {
    targetNodeId: resolved.node.id,
    action: decision.action,
    linkConfidence: decision.linkConfidence,
    provenanceNodeId: decision.provenanceNodeId === resolved.node.id ? null : decision.provenanceNodeId,
    relatedNodeId: decision.relatedNodeId === resolved.node.id ? null : decision.relatedNodeId,
  };
}

export async function reanalyzeCapture(
  deps: CoreDeps,
  actor: ActorContext,
  rawSourceId: string,
): Promise<CaptureResult> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  if (source === null) throw knowledgeError('not_found', '原始来源 ' + rawSourceId + ' 不存在 / RawSource not found');
  return processSource(deps, actor, source, false, true);
}

function pathOf(decision: ClassifyResult): string[] {
  const provided = decision.newNodePath ?? [];
  return provided.length > 0 ? [...provided] : [decision.newNodeTitle ?? ''];
}
