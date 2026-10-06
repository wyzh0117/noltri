/**
 * Research Map and Context Pack against the in-memory double (contract §5: R07).
 *
 * The pure builders (`map.ts` / `context-pack.ts`) are exercised through the façade: the domain
 * gathers the snapshot, `map` marks supported claims and keeps only map edges, and the pack emits the
 * twelve §5 blocks in order with `generatedAt` stamped by this layer.
 */
import { describe, expect, it } from 'vitest';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import { FakeResearchRepository } from './research-fakes';

const USER = 'user-1';

function harness(): ResearchDomain {
  return createResearchDomain(new FakeResearchRepository());
}

async function seededProject(domain: ResearchDomain, name = '碳定价研究'): Promise<string> {
  const project = await domain.createProject(USER, { name });
  return project.id;
}

describe('research map', () => {
  it('aggregates layers, marks supported claims and keeps only map edges', async () => {
    const domain = harness();
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

  it('answers not_found for a project that is not the caller\'s', async () => {
    const domain = harness();
    const projectId = await seededProject(domain);
    await expect(domain.buildMap(projectId, 'user-2')).rejects.toMatchObject({ code: 'not_found' });
    await expect(domain.buildContextPack(projectId, 'user-2')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('research context pack', () => {
  it('emits the twelve §5 blocks in order with the documented content', async () => {
    const domain = harness();
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
