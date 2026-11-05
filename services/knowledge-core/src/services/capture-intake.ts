import { processImageBatchItem } from './image-capture';
import { createHash } from 'node:crypto';
import {
  MAX_CAPTURE_ASSET_BYTES,
  captureAssetBytesMatchMime,
  captureAssetMimeSchema,
  captureAssetRefSchema,
  captureBatchListQuerySchema,
  captureBatchListSchema,
  captureBatchRequestSchema,
  captureBatchStatusSchema,
  processCaptureBatchRequestSchema,
  type CaptureAssetMime,
  type CaptureAssetRef,
  type CaptureBatchItemRequest,
  type CaptureBatchItemStatus,
  type CaptureBatchRequest,
  type CaptureBatchStatus,
  type CaptureBatchSubmitResult,
} from '@noltri/schema';
import { isKnowledgeError, knowledgeError } from '@noltri/shared';
import type { KnowledgeCore } from '../core';
import { capText, type ActorContext } from '../types';
import type { StoredCaptureBatch } from '@noltri/storage';

const MAX_ERROR_REASON_LENGTH = 2000;

function invalid(message: string): never {
  throw knowledgeError('invalid_request', message);
}

function mimeOf(value: string): CaptureAssetMime {
  const parsed = captureAssetMimeSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) return invalid('仅支持 PNG、JPEG、WebP 或 GIF 图片 / only PNG, JPEG, WebP or GIF images are supported');
  return parsed.data;
}

export async function putCaptureAsset(
  core: KnowledgeCore,
  actor: ActorContext,
  input: { assetId: string; sessionId: string; mimeType: string; sha256: string; bytes: Uint8Array },
): Promise<{ duplicate: boolean; asset: CaptureAssetRef }> {
  const parsedIds = captureAssetRefSchema.pick({ assetId: true, sessionId: true }).safeParse({
    assetId: input.assetId,
    sessionId: input.sessionId,
  });
  if (!parsedIds.success) invalid('assetId 或 sessionId 格式无效 / invalid assetId or sessionId');
  const { assetId, sessionId } = parsedIds.data;

  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES) {
    invalid(`asset 字节数必须在 1 到 ${String(MAX_CAPTURE_ASSET_BYTES)} 之间 / asset byte length is out of range`);
  }
  const mimeType = mimeOf(input.mimeType);
  if (!captureAssetBytesMatchMime(input.bytes, mimeType)) invalid('Content-Type 与图片内容不匹配 / Content-Type does not match image bytes');
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) invalid('缺少有效 SHA-256 / invalid SHA-256');
  const actualHash = createHash('sha256').update(input.bytes).digest('hex');
  if (actualHash !== input.sha256) invalid('图片 SHA-256 校验失败 / image SHA-256 mismatch');

  const stored = await core.deps.repository.putCaptureAsset({
    ...input,
    assetId,
    sessionId,
    userId: actor.userId,
    mimeType,
    bytes: new Uint8Array(input.bytes),
  });
  const asset = captureAssetRefSchema.parse({
    assetId: stored.asset.assetId,
    sessionId: stored.asset.sessionId,
    mimeType: stored.asset.mimeType,
    byteLength: stored.asset.byteLength,
    sha256: stored.asset.sha256,
    createdAt: stored.asset.createdAt,
  });
  return { asset, duplicate: stored.duplicate };
}

function canonicalBatch(input: CaptureBatchRequest): string {
  const items = [...input.items].sort((left, right) => left.userOrder - right.userOrder).map((item) => ({
    requestId: item.requestId,
    kind: item.kind,
    userOrder: item.userOrder,
    ...(item.text === undefined ? {} : { text: item.text }),
    ...(item.surroundingContext === undefined ? {} : { surroundingContext: item.surroundingContext }),
    assetIds: [...item.assetIds],
    ...(item.derivedAssets === undefined ? {} : { derivedAssets: item.derivedAssets }),
    source: item.source,
    capture: item.capture,
    ...(item.library === undefined ? {} : { library: item.library }),
  }));
  return JSON.stringify({ batchId: input.batchId, sessionId: input.sessionId, items });
}

function batchHash(input: CaptureBatchRequest): string {
  return createHash('sha256').update(canonicalBatch(input), 'utf8').digest('hex');
}

function publicBatch(batch: StoredCaptureBatch, actor: ActorContext): CaptureBatchStatus {
  return captureBatchStatusSchema.parse({
    batchId: batch.batchId,
    sessionId: batch.sessionId,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items: batch.items.map((item) => ({
      requestId: item.requestId,
      kind: item.kind,
      userOrder: item.userOrder,
      assetIds: item.assetIds,
      ...(item.derivedAssets === undefined ? {} : { derivedAssets: item.derivedAssets.map(derived => ({
        ...derived,
        ...(derived.annotations === undefined ? {} : { annotations: derived.annotations.map(annotation => ({
          ...annotation,
          ...(annotation.text === undefined ? {} : { text: capText(actor, annotation.text) }),
        })) }),
      })) }),
      status: item.status,
      ...(item.rawSourceId === null ? {} : { rawSourceId: item.rawSourceId }),
      duplicate: item.duplicate,
      retryable: item.retryable,
      ...(item.errorReason === null ? {} : { errorReason: capText(actor, item.errorReason) }),
      ...(item.processingReason === null ? {} : { processingReason: item.processingReason }),
      updatedAt: item.updatedAt,
    })),
  });
}

function captureRequest(item: CaptureBatchItemRequest) {
  return {
    requestId: item.requestId,
    text: item.text ?? '',
    source: item.source,
    capture: item.capture,
    ...(item.surroundingContext === undefined ? {} : { surroundingContext: item.surroundingContext }),
    ...(item.library === undefined ? {} : { library: item.library }),
  };
}

function errorMessage(error: unknown): string {
  const message = isKnowledgeError(error) ? error.message : error instanceof Error ? error.message : 'unknown failure';
  return message.slice(0, MAX_ERROR_REASON_LENGTH);
}

function stateFromResult(result: Awaited<ReturnType<KnowledgeCore['capture']>>): CaptureBatchItemStatus {
  if (result.processingStatus === 'failed') return 'failed';
  if (result.processingStatus === 'processing') return 'processing';
  if (result.processingStatus === 'pending') return result.stage === 'saved' ? 'needs_review' : 'queued';
  return result.stage === 'needs_review' ? 'needs_review' : 'done';
}

async function saveResult(
  core: KnowledgeCore,
  actor: ActorContext,
  batchId: string,
  item: CaptureBatchItemRequest,
  result: Awaited<ReturnType<KnowledgeCore['capture']>>,
): Promise<StoredCaptureBatch> {
  const status = stateFromResult(result);
  return core.deps.repository.updateCaptureBatchItem(actor.userId, batchId, item.requestId, {
    status,
    rawSourceId: result.rawSourceId,
    duplicate: result.duplicate,
    retryable: status === 'failed',
    errorReason: result.errorReason ?? null,
  });
}

async function saveFailure(
  core: KnowledgeCore,
  actor: ActorContext,
  batchId: string,
  item: CaptureBatchItemRequest,
  error: unknown,
): Promise<StoredCaptureBatch> {
  let rawSourceId: string | null = null;
  try {
    const clientId = item.capture.deviceId ?? item.capture.client;
    rawSourceId = (await core.deps.repository.findRawSourceByIdempotencyKey(actor.userId, clientId, item.requestId))?.id ?? null;
  } catch {
    // The failed batch status is more valuable than a secondary lookup failure.
  }
  return core.deps.repository.updateCaptureBatchItem(actor.userId, batchId, item.requestId, {
    status: 'failed',
    rawSourceId,
    retryable: true,
    errorReason: errorMessage(error),
  });
}

export async function submitCaptureBatch(
  core: KnowledgeCore,
  actor: ActorContext,
  value: unknown,
): Promise<CaptureBatchSubmitResult> {
  const input = captureBatchRequestSchema.parse(value);
  const orderedItems = [...input.items].sort((left, right) => left.userOrder - right.userOrder);
  const created = await core.deps.repository.createCaptureBatch({
    userId: actor.userId,
    batchId: input.batchId,
    sessionId: input.sessionId,
    payloadHash: batchHash(input),
    items: orderedItems,
  });
  let batch = created.batch;
  if (!created.duplicate) {
    for (const item of orderedItems) {
      if (item.kind !== 'text') { batch = await processImageBatchItem(core, actor, input.batchId, item.requestId); continue; }
      await core.deps.repository.updateCaptureBatchItem(actor.userId, input.batchId, item.requestId, {
        status: 'processing', retryable: false, errorReason: null,
      });
      try {
        const result = await core.capture(captureRequest(item), actor);
        batch = await saveResult(core, actor, input.batchId, item, result);
      } catch (error) {
        batch = await saveFailure(core, actor, input.batchId, item, error);
      }
    }
  }
  const refreshed = await core.deps.repository.getCaptureBatch(actor.userId, input.batchId);
  if (refreshed === null) throw knowledgeError('storage_error', '采集批次写入后消失 / capture batch disappeared after write');
  return { duplicate: created.duplicate, batch: publicBatch(refreshed, actor) };
}

export async function getCaptureBatchStatus(
  core: KnowledgeCore,
  actor: ActorContext,
  batchId: string,
): Promise<CaptureBatchStatus> {
  const batch = await core.deps.repository.getCaptureBatch(actor.userId, batchId);
  if (batch === null) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
  return publicBatch(batch, actor);
}

export async function listCaptureBatches(
  core: KnowledgeCore,
  actor: ActorContext,
  query: unknown,
) {
  const { limit } = captureBatchListQuerySchema.parse(query);
  const batches = await core.deps.repository.listCaptureBatches(actor.userId, limit);
  return captureBatchListSchema.parse({ batches: batches.map(batch => publicBatch(batch, actor)) });
}

export async function readCaptureAsset(
  core: KnowledgeCore,
  actor: ActorContext,
  batchIdValue: string,
  assetIdValue: string,
): Promise<{ asset: CaptureAssetRef; bytes: Uint8Array }> {
  const batchId = captureBatchStatusSchema.shape.batchId.safeParse(batchIdValue);
  const assetId = captureAssetRefSchema.shape.assetId.safeParse(assetIdValue);
  if (!batchId.success || !assetId.success) invalid('采集批次或图片编号格式无效 / invalid capture batch or asset id');

  const batch = await core.deps.repository.getCaptureBatch(actor.userId, batchId.data);
  if (batch === null || !batch.items.some((item) => item.assetIds.includes(assetId.data))) {
    throw knowledgeError('not_found', '采集批次或图片不存在 / capture batch asset not found');
  }
  const stored = await core.deps.repository.getCaptureAsset(actor.userId, batch.sessionId, assetId.data);
  if (stored === null) throw knowledgeError('not_found', '采集批次或图片不存在 / capture batch asset not found');
  if (stored.assetId !== assetId.data || stored.sessionId !== batch.sessionId
    || stored.bytes.byteLength === 0 || stored.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES
    || stored.bytes.byteLength !== stored.byteLength
    || createHash('sha256').update(stored.bytes).digest('hex') !== stored.sha256
    || !captureAssetBytesMatchMime(stored.bytes, stored.mimeType)) {
    throw knowledgeError('storage_error', '采集图片存储长度无效 / stored capture asset length is invalid');
  }

  const asset = captureAssetRefSchema.parse({
    assetId: stored.assetId,
    sessionId: stored.sessionId,
    mimeType: stored.mimeType,
    byteLength: stored.byteLength,
    sha256: stored.sha256,
    createdAt: stored.createdAt,
  });
  return { asset, bytes: new Uint8Array(stored.bytes) };
}

export async function retryCaptureBatchItem(
  core: KnowledgeCore,
  actor: ActorContext,
  batchId: string,
  requestId: string,
): Promise<CaptureBatchStatus> {
  const batch = await core.deps.repository.getCaptureBatch(actor.userId, batchId);
  if (batch === null) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
  const item = batch.items.find((candidate) => candidate.requestId === requestId);
  if (item === undefined) throw knowledgeError('not_found', `批次项目 ${requestId} 不存在 / capture batch item not found`);
  if (item.kind !== 'text') {
    if (item.status !== 'failed' || !item.retryable) throw knowledgeError('conflict', 'Only failed retryable image items can be retried');
    return publicBatch(await processImageBatchItem(core, actor, batchId, requestId), actor);
  }
  if (item.status !== 'failed' || !item.retryable) {
    throw knowledgeError('conflict', '只有可重试的失败文本项目可以重试 / only retryable failed text items can be retried');
  }
  await core.deps.repository.claimCaptureBatchItemForRetry(actor.userId, batchId, requestId);
  try {
    const clientId = item.capture.deviceId ?? item.capture.client;
    const knownSource = item.rawSourceId === null
      ? await core.deps.repository.findRawSourceByIdempotencyKey(actor.userId, clientId, item.requestId)
      : await core.deps.repository.findRawSource(item.rawSourceId, actor.userId);
    const result = knownSource !== null && knownSource.processingStatus !== 'done'
      ? await core.retryCapture(knownSource.id, actor)
      : await core.capture(captureRequest(item), actor);
    const updated = await saveResult(core, actor, batchId, item, result);
    return publicBatch(updated, actor);
  } catch (error) {
    const failed = await saveFailure(core, actor, batchId, item, error);
    return publicBatch(failed, actor);
  }
}

export async function processCaptureBatch(core: KnowledgeCore, actor: ActorContext, batchId: string, value: unknown): Promise<CaptureBatchStatus> {
  const request = processCaptureBatchRequestSchema.parse(value);
  let batch = await core.deps.repository.getCaptureBatch(actor.userId, batchId);
  if (!batch) throw knowledgeError('not_found', 'Capture batch not found');
  const ids = request.requestIds;
  if (ids !== undefined) for (const id of ids) {
    const item = batch.items.find(candidate => candidate.requestId === id);
    if (!item) throw knowledgeError('not_found', 'Capture batch item not found');
    if (item.kind === 'text') throw knowledgeError('invalid_request', 'Text items use the existing capture retry operation');
  }
  for (const item of batch.items) {
    if (item.kind === 'text' || (ids !== undefined && !ids.includes(item.requestId))) continue;
    if (item.status !== 'assets_saved' && !(item.status === 'failed' && item.retryable)) continue;
    batch = await processImageBatchItem(core, actor, batchId, item.requestId);
  }
  return publicBatch(batch, actor);
}
