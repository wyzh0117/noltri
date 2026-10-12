import { z } from 'zod';
import {
  captureActionSchema,
  captureClientSchema,
  captureStageSchema,
  confidenceTierSchema,
  processingStatusSchema,
  sourceTypeSchema,
} from './enums';
import { captureLibraryMetadataSchema, captureSourceUrlSchema } from './library';
import {
  MAX_CAPTURE_TEXT_LENGTH,
  MAX_SURROUNDING_CONTEXT_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MIN_CAPTURE_TEXT_LENGTH,
  MIN_REQUEST_ID_LENGTH,
} from './capture-limits';
export { MAX_CAPTURE_TEXT_LENGTH, MAX_SURROUNDING_CONTEXT_LENGTH, MAX_REQUEST_ID_LENGTH, MIN_CAPTURE_TEXT_LENGTH, MIN_REQUEST_ID_LENGTH } from './capture-limits';

export const captureSourceSchema = z.object({
  type: sourceTypeSchema,
  platform: z.string().min(1).max(120).optional(),
  appName: z.string().min(1).max(120).optional(),
  title: z.string().max(600).optional(),
  url: captureSourceUrlSchema.optional(),
});
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const captureMetaSchema = z.object({
  capturedAt: z.string().min(4).max(64),
  /**
   * The install this text came from. It scopes the idempotency key when a device states one, and the entry
   * point does the same job when it does not, so a key is always scoped by something the caller controls.
   */
  deviceId: z.string().max(200).optional(),
  client: captureClientSchema,
});
export type CaptureMeta = z.infer<typeof captureMetaSchema>;

/**
 * Every capture entry point (extension, desktop, MCP, web app) reduces to this shape.
 * The user is never part of the payload — identity comes from the authenticated request.
 *
 * `requestId` is generated once by the client and kept when a queue resends, so the server can answer the
 * same submission twice without writing the text twice (本地桌面版开发文档 §7.4「服务端按 (clientId, requestId) 幂等」,
 * §10.3「断线重试使用相同 requestId」).
 */
export const captureRequestSchema = z.object({
  requestId: z.string().trim().min(MIN_REQUEST_ID_LENGTH).max(MAX_REQUEST_ID_LENGTH),
  text: z
    .string()
    .min(MIN_CAPTURE_TEXT_LENGTH)
    .max(MAX_CAPTURE_TEXT_LENGTH)
    .refine((text) => text.trim().length >= MIN_CAPTURE_TEXT_LENGTH),
  surroundingContext: z.string().max(MAX_SURROUNDING_CONTEXT_LENGTH).optional(),
  source: captureSourceSchema,
  capture: captureMetaSchema,
  /** Optional library card details, persisted with the original text before any AI call. */
  library: captureLibraryMetadataSchema.optional(),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;

export const captureResultItemSchema = z.object({
  knowledgeItemId: z.string(),
  text: z.string(),
  nodeId: z.string(),
  nodePath: z.array(z.string()),
  action: captureActionSchema,
  confidence: z.number().min(0).max(1),
  confidenceTier: confidenceTierSchema,
});
export type CaptureResultItem = z.infer<typeof captureResultItemSchema>;

/**
 * The reply states the stage the capture reached, and whether this submission was already known.
 *
 * A replay never echoes `items`: rebuilding them from stored rows would put numbers on a decision the
 * model never made, so it names the stage, points at the original `rawSourceId` and lets the inbox show
 * what was filed.
 */
export const captureResultSchema = z.object({
  rawSourceId: z.string(),
  requestId: z.string(),
  stage: captureStageSchema,
  /** True when the server already held a source for this (clientId, requestId) and wrote nothing new. */
  duplicate: z.boolean(),
  items: z.array(captureResultItemSchema),
  processingStatus: processingStatusSchema,
  errorReason: z.string().max(2000).optional(),
});
export type CaptureResult = z.infer<typeof captureResultSchema>;
