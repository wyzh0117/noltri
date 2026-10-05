/**
 * R02 证据支撑关系 has one source of truth: which relation kinds count as 支撑 is stated here, and the
 * 关联地图's dangling-claim rule, the drift checks and the context pack all read it. These cases are what
 * keep that from silently becoming three local copies again — the archived domain module repeated the
 * `supports / partially_supports` pair in three files.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TO_CLAIM_RELATION_TYPES,
  SUPPORTING_RELATION_TYPES,
  researchRelationTypeSchema,
} from '../src/index';

describe('the research relation vocabulary', () => {
  it('names the two kinds that count as 支撑 and nothing else', () => {
    expect([...SUPPORTING_RELATION_TYPES].sort()).toEqual(['partially_supports', 'supports']);
  });

  it('keeps every listed kind inside the enum the wire formats use', () => {
    for (const kind of [...SUPPORTING_RELATION_TYPES, ...EVIDENCE_TO_CLAIM_RELATION_TYPES]) {
      expect(researchRelationTypeSchema.safeParse(kind).success, kind).toBe(true);
    }
  });

  it('treats 反证、限定与背景 as evidence relations that are not 支撑', () => {
    // A contradicting relation is still evidence: it must be a legal evidence→claim kind that is not support.
    for (const kind of ['contradicts', 'qualifies', 'contextualizes'] as const) {
      expect(EVIDENCE_TO_CLAIM_RELATION_TYPES, kind).toContain(kind);
      expect(SUPPORTING_RELATION_TYPES, kind).not.toContain(kind);
    }
  });

  it('draws 支撑 entirely from the evidence→claim kinds', () => {
    for (const kind of SUPPORTING_RELATION_TYPES) {
      expect(EVIDENCE_TO_CLAIM_RELATION_TYPES, kind).toContain(kind);
    }
    expect(EVIDENCE_TO_CLAIM_RELATION_TYPES).toHaveLength(5);
    // Kinds that live elsewhere in the graph never leak into the evidence set.
    for (const kind of ['answers', 'appears_in', 'changes', 'affects', 'relates_to'] as const) {
      expect(EVIDENCE_TO_CLAIM_RELATION_TYPES, kind).not.toContain(kind);
    }
  });
});
