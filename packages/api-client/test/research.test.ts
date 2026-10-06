/**
 * The research wire contract (P5-D1). The desktop workbench calls these methods instead of hand-writing
 * `fetch`, so what needs pinning is the pair of things a typo silently breaks: which method+path each name
 * maps to, and which envelope each read unwraps. The paths below are spelled as literals rather than
 * `apiRoutes.*` on purpose — the table has to be able to disagree with the route constants.
 *
 * 38 endpoints, 45 rows: 复核标记 / 证据 / 论点 / 偏移发现 / 变更 / 关系 each appear twice, once unfiltered
 * and once with a filter, because the empty-query and filtered branches are built by different code paths
 * (drift-check also gets a second row for its optional 正文 body).
 * P6 added the last five endpoints (drift-check / 偏移发现列表 / 偏移发现 PATCH / 地图 / 上下文包).
 * Fixtures are 测试造数 — a 测试项目, not a real study.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError } from '../src/client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(response: { status: number; payload: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(response.payload), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function clientFor(fetchImpl: typeof fetch) {
  return new ApiClient({ baseUrl: 'http://127.0.0.1:8787/', token: 'device-token', clientHint: 'desktop', fetchImpl });
}

const ISO = '2026-10-06T08:00:00.000Z';

const PROJECT = {
  id: 'rp 1',
  userId: 'user-1',
  name: '测试项目：碳定价与工业排放',
  description: null,
  status: 'active',
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const CHARTER = {
  id: 'chtr-1',
  projectId: 'rp 1',
  userId: 'user-1',
  workingTitle: '碳定价与工业排放',
  researchTopic: null,
  researchProblem: null,
  researchGap: null,
  researchQuestionsText: 'RQ1：碳价如何影响排放？',
  coreContribution: null,
  theoreticalLens: null,
  researchContext: null,
  unitOfAnalysis: null,
  researchMethod: '双重差分',
  targetArticleType: null,
  targetJournal: null,
  researchBoundary: null,
  claimBoundary: null,
  currentStage: '开题',
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const VERSION = {
  id: 'cv-1',
  projectId: 'rp 1',
  userId: 'user-1',
  version: 1,
  previousVersion: null,
  charter: CHARTER,
  changedFields: [],
  revisionReason: '开题时批准的基线',
  decisionId: null,
  approvedAt: ISO,
} as const;

const MARK = {
  id: 'rm 1',
  projectId: 'rp 1',
  userId: 'user-1',
  entityType: 'evidence',
  entityId: 'ev-1',
  reason: '出处「排放数据摘录」已归档，这条引用需要重新确认',
  raisedBy: 'source_archived',
  charterVersion: null,
  status: 'pending',
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const REFERENCE = {
  projectId: 'rp 1',
  projectName: '测试项目：碳定价与工业排放',
  evidenceId: 'ev-1',
  evidenceTitle: '排放数据摘录',
  evidenceType: 'dataset',
  claimIds: ['cl-1'],
} as const;

const QUESTION = {
  id: 'rq 1',
  projectId: 'rp 1',
  userId: 'user-1',
  questionCode: 'RQ1',
  questionText: '碳价如何影响短期排放？',
  status: 'open',
  rationale: null,
  relatedMethod: null,
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const EVIDENCE = {
  id: 'ev 1',
  projectId: 'rp 1',
  userId: 'user-1',
  type: 'dataset',
  title: '排放数据摘录',
  description: null,
  sourceReference: '测试年鉴 2024',
  sourceLocation: '表 3-2',
  rawSourceId: 'src-1',
  nodeId: 'n-1',
  locationOrigin: 'captured',
  reliabilityNote: null,
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const CLAIM = {
  id: 'cl 1',
  projectId: 'rp 1',
  userId: 'user-1',
  claimCode: 'C-01',
  claimText: '碳价上升降低了试点地区的短期排放',
  claimType: 'empirical',
  status: 'draft',
  confidence: 0.6,
  boundary: '限于试点地区',
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const SECTION = {
  id: 'sec 1',
  projectId: 'rp 1',
  userId: 'user-1',
  sectionName: '引言',
  sectionReference: '§1',
  sortOrder: 1,
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const RELATION = {
  id: 'rel 1',
  projectId: 'rp 1',
  userId: 'user-1',
  sourceType: 'evidence',
  sourceId: 'ev 1',
  relationType: 'supports',
  targetType: 'claim',
  targetId: 'cl 1',
  note: null,
  createdAt: ISO,
} as const;

const DECISION = {
  id: 'dec 1',
  projectId: 'rp 1',
  userId: 'user-1',
  title: '识别策略',
  decision: '使用双重差分识别碳价效应',
  reason: null,
  alternatives: null,
  rejectedAlternatives: null,
  impact: null,
  relatedEntities: {},
  createdAt: ISO,
} as const;

const CHANGE = {
  id: 'chg 1',
  projectId: 'rp 1',
  userId: 'user-1',
  changeType: 'method',
  before: '普通最小二乘',
  after: '双重差分',
  reason: null,
  impact: null,
  relatedEntities: {},
  createdAt: ISO,
} as const;

const EVENT = {
  id: 'tl 1',
  projectId: 'rp 1',
  userId: 'user-1',
  eventType: 'milestone',
  occurredAt: ISO,
  title: '开题',
  summary: null,
  sourceType: 'manual',
  sourceId: null,
  relatedEntities: {},
  createdAt: ISO,
} as const;

const FINDING = {
  id: 'df 1',
  projectId: 'rp 1',
  userId: 'user-1',
  driftType: 'evidence_drift',
  severity: 'warning',
  description: '论点 C-03 没有任何 supports／partially_supports 关系',
  sourceEntityType: 'claim',
  sourceEntityId: 'cl 3',
  targetEntityType: null,
  targetEntityId: null,
  reason: null,
  recommendedAction: '补充证据或弱化论点表述',
  status: 'open',
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const MAP = {
  project: { id: 'rp 1', name: '测试项目：碳定价与工业排放', status: 'active' },
  charter: {
    workingTitle: '碳定价与工业排放',
    coreContribution: null,
    researchBoundary: null,
    claimBoundary: null,
    currentStage: '开题',
  },
  questions: [{ id: 'rq 1', questionCode: 'RQ1', questionText: '碳价如何影响短期排放？', status: 'open' }],
  evidence: [{ id: 'ev 1', type: 'dataset', title: '排放数据摘录' }],
  claims: [
    {
      id: 'cl 1',
      claimCode: 'C-01',
      claimText: '碳价上升降低了试点地区的短期排放',
      claimType: 'empirical',
      status: 'draft',
      supported: true,
    },
  ],
  sections: [{ id: 'sec 1', sectionName: '引言', sectionReference: '§1' }],
  edges: [
    {
      id: 'rel 1',
      sourceType: 'evidence',
      sourceId: 'ev 1',
      relationType: 'supports',
      targetType: 'claim',
      targetId: 'cl 1',
    },
  ],
  unsupportedClaimIds: [],
} as const;

const PACK = {
  markdown: '## PROJECT\n测试项目：碳定价与工业排放（开题）',
  blocks: [
    { heading: 'PROJECT', body: '测试项目：碳定价与工业排放（开题）' },
    { heading: 'Core Contribution', body: '（未填写）' },
  ],
  generatedAt: ISO,
} as const;

interface WireCase {
  name: string;
  call: (api: ApiClient) => Promise<unknown>;
  method: string;
  /** Path and query only; the base URL is added when the call is asserted. */
  url: string;
  payload: unknown;
  /** A fragment the request body must carry. No `body` means the call must send no body at all. */
  body?: string;
}

const WIRE: readonly WireCase[] = [
  {
    name: 'list 研究项目',
    call: (api) => api.researchProjects(),
    method: 'GET',
    url: '/api/research/projects',
    payload: { projects: [PROJECT] },
  },
  {
    name: 'create 研究项目',
    call: (api) => api.createResearchProject({ name: '测试项目：碳定价与工业排放' }),
    method: 'POST',
    url: '/api/research/projects',
    payload: PROJECT,
    body: '"name":"测试项目：碳定价与工业排放"',
  },
  {
    name: 'read one 研究项目',
    call: (api) => api.researchProject('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201',
    payload: PROJECT,
  },
  {
    name: 'patch 研究项目',
    call: (api) => api.patchResearchProject('p 1', { status: 'completed' }),
    method: 'PATCH',
    url: '/api/research/projects/p%201',
    payload: { ...PROJECT, status: 'completed' },
    body: '"status":"completed"',
  },
  {
    name: 'read 章程',
    call: (api) => api.researchCharter('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/charter',
    payload: { charter: CHARTER },
  },
  {
    name: 'save 章程',
    call: (api) => api.saveResearchCharter('p 1', { workingTitle: '碳定价与工业排放' }),
    method: 'PUT',
    url: '/api/research/projects/p%201/charter',
    payload: CHARTER,
    body: '"workingTitle":"碳定价与工业排放"',
  },
  {
    name: 'approve 章程',
    call: (api) => api.approveResearchCharter('p 1', { revisionReason: '开题时批准的基线' }),
    method: 'POST',
    url: '/api/research/projects/p%201/charter/approve',
    payload: VERSION,
    body: '"revisionReason":"开题时批准的基线"',
  },
  {
    name: 'list 章程版本',
    call: (api) => api.researchCharterVersions('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/charter/versions',
    payload: { versions: [VERSION] },
  },
  {
    name: 'read 章程基线',
    call: (api) => api.researchCharterBaseline('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/charter/baseline',
    payload: { baseline: VERSION },
  },
  {
    name: 'list 复核标记',
    call: (api) => api.researchReviewMarks('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/review-marks',
    payload: { marks: [MARK] },
  },
  {
    name: 'filter 复核标记 by status and reason',
    call: (api) => api.researchReviewMarks('p 1', { status: 'pending', raisedBy: 'source_archived' }),
    method: 'GET',
    url: '/api/research/projects/p%201/review-marks?status=pending&raisedBy=source_archived',
    payload: { marks: [MARK] },
  },
  {
    name: 'clear 复核标记',
    call: (api) => api.clearResearchReviewMark('rm 1'),
    method: 'POST',
    url: '/api/research/review-marks/rm%201/clear',
    payload: MARK,
  },
  {
    name: 'check 引用 by node',
    call: (api) => api.researchReferences({ nodeId: 'n-1' }),
    method: 'GET',
    url: '/api/research/references?nodeId=n-1',
    payload: { references: [REFERENCE] },
  },
  {
    name: 'list 研究问题',
    call: (api) => api.researchQuestions('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/questions',
    payload: { questions: [QUESTION] },
  },
  {
    name: 'create 研究问题',
    call: (api) => api.createResearchQuestion('p 1', { questionCode: 'RQ1', questionText: '碳价如何影响短期排放？' }),
    method: 'POST',
    url: '/api/research/projects/p%201/questions',
    payload: QUESTION,
    body: '"questionCode":"RQ1"',
  },
  {
    name: 'patch 研究问题',
    call: (api) => api.patchResearchQuestion('rq 1', { status: 'answered' }),
    method: 'PATCH',
    url: '/api/research/questions/rq%201',
    payload: { ...QUESTION, status: 'answered' },
    body: '"status":"answered"',
  },
  {
    name: 'list 证据',
    call: (api) => api.researchEvidence('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/evidence',
    payload: { evidence: [EVIDENCE] },
  },
  {
    name: 'filter 证据 by type',
    call: (api) => api.researchEvidence('p 1', { type: 'dataset' }),
    method: 'GET',
    url: '/api/research/projects/p%201/evidence?type=dataset',
    payload: { evidence: [EVIDENCE] },
  },
  {
    name: 'create 证据',
    call: (api) =>
      api.createResearchEvidence('p 1', { type: 'dataset', title: '排放数据摘录', rawSourceId: 'src-1' }),
    method: 'POST',
    url: '/api/research/projects/p%201/evidence',
    payload: EVIDENCE,
    body: '"rawSourceId":"src-1"',
  },
  {
    name: 'patch 证据',
    call: (api) => api.patchResearchEvidence('ev 1', { description: null }),
    method: 'PATCH',
    url: '/api/research/evidence/ev%201',
    payload: EVIDENCE,
    body: '"description":null',
  },
  {
    name: 'list 论点',
    call: (api) => api.researchClaims('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/claims',
    payload: { claims: [CLAIM] },
  },
  {
    name: 'filter 论点 by status',
    call: (api) => api.researchClaims('p 1', { status: 'confirmed' }),
    method: 'GET',
    url: '/api/research/projects/p%201/claims?status=confirmed',
    payload: { claims: [{ ...CLAIM, status: 'confirmed' }] },
  },
  {
    name: 'create 论点',
    call: (api) =>
      api.createResearchClaim('p 1', { claimCode: 'C-01', claimText: '碳价上升降低了短期排放', claimType: 'empirical' }),
    method: 'POST',
    url: '/api/research/projects/p%201/claims',
    payload: CLAIM,
    body: '"claimType":"empirical"',
  },
  {
    name: 'patch 论点',
    call: (api) => api.patchResearchClaim('cl 1', { boundary: '限于试点地区' }),
    method: 'PATCH',
    url: '/api/research/claims/cl%201',
    payload: CLAIM,
    body: '"boundary":"限于试点地区"',
  },
  {
    name: 'list 章节',
    call: (api) => api.researchSections('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/sections',
    payload: { sections: [SECTION] },
  },
  {
    name: 'create 章节',
    call: (api) => api.createResearchSection('p 1', { sectionName: '引言' }),
    method: 'POST',
    url: '/api/research/projects/p%201/sections',
    payload: SECTION,
    body: '"sectionName":"引言"',
  },
  {
    name: 'patch 章节',
    call: (api) => api.patchResearchSection('sec 1', { sortOrder: 2 }),
    method: 'PATCH',
    url: '/api/research/sections/sec%201',
    payload: { ...SECTION, sortOrder: 2 },
    body: '"sortOrder":2',
  },
  {
    name: 'list 关系',
    call: (api) => api.researchRelations('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/relations',
    payload: { relations: [RELATION] },
  },
  {
    name: 'filter 关系 by source',
    call: (api) => api.researchRelations('p 1', { sourceId: 'ev 1', relationType: 'supports' }),
    method: 'GET',
    url: '/api/research/projects/p%201/relations?sourceId=ev+1&relationType=supports',
    payload: { relations: [RELATION] },
  },
  {
    name: 'create 关系',
    call: (api) =>
      api.createResearchRelation('p 1', {
        sourceType: 'evidence',
        sourceId: 'ev 1',
        relationType: 'supports',
        targetType: 'claim',
        targetId: 'cl 1',
      }),
    method: 'POST',
    url: '/api/research/projects/p%201/relations',
    payload: RELATION,
    body: '"relationType":"supports"',
  },
  {
    name: 'delete 关系',
    call: (api) => api.deleteResearchRelation('rel 1'),
    method: 'DELETE',
    url: '/api/research/relations/rel%201',
    payload: { deleted: true, id: 'rel 1' },
  },
  {
    name: 'list 决策',
    call: (api) => api.researchDecisions('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/decisions',
    payload: { decisions: [DECISION] },
  },
  {
    name: 'create 决策',
    call: (api) => api.createResearchDecision('p 1', { title: '识别策略', decision: '使用双重差分识别碳价效应' }),
    method: 'POST',
    url: '/api/research/projects/p%201/decisions',
    payload: DECISION,
    body: '"decision":"使用双重差分识别碳价效应"',
  },
  {
    name: 'list 变更',
    call: (api) => api.researchChanges('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/changes',
    payload: { changes: [CHANGE] },
  },
  {
    name: 'filter 变更 by type',
    call: (api) => api.researchChanges('p 1', { changeType: 'journal' }),
    method: 'GET',
    url: '/api/research/projects/p%201/changes?changeType=journal',
    payload: { changes: [{ ...CHANGE, changeType: 'journal' }] },
  },
  {
    name: 'create 变更',
    call: (api) => api.createResearchChange('p 1', { changeType: 'method', before: '普通最小二乘', after: '双重差分' }),
    method: 'POST',
    url: '/api/research/projects/p%201/changes',
    payload: CHANGE,
    body: '"changeType":"method"',
  },
  {
    name: 'list 时间线',
    call: (api) => api.researchTimeline('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/timeline',
    payload: { events: [EVENT] },
  },
  {
    name: 'create 里程碑',
    call: (api) => api.createResearchMilestone('p 1', { occurredAt: ISO, title: '开题' }),
    method: 'POST',
    url: '/api/research/projects/p%201/timeline',
    payload: EVENT,
    body: `"occurredAt":"${ISO}"`,
  },
  {
    name: 'run 偏移检查',
    call: (api) => api.researchDriftCheck('p 1'),
    method: 'POST',
    url: '/api/research/projects/p%201/drift-check',
    payload: { findings: [FINDING], summary: { total: 1, info: 0, warning: 1, critical: 0 } },
    body: '{}',
  },
  {
    name: 'run 偏移检查 with 正文',
    call: (api) => api.researchDriftCheck('p 1', { manuscriptText: '我们是否高估了碳价效应？' }),
    method: 'POST',
    url: '/api/research/projects/p%201/drift-check',
    payload: { findings: [], summary: { total: 0, info: 0, warning: 0, critical: 0 } },
    body: '"manuscriptText":"我们是否高估了碳价效应？"',
  },
  {
    name: 'list 偏移发现',
    call: (api) => api.researchDriftFindings('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/drift-findings',
    payload: { findings: [FINDING] },
  },
  {
    name: 'filter 偏移发现 by status',
    call: (api) => api.researchDriftFindings('p 1', { status: 'open' }),
    method: 'GET',
    url: '/api/research/projects/p%201/drift-findings?status=open',
    payload: { findings: [FINDING] },
  },
  {
    name: 'patch 偏移发现',
    call: (api) => api.patchResearchDriftFinding('df 1', { status: 'acknowledged' }),
    method: 'PATCH',
    url: '/api/research/drift-findings/df%201',
    payload: { ...FINDING, status: 'acknowledged' },
    body: '"status":"acknowledged"',
  },
  {
    name: 'read 研究地图',
    call: (api) => api.researchMap('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/map',
    payload: MAP,
  },
  {
    name: 'read 上下文包',
    call: (api) => api.researchContextPack('p 1'),
    method: 'GET',
    url: '/api/research/projects/p%201/context-pack',
    payload: PACK,
  },
];

describe('research routes', () => {
  for (const item of WIRE) {
    it(`${item.method} ${item.name}`, async () => {
      const { calls, fetchImpl } = stub({ status: 200, payload: item.payload });

      const result = await item.call(clientFor(fetchImpl));

      expect(calls[0]?.method).toBe(item.method);
      expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${item.url}`);
      if (item.body === undefined) {
        // A body-less call must not announce a payload the server would then try to parse.
        expect(calls[0]?.body).toBeUndefined();
        expect(calls[0]?.headers['content-type']).toBeUndefined();
      } else {
        expect(calls[0]?.body).toContain(item.body);
        expect(calls[0]?.headers['content-type']).toBe('application/json');
      }
      expect(result).toBeDefined();
    });
  }
});

describe('research envelopes', () => {
  it('answers null for a project that has no 章程 yet', async () => {
    const { fetchImpl } = stub({ status: 200, payload: { charter: null } });
    await expect(clientFor(fetchImpl).researchCharter('p 1')).resolves.toBeNull();
  });

  it('answers null for a baseline before the first 批准', async () => {
    const { fetchImpl } = stub({ status: 200, payload: { baseline: null } });
    await expect(clientFor(fetchImpl).researchCharterBaseline('p 1')).resolves.toBeNull();
  });

  it('unwraps a 复核标记 that names the archived 出处 in its reason', async () => {
    const { fetchImpl } = stub({ status: 200, payload: { marks: [MARK] } });
    const marks = await clientFor(fetchImpl).researchReviewMarks('p 1', { status: 'pending' });
    expect(marks[0]?.raisedBy).toBe('source_archived');
    expect(marks[0]?.reason).toContain('已归档');
  });

  it('reads the reference check back with its project name and 论点', async () => {
    const { fetchImpl } = stub({ status: 200, payload: { references: [REFERENCE] } });
    const references = await clientFor(fetchImpl).researchReferences({ nodeId: 'n-1' });
    expect(references[0]?.projectName).toBe('测试项目：碳定价与工业排放');
    expect(references[0]?.claimIds).toEqual(['cl-1']);
  });

  it('sends whichever source id the caller has', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { references: [] } });
    const client = clientFor(fetchImpl);

    await client.researchReferences({ rawSourceId: 'src/1' });
    await client.researchReferences({ nodeId: 'n-1', rawSourceId: 'src-1' });

    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/api/research/references?rawSourceId=src%2F1');
    expect(calls[1]?.url).toBe('http://127.0.0.1:8787/api/research/references?nodeId=n-1&rawSourceId=src-1');
  });

  it('rejects a 502 when a response does not match the shared contract', async () => {
    const { fetchImpl } = stub({ status: 200, payload: { projects: [{ id: 'rp 1' }] } });
    const error = await clientFor(fetchImpl)
      .researchProjects()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(502);
    expect((error as ApiClientError).message).toContain('GET /api/research/projects');
  });

  it('maps a Core refusal onto the error envelope', async () => {
    const { fetchImpl } = stub({
      status: 400,
      payload: { error: { code: 'invalid_request', message: 'supports 只能由证据指向论点', retryable: false, traceId: 'trace-r1' } },
    });
    const error = await clientFor(fetchImpl)
      .createResearchRelation('p 1', {
        sourceType: 'claim',
        sourceId: 'cl 1',
        relationType: 'supports',
        targetType: 'evidence',
        targetId: 'ev 1',
      })
      .catch((cause: unknown) => cause);
    expect((error as ApiClientError).code).toBe('invalid_request');
    expect((error as ApiClientError).traceId).toBe('trace-r1');
  });
});

describe('the P6 envelopes', () => {
  it('keeps the drift summary counts and the severity the Core assigned', async () => {
    const { fetchImpl } = stub({
      status: 200,
      payload: {
        findings: [{ ...FINDING, driftType: 'causality_drift', severity: 'critical' }],
        summary: { total: 1, info: 0, warning: 0, critical: 1 },
      },
    });
    const result = await clientFor(fetchImpl).researchDriftCheck('p 1', {});
    expect(result.summary.critical).toBe(1);
    expect(result.findings[0]?.driftType).toBe('causality_drift');
  });

  it('filters 偏移发现 and sends the acknowledgement back as a PATCH', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { findings: [FINDING] } });
    const findings = await clientFor(fetchImpl).researchDriftFindings('p 1', { status: 'open' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/api/research/projects/p%201/drift-findings?status=open');
    expect(findings[0]?.recommendedAction).toContain('补充证据');

    const patched = stub({ status: 200, payload: { ...FINDING, status: 'acknowledged' } });
    const finding = await clientFor(patched.fetchImpl).patchResearchDriftFinding('df 1', { status: 'acknowledged' });
    expect(patched.calls[0]?.method).toBe('PATCH');
    expect(finding.status).toBe('acknowledged');
  });

  it('reads the map and the context pack as the Core built them', async () => {
    const mapStub = stub({ status: 200, payload: MAP });
    const map = await clientFor(mapStub.fetchImpl).researchMap('p 1');
    expect(map.edges[0]?.relationType).toBe('supports');
    expect(map.unsupportedClaimIds).toEqual([]);

    const packStub = stub({ status: 200, payload: PACK });
    const pack = await clientFor(packStub.fetchImpl).researchContextPack('p 1');
    expect(pack.blocks[0]?.heading).toBe('PROJECT');
    expect(pack.markdown).toContain('## PROJECT');
  });
});

describe('research writes refuse locally what the contract refuses', () => {
  it('reports the zod issues for an unsendable 证据 payload', () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: EVIDENCE });
    // Validation happens before the request is built, so this throws synchronously.
    expect(() => clientFor(fetchImpl).createResearchEvidence('p 1', { type: 'statistics' } as never)).toThrow(
      ApiClientError,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a reference check that names no source', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { references: [] } });
    // A filter-less check reads as 「查全部引用」, which is the opposite of what the caller asked for.
    await expect(clientFor(fetchImpl).researchReferences({} as never)).rejects.toThrow(ApiClientError);
    expect(calls).toEqual([]);
  });

  it('never forwards identity fields from a response-shaped object', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: CHARTER });
    // A panel that keeps the 章程 row in state saves it back as-is; userId/projectId must not ride along (§0 rule 1).
    await clientFor(fetchImpl).saveResearchCharter('p 1', { ...CHARTER });
    expect(calls[0]?.body).toContain('"workingTitle"');
    expect(calls[0]?.body).not.toContain('userId');
    expect(calls[0]?.body).not.toContain('projectId');
    expect(calls[0]?.body).not.toContain('createdAt');
  });

  it('refuses a finding status the contract does not have', () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: FINDING });
    expect(() => clientFor(fetchImpl).patchResearchDriftFinding('df 1', { status: 'done' } as never)).toThrow(
      ApiClientError,
    );
    expect(calls).toEqual([]);
  });
});
