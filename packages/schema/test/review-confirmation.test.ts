import { describe, expect, it } from 'vitest';
import { rawSourceSchema } from '../src/knowledge';

const rawSource = {
  id: 'source', userId: 'owner', rawText: 'immutable original', surroundingContext: null,
  sourceType: 'manual', sourcePlatform: null, sourceApp: null, sourceTitle: null, sourceUrl: null,
  capturedAt: '2026-11-04', metadata: {}, processingStatus: 'done', reviewStatus: 'confirmed',
  reviewRevision: 1, errorReason: null, createdAt: '2026-11-04', requestId: null, clientId: null,
};
const confirmation = {
  rawSourceId: 'source', reviewRevision: 1, knowledgeItemId: 'manual-item', text: 'human draft',
  targetNodeId: 'leaf', path: [{ id: 'root', title: 'Original parent' }, { id: 'leaf', title: 'Original target' }],
};

describe('raw source confirmation projection wire schema', () => {
  it('preserves a canonical confirmation separately from immutable source text', () => {
    expect(rawSourceSchema.parse({ ...rawSource, reviewConfirmation: confirmation })).toMatchObject({
      rawText: 'immutable original', reviewConfirmation: confirmation,
    });
  });
  it('accepts old responses and explicit absence without inventing a human result', () => {
    expect(rawSourceSchema.parse(rawSource)).toEqual(rawSource);
    expect(rawSourceSchema.parse({ ...rawSource, reviewConfirmation: null })).toMatchObject({ reviewConfirmation: null });
  });
  it.each([
    { ...confirmation, reviewRevision: 0 },
    { ...confirmation, path: [] },
    { ...confirmation, targetNodeId: undefined },
  ])('rejects a malformed confirmation instead of silently discarding it', reviewConfirmation => {
    expect(rawSourceSchema.safeParse({ ...rawSource, reviewConfirmation }).success).toBe(false);
  });
});
