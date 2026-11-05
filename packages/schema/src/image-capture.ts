import { z } from 'zod';
import { captureAssetRefSchema, MAX_CAPTURE_BATCH_ITEMS } from './capture-batch';
import { MAX_CAPTURE_TEXT_LENGTH } from './capture-limits';

const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().refine(value => value.x + value.width <= 1 && value.y + value.height <= 1);
export const storedImageRecognitionResultSchema = z.object({
  text: z.string().max(20_000), confidence: z.number().min(0).max(1),
  blocks: z.array(z.object({ kind: z.enum(['paragraph', 'table', 'code', 'formula', 'image']), text: z.string().max(20_000), region: region.optional() }).strict()).max(100),
  uncertainRegions: z.array(z.object({ reason: z.string().min(1).max(1000).refine(value => value.trim().length > 0), text: z.string().max(20_000).optional(), region: region.optional() }).strict()).max(100),
}).strict().refine(value => JSON.stringify(value).length <= 100_000);
export const captureImageProvenanceSchema = z.object({
  kind: z.enum(['image', 'composite']), batchId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), requestId: z.string().min(8).max(64),
  originalTextPresent: z.boolean(), assetRefs: z.array(captureAssetRefSchema).min(1).max(MAX_CAPTURE_BATCH_ITEMS),
  derivedAssets: z.array(z.object({ assetId: z.string().min(1).max(200), operation: z.enum(['rotate', 'stitch', 'annotate']), sourceAssetIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_CAPTURE_BATCH_ITEMS), rotationDegrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(), direction: z.enum(['horizontal', 'vertical']).optional(), annotationCount: z.number().int().min(0).max(200).optional() }).strict()).max(MAX_CAPTURE_BATCH_ITEMS),
}).strict();
export type CaptureImageProvenance = z.infer<typeof captureImageProvenanceSchema>;
export const captureRecognitionEntrySchema = z.object({
  assetId: z.string().min(1).max(200), providerId: z.string().min(1).max(120), modelId: z.string().min(1).max(200).optional(),
  result: storedImageRecognitionResultSchema, createdAt: z.string().min(4).max(64),
}).strict();
export type CaptureRecognitionEntry = z.infer<typeof captureRecognitionEntrySchema>;
export const captureRecognitionSnapshotSchema = z.object({
  version: z.literal(1), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  inputs: z.array(captureAssetRefSchema).min(1).max(MAX_CAPTURE_BATCH_ITEMS),
  results: z.array(captureRecognitionEntrySchema).max(MAX_CAPTURE_BATCH_ITEMS),
  createdAt: z.string().min(4).max(64), updatedAt: z.string().min(4).max(64),
}).strict();
export type CaptureRecognitionSnapshot = z.infer<typeof captureRecognitionSnapshotSchema>;
export const captureRecognitionResponseSchema = z.object({
  rawSourceId: z.string(), provenance: captureImageProvenanceSchema,
  snapshot: captureRecognitionSnapshotSchema.nullable(), processingText: z.string().max(MAX_CAPTURE_TEXT_LENGTH).nullable(),
});
export type CaptureRecognitionResponse = z.infer<typeof captureRecognitionResponseSchema>;
export const processCaptureBatchRequestSchema = z.object({ requestIds: z.array(z.string().trim().min(8).max(64)).min(1).max(MAX_CAPTURE_BATCH_ITEMS).refine(ids => new Set(ids).size === ids.length).optional() }).strict();
export type ProcessCaptureBatchRequest = z.infer<typeof processCaptureBatchRequestSchema>;
