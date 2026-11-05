import { z } from 'zod';
import { captureAssetBytesMatchMime, captureAssetMimeSchema, MAX_CAPTURE_ASSET_BYTES } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { AIProvider, ImageRecognitionResult, RecognizeImageInput } from './types';

export const MAX_IMAGE_RECOGNITION_OUTPUT_CHARS = 100_000;
const textSchema = z.string().max(20_000);
const unitSchema = z.number().finite().min(0).max(1);
const regionSchema = z.object({
  x: unitSchema,
  y: unitSchema,
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
}).strict().refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
  message: 'region must be contained within the image',
});
const resultSchema = z.object({
  text: textSchema,
  confidence: unitSchema,
  blocks: z.array(z.object({
    kind: z.enum(['paragraph', 'table', 'code', 'formula', 'image']),
    text: textSchema,
    region: regionSchema.optional(),
  }).strict()).max(100),
  uncertainRegions: z.array(z.object({
    reason: z.string().min(1).max(1000).refine((reason) => reason.trim().length > 0),
    text: textSchema.optional(),
    region: regionSchema.optional(),
  }).strict()).max(100),
}).strict();
const inputSchema = z.object({
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_CAPTURE_ASSET_BYTES),
  mimeType: captureAssetMimeSchema,
}).strict();

/** Bounds encoded bytes and checks their MIME signature; it does not decode image pixels. */
export function validateRecognizeImageInput(input: unknown): RecognizeImageInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !captureAssetBytesMatchMime(parsed.data.bytes, parsed.data.mimeType)) {
    throw knowledgeError('invalid_request', 'recognizeImage requires bounded PNG/JPEG/WebP/GIF bytes matching their MIME type');
  }
  return parsed.data;
}

/** Model output is derived content only. Strict objects reject invented provenance fields. */
export function validateImageRecognitionResult(result: unknown): ImageRecognitionResult {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) {
    throw knowledgeError('provider_error', 'recognizeImage: invalid structured image recognition output', {
      issue: parsed.error.issues[0]?.path.join('.'),
    });
  }
  if (JSON.stringify(parsed.data).length > MAX_IMAGE_RECOGNITION_OUTPUT_CHARS) {
    throw knowledgeError('provider_error', 'recognizeImage: image recognition output exceeds the size limit');
  }
  return parsed.data;
}

/** Optional capability gate for Core and callers using older text-only providers. */
export async function recognizeImage(provider: AIProvider, input: RecognizeImageInput): Promise<ImageRecognitionResult> {
  if (provider.capabilities.imageRecognition !== true || provider.recognizeImage === undefined) {
    throw knowledgeError('invalid_request', 'Image recognition is unavailable for this provider');
  }
  const validated = validateRecognizeImageInput(input);
  // Providers receive a copy so recognition cannot mutate the caller's original asset bytes.
  const result = await provider.recognizeImage({ ...validated, bytes: Uint8Array.from(validated.bytes) });
  return validateImageRecognitionResult(result);
}
