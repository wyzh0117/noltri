/**
 * R06 makes 批准 an object that has to outlive the draft it came from, so its shape is a contract rather
 * than an implementation detail: versions start at 1, 「没有上一版」 is `null` and not 0, the snapshot is the
 * whole 章程, and the diff may only name fields the draft itself declares.
 *
 * `CHARTER_FIELD_NAMES` is derived from `charterFieldsSchema.shape`, and the domain's diff iterates exactly
 * that array — so this file pins the derivation. A charter field that failed to reach the ledger would read
 * as「从没改过」 forever, which is a silent wrong answer rather than a loud one.
 */
import { describe, expect, it } from 'vitest';
import {
  approveCharterRequestSchema,
  CHARTER_FIELD_NAMES,
  charterFieldNameSchema,
  charterFieldsSchema,
  charterVersionSchema,
  createReviewMarkInputSchema,
  researchCharterSchema,
  researchEntityRefSchema,
  researchEntityTypeSchema,
  researchReviewMarkSchema,
  reviewMarkRaisedBySchema,
  reviewMarkStatusSchema,
  type CharterFieldName,
} from '../src/index';

const ISO = '2026-10-05T00:00:00.000Z';

/** A 章程 row: every declared field present, only `workingTitle` required by the schema. */
function draftOf(overrides: Partial<Record<CharterFieldName, string | null>> = {}): Record<string, unknown> {
  const fields: Record<string, string | null> = {};
  for (const field of CHARTER_FIELD_NAMES) fields[field] = null;
  fields.workingTitle = '碳定价与工业排放';
  return {
    id: 'chtr-1',
    projectId: 'rp-1',
    userId: 'user-1',
    createdAt: ISO,
    updatedAt: ISO,
    ...fields,
    ...overrides,
  };
}

function versionOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cv-1',
    projectId: 'rp-1',
    userId: 'user-1',
    version: 1,
    previousVersion: null,
    charter: draftOf(),
    changedFields: [],
    revisionReason: '开题时批准的基线',
    decisionId: null,
    approvedAt: ISO,
    ...overrides,
  };
}

describe('the 字段账本 a baseline diff reads', () => {
  it('names exactly the fields the draft declares', () => {
    expect([...CHARTER_FIELD_NAMES].sort()).toEqual(Object.keys(charterFieldsSchema.shape).sort());
    expect(CHARTER_FIELD_NAMES.length).toBeGreaterThan(0);
  });

  it('is frozen, because that array is also what the enum reads', () => {
    const names = CHARTER_FIELD_NAMES as readonly string[] as string[];
    expect(Object.isFrozen(names)).toBe(true);
    expect(() => names.push('goneField')).toThrow(TypeError);
    expect(charterFieldNameSchema.options).toEqual([...CHARTER_FIELD_NAMES]);
  });

  it('accepts its own names and refuses one the draft does not have', () => {
    for (const field of CHARTER_FIELD_NAMES) {
      expect(charterFieldNameSchema.safeParse(field).success, field).toBe(true);
    }
    // 存储列名不是章程字段：`userId` 在两张表里都有，却不该出现在 diff 里。
    expect(charterFieldNameSchema.safeParse('goneField').success).toBe(false);
    expect(charterFieldNameSchema.safeParse('userId').success).toBe(false);
  });
});

describe('an approved charter version', () => {
  it('counts versions from 1 and refuses anything else', () => {
    expect(charterVersionSchema.safeParse(versionOf({ version: 1 })).success).toBe(true);
    for (const version of [0, -1, 1.5, '1']) {
      expect(charterVersionSchema.safeParse(versionOf({ version })).success, String(version)).toBe(false);
    }
  });

  it('states 「no previous version」 as null, not as version zero', () => {
    expect(charterVersionSchema.safeParse(versionOf({ previousVersion: null })).success).toBe(true);
    expect(charterVersionSchema.safeParse(versionOf({ previousVersion: 2 })).success).toBe(true);
    expect(charterVersionSchema.safeParse(versionOf({ previousVersion: 0 })).success).toBe(false);
    expect(charterVersionSchema.safeParse(versionOf({ previousVersion: undefined })).success).toBe(false);
  });

  it('snapshots the whole draft through the frozen charter schema', () => {
    // 同一份 schema，不是「宽松一点的副本」：批准版本要能原样读回当时那个对象。
    expect(charterVersionSchema.shape.charter).toBe(researchCharterSchema);
    const partial = draftOf();
    delete partial.claimBoundary;
    expect(charterVersionSchema.safeParse(versionOf({ charter: partial })).success).toBe(false);
  });

  it('reports changed fields only by declared name', () => {
    // 首版是空表：没有可对比的上一版，不等于 14 个字段全改了。
    expect(charterVersionSchema.safeParse(versionOf({ changedFields: [] })).success).toBe(true);
    expect(charterVersionSchema.safeParse(versionOf({ changedFields: ['researchMethod'] })).success).toBe(true);
    expect(charterVersionSchema.safeParse(versionOf({ changedFields: ['goneField'] })).success).toBe(false);
    expect(charterVersionSchema.safeParse(versionOf({ changedFields: null })).success).toBe(false);
  });
});

describe('the approval request', () => {
  it('demands a reason, since a 批准 without one records nothing', () => {
    expect(approveCharterRequestSchema.safeParse({ revisionReason: '换识别策略' }).success).toBe(true);
    expect(approveCharterRequestSchema.safeParse({ revisionReason: '' }).success).toBe(false);
    expect(approveCharterRequestSchema.safeParse({}).success).toBe(false);
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('lets the 依据决策 be absent or explicitly null, but not a number', () => {
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r' }).success).toBe(true);
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r', decisionId: null }).success).toBe(true);
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r', decisionId: 'dec-1' }).success).toBe(true);
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r', decisionId: 7 }).success).toBe(false);
  });

  it('requires both halves of every named object, and bounds how many', () => {
    expect(approveCharterRequestSchema.safeParse({
      revisionReason: 'r',
      affectedEntities: [{ entityType: 'research_question', entityId: 'rq-1' }],
    }).success).toBe(true);

    for (const ref of [{}, { entityType: 'claim' }, { entityId: 'c-1' }, { entityId: '' },
      { entityType: 'node', entityId: 'n-1' }]) {
      expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r', affectedEntities: [ref] }).success)
        .toBe(false);
    }

    const tooMany = Array.from({ length: 201 }, (_unused, index) => ({ entityType: 'claim', entityId: `c-${index}` }));
    expect(approveCharterRequestSchema.safeParse({ revisionReason: 'r', affectedEntities: tooMany }).success)
      .toBe(false);
  });

  it('points at the same 实体词汇 a relation does', () => {
    for (const entityType of researchEntityTypeSchema.options) {
      expect(researchEntityRefSchema.safeParse({ entityType, entityId: 'x-1' }).success, entityType).toBe(true);
    }
  });
});

describe('a review mark', () => {
  it('has exactly two causes and two states', () => {
    // 两种原因都是「别装作这条绑定还有效」：新基线（R06）与来源被归档（R03）。
    expect([...reviewMarkRaisedBySchema.options]).toEqual(['charter_baseline', 'source_archived']);
    expect([...reviewMarkStatusSchema.options]).toEqual(['pending', 'cleared']);
    expect(reviewMarkStatusSchema.safeParse('resolved').success).toBe(false);
  });

  it('binds to one object, and to a baseline only when there is one', () => {
    const input = {
      userId: 'user-1',
      projectId: 'rp-1',
      entityType: 'claim' as const,
      entityId: 'c-1',
      reason: '第 2 版章程基线：换识别策略',
      raisedBy: 'charter_baseline' as const,
    };
    expect(createReviewMarkInputSchema.safeParse(input).success).toBe(true);
    expect(createReviewMarkInputSchema.safeParse({ ...input, charterVersion: null }).success).toBe(true);
    expect(createReviewMarkInputSchema.safeParse({ ...input, charterVersion: 2 }).success).toBe(true);
    expect(createReviewMarkInputSchema.safeParse({ ...input, charterVersion: 0 }).success).toBe(false);
    expect(createReviewMarkInputSchema.safeParse({ ...input, reason: '' }).success).toBe(false);
    // `source_archived` 不属于某一版章程，所以它的行可以没有版本号。
    expect(createReviewMarkInputSchema.safeParse({ ...input, raisedBy: 'source_archived' }).success).toBe(true);
  });

  it('keeps the state explicit on the stored row', () => {
    const row = {
      id: 'rm-1',
      projectId: 'rp-1',
      userId: 'user-1',
      entityType: 'claim',
      entityId: 'c-1',
      reason: '第 1 版章程基线：开题批准',
      raisedBy: 'charter_baseline',
      charterVersion: 1,
      status: 'pending',
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(researchReviewMarkSchema.safeParse(row).success).toBe(true);
    const { status: _unused, ...withoutStatus } = row;
    expect(researchReviewMarkSchema.safeParse(withoutStatus).success).toBe(false);
    expect(researchReviewMarkSchema.safeParse({ ...row, charterVersion: 0 }).success).toBe(false);
    // 「处理完了」不是删掉警告：状态改成 cleared，行留着。
    expect(researchReviewMarkSchema.safeParse({ ...row, status: 'cleared' }).success).toBe(true);
  });
});
