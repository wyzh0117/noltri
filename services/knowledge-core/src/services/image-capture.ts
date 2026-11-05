import { createHash } from 'node:crypto';
import { recognizeImage } from '@noltri/ai-provider';
import { captureAssetBytesMatchMime, captureImageProvenanceSchema, captureRecognitionResponseSchema, MAX_CAPTURE_ASSET_BYTES, type CaptureAssetRef, type CaptureBatchItemRequest, type CaptureProcessingReason, type CaptureImageProvenance, type RawSource } from '@noltri/schema';
import { isKnowledgeError, knowledgeError } from '@noltri/shared';
import type { StoredCaptureBatch, CaptureBatchItemPatch } from '@noltri/storage';
import type { KnowledgeCore } from '../core';
import { capText, type ActorContext } from '../types';
import { beginCaptureAnalysis, recordCaptureAnalysis, taskDeps, type CaptureAnalysis } from '../pipeline/task-rules';
import { cancelledCapture, pendingCapture, publishCaptureRecord, processBoundCaptureSource, saveCaptureSource } from '../pipeline/capture';
import { imageProcessingInput } from '../pipeline/image-input';
import { callProvider } from '../pipeline/provider';

function chosenInputs(item: CaptureBatchItemRequest, refs: CaptureAssetRef[]): CaptureAssetRef[] | null {
  const derivatives = item.derivedAssets ?? [];
  const roots = refs.filter(ref => !derivatives.some(derived => derived.assetId === ref.assetId));
  let selected: string[];
  if (item.kind === 'composite') {
    const stitches = derivatives.filter(derived => derived.operation === 'stitch' && derived.sourceAssetIds.length === roots.length && new Set(derived.sourceAssetIds).size === roots.length && roots.every(root => derived.sourceAssetIds.includes(root.assetId)));
    if (roots.length < 2 || stitches.length !== 1) return null;
    selected = [stitches[0]!.assetId];
  } else {
    if (roots.length !== 1) return null;
    const root = roots[0]!;
    const edited = derivatives.filter(derived => (derived.operation === 'annotate' || derived.operation === 'rotate') && derived.sourceAssetIds.length === 1 && derived.sourceAssetIds[0] === root.assetId);
    if (edited.length > 1) return null;
    selected = [edited[0]?.assetId ?? root.assetId];
  }
  const inputs = selected.map(id => refs.find(ref => ref.assetId === id)!);
  return inputs.every(Boolean) ? inputs.filter((input, index) => inputs.findIndex(other => other.sha256 === input.sha256) === index) : null;
}

async function verifiedAsset(core: KnowledgeCore, actor: ActorContext, sessionId: string, assetId: string) {
  const asset = await core.deps.repository.getCaptureAsset(actor.userId, sessionId, assetId);
  if (!asset) throw knowledgeError('not_found', 'Image asset not found');
  if (asset.bytes.length === 0 || asset.bytes.length > MAX_CAPTURE_ASSET_BYTES || asset.bytes.length !== asset.byteLength || createHash('sha256').update(asset.bytes).digest('hex') !== asset.sha256 || !captureAssetBytesMatchMime(asset.bytes, asset.mimeType)) throw knowledgeError('storage_error', 'Stored image bytes failed integrity verification');
  return asset;
}

/** Existing batch item is the sole durable claim; recognition snapshots are content, not jobs. */
export async function processImageBatchItem(core: KnowledgeCore, actor: ActorContext, batchId: string, requestId: string): Promise<StoredCaptureBatch> {
  const repository = core.deps.repository;
  let batch: StoredCaptureBatch;
  try { batch = await repository.claimCaptureBatchItemForProcessing(actor.userId, batchId, requestId); }
  catch (error) {
    if (!isKnowledgeError(error) || error.code !== 'conflict') throw error;
    const current = await repository.getCaptureBatch(actor.userId, batchId);
    if (!current) throw knowledgeError('not_found', 'Capture batch not found');
    return current;
  }
  const item = batch.items.find(entry => entry.requestId === requestId)!;
  let sourceId = item.rawSourceId;
  let analysis: CaptureAnalysis | undefined;
  let observedSource: RawSource | undefined;
  const saveBatch = (patch: CaptureBatchItemPatch) => repository.updateCaptureBatchItem(actor.userId, batchId, requestId, patch, analysis?.acceptedReviewRevision ?? observedSource?.reviewRevision);
  try {
    const refs: CaptureAssetRef[] = [];
    for (const assetId of item.assetIds) {
      const asset = await verifiedAsset(core, actor, batch.sessionId, assetId);
      refs.push({ assetId: asset.assetId, sessionId: asset.sessionId, mimeType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.sha256, createdAt: asset.createdAt });
    }
    const provenance: CaptureImageProvenance = captureImageProvenanceSchema.parse({
      kind: item.kind, batchId, sessionId: batch.sessionId, requestId, originalTextPresent: item.text !== undefined, assetRefs: refs,
      // Full annotation content stays in the immutable batch request; provenance carries no transcript.
      derivedAssets: (item.derivedAssets ?? []).map(derived => ({ assetId: derived.assetId, operation: derived.operation, sourceAssetIds: derived.sourceAssetIds, ...(derived.rotationDegrees === undefined ? {} : { rotationDegrees: derived.rotationDegrees }), ...(derived.direction === undefined ? {} : { direction: derived.direction }), ...(derived.annotations === undefined ? {} : { annotationCount: derived.annotations.length }) })),
    });
    const clientId = item.capture.deviceId ?? item.capture.client;
    let source = sourceId === null ? await repository.findRawSourceByIdempotencyKey(actor.userId, clientId, requestId) : await repository.findRawSource(sourceId, actor.userId);
    if (source === null) {
      try {
        source = await saveCaptureSource(core.deps, { userId: actor.userId, rawText: item.text ?? '', sourceType: item.source.type, surroundingContext: item.surroundingContext ?? null, sourcePlatform: item.source.platform ?? null, sourceApp: item.source.appName ?? null, sourceTitle: item.source.title ?? null, sourceUrl: item.source.url ?? null, capturedAt: item.capture.capturedAt, clientId, requestId, metadata: { entryPoint: 'capture-image', capture: provenance, library: { ...item.library, kind: 'image' } } });
      } catch (error) {
        source = await repository.findRawSourceByIdempotencyKey(actor.userId, clientId, requestId);
        if (source === null) throw error;
      }
    }
    const savedProvenance = captureImageProvenanceSchema.safeParse(source.metadata.capture);
    if (!savedProvenance.success || source.rawText !== (item.text ?? '') || JSON.stringify(savedProvenance.data) !== JSON.stringify(provenance)) throw knowledgeError('conflict', 'requestId is bound to a different image source');
    sourceId = source.id;
    observedSource = source;
    await saveBatch({ rawSourceId: sourceId, processingReason: null });
    if (source.reviewStatus !== 'needs_review') return saveBatch({ status: source.reviewStatus === 'confirmed' ? 'done' : 'needs_review', retryable: false });
    analysis = await beginCaptureAnalysis(core.deps, source);
    const inputs = chosenInputs(item, refs);
    const pending = async (status: 'assets_saved' | 'needs_review', processingReason: CaptureProcessingReason) => {
      const result = await pendingCapture(analysis!, actor, status === 'assets_saved' ? 'saved' : 'needs_review');
      return saveBatch({ status: analysis!.cancelled ? (result.stage === 'completed' ? 'done' : 'needs_review') : status, retryable: false, errorReason: null, processingReason: analysis!.cancelled ? null : processingReason });
    };
    if (!inputs) return pending('needs_review', 'input_selection_required');
    const inputFingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
    let snapshot = await repository.createCaptureRecognitionSnapshot({ userId: actor.userId, rawSourceId: source.id, inputs, inputFingerprint, expectedReviewRevision: source.reviewRevision });
    const missing = snapshot.inputs.filter(input => !snapshot.results.some(entry => entry.assetId === input.assetId));
    if (core.deps.provider.id === 'offline') return pending('assets_saved', 'offline');
    if (missing.length > 0 && (core.deps.provider.capabilities.imageRecognition !== true || core.deps.provider.recognizeImage === undefined)) return pending('assets_saved', 'unsupported');
    if (missing.length > 0) await recordCaptureAnalysis(analysis, 'extracting', 'running');
    for (const input of missing) {
      const asset = await verifiedAsset(core, actor, batch.sessionId, input.assetId);
      const result = await callProvider('recognizeImage', core.deps, () => recognizeImage(core.deps.provider, { bytes: asset.bytes, mimeType: asset.mimeType }));
      snapshot = await repository.saveCaptureRecognitionResult(actor.userId, source.id, { assetId: input.assetId, providerId: core.deps.provider.id, ...(core.deps.provider.id === 'openai-compatible' && core.deps.config.imageRecognitionModel ? { modelId: core.deps.config.imageRecognitionModel } : {}), result }, source.reviewRevision);
    }
    const ready = await imageProcessingInput(analysis.deps, source);
    if (!ready || ready.reason !== undefined) return pending('needs_review', ready?.reason ?? 'insufficient_text');
    const result = await processBoundCaptureSource(analysis, actor);
    return saveBatch({ status: result.processingStatus === 'failed' ? 'failed' : result.stage === 'needs_review' ? 'needs_review' : result.processingStatus === 'done' ? 'done' : 'needs_review', rawSourceId: source.id, duplicate: result.duplicate, retryable: result.processingStatus === 'failed', errorReason: result.errorReason ?? null, processingReason: null });
  } catch (error) {
    const current = sourceId === null ? null : await repository.findRawSource(sourceId, actor.userId);
    if (current && observedSource && current.reviewRevision !== observedSource.reviewRevision) {
      const outcome = analysis ? await cancelledCapture(analysis, actor, false) : null;
      return saveBatch({ status: (outcome?.stage === 'completed' || (!outcome && current.reviewStatus === 'confirmed')) ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null });
    }
    // Before analysis assignment this request has no source claim to fail or release.
    if (current?.processingStatus === 'processing' && analysis === undefined) return saveBatch({ status: 'processing', retryable: false });
    if (observedSource) {
      const outcome = await repository.finishCaptureProcessing({ userId: actor.userId, rawSourceId: observedSource.id, expectedReviewRevision: observedSource.reviewRevision, status: 'failed', errorReason: 'Image processing failed; saved source and assets retained' });
      if (!outcome.applied) {
        const cancelled = analysis ? await cancelledCapture(analysis, actor, false) : null;
        return saveBatch({ status: cancelled?.stage === 'completed' || (!cancelled && outcome.source.reviewStatus === 'confirmed') ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null });
      }
      if (analysis) {
        analysis.acceptedReviewRevision = outcome.source.reviewRevision;
        const result = await publishCaptureRecord(analysis, actor, { rawSourceId: observedSource.id, requestId: observedSource.requestId ?? '', stage: 'failed', processingStatus: outcome.source.processingStatus, duplicate: false, items: [] }, analysis.phase, 'failed', analysis.phase === 'extracting' ? 'extraction_failed' : 'internal_error');
        if (analysis.cancelled) return saveBatch({ status: result.stage === 'completed' ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null });
      }
    }
    return saveBatch({ status: 'failed', ...(sourceId === null ? {} : { rawSourceId: sourceId }), retryable: !isKnowledgeError(error) || error.retryable, errorReason: (error instanceof Error ? error.message : 'Image processing failed').slice(0, 500), processingReason: null });
  }
}

export async function readCaptureRecognition(core: KnowledgeCore, actor: ActorContext, rawSourceId: string) {
  const source = await core.deps.repository.findRawSource(rawSourceId, actor.userId);
  if (!source) throw knowledgeError('not_found', 'Raw source not found');
  const plan = await core.deps.repository.getCaptureProcessingPlan(actor.userId, rawSourceId);
  const image = await imageProcessingInput(taskDeps(core.deps, plan), source);
  if (!image) throw knowledgeError('not_found', 'Image recognition source not found');
  const snapshot = image.snapshot;
  const payload = snapshot === null ? null : {
    version: snapshot.version, inputFingerprint: snapshot.inputFingerprint, inputs: snapshot.inputs, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
    results: snapshot.results.map(entry => ({ ...entry, result: { ...entry.result, text: capText(actor, entry.result.text), blocks: entry.result.blocks.map(block => ({ ...block, text: capText(actor, block.text) })), uncertainRegions: entry.result.uncertainRegions.map(region => ({ ...region, reason: capText(actor, region.reason), ...(region.text === undefined ? {} : { text: capText(actor, region.text) }) })) } })),
  };
  return captureRecognitionResponseSchema.parse({ rawSourceId, provenance: image.provenance, snapshot: payload, processingText: image.processingText === null ? null : capText(actor, image.processingText) });
}
