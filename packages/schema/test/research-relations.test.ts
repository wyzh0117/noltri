/**
 * R02 证据支撑关系 has one source of truth: which relation kinds count as 支撑, and which endpoints each
 * kind may join, are both stated here. The 关联地图's dangling-claim rule, the drift checks and the context
 * pack all read these tables — the archived domain module repeated the `supports / partially_supports`
 * pair in three files, and a vocabulary that lives in three places is three vocabularies.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TO_CLAIM_RELATION_TYPES,
  RELATION_PAIRINGS,
  SUPPORTING_RELATION_TYPES,
  researchEntityTypeSchema,
  researchRelationTypeSchema,
  type ResearchRelationType,
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

/**
 * A relation kind carries its direction in its meaning: `supports` from a claim to an evidence reads as
 * "the claim supports the evidence", which is the opposite of what anyone typed. The pairing table is
 * therefore part of the contract, not a detail of the domain module that happens to write rows.
 */
describe('the research relation pairings', () => {
  const pairs = (kind: ResearchRelationType): string =>
    `${RELATION_PAIRINGS[kind].sourceTypes.join('|')} → ${RELATION_PAIRINGS[kind].targetTypes.join('|')}`;

  it('states a pairing for exactly the kinds the wire format accepts', () => {
    expect(Object.keys(RELATION_PAIRINGS).sort()).toEqual([...researchRelationTypeSchema.options].sort());
  });

  it('names evidence→claim as the pairing of the five evidence kinds and of nothing else', () => {
    const evidencePaired = researchRelationTypeSchema.options.filter((kind) => pairs(kind) === 'evidence → claim');
    expect(evidencePaired.sort()).toEqual([...EVIDENCE_TO_CLAIM_RELATION_TYPES].sort());
  });

  it('keeps claim→RQ and claim→section distinct, in one direction only', () => {
    expect(RELATION_PAIRINGS.answers).toEqual({ sourceTypes: ['claim'], targetTypes: ['research_question'] });
    expect(RELATION_PAIRINGS.appears_in).toEqual({ sourceTypes: ['claim'], targetTypes: ['manuscript_section'] });
  });

  it('lets a decision or change reach every entity, and nothing else originate one', () => {
    for (const kind of ['changes', 'affects'] as const) {
      expect(RELATION_PAIRINGS[kind].sourceTypes).toEqual(['research_decision', 'research_change']);
      expect([...RELATION_PAIRINGS[kind].targetTypes].sort())
        .toEqual([...researchEntityTypeSchema.options].sort());
    }
    for (const kind of researchRelationTypeSchema.options) {
      // `relates_to` is the deliberate any→any kind and has its own case below.
      if (kind === 'changes' || kind === 'affects' || kind === 'relates_to') continue;
      expect(RELATION_PAIRINGS[kind].sourceTypes, kind).not.toContain('research_decision');
    }
  });

  it('leaves relates_to as the one kind that joins anything to anything', () => {
    expect([...RELATION_PAIRINGS.relates_to.sourceTypes].sort())
      .toEqual([...researchEntityTypeSchema.options].sort());
    expect(RELATION_PAIRINGS.relates_to.sourceTypes).toBe(RELATION_PAIRINGS.relates_to.targetTypes);
  });

  it('freezes the endpoint lists — several modules read one table, none may rewrite it', () => {
    // `sort()` mutates in place. The arrays are shared with zod's own enum options, so a caller that
    // could reorder them would silently change what the domain rejects.
    const targets = RELATION_PAIRINGS.relates_to.targetTypes as unknown[];
    expect(Object.isFrozen(targets)).toBe(true);
    expect(() => targets.sort()).toThrow(TypeError);
    expect(researchEntityTypeSchema.options).toEqual([...targets]);
  });
});
