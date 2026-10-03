/**
 * Step 4 of the pipeline: normalize each extracted point.
 *
 * Extraction is read-only over the user's material: normalizing produces a *new* representation for
 * the KnowledgeItem row and never touches the RawSource (PROJECT_MASTER §2.2).
 */
import type { ExtractedKnowledge } from '@noltri/ai-provider';
import { deriveTitle, normalizeKnowledgeText, truncate } from '@noltri/shared';
import { clamp01, MAX_NODE_TITLE_CHARS } from '../types';

export interface NormalizedPoint {
  /** The atomic knowledge text that becomes knowledge_items.normalized_text. */
  readonly text: string;
  readonly summary: string | null;
  readonly confidence: number;
  /** Title suggestion carried into classification. */
  readonly title: string;
}

const FALLBACK_CONFIDENCE = 0.5;

export function normalizePoints(extracted: readonly ExtractedKnowledge[], maxItems: number): NormalizedPoint[] {
  const points: NormalizedPoint[] = [];
  const seen = new Set<string>();

  for (const entry of extracted) {
    if (points.length >= maxItems) break;
    const text = normalizeKnowledgeText(typeof entry?.text === 'string' ? entry.text : '');
    if (text.length === 0) continue;

    // Two sentences of the same selection saying the same thing are one knowledge point.
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const summary = normalizeKnowledgeText(entry.summary ?? '');
    const rawTitle = normalizeKnowledgeText(entry.suggestedTitle ?? '');

    points.push({
      text,
      summary: summary.length > 0 ? truncate(summary, 400) : null,
      confidence: clamp01(Number.isFinite(entry.confidence) ? entry.confidence : FALLBACK_CONFIDENCE),
      title: truncate(rawTitle.length > 0 ? rawTitle : deriveTitle(text, 28), MAX_NODE_TITLE_CHARS).trim(),
    });
  }

  return points;
}
