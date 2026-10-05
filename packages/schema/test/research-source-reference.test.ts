/**
 * R03's shapes: a 证据 row carries machine-readable pointers to its 出处 next to the 定位 a human typed, and
 * the two are independent — 「第 4 段」 is not resolvable to a node, and a nodeId is not readable to a person.
 *
 * The pointers are required keys that may be `null` rather than optional keys: an old row predating R03 must
 * still parse, and a missing key is what tells a driver it forgot to map a column.
 */
import { describe, expect, it } from 'vitest';
import {
  archivedSourceMarksSchema,
  archiveSourceRequestSchema,
  createEvidenceInputSchema,
  evidenceLocationOriginSchema,
  evidenceSchema,
  patchEvidenceRequestSchema,
  researchReferenceMatchSchema,
  researchReferenceQuerySchema,
  researchReferenceResponseSchema,
} from '../src/index';

const ISO = '2026-10-05T00:00:00.000Z';

function rowOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-1',
    projectId: 'rp-1',
    userId: 'user-1',
    type: 'interview',
    title: '访谈：王工 2026-03',
    description: null,
    sourceReference: '访谈转录稿 第 4 页',
    sourceLocation: '第 4 段',
    rawSourceId: null,
    nodeId: null,
    locationOrigin: null,
    reliabilityNote: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

describe('evidence provenance', () => {
  it('accepts a row with typed pointers and a row without them', () => {
    expect(evidenceSchema.parse(rowOf())).toMatchObject({ nodeId: null, rawSourceId: null, locationOrigin: null });
    expect(
      evidenceSchema.parse(rowOf({ nodeId: 'node-1', rawSourceId: 'raw-1', locationOrigin: 'captured' })),
    ).toMatchObject({ nodeId: 'node-1', locationOrigin: 'captured' });
  });

  it('requires the pointer keys to be present, not merely non-null', () => {
    const row = rowOf();
    delete row.nodeId;
    expect(evidenceSchema.safeParse(row).success).toBe(false);
  });

  it('knows only two locator origins', () => {
    expect(evidenceLocationOriginSchema.options).toEqual(['manual', 'captured']);
    expect(evidenceSchema.safeParse(rowOf({ locationOrigin: 'guessed' })).success).toBe(false);
    // 手动定位 stays whatever the pointers say: the two halves are independent.
    expect(
      evidenceSchema.safeParse(rowOf({ nodeId: null, locationOrigin: 'manual', sourceLocation: '第 4 段' })).success,
    ).toBe(true);
  });

  it('takes the three on create and patch as optional and nullable', () => {
    // The storage input carries identity (the request schema does not); only the provenance keys are tested here.
    const identity = { userId: 'user-1', projectId: 'rp-1', type: 'interview', title: 'T' };
    // Absent, not null: a caller that says nothing about provenance leaves the keys out.
    expect(Object.keys(createEvidenceInputSchema.parse(identity)).sort()).toEqual([
      'projectId',
      'title',
      'type',
      'userId',
    ]);
    expect(
      createEvidenceInputSchema.parse({ ...identity, nodeId: 'n', rawSourceId: 'r', locationOrigin: 'captured' }),
    ).toMatchObject({ nodeId: 'n', locationOrigin: 'captured' });
    expect(patchEvidenceRequestSchema.parse({ nodeId: null })).toEqual({ nodeId: null });
    expect(patchEvidenceRequestSchema.safeParse({ locationOrigin: 'other' }).success).toBe(false);
    expect(createEvidenceInputSchema.safeParse({ ...identity, nodeId: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('the reference check shapes', () => {
  it('needs at least one source id, and takes either or both', () => {
    expect(researchReferenceQuerySchema.safeParse({}).success).toBe(false);
    expect(researchReferenceQuerySchema.safeParse({ nodeId: 'node-1' }).success).toBe(true);
    expect(researchReferenceQuerySchema.safeParse({ rawSourceId: 'raw-1' }).success).toBe(true);
    expect(researchReferenceQuerySchema.safeParse({ nodeId: 'n', rawSourceId: 'r' }).success).toBe(true);
    // 空串 is 「没指名道」, not a search for a node whose id is empty.
    expect(researchReferenceQuerySchema.safeParse({ nodeId: '' }).success).toBe(false);
  });

  it('reports the 论点 list even when the 证据 supports nothing yet', () => {
    const match = researchReferenceMatchSchema.parse({
      projectId: 'rp-1',
      projectName: '冷链物流服务质量研究',
      evidenceId: 'ev-1',
      evidenceTitle: '访谈：王工 2026-03',
      evidenceType: 'interview',
      claimIds: [],
    });
    expect(match.claimIds).toEqual([]);
    expect(researchReferenceResponseSchema.parse({ references: [match] }).references).toHaveLength(1);
    expect(researchReferenceResponseSchema.parse({ references: [] }).references).toEqual([]);
    expect(researchReferenceMatchSchema.safeParse({ ...match, evidenceType: 'rumour' }).success).toBe(false);
  });

  it('lets an archive request name nothing, and answers with three id lists', () => {
    expect(archiveSourceRequestSchema.parse({})).toEqual({});
    expect(archiveSourceRequestSchema.parse({ nodeId: null, sourceTitle: null })).toEqual({ nodeId: null, sourceTitle: null });
    expect(archivedSourceMarksSchema.parse({ markedEvidenceIds: [], markedClaimIds: [], projectIds: [] })).toEqual({
      markedEvidenceIds: [],
      markedClaimIds: [],
      projectIds: [],
    });
    expect(archivedSourceMarksSchema.safeParse({ markedEvidenceIds: [] }).success).toBe(false);
  });
});
