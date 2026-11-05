import { reviewSourceRequestSchema, reviewSourceResponseSchema, type RawSource, type RawSourceReviewConfirmation, type ReviewSourceRequest, type ReviewStatus } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';

export function reviewIntent(request: ReviewSourceRequest): { request: ReviewSourceRequest; fingerprint: string } {
  const parsed = reviewSourceRequestSchema.safeParse(request);
  if (!parsed.success) throw knowledgeError('invalid_request', 'Invalid review action', parsed.error.issues);
  const valid = parsed.data;
  return { request: valid, fingerprint: JSON.stringify([valid.action, valid.expectedRevision, valid.action === 'confirm' ? valid.nodeId : null, valid.action === 'confirm' ? valid.editedText ?? null : null]) };
}

export function nextReviewStatus(source: RawSource, request: ReviewSourceRequest): ReviewStatus {
  if (source.reviewRevision !== request.expectedRevision) throw knowledgeError('conflict', 'Review revision is stale; refresh the source before applying this draft');
  if (source.reviewRevision >= Number.MAX_SAFE_INTEGER) throw knowledgeError('conflict', 'Review revision is exhausted');
  if (request.action === 'restore') {
    if (source.reviewStatus !== 'deferred' && source.reviewStatus !== 'rejected') throw knowledgeError('conflict', 'Only deferred or rejected sources can be restored');
    return 'needs_review';
  }
  if (source.reviewStatus !== 'needs_review') throw knowledgeError('conflict', 'Source is no longer awaiting review');
  return request.action === 'confirm' ? 'confirmed' : request.action === 'defer' ? 'deferred' : 'rejected';
}

/** Read only the exact immutable human action; never infer a result from current item/catalog rows. */
export function reviewConfirmationOf(
  id: string, userId: string, reviewRevision: number,
  actions: Iterable<{ fingerprint: string; response: unknown }>,
): RawSourceReviewConfirmation | null {
  if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 1) return null;
  let found: RawSourceReviewConfirmation | null = null;
  for (const action of actions) {
    let response: unknown;
    let intent: unknown;
    try {
      response = typeof action.response === 'string' ? JSON.parse(action.response) : action.response;
      intent = JSON.parse(action.fingerprint);
    } catch { return null; }
    const parsed = reviewSourceResponseSchema.safeParse(response);
    if (!parsed.success) return null;
    const saved = parsed.data;
    if (saved.reviewRevision !== reviewRevision) continue;
    const item = saved.item;
    const path = saved.path;
    const leaf = path?.at(-1);
    if (saved.reviewStatus !== 'confirmed' || !item || item.userId !== userId || item.rawSourceId !== id || item.isAiDerived ||
      !item.id || !item.normalizedText.trim() || !path?.length || !leaf?.id || path.some(segment => !segment.id) ||
      new Set(path.map(segment => segment.id)).size !== path.length ||
      !Array.isArray(intent) || intent.length !== 4 || intent[0] !== 'confirm' || intent[1] !== reviewRevision - 1 ||
      intent[2] !== leaf.id || (intent[3] !== null && (typeof intent[3] !== 'string' || intent[3].trim() !== item.normalizedText))) return null;
    // Two matching records are ambiguous even if their contents happen to agree.
    if (found !== null) return null;
    found = { rawSourceId: id, reviewRevision, knowledgeItemId: item.id, text: item.normalizedText,
      targetNodeId: leaf.id, path: path.map(segment => ({ ...segment })) };
  }
  return found;
}
