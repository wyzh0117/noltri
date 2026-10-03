/**
 * Drift Checker rules 1–6 (contract §4) — pure-function tests.
 *
 * `runDriftChecks` takes a plain snapshot and returns drafts: no repository, no clock, no ids. These
 * tests pin the deterministic behaviour; persistence and de-duplication are covered in
 * research-domain.test.ts against the façade.
 */
import { describe, expect, it } from 'vitest';
import { contentTokenOverlap, driftFindingKey, normalizeForMatch, runDriftChecks } from '../src/research/drift';
import {
  changeFixture,
  charterFixture,
  claimFixture,
  evidenceFixture,
  questionFixture,
  relationFixture,
} from './research-fakes';
import type { DriftCheckInput } from '../src/research/drift';

function inputOf(overrides: Partial<DriftCheckInput> = {}): DriftCheckInput {
  return {
    charter: charterFixture(),
    questions: [],
    evidence: [],
    claims: [],
    relations: [],
    changes: [],
    ...overrides,
  };
}

describe('drift rules 1–2: evidence_drift / causality_drift', () => {
  it('flags a claim without any supports / partially_supports relation (warning)', () => {
    const claim = claimFixture({ id: 'claim-a', claimCode: 'C1', status: 'proposed' });
    const drafts = runDriftChecks(inputOf({ claims: [claim] }));
    const finding = drafts.find((draft) => draft.driftType === 'evidence_drift');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.sourceEntityType).toBe('claim');
    expect(finding?.sourceEntityId).toBe('claim-a');
    expect(finding?.recommendedAction).toContain('补充 Evidence');
  });

  it('escalates a confirmed claim without evidence to critical', () => {
    const claim = claimFixture({ status: 'confirmed' });
    const [finding] = runDriftChecks(inputOf({ claims: [claim] })).filter(
      (draft) => draft.driftType === 'evidence_drift',
    );
    expect(finding?.severity).toBe('critical');
  });

  it('stays silent once supports or partially_supports exists', () => {
    const claim = claimFixture({ id: 'claim-a' });
    const relation = relationFixture({
      sourceId: 'evidence-1',
      relationType: 'supports',
      targetType: 'claim',
      targetId: 'claim-a',
    });
    const drafts = runDriftChecks(inputOf({ claims: [claim], relations: [relation] }));
    expect(drafts.some((draft) => draft.driftType === 'evidence_drift')).toBe(false);
  });

  it('flags a causal claim with no evidence as critical when boundary is empty', () => {
    const claim = claimFixture({ claimText: 'Policies cause air quality to improve', boundary: null });
    const [finding] = runDriftChecks(inputOf({ claims: [claim] })).filter(
      (draft) => draft.driftType === 'causality_drift',
    );
    expect(finding?.severity).toBe('critical');
    expect(finding?.sourceEntityId).toBe(claim.id);
    expect(finding?.recommendedAction).toContain('弱化');
  });

  it('downgrades a causal claim to info when the boundary weakens the inference', () => {
    const claim = claimFixture({
      claimText: 'Policies cause air quality to improve',
      boundary: 'This may only indicate an association.',
    });
    const [finding] = runDriftChecks(inputOf({ claims: [claim] })).filter(
      (draft) => draft.driftType === 'causality_drift',
    );
    expect(finding?.severity).toBe('info');
  });

  it('keeps a warning when the boundary is present but not weakening', () => {
    const claim = claimFixture({
      claimText: 'Policies cause air quality to improve',
      boundary: '仅限 2020–2024 年的北京城区样本。',
    });
    const [finding] = runDriftChecks(inputOf({ claims: [claim] })).filter(
      (draft) => draft.driftType === 'causality_drift',
    );
    expect(finding?.severity).toBe('warning');
  });

  it('accepts statistical support and flags non-statistical support', () => {
    const claim = claimFixture({ id: 'claim-a', claimText: 'Income determines health access', boundary: 'x' });
    const supporting = relationFixture({
      sourceId: 'evidence-1',
      relationType: 'supports',
      targetType: 'claim',
      targetId: 'claim-a',
    });
    const statistical = evidenceFixture({ id: 'evidence-1', type: 'dataset' });
    const nonStatistical = evidenceFixture({ id: 'evidence-1', type: 'note' });

    const clean = runDriftChecks(
      inputOf({ claims: [claim], relations: [supporting], evidence: [statistical] }),
    );
    expect(clean.some((draft) => draft.driftType === 'causality_drift')).toBe(false);

    const dirty = runDriftChecks(
      inputOf({ claims: [claim], relations: [supporting], evidence: [nonStatistical] }),
    );
    expect(dirty.some((draft) => draft.driftType === 'causality_drift')).toBe(true);
  });

  it('ignores claims without strong causal wording', () => {
    const claim = claimFixture({ claimText: 'Air quality improved after 2020', boundary: null });
    const drafts = runDriftChecks(inputOf({ claims: [claim] }));
    expect(drafts.some((draft) => draft.driftType === 'causality_drift')).toBe(false);
  });
});

describe('drift rule 3: rq_drift', () => {
  it('flags a manuscript question that no charter/question text answers', () => {
    const drafts = runDriftChecks(
      inputOf({ manuscriptText: 'How does remote work change urban retail? This is a statement.' }),
    );
    const findings = drafts.filter((draft) => draft.driftType === 'rq_drift');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain('How does remote work change urban retail?');
    expect(findings[0]?.sourceEntityType).toBe('research_charter');
    expect(findings[0]?.sourceEntityId).toBe('charter-1');
  });

  it('matches registered questions and charter text after normalization', () => {
    const questions = [questionFixture({ questionCode: 'RQ1', questionText: 'How does remote work change urban retail?' })];
    const charter = charterFixture({ researchQuestionsText: 'RQ2: 数字化是否改变就业结构？' });
    const drafts = runDriftChecks(
      inputOf({
        charter,
        questions,
        manuscriptText: 'How does remote work change urban retail? 数字化是否改变就业结构？',
      }),
    );
    expect(drafts.some((draft) => draft.driftType === 'rq_drift')).toBe(false);
  });

  it('flags RQ-code and 研究问题 sentences that are not registered', () => {
    const drafts = runDriftChecks(inputOf({ manuscriptText: 'RQ7 tests something new. 我们是否忽略了季节性因素？' }));
    const findings = drafts.filter((draft) => draft.driftType === 'rq_drift');
    expect(findings).toHaveLength(2);
    expect(findings[0]?.description).toContain('RQ7');
  });

  it('skips the rule entirely without manuscriptText', () => {
    const drafts = runDriftChecks(inputOf());
    expect(drafts.some((draft) => draft.driftType === 'rq_drift')).toBe(false);
  });
});

describe('drift rule 4: contribution_drift', () => {
  it('flags a contribution claim detached from the charter core contribution', () => {
    const charter = charterFixture({
      coreContribution: 'A large-sample study of carbon pricing effects on industrial emissions.',
    });
    const claim = claimFixture({
      claimCode: 'CN1',
      claimType: 'contribution',
      claimText: '深度学习加速器的能效优化方法',
    });
    const [finding] = runDriftChecks(inputOf({ charter, claims: [claim] })).filter(
      (draft) => draft.driftType === 'contribution_drift',
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.sourceEntityId).toBe(claim.id);
    expect(finding?.targetEntityType).toBe('research_charter');
    expect(finding?.targetEntityId).toBe('charter-1');
  });

  it('accepts a contribution claim aligned with the core contribution', () => {
    const text = 'A large-sample study of carbon pricing effects on industrial emissions.';
    const charter = charterFixture({ coreContribution: text });
    const claim = claimFixture({ claimType: 'contribution', claimText: text });
    const drafts = runDriftChecks(inputOf({ charter, claims: [claim] }));
    expect(drafts.some((draft) => draft.driftType === 'contribution_drift')).toBe(false);
  });

  it('is critical when the charter core contribution is empty', () => {
    const charter = charterFixture({ coreContribution: null });
    const claim = claimFixture({ claimType: 'contribution', claimText: '本文提出一个新框架' });
    const [finding] = runDriftChecks(inputOf({ charter, claims: [claim] })).filter(
      (draft) => draft.driftType === 'contribution_drift',
    );
    expect(finding?.severity).toBe('critical');
    expect(finding?.reason).toContain('为空');
  });

  it('adds one finding for divergent manuscript contribution wording', () => {
    const charter = charterFixture({ coreContribution: 'A large-sample study of carbon pricing effects.' });
    const drafts = runDriftChecks(
      inputOf({ charter, manuscriptText: '本文贡献了一个全新的深度学习调度框架。' }),
    );
    const findings = drafts.filter((draft) => draft.driftType === 'contribution_drift');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sourceEntityType).toBe('research_charter');
    expect(findings[0]?.description).toContain('本文贡献了一个全新的深度学习调度框架');
  });

  it('ignores manuscript contribution wording that matches the core contribution', () => {
    const charter = charterFixture({ coreContribution: '本文贡献了一个全新的深度学习调度框架。' });
    const drafts = runDriftChecks(
      inputOf({ charter, manuscriptText: '本文贡献了一个全新的深度学习调度框架。' }),
    );
    expect(drafts.some((draft) => draft.driftType === 'contribution_drift')).toBe(false);
  });
});

describe('drift rules 5–6: method_drift / journal_drift', () => {
  it('flags a method change made after the charter was last updated', () => {
    const charter = charterFixture({ updatedAt: '2026-01-02T00:00:00.000Z' });
    const change = changeFixture({ changeType: 'method', createdAt: '2026-01-03T00:00:00.000Z' });
    const [finding] = runDriftChecks(inputOf({ charter, changes: [change] })).filter(
      (draft) => draft.driftType === 'method_drift',
    );
    expect(finding).toBeDefined();
    expect(finding?.sourceEntityType).toBe('research_change');
    expect(finding?.sourceEntityId).toBe(change.id);
    expect(finding?.targetEntityId).toBe(charter.id);
    expect(finding?.recommendedAction).toContain('Charter');
  });

  it('ignores method changes that predate the charter', () => {
    const charter = charterFixture({ updatedAt: '2026-01-05T00:00:00.000Z' });
    const change = changeFixture({ changeType: 'method', createdAt: '2026-01-03T00:00:00.000Z' });
    const drafts = runDriftChecks(inputOf({ charter, changes: [change] }));
    expect(drafts.some((draft) => draft.driftType === 'method_drift')).toBe(false);
  });

  it('flags journal pivots after the charter', () => {
    const charter = charterFixture({ updatedAt: '2026-01-02T00:00:00.000Z', targetJournal: 'Nature' });
    const change = changeFixture({ changeType: 'journal', createdAt: '2026-01-03T00:00:00.000Z' });
    const [finding] = runDriftChecks(inputOf({ charter, changes: [change] })).filter(
      (draft) => draft.driftType === 'journal_drift',
    );
    expect(finding?.sourceEntityId).toBe(change.id);
  });

  it('flags contribution/scope changes after a target journal was picked', () => {
    const charter = charterFixture({ updatedAt: '2026-01-02T00:00:00.000Z', targetJournal: 'Nature' });
    const contribution = changeFixture({ id: 'change-c', changeType: 'contribution', createdAt: '2026-01-03T00:00:00.000Z' });
    const scope = changeFixture({ id: 'change-s', changeType: 'scope', createdAt: '2026-01-04T00:00:00.000Z' });
    const findings = runDriftChecks(inputOf({ charter, changes: [contribution, scope] })).filter(
      (draft) => draft.driftType === 'journal_drift',
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((draft) => draft.sourceEntityId)).toEqual(['change-c', 'change-s']);
  });

  it('ignores contribution/scope changes when no target journal is set', () => {
    const charter = charterFixture({ updatedAt: '2026-01-02T00:00:00.000Z', targetJournal: null });
    const change = changeFixture({ changeType: 'scope', createdAt: '2026-01-03T00:00:00.000Z' });
    const drafts = runDriftChecks(inputOf({ charter, changes: [change] }));
    expect(drafts.some((draft) => draft.driftType === 'journal_drift')).toBe(false);
  });

  it('skips method/journal rules when there is no charter', () => {
    const change = changeFixture({ changeType: 'journal' });
    const drafts = runDriftChecks(inputOf({ charter: null, changes: [change] }));
    expect(drafts.some((draft) => draft.driftType === 'method_drift' || draft.driftType === 'journal_drift')).toBe(false);
  });
});

describe('drift purity and helpers', () => {
  it('is pure: identical snapshots produce identical drafts', () => {
    const snapshot = inputOf({
      charter: charterFixture({ coreContribution: '贡献甲', updatedAt: '2026-01-02T00:00:00.000Z' }),
      claims: [claimFixture({ claimType: 'contribution', claimText: '完全无关的主张乙' })],
      changes: [changeFixture({ changeType: 'method', createdAt: '2026-01-03T00:00:00.000Z' })],
      manuscriptText: 'RQ9 未登记的问题？',
    });
    expect(runDriftChecks(snapshot)).toEqual(runDriftChecks(snapshot));
  });

  it('keys findings by (driftType, sourceEntityId, targetEntityId)', () => {
    expect(
      driftFindingKey({
        driftType: 'evidence_drift',
        sourceEntityId: 'claim-1',
        targetEntityId: null,
      }),
    ).toBe('evidence_drift|claim-1|');
  });

  it('normalizes matching text and computes stopword-filtered overlap', () => {
    expect(normalizeForMatch(' How does X affect Y? ')).toBe('howdoesxaffecty');
    expect(contentTokenOverlap('carbon pricing reduces emissions', 'carbon pricing reduces emissions')).toBe(1);
    expect(contentTokenOverlap('深度学习调度框架', '碳定价与工业排放')).toBe(0);
  });
});
