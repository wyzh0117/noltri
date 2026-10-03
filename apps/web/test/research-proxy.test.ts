/**
 * Research proxy integration tests: the real /api/web/research/* route handlers are imported as plain
 * exported functions and driven against a local fake Knowledge Core on an ephemeral port. No Next.js
 * runtime, no real backend. Coverage mirrors the research contract §1: every main research proxy,
 * local schema validation, and the frozen error envelope.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as projectsRoute, POST as createProjectRoute } from '../app/api/web/research/projects/route';
import {
  GET as projectRoute,
  PATCH as patchProjectRoute,
} from '../app/api/web/research/projects/[projectId]/route';
import {
  GET as charterRoute,
  PUT as putCharterRoute,
} from '../app/api/web/research/projects/[projectId]/charter/route';
import {
  GET as questionsRoute,
  POST as createQuestionRoute,
} from '../app/api/web/research/projects/[projectId]/questions/route';
import { PATCH as patchQuestionRoute } from '../app/api/web/research/questions/[questionId]/route';
import {
  GET as evidenceRoute,
  POST as createEvidenceRoute,
} from '../app/api/web/research/projects/[projectId]/evidence/route';
import { PATCH as patchEvidenceRoute } from '../app/api/web/research/evidence/[evidenceId]/route';
import {
  GET as claimsRoute,
  POST as createClaimRoute,
} from '../app/api/web/research/projects/[projectId]/claims/route';
import { PATCH as patchClaimRoute } from '../app/api/web/research/claims/[claimId]/route';
import {
  GET as sectionsRoute,
  POST as createSectionRoute,
} from '../app/api/web/research/projects/[projectId]/sections/route';
import { PATCH as patchSectionRoute } from '../app/api/web/research/sections/[sectionId]/route';
import {
  GET as relationsRoute,
  POST as createRelationRoute,
} from '../app/api/web/research/projects/[projectId]/relations/route';
import { DELETE as deleteRelationRoute } from '../app/api/web/research/relations/[relationId]/route';
import {
  GET as decisionsRoute,
  POST as createDecisionRoute,
} from '../app/api/web/research/projects/[projectId]/decisions/route';
import {
  GET as changesRoute,
  POST as createChangeRoute,
} from '../app/api/web/research/projects/[projectId]/changes/route';
import {
  GET as timelineRoute,
  POST as createTimelineEventRoute,
} from '../app/api/web/research/projects/[projectId]/timeline/route';
import { POST as driftCheckRoute } from '../app/api/web/research/projects/[projectId]/drift-check/route';
import { GET as driftFindingsRoute } from '../app/api/web/research/projects/[projectId]/drift-findings/route';
import { PATCH as patchDriftFindingRoute } from '../app/api/web/research/drift-findings/[findingId]/route';
import { GET as mapRoute } from '../app/api/web/research/projects/[projectId]/map/route';
import { GET as contextPackRoute } from '../app/api/web/research/projects/[projectId]/context-pack/route';
import { startFakeResearchCore, type FakeResearchCoreHandle } from './fake-research-core';
import type {
  CharterResponse,
  ClaimListResponse,
  Claim,
  DeleteRelationResponse,
  DriftCheckResponse,
  DriftFinding,
  DriftFindingListResponse,
  EntityRelation,
  EvidenceListResponse,
  Evidence,
  ResearchChange,
  ResearchChangeListResponse,
  ResearchCharter,
  ResearchContextPackResponse,
  ResearchDecision,
  ResearchDecisionListResponse,
  ResearchMapResponse,
  ResearchProject,
  ResearchProjectListResponse,
  ResearchQuestion,
  ResearchQuestionListResponse,
  SectionListResponse,
  TimelineEvent,
  TimelineListResponse,
} from '@noltri/schema';
import { serializeSessionValue } from '../lib/cookie';

const TOKEN = 'test-token';

let core: FakeResearchCoreHandle;

function sessionCookie(token = TOKEN): string {
  return `noltri_session=${encodeURIComponent(serializeSessionValue({ strategy: 'dev-token', token }))}`;
}

function authorized(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set('cookie', sessionCookie());
  return new Request(`http://web.local${path}`, { ...init, headers });
}

function unauthenticated(path: string, init: RequestInit = {}): Request {
  return new Request(`http://web.local${path}`, init);
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

async function readEnvelope(response: Response): Promise<{ code?: string; message?: string }> {
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  return payload.error ?? {};
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

before(async () => {
  core = await startFakeResearchCore();
  process.env.KNOWLEDGE_API_URL = core.baseUrl;
});

after(async () => {
  await core.close();
});

test('projects: 401 envelope without a session cookie', async () => {
  const response = await projectsRoute(unauthenticated('/api/web/research/projects'));
  assert.equal(response.status, 401);
  assert.equal((await readEnvelope(response)).code, 'unauthorized');
});

test('projects: list forwards the bearer and returns the demo fixture', async () => {
  const response = await projectsRoute(authorized('/api/web/research/projects'));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ResearchProjectListResponse;
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ['Noltri Research Demo', '空白研究项目'],
  );
  assert.equal(core.lastAuthorization(), `Bearer ${TOKEN}`);
});

test('projects: create validates locally and reaches the core', async () => {
  const response = await createProjectRoute(authorized('/api/web/research/projects', jsonInit({ name: '代理测试项目' })));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ResearchProject;
  assert.equal(payload.name, '代理测试项目');
  assert.equal(payload.status, 'active');
});

test('projects: an empty name never reaches the core', async () => {
  const response = await createProjectRoute(authorized('/api/web/research/projects', jsonInit({ name: '' })));
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('project: an unknown project becomes the not_found envelope', async () => {
  const response = await projectRoute(authorized('/api/web/research/projects/nope'), ctx({ projectId: 'nope' }));
  assert.equal(response.status, 404);
  assert.equal((await readEnvelope(response)).code, 'not_found');
});

test('project: patch status round-trips through the core', async () => {
  const response = await patchProjectRoute(
    authorized('/api/web/research/projects/proj-empty', jsonInit({ status: 'archived' }, 'PATCH')),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as ResearchProject).status, 'archived');
});

test('charter: an empty project answers { charter: null }', async () => {
  const response = await charterRoute(authorized('/api/web/research/projects/proj-empty/charter'), ctx({ projectId: 'proj-empty' }));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as CharterResponse).charter, null);
});

test('charter: PUT creates it and GET returns the full §10 field set', async () => {
  const put = await putCharterRoute(
    authorized(
      '/api/web/research/projects/proj-empty/charter',
      jsonInit(
        {
          workingTitle: '代理层 Charter 测试',
          researchTopic: '测试主题',
          researchProblem: '问题',
          researchGap: '缺口',
          researchQuestionsText: 'RQ1 …',
          coreContribution: '一个可测试的贡献',
          theoreticalLens: '理论',
          researchContext: '情境',
          unitOfAnalysis: '单元',
          researchMethod: 'ISM',
          targetArticleType: '实证研究',
          targetJournal: 'IJPR',
          researchBoundary: '边界',
          claimBoundary: '主张边界',
          currentStage: '问题界定',
        },
        'PUT',
      ),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(put.status, 200);
  const charter = (await put.json()) as ResearchCharter;
  assert.equal(charter.workingTitle, '代理层 Charter 测试');
  assert.equal(charter.claimBoundary, '主张边界');

  const get = await charterRoute(authorized('/api/web/research/projects/proj-empty/charter'), ctx({ projectId: 'proj-empty' }));
  assert.equal(((await get.json()) as CharterResponse).charter?.currentStage, '问题界定');
});

test('charter: a body without workingTitle is rejected locally', async () => {
  const response = await putCharterRoute(
    authorized('/api/web/research/projects/proj-empty/charter', jsonInit({ researchTopic: '只有主题' }, 'PUT')),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('questions: list shows the RQ1 / RQ2 fixtures', async () => {
  const response = await questionsRoute(authorized('/api/web/research/projects/proj-demo/questions'), ctx({ projectId: 'proj-demo' }));
  const payload = (await response.json()) as ResearchQuestionListResponse;
  assert.deepEqual(
    payload.questions.map((question) => question.questionCode),
    ['RQ1', 'RQ2'],
  );
});

test('questions: create then patch status on the new question', async () => {
  const created = await createQuestionRoute(
    authorized(
      '/api/web/research/projects/proj-empty/questions',
      jsonInit({ questionCode: 'RQ1', questionText: '代理层能否正确转发研究问题？' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(created.status, 200);
  const question = (await created.json()) as ResearchQuestion;

  const patched = await patchQuestionRoute(
    authorized(`/api/web/research/questions/${question.id}`, jsonInit({ status: 'answered' }, 'PATCH')),
    ctx({ questionId: question.id }),
  );
  assert.equal(((await patched.json()) as ResearchQuestion).status, 'answered');
});

test('questions: patching a missing question is not_found', async () => {
  const response = await patchQuestionRoute(
    authorized('/api/web/research/questions/ghost', jsonInit({ status: 'dropped' }, 'PATCH')),
    ctx({ questionId: 'ghost' }),
  );
  assert.equal(response.status, 404);
  assert.equal((await readEnvelope(response)).code, 'not_found');
});

test('evidence: create and filter by type', async () => {
  const created = await createEvidenceRoute(
    authorized(
      '/api/web/research/projects/proj-empty/evidence',
      jsonInit({ type: 'interview', title: '冷链企业访谈', description: '为什么与本研究有关。' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as Evidence).type, 'interview');

  const filtered = await evidenceRoute(
    authorized('/api/web/research/projects/proj-empty/evidence?type=interview'),
    ctx({ projectId: 'proj-empty' }),
  );
  const payload = (await filtered.json()) as EvidenceListResponse;
  assert.ok(payload.evidence.every((entry) => entry.type === 'interview'));
  assert.ok(payload.evidence.length >= 1);
});

test('evidence: an unknown type filter is invalid_request', async () => {
  const response = await evidenceRoute(
    authorized('/api/web/research/projects/proj-empty/evidence?type=谣言'),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('evidence: patch updates title in place', async () => {
  const response = await patchEvidenceRoute(
    authorized('/api/web/research/evidence/ev-1', jsonInit({ title: '德尔菲专家评分（第 2 轮）' }, 'PATCH')),
    ctx({ evidenceId: 'ev-1' }),
  );
  assert.equal(((await response.json()) as Evidence).title, '德尔菲专家评分（第 2 轮）');
});

test('claims: create with confidence, then patch status', async () => {
  const created = await createClaimRoute(
    authorized(
      '/api/web/research/projects/proj-empty/claims',
      jsonInit({ claimCode: 'C-001', claimText: '代理层正确转发主张。', claimType: 'empirical', confidence: 0.6, boundary: '仅限测试范围。' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(created.status, 200);
  const claim = (await created.json()) as Claim;
  assert.equal(claim.confidence, 0.6);

  const patched = await patchClaimRoute(
    authorized(`/api/web/research/claims/${claim.id}`, jsonInit({ status: 'confirmed' }, 'PATCH')),
    ctx({ claimId: claim.id }),
  );
  assert.equal(((await patched.json()) as Claim).status, 'confirmed');
});

test('claims: an invalid confidence is rejected locally', async () => {
  const response = await createClaimRoute(
    authorized(
      '/api/web/research/projects/proj-empty/claims',
      jsonInit({ claimCode: 'C-002', claimText: '越界置信度。', claimType: 'empirical', confidence: 3 }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 400);
});

test('sections: create, patch sortOrder and read back', async () => {
  const created = await createSectionRoute(
    authorized('/api/web/research/projects/proj-empty/sections', jsonInit({ sectionName: 'Introduction', sectionReference: '1' })),
    ctx({ projectId: 'proj-empty' }),
  );
  const section = (await created.json()) as { id: string; sortOrder: number };

  const patched = await patchSectionRoute(
    authorized(`/api/web/research/sections/${section.id}`, jsonInit({ sortOrder: 9 }, 'PATCH')),
    ctx({ sectionId: section.id }),
  );
  assert.equal(((await patched.json()) as { sortOrder: number }).sortOrder, 9);

  const list = await sectionsRoute(authorized('/api/web/research/projects/proj-empty/sections'), ctx({ projectId: 'proj-empty' }));
  assert.equal(((await list.json()) as SectionListResponse).sections.length, 1);
});

test('relations: supports create, idempotent duplicate, then delete', async () => {
  const evidenceList = (await (
    await evidenceRoute(authorized('/api/web/research/projects/proj-empty/evidence'), ctx({ projectId: 'proj-empty' }))
  ).json()) as EvidenceListResponse;
  const claimList = (await (
    await claimsRoute(authorized('/api/web/research/projects/proj-empty/claims'), ctx({ projectId: 'proj-empty' }))
  ).json()) as ClaimListResponse;
  const evidenceId = evidenceList.evidence[0]?.id ?? '';
  const claimId = claimList.claims[0]?.id ?? '';

  const body = { sourceType: 'evidence', sourceId: evidenceId, relationType: 'supports', targetType: 'claim', targetId: claimId };
  const first = await createRelationRoute(
    authorized('/api/web/research/projects/proj-empty/relations', jsonInit(body)),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(first.status, 200);
  const relation = (await first.json()) as EntityRelation;
  assert.equal(relation.relationType, 'supports');

  const duplicate = await createRelationRoute(
    authorized('/api/web/research/projects/proj-empty/relations', jsonInit(body)),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(((await duplicate.json()) as EntityRelation).id, relation.id);

  const removed = await deleteRelationRoute(
    authorized(`/api/web/research/relations/${relation.id}`, { method: 'DELETE' }),
    ctx({ relationId: relation.id }),
  );
  assert.deepEqual((await removed.json()) as DeleteRelationResponse, { deleted: true, id: relation.id });

  const again = await deleteRelationRoute(
    authorized(`/api/web/research/relations/${relation.id}`, { method: 'DELETE' }),
    ctx({ relationId: relation.id }),
  );
  assert.equal(again.status, 404);
});

test('relations: a missing endpoint is invalid_request', async () => {
  const response = await createRelationRoute(
    authorized(
      '/api/web/research/projects/proj-empty/relations',
      jsonInit({ sourceType: 'evidence', sourceId: 'ghost', relationType: 'supports', targetType: 'claim', targetId: 'cl-1' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readEnvelope(response)).code, 'invalid_request');
});

test('relations: query filters narrow the list', async () => {
  const response = await relationsRoute(
    authorized('/api/web/research/projects/proj-demo/relations?relationType=answers'),
    ctx({ projectId: 'proj-demo' }),
  );
  const payload = (await response.json()) as { relations: EntityRelation[] };
  assert.ok(payload.relations.length > 0);
  assert.ok(payload.relations.every((relation) => relation.relationType === 'answers'));
});

test('decisions: append-only create also lands on the timeline', async () => {
  const before = (await (
    await timelineRoute(authorized('/api/web/research/projects/proj-empty/timeline'), ctx({ projectId: 'proj-empty' }))
  ).json()) as TimelineListResponse;

  const created = await createDecisionRoute(
    authorized(
      '/api/web/research/projects/proj-empty/decisions',
      jsonInit({ title: '采用 ISM', decision: '保留结构建模。', reason: '样本不足。' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(created.status, 200);
  const decision = (await created.json()) as ResearchDecision;

  const after = (await (
    await timelineRoute(authorized('/api/web/research/projects/proj-empty/timeline'), ctx({ projectId: 'proj-empty' }))
  ).json()) as TimelineListResponse;
  assert.equal(after.events.length, before.events.length + 1);
  const event = after.events.find((entry) => entry.sourceId === decision.id);
  assert.equal(event?.eventType, 'decision');
});

test('decisions: no update route exists — only POST/GET on the collection', async () => {
  const response = await decisionsRoute(authorized('/api/web/research/projects/proj-demo/decisions'), ctx({ projectId: 'proj-demo' }));
  const payload = (await response.json()) as ResearchDecisionListResponse;
  assert.equal(payload.decisions.length, 2);
});

test('changes: create with changeType and filter by it', async () => {
  const created = await createChangeRoute(
    authorized(
      '/api/web/research/projects/proj-empty/changes',
      jsonInit({ changeType: 'method', before: '仅 ISM', after: 'ISM + ANP', reason: '需要权重。' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as ResearchChange).changeType, 'method');

  const filtered = await changesRoute(
    authorized('/api/web/research/projects/proj-empty/changes?changeType=method'),
    ctx({ projectId: 'proj-empty' }),
  );
  const payload = (await filtered.json()) as ResearchChangeListResponse;
  assert.ok(payload.changes.length >= 1);
  assert.ok(payload.changes.every((entry) => entry.changeType === 'method'));
});

test('timeline: milestone POST plus descending order on GET', async () => {
  const created = await createTimelineEventRoute(
    authorized(
      '/api/web/research/projects/proj-empty/timeline',
      jsonInit({ occurredAt: '2026-12-31T00:00:00.000Z', title: '投稿 V1', summary: '完成投稿包。' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  const event = (await created.json()) as TimelineEvent;
  assert.equal(event.eventType, 'milestone');
  assert.equal(event.sourceType, 'manual');

  const list = (await (
    await timelineRoute(authorized('/api/web/research/projects/proj-empty/timeline'), ctx({ projectId: 'proj-empty' }))
  ).json()) as TimelineListResponse;
  const times = list.events.map((entry) => entry.occurredAt);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal(list.events[0]?.id, event.id);
});

test('drift-check: runs rules, returns findings with summary and dedupes', async () => {
  const response = await driftCheckRoute(
    authorized('/api/web/research/projects/proj-empty/drift-check', jsonInit({})),
    ctx({ projectId: 'proj-empty' }),
  );
  assert.equal(response.status, 200);
  const first = (await response.json()) as DriftCheckResponse;
  assert.ok(first.summary.total >= 1);
  assert.equal(first.summary.total, first.findings.length);
  assert.ok(first.findings.some((finding) => finding.driftType === 'evidence_drift'));

  const second = (await driftCheckRoute(
    authorized('/api/web/research/projects/proj-empty/drift-check', jsonInit({})),
    ctx({ projectId: 'proj-empty' }),
  ).then((res) => res.json())) as DriftCheckResponse;
  assert.equal(second.summary.total, first.summary.total);
});

test('drift-check: manuscript text enables the RQ drift rule', async () => {
  const response = await driftCheckRoute(
    authorized(
      '/api/web/research/projects/proj-empty/drift-check',
      jsonInit({ manuscriptText: 'Robustness across industries remains an open question?' }),
    ),
    ctx({ projectId: 'proj-empty' }),
  );
  const payload = (await response.json()) as DriftCheckResponse;
  assert.ok(payload.findings.some((finding) => finding.driftType === 'rq_drift'));
});

test('drift-findings: patch status and filter by status', async () => {
  const list = (await (
    await driftFindingsRoute(authorized('/api/web/research/projects/proj-empty/drift-findings'), ctx({ projectId: 'proj-empty' }))
  ).json()) as DriftFindingListResponse;
  const target = list.findings[0] as DriftFinding;

  const patched = await patchDriftFindingRoute(
    authorized(`/api/web/research/drift-findings/${target.id}`, jsonInit({ status: 'acknowledged' }, 'PATCH')),
    ctx({ findingId: target.id }),
  );
  assert.equal(((await patched.json()) as DriftFinding).status, 'acknowledged');

  const filtered = await driftFindingsRoute(
    authorized('/api/web/research/projects/proj-empty/drift-findings?status=acknowledged'),
    ctx({ projectId: 'proj-empty' }),
  );
  const payload = (await filtered.json()) as DriftFindingListResponse;
  assert.ok(payload.findings.length >= 1);
  assert.ok(payload.findings.every((finding) => finding.status === 'acknowledged'));
});

test('map: layered response marks unsupported claims', async () => {
  const response = await mapRoute(authorized('/api/web/research/projects/proj-demo/map'), ctx({ projectId: 'proj-demo' }));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ResearchMapResponse;
  assert.equal(payload.project.name, 'Noltri Research Demo');
  assert.equal(payload.questions.length, 2);
  assert.equal(payload.evidence.length, 5);
  assert.equal(payload.claims.length, 5);
  assert.equal(payload.sections.length, 2);
  assert.deepEqual(payload.unsupportedClaimIds, ['cl-5']);
  assert.ok(payload.edges.every((edge) => edge.sourceType !== 'research_project'));
});

test('map: 401 without a session', async () => {
  const response = await mapRoute(unauthenticated('/api/web/research/projects/proj-demo/map'), ctx({ projectId: 'proj-demo' }));
  assert.equal(response.status, 401);
});

test('context-pack: markdown plus ordered blocks come back together', async () => {
  const response = await contextPackRoute(
    authorized('/api/web/research/projects/proj-demo/context-pack'),
    ctx({ projectId: 'proj-demo' }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ResearchContextPackResponse;
  assert.equal(payload.blocks.length, 12);
  assert.equal(payload.blocks[0]?.heading, 'PROJECT');
  assert.ok(payload.markdown.includes('## Core Contribution'));
  assert.ok(payload.markdown.includes('ISM + ANP'));
  assert.ok(payload.generatedAt.length > 0);
});
