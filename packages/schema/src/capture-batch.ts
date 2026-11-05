import { z } from 'zod';
import {
  MAX_CAPTURE_TEXT_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MIN_REQUEST_ID_LENGTH,
  captureRequestSchema,
  captureSourceSchema,
  captureMetaSchema,
} from './capture';
import { captureLibraryMetadataSchema } from './library';
import { MAX_SURROUNDING_CONTEXT_LENGTH } from './capture-limits';

export const MAX_CAPTURE_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_CAPTURE_BATCH_ITEMS = 100;
export const MAX_CAPTURE_BATCH_BODY_BYTES = 256_000;

export const captureProcessingReasonSchema = z.enum(['offline', 'unsupported', 'input_selection_required', 'uncertain_recognition', 'insufficient_text', 'recognition_too_long']);
export type CaptureProcessingReason = z.infer<typeof captureProcessingReasonSchema>;

const stableIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const captureSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const captureAssetMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export type CaptureAssetMime = z.infer<typeof captureAssetMimeSchema>;

export function captureAssetBytesMatchMime(bytes: Uint8Array, mimeType: CaptureAssetMime): boolean {
  const is = (offset: number, values: readonly number[]) => values.every((value, index) => bytes[offset + index] === value);
  switch (mimeType) {
    case 'image/png': return bytes.byteLength >= 8 && is(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return bytes.byteLength >= 3 && is(0, [0xff, 0xd8, 0xff]);
    case 'image/gif': return bytes.byteLength >= 6 && (is(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || is(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    case 'image/webp': return bytes.byteLength >= 12 && is(0, [0x52, 0x49, 0x46, 0x46]) && is(8, [0x57, 0x45, 0x42, 0x50]);
  }
}

export const captureAssetRefSchema = z.object({
  assetId: stableIdSchema,
  sessionId: stableIdSchema,
  mimeType: captureAssetMimeSchema,
  byteLength: z.number().int().positive().max(MAX_CAPTURE_ASSET_BYTES),
  sha256: captureSha256Schema,
  createdAt: z.string().min(4).max(64),
});
export type CaptureAssetRef = z.infer<typeof captureAssetRefSchema>;

export const captureBatchItemKindSchema = z.enum(['text', 'image', 'composite']);
export type CaptureBatchItemKind = z.infer<typeof captureBatchItemKindSchema>;

export const captureImageAnnotationSchema = z.object({
  type: z.enum(['rectangle', 'arrow', 'text', 'pixelate']),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  strokeWidth: z.union([z.literal(2), z.literal(4), z.literal(6)]),
  text: z.string().max(200).optional(),
  fontSize: z.union([z.literal(18), z.literal(24), z.literal(32)]).optional(),
  textRotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
}).superRefine((annotation, context) => {
  if (annotation.type === 'text' && (!annotation.text?.trim() || annotation.fontSize === undefined)) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'text annotations require text and a font size' });
  }
  if (annotation.type !== 'text' && (annotation.text !== undefined || annotation.fontSize !== undefined || annotation.textRotationDegrees !== undefined)) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'only text annotations may include text styling' });
  }
});
export type CaptureImageAnnotation = z.infer<typeof captureImageAnnotationSchema>;

export const captureDerivedAssetSchema = z.object({
  assetId: stableIdSchema,
  operation: z.enum(['rotate', 'stitch', 'annotate']),
  /** Ordered source IDs; stitch order is the exact order used by the rendered derivative. */
  sourceAssetIds: z.array(stableIdSchema).min(1).max(MAX_CAPTURE_BATCH_ITEMS),
  rotationDegrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
  direction: z.enum(['horizontal', 'vertical']).optional(),
  annotations: z.array(captureImageAnnotationSchema).min(1).max(200).optional(),
}).superRefine((asset, context) => {
  if (asset.operation === 'rotate' && (asset.sourceAssetIds.length !== 1 || asset.rotationDegrees === undefined || asset.direction !== undefined || asset.annotations !== undefined)) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'rotation derivatives require one source and a rotation angle' });
  }
  if (asset.operation === 'stitch' && (asset.sourceAssetIds.length < 2 || asset.direction === undefined || asset.rotationDegrees !== undefined || asset.annotations !== undefined)) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'stitch derivatives require ordered sources and a direction' });
  }
  if (asset.operation === 'annotate' && (asset.sourceAssetIds.length !== 1 || asset.annotations === undefined || asset.direction !== undefined)) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'annotation derivatives require one source and annotation geometry' });
  }
});
export type CaptureDerivedAsset = z.infer<typeof captureDerivedAssetSchema>;

export const captureBatchItemRequestSchema = z.object({
  requestId: z.string().trim().min(MIN_REQUEST_ID_LENGTH).max(MAX_REQUEST_ID_LENGTH),
  kind: captureBatchItemKindSchema,
  userOrder: z.number().int().nonnegative().max(MAX_CAPTURE_BATCH_ITEMS * 1000),
  text: z.string().max(MAX_CAPTURE_TEXT_LENGTH).optional(),
  surroundingContext: z.string().max(MAX_SURROUNDING_CONTEXT_LENGTH).optional(),
  assetIds: z.array(stableIdSchema).max(MAX_CAPTURE_BATCH_ITEMS).default([]),
  derivedAssets: z.array(captureDerivedAssetSchema).max(MAX_CAPTURE_BATCH_ITEMS).optional(),
  source: captureSourceSchema,
  capture: captureMetaSchema,
  library: captureLibraryMetadataSchema.optional(),
}).superRefine((item, context) => {
  if (item.kind === 'text') {
    if (item.text === undefined) {
      context.addIssue({ code: 'custom', path: ['text'], message: 'text items require original text' });
      return;
    }
    const parsed = captureRequestSchema.safeParse({
      requestId: item.requestId,
      text: item.text,
      source: item.source,
      capture: item.capture,
      ...(item.surroundingContext === undefined ? {} : { surroundingContext: item.surroundingContext }),
      ...(item.library === undefined ? {} : { library: item.library }),
    });
    if (!parsed.success) {
      context.addIssue({ code: 'custom', path: ['text'], message: 'text does not satisfy the capture contract' });
    }
    if (item.assetIds.length > 0) {
      context.addIssue({ code: 'custom', path: ['assetIds'], message: 'text-only items cannot reference image assets' });
    }
  } else if (item.assetIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['assetIds'], message: 'image and composite items require at least one asset' });
  }
  for (const [index, derived] of (item.derivedAssets ?? []).entries()) {
    if (!item.assetIds.includes(derived.assetId)) {
      context.addIssue({ code: 'custom', path: ['derivedAssets', index, 'assetId'], message: 'derived outputs must be included in the item asset IDs' });
    }
    if (derived.sourceAssetIds.includes(derived.assetId)) {
      context.addIssue({ code: 'custom', path: ['derivedAssets', index, 'sourceAssetIds'], message: 'a derived output cannot be its own source' });
    }
  }
});
export type CaptureBatchItemRequest = z.infer<typeof captureBatchItemRequestSchema>;

export const captureBatchRequestSchema = z.object({
  batchId: stableIdSchema,
  sessionId: stableIdSchema,
  items: z.array(captureBatchItemRequestSchema).min(1).max(MAX_CAPTURE_BATCH_ITEMS),
}).superRefine((batch, context) => {
  const requests = new Set<string>();
  const orders = new Set<number>();
  const allAssetIds = new Set(batch.items.flatMap((item) => item.assetIds));
  const derivedIds = new Set<string>();
  for (const [index, item] of batch.items.entries()) {
    if (requests.has(item.requestId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'requestId'], message: 'requestId must be unique within a batch' });
    }
    if (orders.has(item.userOrder)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'userOrder'], message: 'userOrder must be unique within a batch' });
    }
    requests.add(item.requestId);
    orders.add(item.userOrder);
    if (new Set(item.assetIds).size !== item.assetIds.length) {
      context.addIssue({ code: 'custom', path: ['items', index, 'assetIds'], message: 'asset IDs must be unique within an item' });
    }
    for (const [derivedIndex, derived] of (item.derivedAssets ?? []).entries()) {
      if (derivedIds.has(derived.assetId)) {
        context.addIssue({ code: 'custom', path: ['items', index, 'derivedAssets', derivedIndex, 'assetId'], message: 'each derived asset may be declared once per batch' });
      }
      derivedIds.add(derived.assetId);
    }
  }
  for (const [index, item] of batch.items.entries()) {
    for (const [derivedIndex, derived] of (item.derivedAssets ?? []).entries()) {
      if (derived.sourceAssetIds.some((assetId) => !allAssetIds.has(assetId) || derivedIds.has(assetId))) {
        context.addIssue({ code: 'custom', path: ['items', index, 'derivedAssets', derivedIndex, 'sourceAssetIds'], message: 'derived source IDs must reference stored source assets in this batch' });
      }
    }
  }
});
export type CaptureBatchRequest = z.infer<typeof captureBatchRequestSchema>;

export const captureBatchItemStatusSchema = z.enum(['queued', 'assets_saved', 'processing', 'needs_review', 'done', 'failed']);
export type CaptureBatchItemStatus = z.infer<typeof captureBatchItemStatusSchema>;

export const captureBatchStatusItemSchema = z.object({
  requestId: z.string().min(MIN_REQUEST_ID_LENGTH).max(MAX_REQUEST_ID_LENGTH),
  kind: captureBatchItemKindSchema,
  userOrder: z.number().int().nonnegative(),
  assetIds: z.array(stableIdSchema),
  derivedAssets: z.array(captureDerivedAssetSchema).max(MAX_CAPTURE_BATCH_ITEMS).optional(),
  status: captureBatchItemStatusSchema,
  rawSourceId: z.string().optional(),
  duplicate: z.boolean(),
  retryable: z.boolean(),
  errorReason: z.string().max(2000).optional(),
  processingReason: captureProcessingReasonSchema.optional(),
  updatedAt: z.string().min(4).max(64),
});
export type CaptureBatchStatusItem = z.infer<typeof captureBatchStatusItemSchema>;

export const captureBatchStatusSchema = z.object({
  batchId: stableIdSchema,
  sessionId: stableIdSchema,
  items: z.array(captureBatchStatusItemSchema).max(MAX_CAPTURE_BATCH_ITEMS),
  createdAt: z.string().min(4).max(64),
  updatedAt: z.string().min(4).max(64),
});
export type CaptureBatchStatus = z.infer<typeof captureBatchStatusSchema>;

export const DEFAULT_CAPTURE_BATCH_LIST_LIMIT = 20;
export const MAX_CAPTURE_BATCH_LIST_LIMIT = 50;
export const captureBatchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CAPTURE_BATCH_LIST_LIMIT).default(DEFAULT_CAPTURE_BATCH_LIST_LIMIT),
});
export type CaptureBatchListQuery = z.infer<typeof captureBatchListQuerySchema>;

export const captureBatchListSchema = z.object({
  batches: z.array(captureBatchStatusSchema).max(MAX_CAPTURE_BATCH_LIST_LIMIT),
});
export type CaptureBatchList = z.infer<typeof captureBatchListSchema>;

export const captureBatchSubmitResultSchema = z.object({
  duplicate: z.boolean(),
  batch: captureBatchStatusSchema,
});
export type CaptureBatchSubmitResult = z.infer<typeof captureBatchSubmitResultSchema>;

export const captureAssetUploadResultSchema = z.object({
  duplicate: z.boolean(),
  asset: captureAssetRefSchema,
});
export type CaptureAssetUploadResult = z.infer<typeof captureAssetUploadResultSchema>;
