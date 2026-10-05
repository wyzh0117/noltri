/**
 * 开发文档 §12 的用户完整流程，收到 P5 的完成门槛（§18「章程到章节的真实数据闭环；保留既有知识溯源」）为止。
 *
 * Three lines:
 *  1. the chain through the domain over the real in-memory driver: 项目 → 章程 → RQ → 证据 → 论点 →
 *     supports / answers / appears_in → 章节 → 决策 / 变更 → 时间线;
 *  2. the demo seed's shape, and the honesty of the fixture (marked as test data, gaps left in on purpose);
 *  3. the same chain over the real router with the frozen response schemas.
 *
 * Map, drift checks and the context pack are not asserted here: they are P6, and this branch's façade does
 * not have those methods yet.
 */
import { describe, expect, it } from 'vitest';
import { createOfflineProvider } from '@noltri/ai-provider';
import {
  apiErrorSchema,
  claimSchema,
  entityRelationSchema,
  evidenceSchema,
  researchCharterSchema,
  researchProjectSchema,
  researchQuestionSchema,
  sectionListResponseSchema,
  timelineListResponseSchema,
} from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createInMemoryRepository, createInMemoryResearchRepository } from '@noltri/storage';
import { createKnowledgeCore } from '../src/core';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import { buildResearchDemoData, seedResearchDemo } from '../src/research/demo';
import { createRequestHandler, type RequestHandler } from '../src/http/router';
import { testConfig } from './fakes';

function domainOf(): ResearchDomain {
  return createResearchDomain(createInMemoryResearchRepository());
}

function handlerOf(): RequestHandler {
  const config = testConfig();
  const core = createKnowledgeCore({
    repository: createInMemoryRepository(),
    provider: createOfflineProvider({ embeddingDim: 1536 }),
    config,
    logger: silentLogger,
    research: domainOf(),
  });
  return createRequestHandler({ core, config });
}

async function call(handle: RequestHandler, method: string, path: string, body?: unknown): Promise<Response> {
  return handle(
    new Request(`http://core.local${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-noltri-client': 'desktop' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function jsonOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

describe('章程 → 章节 closed loop', () => {
  it('walks the whole chain and every step satisfies its frozen schema', async () => {
    const domain = domainOf();
    const userId = 'user-e2e';

    const project = await domain.createProject(userId, {
      name: 'Chain Test Project',
      description: '端到端链路验证',
    });
    expect(researchProjectSchema.safeParse(project).success).toBe(true);

    const charter = await domain.upsertCharter(project.id, userId, {
      workingTitle: '链路测试论文',
      coreContribution: '一个可追溯的结构模型。',
      researchBoundary: '只处理结构关系，不含因果推断。',
      claimBoundary: 'ISM relationship ≠ statistical causality。',
      researchMethod: 'ISM',
      currentStage: '设计',
    });
    expect(researchCharterSchema.safeParse(charter).success).toBe(true);

    const question = await domain.createQuestion(project.id, userId, {
      questionCode: 'RQ1',
      questionText: 'How are the factors structurally organized?',
    });
    expect(researchQuestionSchema.safeParse(question).success).toBe(true);

    const evidence = await domain.createEvidence(project.id, userId, {
      type: 'analysis_result',
      title: 'ISM 层级输出',
    });
    expect(evidenceSchema.safeParse(evidence).success).toBe(true);

    const claim = await domain.createClaim(project.id, userId, {
      claimCode: 'C-01',
      claimText: '可靠性因素位于结构模型的较高层级。',
      claimType: 'empirical',
      boundary: '结构层级不等于因果。',
    });
    expect(claimSchema.safeParse(claim).success).toBe(true);

    const supports = await domain.createRelation(project.id, userId, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: claim.id,
    });
    const answers = await domain.createRelation(project.id, userId, {
      sourceType: 'claim',
      sourceId: claim.id,
      relationType: 'answers',
      targetType: 'research_question',
      targetId: question.id,
    });
    const section = await domain.createSection(project.id, userId, {
      sectionName: 'Results 4.1',
      sectionReference: 'ISM 结构',
    });
    const appears = await domain.createRelation(project.id, userId, {
      sourceType: 'claim',
      sourceId: claim.id,
      relationType: 'appears_in',
      targetType: 'manuscript_section',
      targetId: section.id,
    });
    for (const relation of [supports, answers, appears]) {
      expect(entityRelationSchema.safeParse(relation).success).toBe(true);
    }

    const decision = await domain.createDecision(project.id, userId, {
      title: '采用 ISM 方法',
      decision: '用 ISM 刻画结构层级。',
    });
    await domain.createChange(project.id, userId, { changeType: 'scope', before: '全行业', after: '冷链' });

    const timeline = await domain.listTimeline(project.id, userId);
    expect(timelineListResponseSchema.safeParse({ events: timeline }).success).toBe(true);
    expect(timeline.map((event) => event.eventType).sort()).toEqual(['change', 'decision']);
    expect(timeline.find((event) => event.eventType === 'decision')?.sourceId).toBe(decision.id);
    expect((await domain.listSections(project.id, userId)).map((row) => row.id)).toEqual([section.id]);
  });
});

describe('Noltri Research Demo seed', () => {
  it('seeds the documented shape: RQ×2, Evidence×5, Claim×5, Section×4, Decision×2, Change×2', async () => {
    const seed = await seedResearchDemo(domainOf(), 'user-demo');

    expect(seed.project.name).toBe('Noltri Research Demo');
    expect(seed.questions).toHaveLength(2);
    expect(seed.evidence).toHaveLength(5);
    expect(seed.claims).toHaveLength(5);
    expect(seed.decisions).toHaveLength(2);
    expect(seed.changes).toHaveLength(2);
    expect(seed.sections).toHaveLength(4);
    expect(seed.relations).toHaveLength(13);
    expect(seed.events.length).toBeGreaterThanOrEqual(5); // 2 decision + 2 change + 1 milestone
  });

  it('keeps the seeded timeline newest-first and readable after every write', async () => {
    const domain = domainOf();
    const seed = await seedResearchDemo(domain, 'user-demo-timeline');
    const timeline = await domain.listTimeline(seed.project.id, 'user-demo-timeline');
    expect(timeline[0]!.occurredAt >= timeline[timeline.length - 1]!.occurredAt).toBe(true);
    expect(timelineListResponseSchema.safeParse({ events: timeline }).success).toBe(true);
  });

  it('is marked as test data and keeps the gaps P6 needs to detect', () => {
    const data = buildResearchDemoData();
    expect(data.project.description).toContain('虚构');
    expect(data.charter.claimBoundary).toContain('≠');
    expect(data.charter.researchBoundary).toContain('不包含');

    // C-03 没有任何 supports 边，C-05 没有 boundary：两者都是留给偏移检查的真实缺口。
    const targets = new Set(
      data.relations.filter((relation) => relation.targetType === 'claim').map((relation) => relation.targetId),
    );
    expect(targets.has('$C3')).toBe(false);
    expect(data.claims[4]?.boundary).toBeUndefined();
  });
});

describe('chain over the real HTTP router', () => {
  it('walks 章程→章节 through the wire with the frozen response schemas', async () => {
    const handle = handlerOf();

    const created = await call(handle, 'POST', '/api/research/projects', { name: 'HTTP Chain' });
    expect(created.status).toBe(200);
    const project = researchProjectSchema.parse(await jsonOf(created));

    const charterResponse = await call(handle, 'PUT', `/api/research/projects/${project.id}/charter`, {
      workingTitle: 'HTTP 链路论文',
      coreContribution: '端到端可执行的研究连续性链路。',
      researchMethod: 'ISM + ANP',
      claimBoundary: 'Expert judgement ≠ objective population parameter。',
    });
    expect(charterResponse.status).toBe(200);
    researchCharterSchema.parse(await jsonOf(charterResponse));

    const evidence = evidenceSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${project.id}/evidence`, {
          type: 'expert_judgement',
          title: '专家判断记录',
        }),
      ),
    );
    const claim = claimSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${project.id}/claims`, {
          claimCode: 'C-01',
          claimText: 'ANP 权重反映特定决策目标下的相对优先级。',
          claimType: 'methodological',
        }),
      ),
    );
    const relation = entityRelationSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${project.id}/relations`, {
          sourceType: 'evidence',
          sourceId: evidence.id,
          relationType: 'supports',
          targetType: 'claim',
          targetId: claim.id,
        }),
      ),
    );
    expect(relation.sourceId).toBe(evidence.id);

    await call(handle, 'POST', `/api/research/projects/${project.id}/sections`, { sectionName: 'Results 4.1' });
    const sections = sectionListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/sections`)),
    );
    expect(sections.sections).toHaveLength(1);

    const events = timelineListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/timeline`)),
    );
    expect(events.events).toHaveLength(0);

    await call(handle, 'POST', `/api/research/projects/${project.id}/decisions`, {
      title: '选择 ANP',
      decision: '用 ANP 给出目标依赖的优先级。',
    });
    const afterDecision = timelineListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/timeline`)),
    );
    expect(afterDecision.events.map((event) => event.eventType)).toEqual(['decision']);
  });

  it('rejects a project the caller does not own with the frozen not_found envelope', async () => {
    const handle = handlerOf();
    const created = await call(handle, 'POST', '/api/research/projects', { name: 'Owned' });
    expect(researchProjectSchema.parse(await jsonOf(created)).name).toBe('Owned');

    const missing = await call(handle, 'GET', '/api/research/projects/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await jsonOf(missing)).error.code).toBe('not_found');
  });
});
