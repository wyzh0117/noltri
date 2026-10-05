/**
 * Research domain façade behaviour (research contract §0 / §2) against the in-memory double.
 *
 * Covers what P5 promises: identity and ownership (`not_found`, never a leak), payload rules
 * (`invalid_request`), per-project isolation on every list, the append-only Decision/Change → timeline
 * coupling, and relation validation plus idempotency. Drift rules, the map and the context pack are P6,
 * so the façade has no such method to test yet.
 */
import { describe, expect, it } from 'vitest';
import type {
  ApiErrorCode,
  CreateClaimRequest,
  CreateResearchProjectRequest,
  CreateResearchQuestionRequest,
  CreateSectionRequest,
  PatchResearchProjectRequest,
} from '@noltri/schema';
import { isKnowledgeError } from '@noltri/shared';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import { FakeResearchRepository } from './research-fakes';

const USER = 'user-1';
const OTHER_USER = 'user-2';

function harness(): ResearchDomain {
  return createResearchDomain(new FakeResearchRepository());
}

async function expectCode(action: Promise<unknown>, code: ApiErrorCode): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(isKnowledgeError(error)).toBe(true);
    if (isKnowledgeError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected knowledgeError(${code}) but the call resolved`);
}

async function seededProject(domain: ResearchDomain, name = '碳定价研究'): Promise<string> {
  const project = await domain.createProject(USER, { name });
  return project.id;
}

describe('research projects and charter', () => {
  it('creates projects under the credential user and lists only that user', async () => {
    const domain = harness();
    const project = await domain.createProject(USER, { name: '碳定价研究', description: 'V1' });
    expect(project.userId).toBe(USER);
    expect(project.status).toBe('active');
    await domain.createProject(OTHER_USER, { name: '别人的项目' });

    const mine = await domain.listProjects(USER);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(project.id);
  });

  it('rejects a payload that fails the contract schema with invalid_request', async () => {
    const domain = harness();
    await expectCode(domain.createProject(USER, { name: '' } as CreateResearchProjectRequest), 'invalid_request');
  });

  it('treats a project of another user as not_found', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    await expectCode(domain.getProject(projectId, OTHER_USER), 'not_found');
    await expectCode(domain.listQuestions(projectId, OTHER_USER), 'not_found');
    await expectCode(domain.getCharter(projectId, OTHER_USER), 'not_found');
    await expectCode(
      domain.updateProject(projectId, OTHER_USER, { name: 'x' } as PatchResearchProjectRequest),
      'not_found',
    );
  });

  it('patches project fields and upserts one charter per project', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);

    const updated = await domain.updateProject(projectId, USER, { status: 'archived', description: null });
    expect(updated.status).toBe('archived');
    expect(updated.description).toBeNull();

    expect(await domain.getCharter(projectId, USER)).toBeNull();
    const charter = await domain.upsertCharter(projectId, USER, {
      workingTitle: '碳定价与工业排放',
      coreContribution: '大样本因果估计',
      currentStage: '设计',
    });
    expect(charter.projectId).toBe(projectId);
    const again = await domain.upsertCharter(projectId, USER, {
      workingTitle: '碳定价与工业排放（修订）',
      coreContribution: '大样本因果估计',
      currentStage: '数据',
    });
    expect(again.id).toBe(charter.id);
    expect((await domain.getCharter(projectId, USER))?.currentStage).toBe('数据');
  });
});

describe('questions / evidence / claims / sections', () => {
  it('creates, lists and updates research questions', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const question = await domain.createQuestion(projectId, USER, {
      questionCode: 'RQ1',
      questionText: '碳定价是否降低工业排放？',
    } satisfies CreateResearchQuestionRequest);
    expect(question.status).toBe('open');

    const revised = await domain.updateQuestion(question.id, USER, { status: 'answered' });
    expect(revised.status).toBe('answered');
    expect(await domain.listQuestions(projectId, USER)).toHaveLength(1);

    await expectCode(domain.updateQuestion('missing', USER, { status: 'dropped' }), 'not_found');
    await expectCode(
      domain.createQuestion(projectId, USER, { questionCode: '', questionText: 'x' } as CreateResearchQuestionRequest),
      'invalid_request',
    );
  });

  it('filters evidence and claims by the documented query fields', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    await domain.createEvidence(projectId, USER, { type: 'literature', title: '文献 A' });
    await domain.createEvidence(projectId, USER, { type: 'dataset', title: '数据集 B' });
    await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: '排放下降了。',
      claimType: 'empirical',
      status: 'confirmed',
    } satisfies CreateClaimRequest);
    await domain.createClaim(projectId, USER, {
      claimCode: 'C2',
      claimText: '方法有效。',
      claimType: 'methodological',
    } satisfies CreateClaimRequest);

    expect(await domain.listEvidence(projectId, USER, { type: 'dataset' })).toHaveLength(1);
    expect(await domain.listClaims(projectId, USER, { status: 'confirmed' })).toHaveLength(1);
    expect(await domain.listClaims(projectId, USER, { claimType: 'methodological' })).toHaveLength(1);
    expect(await domain.listClaims(projectId, USER, {})).toHaveLength(2);
  });

  it('keeps every list inside the project it was asked about', async () => {
    const domain = harness();
    const first = await seededProject(domain, '项目一');
    const second = await seededProject(domain, '项目二');
    await domain.createQuestion(first, USER, { questionCode: 'RQ1', questionText: '属于项目一' });
    await domain.createEvidence(second, USER, { type: 'dataset', title: '属于项目二' });

    expect((await domain.listQuestions(first, USER)).map((question) => question.projectId))
      .toEqual([first]);
    expect((await domain.listEvidence(second, USER, {})).map((evidence) => evidence.projectId))
      .toEqual([second]);
    expect(await domain.listQuestions(second, USER)).toHaveLength(0);
  });

  it('creates and patches manuscript sections, defaulting sortOrder to 0', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const section = await domain.createSection(projectId, USER, {
      sectionName: '方法',
    } satisfies CreateSectionRequest);
    expect(section.sortOrder).toBe(0);
    const patched = await domain.updateSection(section.id, USER, { sortOrder: 2, sectionReference: '§3' });
    expect(patched.sortOrder).toBe(2);
    expect(patched.sectionReference).toBe('§3');
    await expectCode(domain.updateSection('missing', USER, { sortOrder: 1 }), 'not_found');
  });
});

describe('relations', () => {
  it('rejects endpoints that are not in the project with invalid_request', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const claim = await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    await expectCode(
      domain.createRelation(projectId, USER, {
        sourceType: 'evidence',
        sourceId: 'not-here',
        relationType: 'supports',
        targetType: 'claim',
        targetId: claim.id,
      }),
      'invalid_request',
    );
    await expectCode(
      domain.createRelation(projectId, USER, {
        sourceType: 'claim',
        sourceId: claim.id,
        relationType: 'answers',
        targetType: 'research_question',
        targetId: 'not-here',
      }),
      'invalid_request',
    );
  });

  it('refuses a pair the relation type cannot mean, even between two real entities', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const evidence = await domain.createEvidence(projectId, USER, { type: 'literature', title: 'E1' });
    const claim = await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    const question = await domain.createQuestion(projectId, USER, { questionCode: 'RQ1', questionText: 'q' });

    // R02: the endpoints are both in this project, so existence cannot excuse the direction.
    await expectCode(
      domain.createRelation(projectId, USER, {
        sourceType: 'claim',
        sourceId: claim.id,
        relationType: 'supports',
        targetType: 'evidence',
        targetId: evidence.id,
      }),
      'invalid_request',
    );
    await expectCode(
      domain.createRelation(projectId, USER, {
        sourceType: 'evidence',
        sourceId: evidence.id,
        relationType: 'answers',
        targetType: 'research_question',
        targetId: question.id,
      }),
      'invalid_request',
    );
    expect(await domain.listRelations(projectId, USER, {})).toHaveLength(0);

    // 反证 is a real evidence relation: not 支撑, and still perfectly legal to record.
    const contradicting = await domain.createRelation(projectId, USER, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'contradicts',
      targetType: 'claim',
      targetId: claim.id,
    });
    expect(contradicting.relationType).toBe('contradicts');

    // A decision reaches anything, which is how 修订影响论点 without inventing a sixth evidence kind.
    const decision = await domain.createDecision(projectId, USER, { title: '改用 DiD', decision: '采用双重差分' });
    await expect(
      domain.createRelation(projectId, USER, {
        sourceType: 'research_decision',
        sourceId: decision.id,
        relationType: 'affects',
        targetType: 'claim',
        targetId: claim.id,
      }),
    ).resolves.toMatchObject({ relationType: 'affects' });
  });

  it('reports the pairing rather than the missing endpoint when both are wrong', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    try {
      await domain.createRelation(projectId, USER, {
        sourceType: 'claim',
        sourceId: 'nowhere',
        relationType: 'appears_in',
        targetType: 'claim',
        targetId: 'nowhere-either',
      });
      throw new Error('expected the pairing check to reject this relation');
    } catch (error) {
      expect(isKnowledgeError(error)).toBe(true);
      if (isKnowledgeError(error)) expect(error.message).toContain('manuscript_section');
    }
  });

  it('is idempotent for an identical quintuple and supports delete', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const evidence = await domain.createEvidence(projectId, USER, { type: 'dataset', title: 'D' });
    const claim = await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    const body = {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: claim.id,
    } as const;

    const first = await domain.createRelation(projectId, USER, body);
    const second = await domain.createRelation(projectId, USER, body);
    expect(second.id).toBe(first.id);
    expect(await domain.listRelations(projectId, USER, { sourceId: evidence.id })).toHaveLength(1);

    expect(await domain.deleteRelation(first.id, USER)).toEqual({ deleted: true, id: first.id });
    await expectCode(domain.deleteRelation(first.id, USER), 'not_found');
    expect(await domain.listRelations(projectId, USER, {})).toHaveLength(0);
  });
});

describe('decisions / changes / timeline', () => {
  it('writes a decision timeline event alongside the append-only decision', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const decision = await domain.createDecision(projectId, USER, {
      title: '采用双重差分',
      decision: '使用 DiD 估计因果效应。',
    });
    const events = await domain.listTimeline(projectId, USER);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('decision');
    expect(events[0]?.sourceType).toBe('research_decision');
    expect(events[0]?.sourceId).toBe(decision.id);
    expect(events[0]?.occurredAt).toBe(decision.createdAt);
  });

  it('writes a change timeline event alongside the append-only change', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    const change = await domain.createChange(projectId, USER, {
      changeType: 'method',
      before: '访谈',
      after: '问卷',
    });
    const events = await domain.listTimeline(projectId, USER);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('change');
    expect(events[0]?.sourceType).toBe('research_change');
    expect(events[0]?.sourceId).toBe(change.id);
  });

  it('creates manual milestones and returns the timeline newest-first', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    await domain.createDecision(projectId, USER, { title: '决策', decision: '内容' });
    const milestone = await domain.createMilestone(projectId, USER, {
      occurredAt: '2027-06-01T00:00:00.000Z',
      title: '投稿',
      summary: '投递第一版',
    });
    expect(milestone.eventType).toBe('milestone');
    expect(milestone.sourceType).toBe('manual');

    await expectCode(
      domain.createMilestone(projectId, USER, { occurredAt: 'not-a-date', title: 'x' }),
      'invalid_request',
    );

    const events = await domain.listTimeline(projectId, USER);
    expect(events.map((event) => event.title)).toEqual(['投稿', '决策']);
  });
});
