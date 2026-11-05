import { captureImageProvenanceSchema, tierForConfidence, MAX_CAPTURE_TEXT_LENGTH, MIN_CAPTURE_TEXT_LENGTH, type RawSource, type CaptureProcessingReason } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { CoreDeps } from '../types';

/** Recognition is a separate derived input; this function never writes RawSource.rawText. */
export async function imageProcessingInput(deps: CoreDeps, source: RawSource) {
  const value = source.metadata.capture;
  if (typeof value !== 'object' || value === null || !('kind' in value) || (value.kind !== 'image' && value.kind !== 'composite')) return null;
  const parsed = captureImageProvenanceSchema.safeParse(value);
  if (!parsed.success) throw knowledgeError('storage_error', 'Invalid saved image provenance');
  const snapshot = await deps.repository.getCaptureRecognitionSnapshot(source.userId, source.id);
  let reason: CaptureProcessingReason | undefined;
  let processingText: string | null = null;
  if (!snapshot || snapshot.inputs.some(input => !snapshot.results.some(entry => entry.assetId === input.assetId))) reason = 'insufficient_text';
  else {
    const ordered = snapshot.inputs.map(input => snapshot.results.find(entry => entry.assetId === input.assetId)!);
    const text = ordered.map(entry => entry.result.text).join('\n\n');
    processingText = (source.rawText.length > 0 ? '[原始附文]\n' + source.rawText + '\n\n' : '') + '[图片识别衍生文本]\n' + text;
    if (processingText.length > MAX_CAPTURE_TEXT_LENGTH) { reason = 'recognition_too_long'; processingText = null; }
    else if (ordered.some(entry => entry.result.uncertainRegions.length > 0 || tierForConfidence(entry.result.confidence, deps.config.thresholds) !== 'high')) reason = 'uncertain_recognition';
    else if (ordered.some(entry => entry.result.text.trim().length === 0) || (source.rawText + '\n' + text).trim().length < MIN_CAPTURE_TEXT_LENGTH) reason = 'insufficient_text';
  }
  return { provenance: parsed.data, snapshot, processingText, reason };
}
