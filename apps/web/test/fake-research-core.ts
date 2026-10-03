/**
 * Local fake Knowledge Core for the Research Domain integration tests (research doc §9–§33).
 *
 * Same contract-only philosophy as `fake-core.ts`: this server re-implements `/api/research/*` from
 * the frozen HTTP contract with shared schema types (compile-time) and shared Zod schemas
 * (runtime). Fixtures follow the §36 demo project (RQ1/RQ2, 5 evidence, 5 claims, 2 decisions,
 * 2 changes) plus one empty project for empty-state routes. No real backend is involved.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  charterRequestSchema,
  changeListQuerySchema,
  charterResponseSchema,
  claimListQuerySchema,
  claimListResponseSchema,
  claimSchema,
  createClaimRequestSchema,
  createEntityRelationRequestSchema,
  createEvidenceRequestSchema,
  createResearchChangeRequestSchema,
  createResearchDecisionRequestSchema,
  createResearchProjectRequestSchema,
  createResearchQuestionRequestSchema,
  createSectionRequestSchema,
  createTimelineEventRequestSchema,
  deleteRelationResponseSchema,
  driftCheckRequestSchema,
  driftCheckResponseSchema,
  driftFindingListQuerySchema,
  driftFindingListResponseSchema,
  driftFindingSchema,
  entityRelationSchema,
  evidenceListQuerySchema,
  evidenceListResponseSchema,
  evidenceSchema,
  manuscriptSectionSchema,
  patchClaimRequestSchema,
  patchDriftFindingRequestSchema,
  patchEvidenceRequestSchema,
  patchResearchProjectRequestSchema,
  patchResearchQuestionRequestSchema,
  patchSectionRequestSchema,
  relationListResponseSchema,
  researchChangeListResponseSchema,
  researchChangeSchema,
  researchCharterSchema,
  researchContextPackResponseSchema,
  researchDecisionListResponseSchema,
  researchDecisionSchema,
  researchMapResponseSchema,
  researchProjectListResponseSchema,
  researchProjectSchema,
  researchQuestionListResponseSchema,
  researchQuestionSchema,
  sectionListResponseSchema,
  timelineEventSchema,
  timelineListResponseSchema,
  type CharterRequest,
  type Claim,
  type ClaimListQuery,
  type CreateClaimRequest,
  type CreateEntityRelationRequest,
  type CreateEvidenceRequest,
  type CreateResearchChangeRequest,
  type CreateResearchDecisionRequest,
  type CreateResearchProjectRequest,
  type CreateResearchQuestionRequest,
  type CreateSectionRequest,
  type CreateTimelineEventRequest,
  type DriftCheckRequest,
  type DriftFinding,
  type DriftFindingListQuery,
  type EntityRelation,
  type Evidence,
  type EvidenceListQuery,
  type ManuscriptSection,
  type PatchClaimRequest,
  type PatchDriftFindingRequest,
  type PatchEvidenceRequest,
  type PatchResearchProjectRequest,
  type PatchResearchQuestionRequest,
  type PatchSectionRequest,
  type ResearchChange,
  type ResearchChangeType,
  type ResearchCharter,
  type ResearchDecision,
  type ResearchEntityType,
  type ResearchProject,
  type ResearchQuestion,
  type ResearchRelationType,
  type TimelineEvent,
} from '@noltri/schema';
import { ApiClientError } from '@noltri/api-client';
import { nowIso } from '@noltri/shared';

const USER_ID = 'fake-user';
const FIXED_ISO = '2026-10-01T08:00:00.000Z';
const MAP_RELATIONS: readonly ResearchRelationType[] = [
  'supports',
  'partially_supports',
  'contradicts',
  'qualifies',
  'contextualizes',
  'answers',
  'appears_in',
];

export interface FakeResearchCoreHandle {
  baseUrl: string;
  /** Authorization header of the most recent request, for proxy forwarding assertions. */
  lastAuthorization(): string | null;
  close(): Promise<void>;
}

export interface FakeResearchCoreOptions {
  /** When set, requests without this bearer token are rejected with 401 unauthorized. */
  requiredToken?: string;
}

interface ResearchState {
  projects: ResearchProject[];
  charters: Map<string, ResearchCharter>;
  questions: ResearchQuestion[];
  evidence: Evidence[];
  claims: Claim[];
  sections: ManuscriptSection[];
  relations: EntityRelation[];
  decisions: ResearchDecision[];
  changes: ResearchChange[];
  findings: DriftFinding[];
  timeline: TimelineEvent[];
  nextId: number;
}

/** §36 demo project plus one empty project, so empty-state routes have real answers. */
export function createResearchFixtures(): ResearchState {
  const iso = (offsetMinutes: number): string =>
    new Date(Date.parse(FIXED_ISO) + offsetMinutes * 60_000).toISOString();

  const state: ResearchState = {
    projects: [
      {
        id: 'proj-demo',
        userId: USER_ID,
        name: 'Noltri Research Demo',
        description: '冷链物流服务质量因素的结构关系研究。',
        status: 'active',
        createdAt: iso(0),
        updatedAt: iso(0),
      },
      {
        id: 'proj-empty',
        userId: USER_ID,
        name: '空白研究项目',
        description: null,
        status: 'active',
        createdAt: iso(1),
        updatedAt: iso(1),
      },
    ],
    charters: new Map(),
    questions: [],
    evidence: [],
    claims: [],
    sections: [],
    relations: [],
    decisions: [],
    changes: [],
    findings: [],
    timeline: [],
    // Above every seeded fixture id (rel-1…rel-9), so generated ids can never shadow them.
    nextId: 1000,
  };

  state.charters.set('proj-demo', {
    id: 'charter-demo',
    projectId: 'proj-demo',
    userId: USER_ID,
    workingTitle: '冷链物流服务质量因素的结构关系研究',
    researchTopic: '冷链物流服务质量因素',
    researchProblem: '服务质量因素之间的结构关系尚不清晰',
    researchGap: '缺少面向冷链的结构模型',
    researchQuestionsText: 'RQ1 服务质量因素如何组织？RQ2 哪些因素处于较高层级？',
    coreContribution: '提出面向冷链服务质量的 ISM 结构模型',
    theoreticalLens: '服务质量理论',
    researchContext: '冷链物流企业',
    unitOfAnalysis: '服务质量因素',
    researchMethod: 'ISM + ANP',
    targetArticleType: '实证研究',
    targetJournal: 'IJPR',
    researchBoundary: '研究因素之间的结构关系；不包含统计意义上的因果推断。',
    claimBoundary: 'ISM 关系 ≠ 统计因果；ANP 权重 ≠ 经济价值。',
    currentStage: '方法定稿',
    createdAt: iso(2),
    updatedAt: iso(3),
  });

  const question = (
    id: string,
    code: string,
    text: string,
    status: ResearchQuestion['status'],
    offset: number,
  ): ResearchQuestion => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    questionCode: code,
    questionText: text,
    status,
    rationale: null,
    relatedMethod: 'ISM 建模',
    createdAt: iso(offset),
    updatedAt: iso(offset),
  });
  state.questions.push(
    question('rq-1', 'RQ1', '服务质量因素如何结构化组织？', 'open', 4),
    question('rq-2', 'RQ2', '哪些因素处于较高层级？', 'answered', 5),
  );

  const evidence = (id: string, type: Evidence['type'], title: string, offset: number): Evidence => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    type,
    title,
    description: `${title} 与本研究的关联说明。`,
    sourceReference: '来源引用',
    sourceLocation: null,
    reliabilityNote: null,
    createdAt: iso(offset),
    updatedAt: iso(offset),
  });
  state.evidence.push(
    evidence('ev-1', 'expert_judgement', '德尔菲专家评分', 6),
    evidence('ev-2', 'literature', '供应链服务质量综述', 7),
    evidence('ev-3', 'dataset', '冷链企业问卷数据', 8),
    evidence('ev-4', 'analysis_result', 'ISM 层级分解结果', 9),
    evidence('ev-5', 'note', '研究日志：鲁棒性检查', 10),
  );

  const claim = (
    id: string,
    code: string,
    text: string,
    type: Claim['claimType'],
    status: Claim['status'],
    offset: number,
  ): Claim => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    claimCode: code,
    claimText: text,
    claimType: type,
    status,
    confidence: 0.7,
    boundary: '结构层级 ≠ 统计因果',
    createdAt: iso(offset),
    updatedAt: iso(offset),
  });
  state.claims.push(
    claim('cl-1', 'C-021', '可靠性相关因素处于 ISM 模型的较高结构层级。', 'empirical', 'confirmed', 11),
    claim('cl-2', 'C-022', 'ANP 权重反映目标依赖的相对优先级。', 'interpretive', 'proposed', 12),
    claim('cl-3', 'C-023', '柔性因素对服务质量有显著因果影响。', 'empirical', 'draft', 13),
    claim('cl-4', 'C-024', '研究方法采用 ISM + ANP 两阶段建模。', 'methodological', 'confirmed', 14),
    // cl-5 has no supporting relation on purpose: the map must show it as dangling.
    claim('cl-5', 'C-025', '冷链鲁棒性结论可外推到其他行业。', 'contribution', 'draft', 15),
  );

  const section = (id: string, name: string, reference: string | null, order: number, offset: number): ManuscriptSection => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    sectionName: name,
    sectionReference: reference,
    sortOrder: order,
    createdAt: iso(offset),
    updatedAt: iso(offset),
  });
  state.sections.push(section('sec-1', 'Results', '4.2', 2, 16), section('sec-2', 'Discussion', '5.1', 3, 17));

  const relation = (
    id: string,
    sourceType: ResearchEntityType,
    sourceId: string,
    relationType: ResearchRelationType,
    targetType: ResearchEntityType,
    targetId: string,
    offset: number,
  ): EntityRelation => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    sourceType,
    sourceId,
    relationType,
    targetType,
    targetId,
    note: null,
    createdAt: iso(offset),
  });
  state.relations.push(
    relation('rel-1', 'evidence', 'ev-1', 'supports', 'claim', 'cl-1', 18),
    relation('rel-2', 'evidence', 'ev-2', 'partially_supports', 'claim', 'cl-1', 19),
    relation('rel-3', 'evidence', 'ev-3', 'supports', 'claim', 'cl-2', 20),
    relation('rel-4', 'evidence', 'ev-4', 'contradicts', 'claim', 'cl-3', 21),
    relation('rel-5', 'claim', 'cl-1', 'answers', 'research_question', 'rq-1', 22),
    relation('rel-6', 'claim', 'cl-2', 'answers', 'research_question', 'rq-2', 23),
    relation('rel-7', 'claim', 'cl-1', 'appears_in', 'manuscript_section', 'sec-1', 24),
    relation('rel-8', 'evidence', 'ev-3', 'partially_supports', 'claim', 'cl-3', 26),
    relation('rel-9', 'evidence', 'ev-5', 'supports', 'claim', 'cl-4', 27),
  );

  const decision = (id: string, title: string, decision: string, offset: number): ResearchDecision => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    title,
    decision,
    reason: '样本量不足以支撑统计因果推断。',
    alternatives: null,
    rejectedAlternatives: null,
    impact: null,
    relatedEntities: { claim: 'C-021' },
    createdAt: iso(offset),
  });
  state.decisions.push(
    decision('dec-1', '采用 ISM + ANP', '保留两阶段结构建模。', 25),
    decision('dec-2', '删除 Hypothesis 3', '证据不足以支撑该假设。', 35),
  );

  const change = (id: string, changeType: ResearchChangeType, before: string, after: string, offset: number): ResearchChange => ({
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    changeType,
    before,
    after,
    reason: 'ANP 输出是目标依赖的相对权重。',
    impact: 'Introduction / Method',
    relatedEntities: { rq: 'RQ2' },
    createdAt: iso(offset),
  });
  state.changes.push(
    change('chg-1', 'research_question', 'RQ2 关注整体重要性', 'RQ2 关注目标依赖的决策优先级', 45),
    change('chg-2', 'journal', '目标期刊 A', '目标期刊 B', 55),
  );

  state.findings.push({
    id: 'df-1',
    projectId: 'proj-demo',
    userId: USER_ID,
    driftType: 'evidence_drift',
    severity: 'warning',
    description: 'Claim C-023 缺少支持证据。',
    sourceEntityType: 'claim',
    sourceEntityId: 'cl-3',
    targetEntityType: null,
    targetEntityId: null,
    reason: null,
    recommendedAction: '补充 Evidence、弱化 Claim 或改为 Future Research。',
    status: 'open',
    createdAt: iso(60),
    updatedAt: iso(60),
  });
  state.findings.push({
    id: 'df-2',
    projectId: 'proj-demo',
    userId: USER_ID,
    driftType: 'journal_drift',
    severity: 'info',
    description: '目标期刊已变更，Charter 未同步。',
    sourceEntityType: 'research_change',
    sourceEntityId: 'chg-2',
    targetEntityType: 'research_charter',
    targetEntityId: 'charter-demo',
    reason: null,
    recommendedAction: '更新 Charter 的 Target Journal。',
    status: 'acknowledged',
    createdAt: iso(61),
    updatedAt: iso(61),
  });

  // Decisions and changes also land on the timeline (research doc §2); one manual milestone completes it.
  state.timeline.push(
    timelineOf('evt-dec-1', 'decision', 'dec-1', '采用 ISM + ANP', '保留两阶段结构建模。', 'research_decision', iso(25), iso(25)),
    timelineOf('evt-dec-2', 'decision', 'dec-2', '删除 Hypothesis 3', '证据不足以支撑该假设。', 'research_decision', iso(35), iso(35)),
    timelineOf('evt-chg-1', 'change', 'chg-1', 'RQ2 modified', 'RQ2 关注整体重要性 → RQ2 关注目标依赖的决策优先级', 'research_change', iso(45), iso(45)),
    timelineOf('evt-chg-2', 'change', 'chg-2', '目标期刊变更', '目标期刊 A → 目标期刊 B', 'research_change', iso(55), iso(55)),
    timelineOf('evt-ms-1', 'milestone', null, '投稿 V1', '完成第一版投稿包。', 'manual', iso(70), iso(70)),
  );

  return state;
}

function timelineOf(
  id: string,
  eventType: TimelineEvent['eventType'],
  sourceId: string | null,
  title: string,
  summary: string,
  sourceType: TimelineEvent['sourceType'],
  occurredAt: string,
  createdAt: string,
): TimelineEvent {
  return {
    id,
    projectId: 'proj-demo',
    userId: USER_ID,
    eventType,
    occurredAt,
    title,
    summary,
    sourceType,
    sourceId,
    relatedEntities: {},
    createdAt,
  };
}

export async function startFakeResearchCore(options: FakeResearchCoreOptions = {}): Promise<FakeResearchCoreHandle> {
  const state = createResearchFixtures();
  let lastAuthorization: string | null = null;

  const server: Server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      const failure =
        error instanceof ApiClientError
          ? { status: error.status, code: error.code, message: error.message }
          : { status: 500, code: 'internal_error', message: error instanceof Error ? error.message : 'fake core failed' };
      send(response, failure.status >= 400 ? failure.status : 500, {
        error: { code: failure.code, message: failure.message },
      });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake-research-core.local');
    const method = request.method ?? 'GET';
    lastAuthorization = request.headers.authorization ?? null;

    if (options.requiredToken !== undefined && options.requiredToken.length > 0) {
      if (lastAuthorization !== `Bearer ${options.requiredToken}`) {
        send(response, 401, { error: { code: 'unauthorized', message: 'Missing or wrong bearer token' } });
        return;
      }
    }

    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments[0] !== 'api' || segments[1] !== 'research') {
      send(response, 404, { error: { code: 'not_found', message: `No fake route for ${method} ${url.pathname}` } });
      return;
    }
    await routeResearch(request, response, url, method, segments.slice(2), state);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lastAuthorization: () => lastAuthorization,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function routeResearch(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  rest: string[],
  state: ResearchState,
): Promise<void> {
  if (rest[0] !== 'projects') {
    await routeLooseEntity(request, response, method, rest, state);
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendValid(response, researchProjectListResponseSchema, { projects: state.projects });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createResearchProjectRequestSchema)) as CreateResearchProjectRequest;
      const project: ResearchProject = {
        id: `rp-${state.nextId++}`,
        userId: USER_ID,
        name: body.name,
        description: body.description ?? null,
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.projects.push(project);
      sendValid(response, researchProjectSchema, project);
      return;
    }
  }

  const project = findProject(state, decodeURIComponent(rest[1] ?? ''));

  if (rest.length === 2) {
    if (method === 'GET') {
      sendValid(response, researchProjectSchema, project);
      return;
    }
    if (method === 'PATCH') {
      const body = (await parseBody(request, patchResearchProjectRequestSchema)) as PatchResearchProjectRequest;
      if (body.name !== undefined) project.name = body.name;
      if (body.description !== undefined) project.description = body.description;
      if (body.status !== undefined) project.status = body.status;
      project.updatedAt = nowIso();
      sendValid(response, researchProjectSchema, project);
      return;
    }
  }

  const scope = rest[2];

  if (scope === 'charter') {
    if (method === 'GET') {
      sendValid(response, charterResponseSchema, { charter: state.charters.get(project.id) ?? null });
      return;
    }
    if (method === 'PUT') {
      const body = (await parseBody(request, charterRequestSchema)) as CharterRequest;
      const existing = state.charters.get(project.id);
      const charter: ResearchCharter = {
        id: existing?.id ?? `charter-${project.id}`,
        projectId: project.id,
        userId: USER_ID,
        workingTitle: body.workingTitle,
        researchTopic: body.researchTopic ?? null,
        researchProblem: body.researchProblem ?? null,
        researchGap: body.researchGap ?? null,
        researchQuestionsText: body.researchQuestionsText ?? null,
        coreContribution: body.coreContribution ?? null,
        theoreticalLens: body.theoreticalLens ?? null,
        researchContext: body.researchContext ?? null,
        unitOfAnalysis: body.unitOfAnalysis ?? null,
        researchMethod: body.researchMethod ?? null,
        targetArticleType: body.targetArticleType ?? null,
        targetJournal: body.targetJournal ?? null,
        researchBoundary: body.researchBoundary ?? null,
        claimBoundary: body.claimBoundary ?? null,
        currentStage: body.currentStage ?? null,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      state.charters.set(project.id, charter);
      sendValid(response, researchCharterSchema, charter);
      return;
    }
  }

  if (scope === 'questions') {
    const questions = state.questions.filter((entry) => entry.projectId === project.id);
    if (method === 'GET') {
      sendValid(response, researchQuestionListResponseSchema, { questions });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createResearchQuestionRequestSchema)) as CreateResearchQuestionRequest;
      const created: ResearchQuestion = {
        id: `rq-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        questionCode: body.questionCode,
        questionText: body.questionText,
        status: 'open',
        rationale: body.rationale ?? null,
        relatedMethod: body.relatedMethod ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.questions.push(created);
      sendValid(response, researchQuestionSchema, created);
      return;
    }
  }

  if (scope === 'evidence') {
    const query: EvidenceListQuery = parseQuery(evidenceListQuerySchema, url, ['type']);
    const evidence = state.evidence.filter(
      (entry) => entry.projectId === project.id && (query.type === undefined || entry.type === query.type),
    );
    if (method === 'GET') {
      sendValid(response, evidenceListResponseSchema, { evidence });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createEvidenceRequestSchema)) as CreateEvidenceRequest;
      const created: Evidence = {
        id: `ev-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        type: body.type,
        title: body.title,
        description: body.description ?? null,
        sourceReference: body.sourceReference ?? null,
        sourceLocation: body.sourceLocation ?? null,
        reliabilityNote: body.reliabilityNote ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.evidence.push(created);
      sendValid(response, evidenceSchema, created);
      return;
    }
  }

  if (scope === 'claims') {
    const query: ClaimListQuery = parseQuery(claimListQuerySchema, url, ['status', 'claimType']);
    const claims = state.claims.filter(
      (entry) =>
        entry.projectId === project.id &&
        (query.status === undefined || entry.status === query.status) &&
        (query.claimType === undefined || entry.claimType === query.claimType),
    );
    if (method === 'GET') {
      sendValid(response, claimListResponseSchema, { claims });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createClaimRequestSchema)) as CreateClaimRequest;
      const created: Claim = {
        id: `cl-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        claimCode: body.claimCode,
        claimText: body.claimText,
        claimType: body.claimType,
        status: body.status ?? 'draft',
        confidence: body.confidence ?? 0.5,
        boundary: body.boundary ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.claims.push(created);
      sendValid(response, claimSchema, created);
      return;
    }
  }

  if (scope === 'sections') {
    const sections = state.sections.filter((entry) => entry.projectId === project.id);
    if (method === 'GET') {
      sendValid(response, sectionListResponseSchema, { sections });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createSectionRequestSchema)) as CreateSectionRequest;
      const created: ManuscriptSection = {
        id: `sec-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        sectionName: body.sectionName,
        sectionReference: body.sectionReference ?? null,
        sortOrder: body.sortOrder ?? sections.length + 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.sections.push(created);
      sendValid(response, manuscriptSectionSchema, created);
      return;
    }
  }

  if (scope === 'relations') {
    const relations = state.relations.filter(
      (entry) =>
        entry.projectId === project.id &&
        matchRelationFilter(entry, url, 'sourceType') &&
        matchRelationFilter(entry, url, 'sourceId') &&
        matchRelationFilter(entry, url, 'targetType') &&
        matchRelationFilter(entry, url, 'targetId') &&
        matchRelationFilter(entry, url, 'relationType'),
    );
    if (method === 'GET') {
      sendValid(response, relationListResponseSchema, { relations });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createEntityRelationRequestSchema)) as CreateEntityRelationRequest;
      // Contract §2: endpoints must exist in this project, and a duplicate tuple is idempotent.
      if (!entityExists(state, project.id, body.sourceType, body.sourceId)) {
        throw new ApiClientError(400, 'invalid_request', `Relation source ${body.sourceType}/${body.sourceId} does not exist`);
      }
      if (!entityExists(state, project.id, body.targetType, body.targetId)) {
        throw new ApiClientError(400, 'invalid_request', `Relation target ${body.targetType}/${body.targetId} does not exist`);
      }
      const duplicate = state.relations.find(
        (entry) =>
          entry.projectId === project.id &&
          entry.sourceType === body.sourceType &&
          entry.sourceId === body.sourceId &&
          entry.relationType === body.relationType &&
          entry.targetType === body.targetType &&
          entry.targetId === body.targetId,
      );
      if (duplicate !== undefined) {
        sendValid(response, entityRelationSchema, duplicate);
        return;
      }
      const created: EntityRelation = {
        id: `rel-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        relationType: body.relationType,
        targetType: body.targetType,
        targetId: body.targetId,
        note: body.note ?? null,
        createdAt: nowIso(),
      };
      state.relations.push(created);
      sendValid(response, entityRelationSchema, created);
      return;
    }
  }

  if (scope === 'decisions') {
    const decisions = state.decisions.filter((entry) => entry.projectId === project.id);
    if (method === 'GET') {
      sendValid(response, researchDecisionListResponseSchema, { decisions });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createResearchDecisionRequestSchema)) as CreateResearchDecisionRequest;
      const created: ResearchDecision = {
        id: `dec-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        title: body.title,
        decision: body.decision,
        reason: body.reason ?? null,
        alternatives: body.alternatives ?? null,
        rejectedAlternatives: body.rejectedAlternatives ?? null,
        impact: body.impact ?? null,
        relatedEntities: body.relatedEntities ?? {},
        createdAt: nowIso(),
      };
      state.decisions.push(created);
      state.timeline.push({
        id: `evt-${created.id}`,
        projectId: project.id,
        userId: USER_ID,
        eventType: 'decision',
        occurredAt: created.createdAt,
        title: created.title,
        summary: created.decision,
        sourceType: 'research_decision',
        sourceId: created.id,
        relatedEntities: created.relatedEntities,
        createdAt: created.createdAt,
      });
      sendValid(response, researchDecisionSchema, created);
      return;
    }
  }

  if (scope === 'changes') {
    const query = parseQuery(changeListQuerySchema, url, ['changeType']) as { changeType?: ResearchChangeType };
    const changes = state.changes.filter(
      (entry) => entry.projectId === project.id && (query.changeType === undefined || entry.changeType === query.changeType),
    );
    if (method === 'GET') {
      sendValid(response, researchChangeListResponseSchema, { changes });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createResearchChangeRequestSchema)) as CreateResearchChangeRequest;
      const created: ResearchChange = {
        id: `chg-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        changeType: body.changeType,
        before: body.before,
        after: body.after,
        reason: body.reason ?? null,
        impact: body.impact ?? null,
        relatedEntities: body.relatedEntities ?? {},
        createdAt: nowIso(),
      };
      state.changes.push(created);
      state.timeline.push({
        id: `evt-${created.id}`,
        projectId: project.id,
        userId: USER_ID,
        eventType: 'change',
        occurredAt: created.createdAt,
        title: '研究变更',
        summary: `${created.before} → ${created.after}`,
        sourceType: 'research_change',
        sourceId: created.id,
        relatedEntities: created.relatedEntities,
        createdAt: created.createdAt,
      });
      sendValid(response, researchChangeSchema, created);
      return;
    }
  }

  if (scope === 'timeline') {
    const events = state.timeline
      .filter((entry) => entry.projectId === project.id)
      .sort((first, second) => (first.occurredAt < second.occurredAt ? 1 : first.occurredAt > second.occurredAt ? -1 : 0));
    if (method === 'GET') {
      sendValid(response, timelineListResponseSchema, { events });
      return;
    }
    if (method === 'POST') {
      const body = (await parseBody(request, createTimelineEventRequestSchema)) as CreateTimelineEventRequest;
      const created: TimelineEvent = {
        id: `evt-ms-${state.nextId++}`,
        projectId: project.id,
        userId: USER_ID,
        eventType: 'milestone',
        occurredAt: body.occurredAt,
        title: body.title,
        summary: body.summary ?? null,
        sourceType: 'manual',
        sourceId: null,
        relatedEntities: body.relatedEntities ?? {},
        createdAt: nowIso(),
      };
      state.timeline.push(created);
      sendValid(response, timelineEventSchema, created);
      return;
    }
  }

  if (scope === 'drift-check' && method === 'POST') {
    const body = (await parseBody(request, driftCheckRequestSchema)) as DriftCheckRequest;
    runDriftCheck(project.id, body, state);
    sendValid(response, driftCheckResponseSchema, {
      findings: state.findings.filter((entry) => entry.projectId === project.id),
      summary: summarize(state.findings.filter((entry) => entry.projectId === project.id)),
    });
    return;
  }

  if (scope === 'drift-findings' && method === 'GET') {
    const query: DriftFindingListQuery = parseQuery(driftFindingListQuerySchema, url, ['status', 'driftType', 'severity']);
    const findings = state.findings.filter(
      (entry) =>
        entry.projectId === project.id &&
        (query.status === undefined || entry.status === query.status) &&
        (query.driftType === undefined || entry.driftType === query.driftType) &&
        (query.severity === undefined || entry.severity === query.severity),
    );
    sendValid(response, driftFindingListResponseSchema, { findings });
    return;
  }

  if (scope === 'map' && method === 'GET') {
    sendValid(response, researchMapResponseSchema, buildMap(project, state));
    return;
  }

  if (scope === 'context-pack' && method === 'GET') {
    sendValid(response, researchContextPackResponseSchema, buildContextPack(project, state));
    return;
  }

  send(response, 404, { error: { code: 'not_found', message: `No fake research route for ${method}` } });
}

/** Loose entity routes: questions/:id, evidence/:id, claims/:id, sections/:id, relations/:id, drift-findings/:id */
async function routeLooseEntity(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  rest: string[],
  state: ResearchState,
): Promise<void> {
  const [kind, rawId] = rest;
  const id = decodeURIComponent(rawId ?? '');

  if (kind === 'questions' && method === 'PATCH') {
    const body = (await parseBody(request, patchResearchQuestionRequestSchema)) as PatchResearchQuestionRequest;
    const target = state.questions.find((entry) => entry.id === id);
    if (target === undefined) throw new ApiClientError(404, 'not_found', `Question ${id} does not exist`);
    if (body.questionCode !== undefined) target.questionCode = body.questionCode;
    if (body.questionText !== undefined) target.questionText = body.questionText;
    if (body.status !== undefined) target.status = body.status;
    if (body.rationale !== undefined) target.rationale = body.rationale;
    if (body.relatedMethod !== undefined) target.relatedMethod = body.relatedMethod;
    target.updatedAt = nowIso();
    sendValid(response, researchQuestionSchema, target);
    return;
  }

  if (kind === 'evidence' && method === 'PATCH') {
    const body = (await parseBody(request, patchEvidenceRequestSchema)) as PatchEvidenceRequest;
    const target = state.evidence.find((entry) => entry.id === id);
    if (target === undefined) throw new ApiClientError(404, 'not_found', `Evidence ${id} does not exist`);
    if (body.type !== undefined) target.type = body.type;
    if (body.title !== undefined) target.title = body.title;
    if (body.description !== undefined) target.description = body.description;
    if (body.sourceReference !== undefined) target.sourceReference = body.sourceReference;
    if (body.sourceLocation !== undefined) target.sourceLocation = body.sourceLocation;
    if (body.reliabilityNote !== undefined) target.reliabilityNote = body.reliabilityNote;
    target.updatedAt = nowIso();
    sendValid(response, evidenceSchema, target);
    return;
  }

  if (kind === 'claims' && method === 'PATCH') {
    const body = (await parseBody(request, patchClaimRequestSchema)) as PatchClaimRequest;
    const target = state.claims.find((entry) => entry.id === id);
    if (target === undefined) throw new ApiClientError(404, 'not_found', `Claim ${id} does not exist`);
    if (body.claimCode !== undefined) target.claimCode = body.claimCode;
    if (body.claimText !== undefined) target.claimText = body.claimText;
    if (body.claimType !== undefined) target.claimType = body.claimType;
    if (body.status !== undefined) target.status = body.status;
    if (body.confidence !== undefined) target.confidence = body.confidence;
    if (body.boundary !== undefined) target.boundary = body.boundary;
    target.updatedAt = nowIso();
    sendValid(response, claimSchema, target);
    return;
  }

  if (kind === 'sections' && method === 'PATCH') {
    const body = (await parseBody(request, patchSectionRequestSchema)) as PatchSectionRequest;
    const target = state.sections.find((entry) => entry.id === id);
    if (target === undefined) throw new ApiClientError(404, 'not_found', `Section ${id} does not exist`);
    if (body.sectionName !== undefined) target.sectionName = body.sectionName;
    if (body.sectionReference !== undefined) target.sectionReference = body.sectionReference;
    if (body.sortOrder !== undefined) target.sortOrder = body.sortOrder;
    target.updatedAt = nowIso();
    sendValid(response, manuscriptSectionSchema, target);
    return;
  }

  if (kind === 'relations' && method === 'DELETE') {
    const index = state.relations.findIndex((entry) => entry.id === id);
    if (index < 0) throw new ApiClientError(404, 'not_found', `Relation ${id} does not exist`);
    state.relations.splice(index, 1);
    sendValid(response, deleteRelationResponseSchema, { deleted: true, id });
    return;
  }

  if (kind === 'drift-findings' && method === 'PATCH') {
    const body = (await parseBody(request, patchDriftFindingRequestSchema)) as PatchDriftFindingRequest;
    const target = state.findings.find((entry) => entry.id === id);
    if (target === undefined) throw new ApiClientError(404, 'not_found', `Drift finding ${id} does not exist`);
    target.status = body.status;
    target.updatedAt = nowIso();
    sendValid(response, driftFindingSchema, target);
    return;
  }

  send(response, 404, { error: { code: 'not_found', message: `No fake research route for ${rest.join('/')}` } });
}

// --- fake domain behaviour --------------------------------------------------

function findProject(state: ResearchState, id: string): ResearchProject {
  const found = state.projects.find((entry) => entry.id === id);
  if (!found) throw new ApiClientError(404, 'not_found', `Research project ${id} does not exist`);
  return found;
}

function entityExists(state: ResearchState, projectId: string, type: ResearchEntityType, id: string): boolean {
  switch (type) {
    case 'research_project':
      return state.projects.some((entry) => entry.id === id && entry.id === projectId);
    case 'research_charter':
      return state.charters.get(projectId)?.id === id;
    case 'research_question':
      return state.questions.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'evidence':
      return state.evidence.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'claim':
      return state.claims.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'research_decision':
      return state.decisions.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'research_change':
      return state.changes.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'drift_finding':
      return state.findings.some((entry) => entry.id === id && entry.projectId === projectId);
    case 'manuscript_section':
      return state.sections.some((entry) => entry.id === id && entry.projectId === projectId);
  }
}

/**
 * Deterministic drift rules (research doc §4): the fake implements the evidence-drift core rule and
 * the manuscript RQ rule so the proxy tests see real findings; the full rule set lives in the core.
 */
function runDriftCheck(projectId: string, body: DriftCheckRequest, state: ResearchState): void {
  for (const claim of state.claims.filter((entry) => entry.projectId === projectId)) {
    const supported = state.relations.some(
      (relation) =>
        relation.targetType === 'claim' &&
        relation.targetId === claim.id &&
        (relation.relationType === 'supports' || relation.relationType === 'partially_supports'),
    );
    if (supported) continue;
    const duplicate = state.findings.some(
      (finding) =>
        finding.status === 'open' &&
        finding.driftType === 'evidence_drift' &&
        finding.sourceEntityId === claim.id,
    );
    if (duplicate) continue;
    state.findings.push({
      id: `df-${state.nextId++}`,
      projectId,
      userId: USER_ID,
      driftType: 'evidence_drift',
      severity: claim.status === 'confirmed' ? 'critical' : 'warning',
      description: `Claim ${claim.claimCode} 没有任何支持证据。`,
      sourceEntityType: 'claim',
      sourceEntityId: claim.id,
      targetEntityType: null,
      targetEntityId: null,
      reason: '缺少 supports / partially_supports 关系。',
      recommendedAction: '补充 Evidence、弱化 Claim 或改为 Future Research。',
      status: 'open',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const text = body.manuscriptText;
  if (text === undefined || text.trim().length === 0) return;
  const charter = state.charters.get(projectId);
  const known = state.questions.filter((entry) => entry.projectId === projectId);
  for (const sentence of text.split(/(?<=[?？])|\n+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    if (!/[?？]$/.test(sentence)) continue;
    const matched =
      known.some((question) => sentence.includes(question.questionCode)) ||
      (charter?.researchQuestionsText ?? '').includes(sentence) ||
      known.some((question) => question.questionText === sentence);
    if (matched) continue;
    state.findings.push({
      id: `df-${state.nextId++}`,
      projectId,
      userId: USER_ID,
      driftType: 'rq_drift',
      severity: 'warning',
      description: `正文出现未登记的研究问题：${sentence}`,
      sourceEntityType: 'research_charter',
      sourceEntityId: charter?.id ?? null,
      targetEntityType: null,
      targetEntityId: null,
      reason: '该问题未出现在 Charter 与已登记 RQ 中。',
      recommendedAction: '登记为新的 RQ 或修改正文表述。',
      status: 'open',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
}

function summarize(findings: readonly DriftFinding[]): { total: number; info: number; warning: number; critical: number } {
  return {
    total: findings.length,
    info: findings.filter((entry) => entry.severity === 'info').length,
    warning: findings.filter((entry) => entry.severity === 'warning').length,
    critical: findings.filter((entry) => entry.severity === 'critical').length,
  };
}

function buildMap(project: ResearchProject, state: ResearchState): unknown {
  const charter = state.charters.get(project.id);
  const claims = state.claims.filter((entry) => entry.projectId === project.id);
  const supported = (claimId: string): boolean =>
    state.relations.some(
      (relation) =>
        relation.targetType === 'claim' &&
        relation.targetId === claimId &&
        (relation.relationType === 'supports' || relation.relationType === 'partially_supports'),
    );
  return {
    project: { id: project.id, name: project.name, status: project.status },
    charter: {
      workingTitle: charter?.workingTitle ?? project.name,
      coreContribution: charter?.coreContribution ?? null,
      researchBoundary: charter?.researchBoundary ?? null,
      claimBoundary: charter?.claimBoundary ?? null,
      currentStage: charter?.currentStage ?? null,
    },
    questions: state.questions
      .filter((entry) => entry.projectId === project.id)
      .map((entry) => ({ id: entry.id, questionCode: entry.questionCode, questionText: entry.questionText, status: entry.status })),
    evidence: state.evidence
      .filter((entry) => entry.projectId === project.id)
      .map((entry) => ({ id: entry.id, type: entry.type, title: entry.title })),
    claims: claims.map((entry) => ({
      id: entry.id,
      claimCode: entry.claimCode,
      claimText: entry.claimText,
      claimType: entry.claimType,
      status: entry.status,
      supported: supported(entry.id),
    })),
    sections: state.sections
      .filter((entry) => entry.projectId === project.id)
      .map((entry) => ({ id: entry.id, sectionName: entry.sectionName, sectionReference: entry.sectionReference })),
    edges: state.relations
      .filter((entry) => entry.projectId === project.id && MAP_RELATIONS.includes(entry.relationType))
      .map((entry) => ({
        id: entry.id,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        relationType: entry.relationType,
        targetType: entry.targetType,
        targetId: entry.targetId,
      })),
    unsupportedClaimIds: claims.filter((entry) => !supported(entry.id)).map((entry) => entry.id),
  };
}

function buildContextPack(project: ResearchProject, state: ResearchState): unknown {
  const charter = state.charters.get(project.id);
  const questions = state.questions.filter((entry) => entry.projectId === project.id);
  const claims = state.claims.filter((entry) => entry.projectId === project.id);
  const confirmed = claims.filter((entry) => entry.status === 'confirmed');
  const decisions = state.decisions.filter((entry) => entry.projectId === project.id).slice(-5).reverse();
  const changes = state.changes.filter((entry) => entry.projectId === project.id).slice(-5).reverse();
  const findings = state.findings.filter((entry) => entry.projectId === project.id && entry.status === 'open');
  const supportedIds = new Set(
    state.relations
      .filter(
        (relation) =>
          relation.targetType === 'claim' &&
          (relation.relationType === 'supports' || relation.relationType === 'partially_supports'),
      )
      .map((relation) => relation.targetId),
  );
  const keyEvidence = state.evidence.filter((entry) =>
    state.relations.some(
      (relation) => relation.sourceType === 'evidence' && relation.sourceId === entry.id && supportedIds.has(relation.targetId) && confirmed.some((claim) => claim.id === relation.targetId),
    ),
  );

  const blocks = [
    { heading: 'PROJECT', body: `${project.name} · ${charter?.currentStage ?? '未标注阶段'}` },
    {
      heading: 'Current Research Questions',
      body: questions.map((entry) => `${entry.questionCode} ${entry.questionText}（${entry.status}）`).join('\n') || '（无）',
    },
    { heading: 'Core Contribution', body: charter?.coreContribution ?? '（未填写）' },
    { heading: 'Research Boundary', body: charter?.researchBoundary ?? '（未填写）' },
    { heading: 'Claim Boundary', body: charter?.claimBoundary ?? '（未填写）' },
    { heading: 'Current Method', body: charter?.researchMethod ?? '（未填写）' },
    {
      heading: 'Confirmed Claims',
      body: confirmed.map((entry) => `${entry.claimCode} ${entry.claimText}`).join('\n') || '（无）',
    },
    {
      heading: 'Key Evidence',
      body: keyEvidence.map((entry) => `${entry.title}（${entry.type}）`).join('\n') || '（无）',
    },
    {
      heading: 'Important Decisions',
      body: decisions.map((entry) => `${entry.title}：${entry.decision}`).join('\n') || '（无）',
    },
    {
      heading: 'Recent Changes',
      body: changes.map((entry) => `${entry.changeType} ${entry.before} → ${entry.after}`).join('\n') || '（无）',
    },
    {
      heading: 'Open Issues',
      body: `${questions.filter((entry) => entry.status === 'open').length} 个待解决 RQ；${findings.length} 条未处理 Drift Finding`,
    },
    {
      heading: 'Current Drift Warnings',
      body: findings.map((entry) => `${entry.severity} ${entry.description}`).join('\n') || '（无）',
    },
  ];

  return {
    markdown: blocks.map((block) => `## ${block.heading}\n\n${block.body}`).join('\n\n'),
    blocks,
    generatedAt: nowIso(),
  };
}

// --- HTTP plumbing (mirrors fake-core.ts) -----------------------------------

interface SchemaLike {
  safeParse(data: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: readonly { message: string }[] };
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function parseBody(request: IncomingMessage, schema: SchemaLike): Promise<unknown> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw new ApiClientError(400, 'invalid_request', 'Fake core rejected the request payload', parsed.error?.issues);
  }
  return parsed.data;
}

function parseQuery(schema: SchemaLike, url: URL, keys: readonly string[]): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const key of keys) raw[key] = url.searchParams.get(key) ?? undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiClientError(400, 'invalid_request', 'Fake core rejected the query parameters', parsed.error?.issues);
  }
  return parsed.data as Record<string, string | undefined>;
}

function matchRelationFilter(entry: EntityRelation, url: URL, key: 'sourceType' | 'sourceId' | 'targetType' | 'targetId' | 'relationType'): boolean {
  const raw = url.searchParams.get(key);
  return raw === null || raw.length === 0 || entry[key] === raw;
}

function sendValid(response: ServerResponse, schema: SchemaLike, payload: unknown): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    send(response, 500, {
      error: {
        code: 'internal_error',
        message: `Fake core broke the shared contract: ${parsed.error?.issues.map((issue) => issue.message).join('; ') ?? 'unknown'}`,
      },
    });
    return;
  }
  send(response, 200, payload);
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
