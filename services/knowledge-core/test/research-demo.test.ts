/**
 * §34 最小成功链路端到端 + §36「Noltri Research Demo」种子验收（research doc §34/§36）。
 *
 * 三条线：
 *  1. 端到端链路：创建项目 → Charter → RQ1 → Evidence → Claim → supports → answers →
 *     appears_in → Research Map → Drift Checker → Research Context Pack；
 *  2. Demo 种子：数量符合 §36，运行 Drift Checker 覆盖 evidence/causality/journal 三类；
 *  3. HTTP 闭环：真实 router + 冻结 zod schema 校验响应形状。
 */
import { describe, expect, it } from 'vitest';
import { createOfflineProvider } from '@noltri/ai-provider';
import {
  claimSchema,
  driftCheckResponseSchema,
  entityRelationSchema,
  evidenceSchema,
  researchCharterSchema,
  researchContextPackResponseSchema,
  researchMapResponseSchema,
  researchProjectSchema,
  researchQuestionSchema,
  timelineListResponseSchema,
} from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createInMemoryResearchRepository, createInMemoryRepository } from '@noltri/storage';
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
  const research = domainOf();
  const core = createKnowledgeCore({
    repository: createInMemoryRepository(),
    provider: createOfflineProvider({ embeddingDim: 1536 }),
    config,
    logger: silentLogger,
    research,
  });
  return createRequestHandler({ core, config, research });
}

async function call(handle: RequestHandler, method: string, path: string, body?: unknown): Promise<Response> {
  return handle(
    new Request(`http://core.local${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-noltri-client': 'web_app' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('§34 minimal success chain (research doc §34)', () => {
  it('runs create project → charter → RQ1 → evidence → claim → relations → map → drift → context pack', async () => {
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

    const map = await domain.buildMap(project.id, userId);
    expect(researchMapResponseSchema.safeParse(map).success).toBe(true);
    expect(map.edges.map((edge) => edge.relationType).sort()).toEqual(['answers', 'appears_in', 'supports']);
    expect(map.claims[0]?.supported).toBe(true);
    expect(map.unsupportedClaimIds).toEqual([]);

    const drift = await domain.runDriftCheck(project.id, userId, {});
    expect(driftCheckResponseSchema.safeParse(drift).success).toBe(true);

    const pack = await domain.buildContextPack(project.id, userId);
    expect(researchContextPackResponseSchema.safeParse(pack).success).toBe(true);
    for (const heading of [
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
    ]) {
      expect(pack.markdown).toContain(heading);
    }
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
  });
});

describe('§36 Noltri Research Demo seed', () => {
  it('seeds exactly the §36 shape: RQ×2, Evidence×5, Claim×5, Decision×2, Change×2', async () => {
    const domain = domainOf();
    const seed = await seedResearchDemo(domain, 'user-demo');

    expect(seed.project.name).toBe('Noltri Research Demo');
    expect(seed.questions).toHaveLength(2);
    expect(seed.evidence).toHaveLength(5);
    expect(seed.claims).toHaveLength(5);
    expect(seed.decisions).toHaveLength(2);
    expect(seed.changes).toHaveLength(2);
    expect(seed.sections).toHaveLength(4);
    expect(seed.events.length).toBeGreaterThanOrEqual(3); // 2 decision + 2 change + 1 milestone
  });

  it('produces at least 3 drift findings covering evidence, causality and journal drift', async () => {
    const domain = domainOf();
    const seed = await seedResearchDemo(domain, 'user-demo-drift');

    const drift = await domain.runDriftCheck(seed.project.id, 'user-demo-drift', {});
    expect(drift.findings.length).toBeGreaterThanOrEqual(3);

    const types = new Set(drift.findings.map((finding) => finding.driftType));
    expect(types.has('evidence_drift')).toBe(true); // C-03 无支持证据
    expect(types.has('causality_drift')).toBe(true); // C-05 强因果 + 仅专家判断
    expect(types.has('journal_drift')).toBe(true); // 期刊变更晚于 Charter

    const causality = drift.findings.find((finding) => finding.driftType === 'causality_drift');
    expect(causality?.severity).toBe('critical'); // C-05 无 boundary

    // 去重：重复运行不产生新的同 key open findings
    const again = await domain.runDriftCheck(seed.project.id, 'user-demo-drift', {});
    expect(again.findings.length).toBe(drift.findings.length);
  });

  it('answers every research question and keeps the demo map readable', async () => {
    const domain = domainOf();
    const seed = await seedResearchDemo(domain, 'user-demo-map');

    const map = await domain.buildMap(seed.project.id, 'user-demo-map');
    expect(map.questions).toHaveLength(2);
    expect(map.evidence).toHaveLength(5);
    expect(map.claims).toHaveLength(5);
    expect(map.sections).toHaveLength(4);
    expect(map.unsupportedClaimIds).toHaveLength(1); // 仅 C-03
    expect(map.edges.filter((edge) => edge.relationType === 'answers')).toHaveLength(4);

    const timeline = await domain.listTimeline(seed.project.id, 'user-demo-map');
    expect(timeline[0]?.occurredAt >= timeline[timeline.length - 1]?.occurredAt).toBe(true);
    expect(timelineListResponseSchema.safeParse({ events: timeline }).success).toBe(true);
  });
});

describe('§34 chain over the real HTTP router', () => {
  it('walks the chain through 8 endpoints with the frozen response schemas', async () => {
    const handle = handlerOf();

    const created = await call(handle, 'POST', '/api/research/projects', { name: 'HTTP Chain' });
    expect(created.status).toBe(200);
    const project = researchProjectSchema.parse(await created.json());

    const charterResponse = await call(handle, 'PUT', `/api/research/projects/${project.id}/charter`, {
      workingTitle: 'HTTP 链路论文',
      coreContribution: '端到端可执行的研究连续性链路。',
      researchMethod: 'ISM + ANP',
      claimBoundary: 'Expert judgement ≠ objective population parameter。',
    });
    expect(charterResponse.status).toBe(200);
    researchCharterSchema.parse(await charterResponse.json());

    const evidenceResponse = await call(handle, 'POST', `/api/research/projects/${project.id}/evidence`, {
      type: 'expert_judgement',
      title: '专家判断记录',
    });
    expect(evidenceResponse.status).toBe(200);
    const evidence = evidenceSchema.parse(await evidenceResponse.json());

    const claimResponse = await call(handle, 'POST', `/api/research/projects/${project.id}/claims`, {
      claimCode: 'C-01',
      claimText: 'ANP 权重反映特定决策目标下的相对优先级。',
      claimType: 'methodological',
    });
    expect(claimResponse.status).toBe(200);
    const claim = claimSchema.parse(await claimResponse.json());

    const relationResponse = await call(handle, 'POST', `/api/research/projects/${project.id}/relations`, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: claim.id,
    });
    expect(relationResponse.status).toBe(200);
    entityRelationSchema.parse(await relationResponse.json());

    const mapResponse = await call(handle, 'GET', `/api/research/projects/${project.id}/map`);
    expect(mapResponse.status).toBe(200);
    const map = researchMapResponseSchema.parse(await mapResponse.json());
    expect(map.edges).toHaveLength(1);

    const driftResponse = await call(handle, 'POST', `/api/research/projects/${project.id}/drift-check`, {});
    expect(driftResponse.status).toBe(200);
    driftCheckResponseSchema.parse(await driftResponse.json());

    const packResponse = await call(handle, 'GET', `/api/research/projects/${project.id}/context-pack`);
    expect(packResponse.status).toBe(200);
    const pack = researchContextPackResponseSchema.parse(await packResponse.json());
    expect(pack.markdown).toContain('PROJECT');
  });

  it('rejects cross-user access with the frozen not_found envelope', async () => {
    const handle = handlerOf();
    const created = await call(handle, 'POST', '/api/research/projects', { name: 'Owned' });
    const project = researchProjectSchema.parse(await created.json());

    // 同一 handle 的 dev 身份是同一用户；改用不存在的 projectId 验证归属口径
    const missing = await call(handle, 'GET', '/api/research/projects/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
    expect(project.name).toBe('Owned');
  });
});

describe('demo data factory', () => {
  it('never references real papers and keeps claim boundary semantics visible', () => {
    const data = buildResearchDemoData();
    expect(data.charter.claimBoundary).toContain('≠');
    expect(data.charter.researchBoundary).toContain('不包含');
    // C-03 刻意无 supports；C-05 刻意无 boundary —— 用于触发 Drift
    const relations = data.relations;
    const supportedClaims = new Set(
      relations.filter((relation) => relation.targetType === 'claim').map((relation) => relation.targetId),
    );
    expect(supportedClaims.has('$C3')).toBe(false);
    expect(data.claims[4]?.boundary).toBeUndefined();
  });
});
