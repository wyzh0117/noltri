/**
 * Research domain façade behaviour (contract §2 service rules) against the in-memory double.
 *
 * Covers: identity/ownership (`not_found`, never a leak), payload rules (`invalid_request`), the
 * append-only Decision/Change → timeline coupling, relation validation + idempotency, drift
 * persistence/de-duplication, and the Map / Context Pack aggregates.
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

function harness(): { repo: FakeResearchRepository; domain: ResearchDomain } {
  const repo = new FakeResearchRepository();
  return { repo, domain: createResearchDomain(repo) };
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
    const { domain } = harness();
    const project = await domain.createProject(USER, { name: '碳定价研究', description: 'V1' });
    expect(project.userId).toBe(USER);
    expect(project.status).toBe('active');
    await domain.createProject(OTHER_USER, { name: '别人的项目' });

    const mine = await domain.listProjects(USER);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(project.id);
  });

  it('rejects a payload that fails the contract schema with invalid_request', async () => {
    const { domain } = harness();
    await expectCode(
      domain.createProject(USER, { name: '' } as CreateResearchProjectRequest),
      'invalid_request',
    );
  });

  it('treats a project of another user as not_found', async () => {
    const { domain } = harness();
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
    const { domain } = harness();
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
    const { domain } = harness();
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
    const { domain } = harness();
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

  it('creates and patches manuscript sections, defaulting sortOrder to 0', async () => {
    const { domain } = harness();
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
    const { domain } = harness();
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

  it('is idempotent for an identical quintuple and supports delete', async () => {
    const { domain } = harness();
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
    const { domain } = harness();
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
    const { domain } = harness();
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
    const { domain } = harness();
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

describe('drift persistence wrapper', () => {
  it('persists findings once and de-duplicates by (driftType, source, target) on reruns', async () => {
    const { repo, domain } = harness();
    const projectId = await seededProject(domain);
    await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: '观察到排放下降。',
      claimType: 'empirical',
      status: 'confirmed',
    });

    const first = await domain.runDriftCheck(projectId, USER, {});
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]?.driftType).toBe('evidence_drift');
    expect(first.findings[0]?.status).toBe('open');
    expect(first.summary).toEqual({ total: 1, info: 0, warning: 0, critical: 1 });

    const second = await domain.runDriftCheck(projectId, USER, {});
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]?.id).toBe(first.findings[0]?.id);
    expect(await repo.listDriftFindings(projectId, USER)).toHaveLength(1);

    // Once resolved, the same gap is a fresh finding on the next run.
    await domain.updateDriftFinding(first.findings[0]!.id, USER, { status: 'resolved' });
    const third = await domain.runDriftCheck(projectId, USER, {});
    expect(third.findings).toHaveLength(1);
    expect(third.findings[0]?.id).not.toBe(first.findings[0]?.id);
    await expectCode(domain.updateDriftFinding('missing', USER, { status: 'open' }), 'not_found');
  });

  it('merges existing open findings into the response summary', async () => {
    const { domain } = harness();
    const projectId = await seededProject(domain);
    await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: '观察到排放下降。',
      claimType: 'empirical',
      status: 'proposed',
    });
    const run = await domain.runDriftCheck(projectId, USER, {});
    expect(run.summary).toEqual({ total: 1, info: 0, warning: 1, critical: 0 });
    expect(await domain.listDriftFindings(projectId, USER, { status: 'open' })).toHaveLength(1);
    expect(await domain.listDriftFindings(projectId, USER, { driftType: 'evidence_drift' })).toHaveLength(1);
    expect(await domain.listDriftFindings(projectId, USER, { severity: 'warning' })).toHaveLength(1);
    expect(await domain.listDriftFindings(projectId, USER, { severity: 'critical' })).toHaveLength(0);
  });
});

describe('research map', () => {
  it('aggregates layers, marks supported claims and keeps only map edges', async () => {
    const { domain } = harness();
    const projectId = await seededProject(domain);
    await domain.upsertCharter(projectId, USER, { workingTitle: 'W', coreContribution: '贡献' });
    const question = await domain.createQuestion(projectId, USER, { questionCode: 'RQ1', questionText: 'q' });
    const evidence = await domain.createEvidence(projectId, USER, { type: 'dataset', title: 'D' });
    const supported = await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    const dangling = await domain.createClaim(projectId, USER, {
      claimCode: 'C2',
      claimText: 'y',
      claimType: 'empirical',
    });
    const section = await domain.createSection(projectId, USER, { sectionName: '结果' });

    await domain.createRelation(projectId, USER, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: supported.id,
    });
    await domain.createRelation(projectId, USER, {
      sourceType: 'claim',
      sourceId: supported.id,
      relationType: 'answers',
      targetType: 'research_question',
      targetId: question.id,
    });
    await domain.createRelation(projectId, USER, {
      sourceType: 'claim',
      sourceId: supported.id,
      relationType: 'appears_in',
      targetType: 'manuscript_section',
      targetId: section.id,
    });
    // Not part of the map vocabulary/triples: claim→claim relates_to and decision changes.
    await domain.createRelation(projectId, USER, {
      sourceType: 'claim',
      sourceId: supported.id,
      relationType: 'relates_to',
      targetType: 'claim',
      targetId: dangling.id,
    });

    const map = await domain.buildMap(projectId, USER);
    expect(map.project).toEqual({ id: projectId, name: '碳定价研究', status: 'active' });
    expect(map.charter.coreContribution).toBe('贡献');
    expect(map.questions.map((question0) => question0.questionCode)).toEqual(['RQ1']);
    expect(map.claims.find((claim) => claim.id === supported.id)?.supported).toBe(true);
    expect(map.claims.find((claim) => claim.id === dangling.id)?.supported).toBe(false);
    expect(map.unsupportedClaimIds).toEqual([dangling.id]);
    expect(map.edges).toHaveLength(3);
    expect(map.edges.map((edge) => edge.relationType).sort()).toEqual(['answers', 'appears_in', 'supports']);
  });
});

describe('research context pack', () => {
  it('emits the §33 blocks in order with the documented content', async () => {
    const { domain } = harness();
    const projectId = await seededProject(domain, '碳定价研究');
    await domain.upsertCharter(projectId, USER, {
      workingTitle: '碳定价与工业排放',
      coreContribution: '大样本因果估计',
      researchBoundary: '2015–2024 中国工业',
      claimBoundary: '仅相关性推断',
      researchMethod: '双重差分',
      currentStage: '写作',
    });
    await domain.createQuestion(projectId, USER, {
      questionCode: 'RQ1',
      questionText: '碳定价是否降低排放？',
      relatedMethod: '面板回归',
    });
    await domain.createQuestion(projectId, USER, { questionCode: 'RQ2', questionText: '机制是什么？' });
    const evidence = await domain.createEvidence(projectId, USER, { type: 'dataset', title: '排放数据' });
    await domain.createEvidence(projectId, USER, { type: 'note', title: '未支撑证据' });
    const confirmed = await domain.createClaim(projectId, USER, {
      claimCode: 'C1',
      claimText: '排放下降 8%。',
      claimType: 'empirical',
      status: 'confirmed',
    });
    await domain.createClaim(projectId, USER, {
      claimCode: 'C2',
      claimText: '尚待验证。',
      claimType: 'empirical',
      status: 'draft',
    });
    await domain.createRelation(projectId, USER, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: confirmed.id,
    });

    for (let index = 1; index <= 6; index += 1) {
      await domain.createDecision(projectId, USER, { title: `决策${index}`, decision: `内容${index}` });
      await domain.createChange(projectId, USER, {
        changeType: 'scope',
        before: `前${index}`,
        after: `后${index}`,
      });
    }
    await domain.runDriftCheck(projectId, USER, {});

    const pack = await domain.buildContextPack(projectId, USER);
    expect(pack.blocks.map((block) => block.heading)).toEqual([
      'PROJECT',
      'Current Research Question',
      'Core Contribution',
      'Research Boundary',
      'Claim Boundary',
      'Current Method',
      'Confirmed Claims',
      'Key Evidence',
      'Important Decisions',
      'Recent Changes',
      'Open Issues',
      'Current Drift Warnings',
    ]);

    const byHeading = new Map(pack.blocks.map((block) => [block.heading, block.body]));
    expect(byHeading.get('PROJECT')).toBe('碳定价研究（写作）');
    expect(byHeading.get('Current Research Question')).toContain('[RQ1] 碳定价是否降低排放？（open）');
    expect(byHeading.get('Current Method')).toBe('双重差分；面板回归');
    expect(byHeading.get('Confirmed Claims')).toContain('[C1] 排放下降 8%。');
    expect(byHeading.get('Confirmed Claims')).not.toContain('C2');
    expect(byHeading.get('Key Evidence')).toBe('- 排放数据（dataset）');
    expect(byHeading.get('Important Decisions')).toContain('决策6');
    expect(byHeading.get('Important Decisions')).not.toContain('决策1');
    expect(byHeading.get('Recent Changes')).toContain('后6');
    expect(byHeading.get('Recent Changes')).not.toContain('前1');
    expect(byHeading.get('Open Issues')).toContain('开放研究问题 2 条');
    expect(byHeading.get('Current Drift Warnings')).toContain('[warning]');
    expect(byHeading.get('Current Drift Warnings')).toContain('C2');

    expect(pack.markdown).toContain('## Core Contribution');
    expect(pack.markdown).toContain('大样本因果估计');
    expect(Date.parse(pack.generatedAt)).not.toBeNaN();
  });
});
