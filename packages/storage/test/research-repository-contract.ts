import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isKnowledgeError } from '@noltri/shared';
import type { KnowledgeError } from '@noltri/shared';
import type { ResearchProject } from '@noltri/schema';
import type { CharterFields, ResearchRepository } from '../src/research-types';

export interface ResearchContractOptions {
  /** Applies the longer timeouts a networked driver needs; asserts nothing Postgres-specific. */
  requiresServer?: boolean;
}

type MaybeRepository = ResearchRepository | Promise<ResearchRepository>;

const USER_PREFIX = 'research-contract-user';

async function rejection(work: Promise<unknown>): Promise<KnowledgeError> {
  try {
    await work;
  } catch (cause: unknown) {
    if (!isKnowledgeError(cause)) {
      throw new Error(
        `expected a KnowledgeError, received ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return cause;
  }
  throw new Error('expected the call to reject');
}

/** Repositories that own a connection pool expose close(); the in-memory one does not. */
async function release(repository: ResearchRepository): Promise<void> {
  const candidate: unknown = Reflect.get(repository, 'close');
  if (typeof candidate === 'function') {
    await (candidate as () => Promise<void>).call(repository);
  }
}

/** Small wall-clock gaps so timestamp-ordered reads are deterministic on every driver. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 8);
  });
}

export function describeResearchRepository(
  name: string,
  factory: () => MaybeRepository,
  options: ResearchContractOptions = {},
): void {
  const timeout = options.requiresServer === true ? 30_000 : 5_000;
  const foreignUser = () => `${USER_PREFIX}-foreign-${randomUUID()}`;

  async function scope<T>(work: (repository: ResearchRepository, userId: string) => Promise<T>): Promise<T> {
    const repository = await factory();
    try {
      return await work(repository, `${USER_PREFIX}-${randomUUID()}`);
    } finally {
      await release(repository);
    }
  }

  async function project(
    repository: ResearchRepository,
    userId: string,
    name = '冷链物流服务质量研究',
  ): Promise<ResearchProject> {
    return repository.createResearchProject({ userId, name, description: 'ISM + ANP 结构关系研究' });
  }

  function charterFields(overrides: Partial<CharterFields> = {}): CharterFields {
    return {
      workingTitle: '冷链服务质量因素的结构关系研究',
      researchTopic: '冷链物流服务质量',
      researchProblem: '可靠性因素的结构性位置不明',
      researchGap: '缺少专家判断依赖关系的结构化证据',
      researchQuestionsText: 'RQ1 服务因素如何组织？',
      coreContribution: '提出冷链服务质量因素的 ISM 结构模型',
      theoreticalLens: '服务质量理论',
      researchContext: '冷链行业专家访谈',
      unitOfAnalysis: '服务质量因素',
      researchMethod: 'ISM + ANP',
      targetArticleType: 'empirical research',
      targetJournal: null,
      researchBoundary: '因素之间的专家判断依赖关系，不包含统计因果推断',
      claimBoundary: 'ISM relationship ≠ statistical causality',
      currentStage: 'model building',
      ...overrides,
    };
  }

  describe(`${name} satisfies the ResearchRepository contract`, () => {
    it('creates, reads, lists and patches research projects', async () => {
      await scope(async (repository, userId) => {
        const created = await project(repository, userId);
        expect(created.status).toBe('active');
        expect(created.name).toBe('冷链物流服务质量研究');
        expect(created.description).toBe('ISM + ANP 结构关系研究');
        expect(created.createdAt).toBe(created.updatedAt);
        expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
        expect(await repository.findResearchProject(created.id, userId)).toEqual(created);
        expect(await repository.findResearchProject(created.id, foreignUser())).toBeNull();
        expect(await repository.findResearchProject('absent', userId)).toBeNull();

        await pause();
        const minimal = await repository.createResearchProject({ userId, name: '  极简项目  ' });
        expect(minimal.name).toBe('极简项目');
        expect(minimal.description).toBeNull();

        await pause();
        const second = await project(repository, userId, '第二研究');
        expect((await repository.listResearchProjects(userId)).map((row) => row.id)).toEqual([
          created.id,
          minimal.id,
          second.id,
        ]);
        expect(await repository.listResearchProjects(foreignUser())).toEqual([]);

        await pause();
        const patched = await repository.updateResearchProject(created.id, userId, {
          name: '冷链物流服务质量因素研究',
          status: 'archived',
        });
        expect(patched.name).toBe('冷链物流服务质量因素研究');
        expect(patched.status).toBe('archived');
        expect(patched.description).toBe('ISM + ANP 结构关系研究');
        expect(patched.createdAt).toBe(created.createdAt);
        expect(patched.updatedAt > created.updatedAt).toBe(true);

        const nulled = await repository.updateResearchProject(created.id, userId, { description: null });
        expect(nulled.description).toBeNull();

        const missing = await rejection(repository.updateResearchProject('absent', userId, { name: 'x' }));
        expect(missing.code).toBe('not_found');
        expect(missing.message).toBe('ResearchProject absent not found');
        const foreign = await rejection(repository.updateResearchProject(created.id, foreignUser(), { name: 'x' }));
        expect(foreign.message).toBe(`ResearchProject ${created.id} not found`);
      });
    }, timeout);

    it('upserts one charter per project and refreshes its timestamps', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        expect(await repository.findCharter(research.id, userId)).toBeNull();

        const created = await repository.upsertCharter({ userId, projectId: research.id, ...charterFields() });
        expect(created.projectId).toBe(research.id);
        expect(created.workingTitle).toBe('冷链服务质量因素的结构关系研究');
        expect(created.targetJournal).toBeNull();
        expect(created.claimBoundary).toBe('ISM relationship ≠ statistical causality');
        expect(created.createdAt).toBe(created.updatedAt);
        expect(await repository.findCharter(research.id, userId)).toEqual(created);

        await pause();
        const updated = await repository.upsertCharter({
          userId,
          projectId: research.id,
          ...charterFields({ workingTitle: '冷链服务质量因素结构研究（改）', targetJournal: 'IJLM' }),
        });
        // One charter per project: the same row is rewritten, never a second draft.
        expect(updated.id).toBe(created.id);
        expect(updated.createdAt).toBe(created.createdAt);
        expect(updated.updatedAt > created.updatedAt).toBe(true);
        expect(updated.workingTitle).toBe('冷链服务质量因素结构研究（改）');
        expect(updated.targetJournal).toBe('IJLM');

        // Unstated optional fields clear back to null: the request carries the whole charter.
        const cleared = await repository.upsertCharter({
          userId,
          projectId: research.id,
          workingTitle: '只剩标题',
        });
        expect(cleared.id).toBe(created.id);
        expect(cleared.workingTitle).toBe('只剩标题');
        expect(cleared.researchTopic).toBeNull();
        expect(cleared.researchMethod).toBeNull();

        expect(await repository.findCharter(research.id, foreignUser())).toBeNull();
        const foreignProject = await foreignUser();
        const foreign = await rejection(
          repository.upsertCharter({ userId: foreignProject, projectId: research.id, ...charterFields() }),
        );
        expect(foreign.code).toBe('not_found');
        expect(foreign.message).toBe(`ResearchProject ${research.id} not found`);
      });
    }, timeout);

    it('appends approved charter versions and reads the newest one as the baseline', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const draft = await repository.upsertCharter({ userId, projectId: research.id, ...charterFields() });

        expect(await repository.findCharterBaseline(research.id, userId)).toBeNull();
        expect(await repository.listCharterVersions(research.id, userId)).toEqual([]);

        const first = await repository.createCharterVersion({
          userId,
          projectId: research.id,
          version: 1,
          previousVersion: null,
          charter: draft,
          changedFields: [],
          revisionReason: '开题时批准的基线',
          decisionId: null,
        });
        expect(first.version).toBe(1);
        expect(first.previousVersion).toBeNull();
        expect(first.charter.id).toBe(draft.id);
        expect(first.changedFields).toEqual([]);
        expect(first.decisionId).toBeNull();
        expect(new Date(first.approvedAt).toISOString()).toBe(first.approvedAt);

        await pause();
        const second = await repository.createCharterVersion({
          userId,
          projectId: research.id,
          version: 2,
          previousVersion: 1,
          charter: { ...draft, researchMethod: 'ISM + ANP + 稳健性检验', claimBoundary: '扩展到 2015 年后样本' },
          changedFields: ['researchMethod', 'claimBoundary'],
          revisionReason: '加入稳健性检验，并把论断范围放宽到 2015 年后',
          decisionId: 'decision-1',
        });

        // Ordered by version number, not by the order the rows were written.
        expect((await repository.listCharterVersions(research.id, userId)).map((row) => row.version)).toEqual([
          2,
          1,
        ]);
        const baseline = await repository.findCharterBaseline(research.id, userId);
        expect(baseline?.id).toBe(second.id);
        expect(baseline?.changedFields).toEqual(['researchMethod', 'claimBoundary']);
        expect(baseline?.decisionId).toBe('decision-1');

        // The draft moves on; the approved snapshot is the text that was frozen at approval (R06).
        await repository.upsertCharter({ userId, projectId: research.id, ...charterFields({ workingTitle: '换题了' }) });
        expect((await repository.findCharter(research.id, userId))?.workingTitle).toBe('换题了');
        expect((await repository.findCharterBaseline(research.id, userId))?.charter.workingTitle).toBe(
          '冷链服务质量因素的结构关系研究',
        );
        expect((await repository.listCharterVersions(research.id, userId))[1]?.charter.researchMethod).toBe('ISM + ANP');
      });
    }, timeout);

    it('refuses a charter version number the project already used', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const charter = await repository.upsertCharter({ userId, projectId: research.id, ...charterFields() });
        const input = {
          userId,
          projectId: research.id,
          previousVersion: null,
          charter,
          changedFields: [],
          revisionReason: '批准',
          decisionId: null,
        };

        await repository.createCharterVersion({ ...input, version: 1 });
        const clash = await rejection(repository.createCharterVersion({ ...input, version: 1 }));
        expect(clash.code).toBe('storage_error');
        expect(clash.message).toContain('已存在');
        // The loser of a numbering race writes nothing: the first row keeps its own reason.
        const versions = await repository.listCharterVersions(research.id, userId);
        expect(versions).toHaveLength(1);
        expect(versions[0]?.revisionReason).toBe('批准');

        const foreign = await rejection(repository.listCharterVersions(research.id, foreignUser()));
        expect(foreign.code).toBe('not_found');
        expect(await repository.findCharterBaseline(research.id, foreignUser())).toBeNull();
        // A project that does not exist yet cannot hold a baseline either.
        await rejection(
          repository.createCharterVersion({ ...input, version: 2, projectId: 'absent-project' }),
        );
      });
    }, timeout);

    it('raises one review mark per entity and cause, and clears it without deleting it', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const absent = await rejection(repository.clearReviewMark('no-such-mark', userId));
        expect(absent.code).toBe('not_found');
        expect(await repository.findReviewMark('no-such-mark', userId)).toBeNull();

        const raised = await repository.raiseReviewMark({
          userId,
          projectId: research.id,
          entityType: 'claim',
          entityId: 'claim-1',
          reason: '新基线放宽了论断边界',
          raisedBy: 'charter_baseline',
          charterVersion: 2,
        });
        expect(raised.status).toBe('pending');
        expect(raised.charterVersion).toBe(2);

        await pause();
        const otherKind = await repository.raiseReviewMark({
          userId,
          projectId: research.id,
          entityType: 'claim',
          entityId: 'claim-1',
          reason: '引用的节点被归档了',
          raisedBy: 'source_archived',
        });
        expect(otherKind.id).not.toBe(raised.id);
        expect(otherKind.charterVersion).toBeNull();

        // Same entity, same cause, same baseline: one warning refreshed, not two stacked.
        await pause();
        const again = await repository.raiseReviewMark({
          userId,
          projectId: research.id,
          entityType: 'claim',
          entityId: 'claim-1',
          reason: '新基线放宽了论断边界（第二次批准）',
          raisedBy: 'charter_baseline',
          charterVersion: 2,
        });
        expect(again.id).toBe(raised.id);
        expect(again.reason).toBe('新基线放宽了论断边界（第二次批准）');
        expect(again.createdAt).toBe(raised.createdAt);
        expect(again.updatedAt > raised.updatedAt).toBe(true);

        // A different baseline is a different warning, so history shows both revisions.
        await pause();
        const third = await repository.raiseReviewMark({
          userId,
          projectId: research.id,
          entityType: 'claim',
          entityId: 'claim-1',
          reason: '第三次批准又动了方法',
          raisedBy: 'charter_baseline',
          charterVersion: 3,
        });
        expect(third.id).not.toBe(raised.id);

        const all = await repository.listReviewMarks(research.id, userId);
        expect(all.map((mark) => mark.id)).toEqual([raised.id, otherKind.id, third.id]);
        // 谁标的分开查：R06 的基线标记和 R03 的来源标记各自成组。
        expect(
          (await repository.listReviewMarks(research.id, userId, { raisedBy: 'source_archived' })).map((m) => m.id),
        ).toEqual([otherKind.id]);
        expect(
          (await repository.listReviewMarks(research.id, userId, { raisedBy: 'charter_baseline' })).map((m) => m.id),
        ).toEqual([raised.id, third.id]);

        const cleared = await repository.clearReviewMark(otherKind.id, userId);
        expect(cleared.status).toBe('cleared');
        expect(cleared.id).toBe(otherKind.id);
        expect(await repository.findReviewMark(otherKind.id, userId)).toMatchObject({ status: 'cleared' });
        // Clearing is a state change, not a deletion: the warning stays readable (开发文档 §14).
        expect((await repository.listReviewMarks(research.id, userId)).map((mark) => mark.id))
          .toEqual([raised.id, otherKind.id, third.id]);
        expect((await repository.listReviewMarks(research.id, userId, { status: 'pending' })).map((mark) => mark.id))
          .toEqual([raised.id, third.id]);
        expect(await repository.listReviewMarks(research.id, userId, { entityType: 'research_question' })).toEqual([]);
        expect((await repository.listReviewMarks(research.id, userId, { entityId: 'claim-1', status: 'cleared' })))
          .toHaveLength(1);

        expect(await repository.findReviewMark(raised.id, foreignUser())).toBeNull();
        const foreignClear = await rejection(repository.clearReviewMark(raised.id, foreignUser()));
        expect(foreignClear.code).toBe('not_found');
        const foreignList = await rejection(repository.listReviewMarks(research.id, foreignUser()));
        expect(foreignList.code).toBe('not_found');
        const foreignRaise = await rejection(
          repository.raiseReviewMark({
            userId: foreignUser(),
            projectId: research.id,
            entityType: 'claim',
            entityId: 'claim-1',
            reason: 'x',
            raisedBy: 'charter_baseline',
          }),
        );
        expect(foreignRaise.code).toBe('not_found');
      });
    }, timeout);

    it('creates, reads, lists and patches research questions', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const created = await repository.createResearchQuestion({
          userId,
          projectId: research.id,
          questionCode: 'RQ1',
          questionText: 'How are service-quality factors structurally organized?',
        });
        expect(created.status).toBe('open');
        expect(created.rationale).toBeNull();
        expect(created.relatedMethod).toBeNull();
        expect(await repository.findResearchQuestion(created.id, userId)).toEqual(created);
        expect(await repository.findResearchQuestion(created.id, foreignUser())).toBeNull();

        await pause();
        const sibling = await repository.createResearchQuestion({
          userId,
          projectId: research.id,
          questionCode: 'RQ2',
          questionText: 'Which factors dominate under a decision goal?',
          status: 'answered',
          rationale: 'ANP 输出是目标依赖的相对权重',
          relatedMethod: 'ANP',
        });
        expect(sibling.status).toBe('answered');
        expect((await repository.listResearchQuestions(research.id, userId)).map((row) => row.id)).toEqual([
          created.id,
          sibling.id,
        ]);

        await pause();
        const patched = await repository.updateResearchQuestion(created.id, userId, {
          questionText: 'How are factors organized in the elicited ISM model?',
          status: 'revised',
          rationale: '范围收窄到 ISM 模型',
          relatedMethod: 'ISM',
        });
        expect(patched.questionText).toBe('How are factors organized in the elicited ISM model?');
        expect(patched.status).toBe('revised');
        expect(patched.rationale).toBe('范围收窄到 ISM 模型');
        expect(patched.relatedMethod).toBe('ISM');
        expect(patched.questionCode).toBe('RQ1');
        expect(patched.createdAt).toBe(created.createdAt);
        expect(patched.updatedAt > created.updatedAt).toBe(true);

        const missing = await rejection(repository.updateResearchQuestion('absent', userId, { status: 'dropped' }));
        expect(missing.message).toBe('ResearchQuestion absent not found');
        const foreign = await rejection(
          repository.updateResearchQuestion(created.id, foreignUser(), { status: 'dropped' }),
        );
        expect(foreign.message).toBe(`ResearchQuestion ${created.id} not found`);
      });
    }, timeout);

    it('creates, reads, lists and filters evidence', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const created = await repository.createEvidence({
          userId,
          projectId: research.id,
          type: 'expert_judgement',
          title: '专家访谈 E-031',
        });
        expect(created.description).toBeNull();
        expect(created.sourceReference).toBeNull();
        expect(created.sourceLocation).toBeNull();
        expect(created.reliabilityNote).toBeNull();
        expect(await repository.findEvidence(created.id, userId)).toEqual(created);
        expect(await repository.findEvidence(created.id, foreignUser())).toBeNull();

        await pause();
        const sibling = await repository.createEvidence({
          userId,
          projectId: research.id,
          type: 'dataset',
          title: 'ANP 权重表',
          description: '目标依赖的优先级输出',
          sourceReference: 'Saaty scale run 2',
          sourceLocation: '附录 B',
          reliabilityNote: '12 位专家一致性 0.08',
        });
        expect(sibling.description).toBe('目标依赖的优先级输出');
        expect((await repository.listEvidence(research.id, userId)).map((row) => row.id)).toEqual([
          created.id,
          sibling.id,
        ]);
        expect((await repository.listEvidence(research.id, userId, { type: 'dataset' })).map((row) => row.id)).toEqual([
          sibling.id,
        ]);
        expect(await repository.listEvidence(research.id, userId, { type: 'figure' })).toEqual([]);

        await pause();
        const patched = await repository.updateEvidence(created.id, userId, {
          type: 'interview',
          title: '专家访谈 E-031（改）',
          reliabilityNote: '专家背景与研究主题匹配',
        });
        expect(patched.type).toBe('interview');
        expect(patched.title).toBe('专家访谈 E-031（改）');
        expect(patched.reliabilityNote).toBe('专家背景与研究主题匹配');
        expect(patched.description).toBeNull();
        expect(patched.createdAt).toBe(created.createdAt);

        const missing = await rejection(repository.updateEvidence('absent', userId, { title: 'x' }));
        expect(missing.message).toBe('Evidence absent not found');
        const foreign = await rejection(repository.updateEvidence(created.id, foreignUser(), { title: 'x' }));
        expect(foreign.message).toBe(`Evidence ${created.id} not found`);
      });
    }, timeout);

    it('creates, reads, lists and filters claims', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const created = await repository.createClaim({
          userId,
          projectId: research.id,
          claimCode: 'C-021',
          claimText: 'Reliability-related factors occupy relatively high structural levels.',
          claimType: 'descriptive',
        });
        expect(created.status).toBe('draft');
        expect(created.confidence).toBeCloseTo(0, 6);
        expect(created.boundary).toBeNull();
        expect(await repository.findClaim(created.id, userId)).toEqual(created);
        expect(await repository.findClaim(created.id, foreignUser())).toBeNull();

        await pause();
        const sibling = await repository.createClaim({
          userId,
          projectId: research.id,
          claimCode: 'C-022',
          claimText: 'This study contributes an ISM model of cold-chain service quality.',
          claimType: 'contribution',
          status: 'confirmed',
          confidence: 0.8,
          boundary: 'ISM relationship ≠ statistical causality',
        });
        expect(sibling.confidence).toBeCloseTo(0.8, 6);
        expect((await repository.listClaims(research.id, userId)).map((row) => row.id)).toEqual([
          created.id,
          sibling.id,
        ]);
        expect(
          (await repository.listClaims(research.id, userId, { status: 'confirmed' })).map((row) => row.id),
        ).toEqual([sibling.id]);
        expect(
          (await repository.listClaims(research.id, userId, { claimType: 'descriptive' })).map((row) => row.id),
        ).toEqual([created.id]);
        expect(
          (await repository.listClaims(research.id, userId, { status: 'confirmed', claimType: 'descriptive' })).length,
        ).toBe(0);

        await pause();
        const patched = await repository.updateClaim(created.id, userId, {
          claimText: 'Reliability factors sit high in the elicited ISM model.',
          claimType: 'empirical',
          status: 'proposed',
          confidence: 0.55,
          boundary: '专家判断层级 ≠ 统计显著性',
        });
        expect(patched.claimText).toBe('Reliability factors sit high in the elicited ISM model.');
        expect(patched.claimType).toBe('empirical');
        expect(patched.status).toBe('proposed');
        expect(patched.confidence).toBeCloseTo(0.55, 6);
        expect(patched.boundary).toBe('专家判断层级 ≠ 统计显著性');
        expect(patched.claimCode).toBe('C-021');
        expect(patched.createdAt).toBe(created.createdAt);

        const missing = await rejection(repository.updateClaim('absent', userId, { status: 'dropped' }));
        expect(missing.message).toBe('Claim absent not found');
        const foreign = await rejection(repository.updateClaim(created.id, foreignUser(), { status: 'dropped' }));
        expect(foreign.message).toBe(`Claim ${created.id} not found`);
      });
    }, timeout);

    it('creates, reads, lists and patches manuscript sections', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const created = await repository.createManuscriptSection({
          userId,
          projectId: research.id,
          sectionName: 'Results',
          sectionReference: '4.2',
        });
        expect(created.sortOrder).toBe(0);
        expect(await repository.findManuscriptSection(created.id, userId)).toEqual(created);
        expect(await repository.findManuscriptSection(created.id, foreignUser())).toBeNull();

        await pause();
        const sibling = await repository.createManuscriptSection({
          userId,
          projectId: research.id,
          sectionName: 'Discussion',
          sectionReference: '5.1',
          sortOrder: 5,
        });
        // Sections read in creation order; sortOrder is a display hint, not the list key.
        expect((await repository.listManuscriptSections(research.id, userId)).map((row) => row.id)).toEqual([
          created.id,
          sibling.id,
        ]);

        await pause();
        const patched = await repository.updateManuscriptSection(created.id, userId, {
          sectionName: 'Results and Robustness',
          sectionReference: null,
          sortOrder: 1,
        });
        expect(patched.sectionName).toBe('Results and Robustness');
        expect(patched.sectionReference).toBeNull();
        expect(patched.sortOrder).toBe(1);
        expect(patched.createdAt).toBe(created.createdAt);

        const missing = await rejection(repository.updateManuscriptSection('absent', userId, { sortOrder: 2 }));
        expect(missing.message).toBe('ManuscriptSection absent not found');
        const foreign = await rejection(
          repository.updateManuscriptSection(created.id, foreignUser(), { sortOrder: 2 }),
        );
        expect(foreign.message).toBe(`ManuscriptSection ${created.id} not found`);
      });
    }, timeout);

    it('creates relations idempotently, filters them and deletes links only', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const question = await repository.createResearchQuestion({
          userId,
          projectId: research.id,
          questionCode: 'RQ1',
          questionText: 'How are factors organized?',
        });
        const evidence = await repository.createEvidence({
          userId,
          projectId: research.id,
          type: 'expert_judgement',
          title: '专家访谈 E-031',
        });
        const claim = await repository.createClaim({
          userId,
          projectId: research.id,
          claimCode: 'C-021',
          claimText: 'Reliability factors sit high in the ISM model.',
          claimType: 'descriptive',
        });
        const section = await repository.createManuscriptSection({
          userId,
          projectId: research.id,
          sectionName: 'Results',
        });

        const supported = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'evidence',
          sourceId: evidence.id,
          relationType: 'supports',
          targetType: 'claim',
          targetId: claim.id,
          note: '访谈共识支持该判断',
        });
        expect(supported.note).toBe('访谈共识支持该判断');

        // Same five-tuple again: the existing row comes back untouched (contract §2 idempotence).
        const again = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'evidence',
          sourceId: evidence.id,
          relationType: 'supports',
          targetType: 'claim',
          targetId: claim.id,
          note: '另一段说明',
        });
        expect(again.id).toBe(supported.id);
        expect(again.note).toBe('访谈共识支持该判断');
        expect(await repository.listEntityRelations(research.id, userId)).toHaveLength(1);

        await pause();
        const contradicts = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'evidence',
          sourceId: evidence.id,
          relationType: 'contradicts',
          targetType: 'claim',
          targetId: claim.id,
        });
        await pause();
        const answers = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'claim',
          sourceId: claim.id,
          relationType: 'answers',
          targetType: 'research_question',
          targetId: question.id,
        });
        await pause();
        const appears = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'claim',
          sourceId: claim.id,
          relationType: 'appears_in',
          targetType: 'manuscript_section',
          targetId: section.id,
        });
        expect(appears.note).toBeNull();

        const all = await repository.listEntityRelations(research.id, userId);
        expect(all.map((row) => row.id)).toEqual([supported.id, contradicts.id, answers.id, appears.id]);
        expect(
          (await repository.listEntityRelations(research.id, userId, { sourceType: 'evidence' })).map((row) => row.id),
        ).toEqual([supported.id, contradicts.id]);
        expect(
          (await repository.listEntityRelations(research.id, userId, { relationType: 'answers' })).map((row) => row.id),
        ).toEqual([answers.id]);
        expect(
          (
            await repository.listEntityRelations(research.id, userId, {
              targetType: 'claim',
              targetId: claim.id,
              relationType: 'supports',
            })
          ).map((row) => row.id),
        ).toEqual([supported.id]);
        expect(
          (await repository.listEntityRelations(research.id, userId, { sourceId: 'absent' })).length,
        ).toBe(0);

        // Removing a link never removes the entities it connected.
        expect(await repository.deleteEntityRelation(supported.id, userId)).toBe(true);
        expect(await repository.deleteEntityRelation(supported.id, userId)).toBe(false);
        expect(await repository.deleteEntityRelation(contradicts.id, foreignUser())).toBe(false);
        expect(await repository.findClaim(claim.id, userId)).not.toBeNull();
        expect(await repository.findEvidence(evidence.id, userId)).not.toBeNull();
        expect((await repository.listEntityRelations(research.id, userId)).map((row) => row.id)).toEqual([
          contradicts.id,
          answers.id,
          appears.id,
        ]);
      });
    }, timeout);

    it('appends decisions and changes and never offers a rewrite', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        // Append-only is visible in the interface itself: no update/delete method exists.
        expect(Reflect.get(repository, 'updateResearchDecision')).toBeUndefined();
        expect(Reflect.get(repository, 'deleteResearchDecision')).toBeUndefined();
        expect(Reflect.get(repository, 'updateResearchChange')).toBeUndefined();
        expect(Reflect.get(repository, 'deleteResearchChange')).toBeUndefined();

        const decision = await repository.createResearchDecision({
          userId,
          projectId: research.id,
          title: '采用 ISM + ANP',
          decision: '以 ISM 建立结构、以 ANP 计算目标依赖优先级',
          reason: '研究问题关注结构关系而非统计因果',
        });
        expect(decision.reason).toBe('研究问题关注结构关系而非统计因果');
        expect(decision.alternatives).toBeNull();
        expect(decision.rejectedAlternatives).toBeNull();
        expect(decision.impact).toBeNull();
        expect(decision.relatedEntities).toEqual({});
        expect(await repository.findResearchDecision(decision.id, userId)).toEqual(decision);
        expect(await repository.findResearchDecision(decision.id, foreignUser())).toBeNull();
        expect(await repository.findResearchDecision('absent', userId)).toBeNull();

        await pause();
        const second = await repository.createResearchDecision({
          userId,
          projectId: research.id,
          title: '更换目标期刊',
          decision: '投稿 IJLM',
          reason: '范围与读者匹配',
          alternatives: 'JSCM',
          rejectedAlternatives: 'JSCM 周期过长',
          impact: 'Introduction / Discussion',
          relatedEntities: { entities: [decision.id] },
        });
        expect(second.relatedEntities).toEqual({ entities: [decision.id] });
        expect((await repository.listResearchDecisions(research.id, userId)).map((row) => row.id)).toEqual([
          decision.id,
          second.id,
        ]);

        const change = await repository.createResearchChange({
          userId,
          projectId: research.id,
          changeType: 'research_question',
          before: 'RQ2 focused on overall importance.',
          after: 'RQ2 focuses on goal-dependent decision priority.',
          reason: 'ANP 输出是目标依赖的相对优先级',
          impact: 'Introduction / Method / Results',
        });
        expect(change.reason).toBe('ANP 输出是目标依赖的相对优先级');
        expect(change.relatedEntities).toEqual({});
        expect(await repository.findResearchChange(change.id, userId)).toEqual(change);
        expect(await repository.findResearchChange(change.id, foreignUser())).toBeNull();

        await pause();
        const journalChange = await repository.createResearchChange({
          userId,
          projectId: research.id,
          changeType: 'journal',
          before: 'JSCM',
          after: 'IJLM',
          relatedEntities: { entities: [decision.id] },
        });
        expect((await repository.listResearchChanges(research.id, userId)).map((row) => row.id)).toEqual([
          change.id,
          journalChange.id,
        ]);
        expect(
          (await repository.listResearchChanges(research.id, userId, { changeType: 'journal' })).map((row) => row.id),
        ).toEqual([journalChange.id]);
        expect(await repository.listResearchChanges(research.id, userId, { changeType: 'method' })).toEqual([]);
      });
    }, timeout);

    it('records drift findings, filters them and moves their status', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const claim = await repository.createClaim({
          userId,
          projectId: research.id,
          claimCode: 'C-021',
          claimText: 'Reliability factors sit high in the ISM model.',
          claimType: 'descriptive',
        });
        const finding = await repository.createDriftFinding({
          userId,
          projectId: research.id,
          driftType: 'evidence_drift',
          severity: 'critical',
          description: 'C-021 缺少 supports / partially_supports 证据',
          sourceEntityType: 'claim',
          sourceEntityId: claim.id,
          reason: 'confirmed claim 没有支撑证据',
          recommendedAction: '补充 Evidence 或弱化 Claim',
        });
        expect(finding.status).toBe('open');
        expect(finding.createdAt).toBe(finding.updatedAt);
        expect(await repository.findDriftFinding(finding.id, userId)).toEqual(finding);
        expect(await repository.findDriftFinding(finding.id, foreignUser())).toBeNull();

        await pause();
        const quiet = await repository.createDriftFinding({
          userId,
          projectId: research.id,
          driftType: 'rq_drift',
          severity: 'info',
          description: '正文出现未登记的研究问题',
        });
        expect(quiet.sourceEntityType).toBeNull();
        expect(quiet.sourceEntityId).toBeNull();
        expect(quiet.targetEntityType).toBeNull();
        expect(quiet.targetEntityId).toBeNull();
        expect(quiet.reason).toBeNull();
        expect(quiet.recommendedAction).toBeNull();

        expect((await repository.listDriftFindings(research.id, userId)).map((row) => row.id)).toEqual([
          finding.id,
          quiet.id,
        ]);
        expect(
          (await repository.listDriftFindings(research.id, userId, { status: 'open' })).map((row) => row.id),
        ).toEqual([finding.id, quiet.id]);
        expect(
          (await repository.listDriftFindings(research.id, userId, { driftType: 'rq_drift' })).map((row) => row.id),
        ).toEqual([quiet.id]);
        expect(
          (await repository.listDriftFindings(research.id, userId, { severity: 'critical' })).map((row) => row.id),
        ).toEqual([finding.id]);
        expect(
          (
            await repository.listDriftFindings(research.id, userId, { driftType: 'evidence_drift', severity: 'info' })
          ).length,
        ).toBe(0);

        await pause();
        const resolved = await repository.updateDriftFindingStatus(finding.id, userId, 'resolved');
        expect(resolved.status).toBe('resolved');
        expect(resolved.createdAt).toBe(finding.createdAt);
        expect(resolved.updatedAt > finding.updatedAt).toBe(true);
        expect(resolved.description).toBe('C-021 缺少 supports / partially_supports 证据');
        expect(
          (await repository.listDriftFindings(research.id, userId, { status: 'resolved' })).map((row) => row.id),
        ).toEqual([finding.id]);

        const missing = await rejection(repository.updateDriftFindingStatus('absent', userId, 'dismissed'));
        expect(missing.message).toBe('DriftFinding absent not found');
        const foreign = await rejection(repository.updateDriftFindingStatus(finding.id, foreignUser(), 'dismissed'));
        expect(foreign.message).toBe(`DriftFinding ${finding.id} not found`);
      });
    }, timeout);

    it('orders timeline events by occurredAt, newest first', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        // Created out of chronological order on purpose: the list must sort by occurredAt desc.
        const early = await repository.createTimelineEvent({
          userId,
          projectId: research.id,
          eventType: 'decision',
          occurredAt: '2026-03-18T00:00:00.000Z',
          title: 'RQ2 modified',
          sourceType: 'research_decision',
        });
        const late = await repository.createTimelineEvent({
          userId,
          projectId: research.id,
          eventType: 'change',
          occurredAt: '2026-05-11T00:00:00.000Z',
          title: 'Robustness analysis added',
          summary: '增加稳健性分析',
          sourceType: 'research_change',
          relatedEntities: { sections: ['Results'] },
        });
        const middle = await repository.createTimelineEvent({
          userId,
          projectId: research.id,
          eventType: 'milestone',
          occurredAt: '2026-04-02T00:00:00.000Z',
          title: 'Method baseline frozen',
        });
        expect(middle.summary).toBeNull();
        expect(middle.sourceType).toBeNull();
        expect(middle.sourceId).toBeNull();
        expect(middle.relatedEntities).toEqual({});

        const events = await repository.listTimelineEvents(research.id, userId);
        expect(events.map((row) => row.id)).toEqual([late.id, middle.id, early.id]);
        expect(events.map((row) => row.title)).toEqual([
          'Robustness analysis added',
          'Method baseline frozen',
          'RQ2 modified',
        ]);
        // occurredAt round-trips exactly what the caller stamped on the event.
        expect(early.occurredAt).toBe('2026-03-18T00:00:00.000Z');
        expect(late.occurredAt).toBe('2026-05-11T00:00:00.000Z');
        const foreign = await rejection(repository.listTimelineEvents(research.id, foreignUser()));
        expect(foreign.code).toBe('not_found');
      });
    }, timeout);

    it('aggregates research project statistics', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const empty = await repository.researchProjectStats(research.id, userId);
        expect(empty).toEqual({
          questionCount: 0,
          evidenceCount: 0,
          claimCount: 0,
          decisionCount: 0,
          changeCount: 0,
          openDriftCount: 0,
        });

        for (const code of ['RQ1', 'RQ2']) {
          await repository.createResearchQuestion({
            userId,
            projectId: research.id,
            questionCode: code,
            questionText: `${code} 的研究问题`,
          });
        }
        await repository.createEvidence({ userId, projectId: research.id, type: 'note', title: '便签' });
        for (const code of ['C-01', 'C-02', 'C-03']) {
          await repository.createClaim({
            userId,
            projectId: research.id,
            claimCode: code,
            claimText: `${code} 的判断`,
            claimType: 'descriptive',
          });
        }
        await repository.createResearchDecision({
          userId,
          projectId: research.id,
          title: '冻结方法基线',
          decision: 'ISM + ANP',
        });
        for (const changeType of ['method', 'scope'] as const) {
          await repository.createResearchChange({
            userId,
            projectId: research.id,
            changeType,
            before: 'before',
            after: 'after',
          });
        }
        const open = await repository.createDriftFinding({
          userId,
          projectId: research.id,
          driftType: 'evidence_drift',
          severity: 'warning',
          description: 'C-01 无支撑证据',
        });
        const resolved = await repository.createDriftFinding({
          userId,
          projectId: research.id,
          driftType: 'method_drift',
          severity: 'info',
          description: '方法变更未同步章程',
        });
        await repository.updateDriftFindingStatus(resolved.id, userId, 'resolved');

        expect(await repository.researchProjectStats(research.id, userId)).toEqual({
          questionCount: 2,
          evidenceCount: 1,
          claimCount: 3,
          decisionCount: 1,
          changeCount: 2,
          openDriftCount: 1,
        });
        expect(open.status).toBe('open');

        const foreign = await rejection(repository.researchProjectStats(research.id, foreignUser()));
        expect(foreign.code).toBe('not_found');
        const missing = await rejection(repository.researchProjectStats('absent', userId));
        expect(missing.message).toBe('ResearchProject absent not found');
      });
    }, timeout);

    it('refuses to write into a project the caller does not own', async () => {
      await scope(async (repository, userId) => {
        const other = foreignUser();
        const theirs = await project(repository, other, '别人的项目');
        const attackerId = userId;

        // Absent and foreign projects are indistinguishable: both surface as not_found (contract §2).
        const probes: Array<() => Promise<unknown>> = [
          () => repository.upsertCharter({ userId: attackerId, projectId: theirs.id, ...charterFields() }),
          () =>
            repository.createResearchQuestion({
              userId: attackerId,
              projectId: theirs.id,
              questionCode: 'RQ1',
              questionText: 'x',
            }),
          () => repository.createEvidence({ userId: attackerId, projectId: theirs.id, type: 'note', title: 'x' }),
          () =>
            repository.createClaim({
              userId: attackerId,
              projectId: theirs.id,
              claimCode: 'C-1',
              claimText: 'x',
              claimType: 'descriptive',
            }),
          () => repository.createManuscriptSection({ userId: attackerId, projectId: theirs.id, sectionName: 'x' }),
          () =>
            repository.createEntityRelation({
              userId: attackerId,
              projectId: theirs.id,
              sourceType: 'claim',
              sourceId: 'c',
              relationType: 'relates_to',
              targetType: 'claim',
              targetId: 'c2',
            }),
          () =>
            repository.createResearchDecision({
              userId: attackerId,
              projectId: theirs.id,
              title: 'x',
              decision: 'x',
            }),
          () =>
            repository.createResearchChange({
              userId: attackerId,
              projectId: theirs.id,
              changeType: 'other',
              before: 'x',
              after: 'y',
            }),
          () =>
            repository.createDriftFinding({
              userId: attackerId,
              projectId: theirs.id,
              driftType: 'rq_drift',
              severity: 'info',
              description: 'x',
            }),
          () =>
            repository.createTimelineEvent({
              userId: attackerId,
              projectId: theirs.id,
              eventType: 'milestone',
              occurredAt: '2026-01-01T00:00:00.000Z',
              title: 'x',
            }),
          () => repository.listResearchQuestions(theirs.id, attackerId),
          () => repository.listEvidence(theirs.id, attackerId),
          () => repository.listClaims(theirs.id, attackerId),
          () => repository.listManuscriptSections(theirs.id, attackerId),
          () => repository.listEntityRelations(theirs.id, attackerId),
          () => repository.listResearchDecisions(theirs.id, attackerId),
          () => repository.listResearchChanges(theirs.id, attackerId),
          () => repository.listDriftFindings(theirs.id, attackerId),
          () => repository.listTimelineEvents(theirs.id, attackerId),
          () => repository.researchProjectStats(theirs.id, attackerId),
        ];
        for (const probe of probes) {
          const error = await rejection(probe());
          expect(error.code).toBe('not_found');
          expect(error.message).toBe(`ResearchProject ${theirs.id} not found`);
        }

        // Reads by id stay silent (null), and nothing was written into the foreign project.
        expect(await repository.findCharter(theirs.id, attackerId)).toBeNull();
        expect(await repository.researchProjectStats(theirs.id, other)).toEqual({
          questionCount: 0,
          evidenceCount: 0,
          claimCount: 0,
          decisionCount: 0,
          changeCount: 0,
          openDriftCount: 0,
        });
      });
    }, timeout);

    it('keeps every research object invisible to another user', async () => {
      await scope(async (repository, userId) => {
        const research = await project(repository, userId);
        const charter = await repository.upsertCharter({ userId, projectId: research.id, ...charterFields() });
        const question = await repository.createResearchQuestion({
          userId,
          projectId: research.id,
          questionCode: 'RQ1',
          questionText: 'How are factors organized?',
        });
        const evidence = await repository.createEvidence({
          userId,
          projectId: research.id,
          type: 'note',
          title: '便签',
        });
        const claim = await repository.createClaim({
          userId,
          projectId: research.id,
          claimCode: 'C-1',
          claimText: 'x',
          claimType: 'descriptive',
        });
        const section = await repository.createManuscriptSection({
          userId,
          projectId: research.id,
          sectionName: 'Results',
        });
        const relation = await repository.createEntityRelation({
          userId,
          projectId: research.id,
          sourceType: 'evidence',
          sourceId: evidence.id,
          relationType: 'supports',
          targetType: 'claim',
          targetId: claim.id,
        });
        const decision = await repository.createResearchDecision({
          userId,
          projectId: research.id,
          title: '决定',
          decision: '决定内容',
        });
        const change = await repository.createResearchChange({
          userId,
          projectId: research.id,
          changeType: 'scope',
          before: 'a',
          after: 'b',
        });
        const finding = await repository.createDriftFinding({
          userId,
          projectId: research.id,
          driftType: 'evidence_drift',
          severity: 'warning',
          description: '缺证据',
        });
        const event = await repository.createTimelineEvent({
          userId,
          projectId: research.id,
          eventType: 'milestone',
          occurredAt: '2026-01-01T00:00:00.000Z',
          title: '开工',
        });

        const thief = foreignUser();
        expect(await repository.findResearchProject(research.id, thief)).toBeNull();
        expect(await repository.listResearchProjects(thief)).toEqual([]);
        expect(await repository.findCharter(research.id, thief)).toBeNull();
        expect(charter.userId).toBe(userId);
        expect(await repository.findResearchQuestion(question.id, thief)).toBeNull();
        expect(await repository.findEvidence(evidence.id, thief)).toBeNull();
        expect(await repository.findClaim(claim.id, thief)).toBeNull();
        expect(await repository.findManuscriptSection(section.id, thief)).toBeNull();
        expect(await repository.findResearchDecision(decision.id, thief)).toBeNull();
        expect(await repository.findResearchChange(change.id, thief)).toBeNull();
        expect(await repository.findDriftFinding(finding.id, thief)).toBeNull();
        expect(event.userId).toBe(userId);

        expect((await rejection(repository.updateResearchProject(research.id, thief, { name: '偷' }))).code).toBe(
          'not_found',
        );
        expect(
          (await rejection(repository.updateResearchQuestion(question.id, thief, { status: 'dropped' }))).code,
        ).toBe('not_found');
        expect((await rejection(repository.updateEvidence(evidence.id, thief, { title: '偷' }))).code).toBe('not_found');
        expect((await rejection(repository.updateClaim(claim.id, thief, { status: 'dropped' }))).code).toBe(
          'not_found',
        );
        expect(
          (await rejection(repository.updateManuscriptSection(section.id, thief, { sortOrder: 9 }))).code,
        ).toBe('not_found');
        expect((await rejection(repository.updateDriftFindingStatus(finding.id, thief, 'dismissed'))).code).toBe(
          'not_found',
        );

        // A foreign user can neither delete the link nor claim the relation exists elsewhere.
        expect(await repository.deleteEntityRelation(relation.id, thief)).toBe(false);
        expect(await repository.deleteEntityRelation(relation.id, userId)).toBe(true);
        expect(await repository.listEntityRelations(research.id, userId)).toEqual([]);
      });
    }, timeout);
  });
}
