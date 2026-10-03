import { z } from 'zod';
import {
  captureActionSchema,
  captureClientSchema,
  confidenceTierSchema,
  processingStatusSchema,
  sourceTypeSchema,
} from './enums';

export const captureSourceSchema = z.object({
  type: sourceTypeSchema,
  platform: z.string().min(1).max(120).optional(),
  appName: z.string().min(1).max(120).optional(),
  title: z.string().max(600).optional(),
  url: z.string().max(2048).optional(),
});
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const captureMetaSchema = z.object({
  capturedAt: z.string().min(4).max(64),
  deviceId: z.string().max(200).optional(),
  client: captureClientSchema,
});
export type CaptureMeta = z.infer<typeof captureMetaSchema>;

export const MIN_CAPTURE_TEXT_LENGTH = 8;
export const MAX_CAPTURE_TEXT_LENGTH = 40_000;
export const MAX_SURROUNDING_CONTEXT_LENGTH = 20_000;

/**
 * Every capture entry point (extension, desktop, MCP, web app) reduces to this shape.
 * The user is never part of the payload — identity comes from the authenticated request.
 */
export const captureRequestSchema = z.object({
  text: z.string().trim().min(MIN_CAPTURE_TEXT_LENGTH).max(MAX_CAPTURE_TEXT_LENGTH),
  surroundingContext: z.string().max(MAX_SURROUNDING_CONTEXT_LENGTH).optional(),
  source: captureSourceSchema,
  capture: captureMetaSchema,
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

export const captureResultSchema = z.object({
  rawSourceId: z.string(),
  items: z.array(captureResultItemSchema),
  processingStatus: processingStatusSchema,
  errorReason: z.string().max(2000).optional(),
});
export type CaptureResult = z.infer<typeof captureResultSchema>;
