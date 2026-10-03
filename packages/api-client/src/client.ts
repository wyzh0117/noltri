import { z } from 'zod';
import {
  apiErrorSchema,
  captureRequestSchema,
  captureResultSchema,
  charterResponseSchema,
  claimListResponseSchema,
  claimSchema,
  deleteRelationResponseSchema,
  driftCheckResponseSchema,
  driftFindingListResponseSchema,
  driftFindingSchema,
  entityRelationSchema,
  evidenceListResponseSchema,
  evidenceSchema,
  healthResponseSchema,
  knowledgeNodeSchema,
  manuscriptSectionSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
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
  searchResponseSchema,
  sectionListResponseSchema,
  timelineEventSchema,
  timelineListResponseSchema,
  treeResponseSchema,
  type CaptureRequest,
  type CaptureResult,
  type ChangeListQuery,
  type CharterRequest,
  type CharterResponse,
  type Claim,
  type ClaimListQuery,
  type ClaimListResponse,
  type CreateClaimRequest,
  type CreateEntityRelationRequest,
  type CreateEvidenceRequest,
  type CreateResearchChangeRequest,
  type CreateResearchDecisionRequest,
  type CreateResearchProjectRequest,
  type CreateResearchQuestionRequest,
  type CreateSectionRequest,
  type CreateTimelineEventRequest,
  type DeleteRelationResponse,
  type DriftCheckRequest,
  type DriftCheckResponse,
  type DriftFinding,
  type DriftFindingListQuery,
  type DriftFindingListResponse,
  type EntityRelation,
  type Evidence,
  type EvidenceListQuery,
  type EvidenceListResponse,
  type HealthResponse,
  type KnowledgeNode,
  type ManuscriptSection,
  type MoveNodeRequest,
  type MoveNodeResponse,
  type NodeChatRequest,
  type NodeChatResponse,
  type NodeContext,
  type NodeContextRequest,
  type NodeDetail,
  type PatchClaimRequest,
  type PatchDriftFindingRequest,
  type PatchEvidenceRequest,
  type PatchNodeRequest,
  type PatchResearchProjectRequest,
  type PatchResearchQuestionRequest,
  type PatchSectionRequest,
  type RelationListQuery,
  type RelationListResponse,
  type ResearchChange,
  type ResearchChangeListResponse,
  type ResearchCharter,
  type ResearchContextPackResponse,
  type ResearchDecision,
  type ResearchDecisionListResponse,
  type ResearchMapResponse,
  type ResearchProject,
  type ResearchProjectListResponse,
  type ResearchQuestion,
  type ResearchQuestionListResponse,
  type SearchRequest,
  type SearchResponse,
  type SectionListResponse,
  type TimelineEvent,
  type TimelineListResponse,
  type TreeQuery,
  type TreeResponse,
} from '@noltri/schema';
import { nowIso } from '@noltri/shared';

export const apiRoutes = {
  health: '/api/health',
  capture: '/api/capture',
  tree: '/api/tree',
  node: (id: string) => `/api/nodes/${encodeURIComponent(id)}`,
  move: (id: string) => `/api/nodes/${encodeURIComponent(id)}/move`,
  search: '/api/search',
  nodeContext: '/api/node-context',
  chat: '/api/chat',
} as const;

/** Research Domain REST map (research doc §9–§33). Identity never travels in a body. */
export const researchApiRoutes = {
  projects: '/api/research/projects',
  project: (id: string) => `/api/research/projects/${encodeURIComponent(id)}`,
  charter: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/charter`,
  questions: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/questions`,
  question: (id: string) => `/api/research/questions/${encodeURIComponent(id)}`,
  evidence: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/evidence`,
  evidenceItem: (id: string) => `/api/research/evidence/${encodeURIComponent(id)}`,
  claims: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/claims`,
  claim: (id: string) => `/api/research/claims/${encodeURIComponent(id)}`,
  sections: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/sections`,
  section: (id: string) => `/api/research/sections/${encodeURIComponent(id)}`,
  relations: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/relations`,
  relation: (id: string) => `/api/research/relations/${encodeURIComponent(id)}`,
  decisions: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/decisions`,
  changes: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/changes`,
  timeline: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/timeline`,
  driftCheck: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/drift-check`,
  driftFindings: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/drift-findings`,
  driftFinding: (id: string) => `/api/research/drift-findings/${encodeURIComponent(id)}`,
  map: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/map`,
  contextPack: (projectId: string) => `/api/research/projects/${encodeURIComponent(projectId)}/context-pack`,
} as const;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token: Supabase JWT in the web app, device token for extension/desktop. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface BuildCaptureRequestInput {
  text: string;
  surroundingContext?: string;
  source: CaptureRequest['source'];
  client: CaptureRequest['capture']['client'];
  deviceId?: string;
  capturedAt?: string;
}

export function buildCaptureRequest(input: BuildCaptureRequestInput): CaptureRequest {
  return {
    text: input.text,
    ...(input.surroundingContext ? { surroundingContext: input.surroundingContext } : {}),
    source: input.source,
    capture: {
      capturedAt: input.capturedAt ?? nowIso(),
      client: input.client,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    },
  };
}

/** Typed, validating HTTP client shared by web app, extension and desktop companion. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', apiRoutes.health, healthResponseSchema);
  }

  capture(request: CaptureRequest): Promise<CaptureResult> {
    const validated = captureRequestSchema.safeParse(request);
    if (!validated.success) {
      // Fail before the network call so a broken capture never reaches the pipeline.
      throw new ApiClientError(400, 'invalid_request', 'Capture payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.capture, captureResultSchema, { body: validated.data });
  }

  tree(query: TreeQuery = {}): Promise<TreeResponse> {
    const params = new URLSearchParams();
    if (query.rootId) params.set('rootId', query.rootId);
    if (query.depth) params.set('depth', String(query.depth));
    const suffix = params.toString();
    return this.request('GET', `${apiRoutes.tree}${suffix ? `?${suffix}` : ''}`, treeResponseSchema);
  }

  nodeDetail(id: string): Promise<NodeDetail> {
    return this.request('GET', apiRoutes.node(id), nodeDetailSchema);
  }

  patchNode(id: string, patch: PatchNodeRequest): Promise<KnowledgeNode> {
    return this.request('PATCH', apiRoutes.node(id), knowledgeNodeSchema, { body: patch });
  }

  moveNode(id: string, request: MoveNodeRequest): Promise<MoveNodeResponse> {
    return this.request('POST', apiRoutes.move(id), moveNodeResponseSchema, { body: request });
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.request('POST', apiRoutes.search, searchResponseSchema, { body: request });
  }

  nodeContext(request: NodeContextRequest): Promise<NodeContext> {
    return this.request('POST', apiRoutes.nodeContext, nodeContextSchema, { body: request });
  }

  chat(request: NodeChatRequest): Promise<NodeChatResponse> {
    return this.request('POST', apiRoutes.chat, nodeChatResponseSchema, {
      body: request,
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
  }

  // --- Research Domain (Noltri Research V1) --------------------------------

  researchProjects(): Promise<ResearchProjectListResponse> {
    return this.request('GET', researchApiRoutes.projects, researchProjectListResponseSchema);
  }

  createResearchProject(body: CreateResearchProjectRequest): Promise<ResearchProject> {
    return this.request('POST', researchApiRoutes.projects, researchProjectSchema, { body });
  }

  researchProject(id: string): Promise<ResearchProject> {
    return this.request('GET', researchApiRoutes.project(id), researchProjectSchema);
  }

  patchResearchProject(id: string, body: PatchResearchProjectRequest): Promise<ResearchProject> {
    return this.request('PATCH', researchApiRoutes.project(id), researchProjectSchema, { body });
  }

  researchCharter(projectId: string): Promise<CharterResponse> {
    return this.request('GET', researchApiRoutes.charter(projectId), charterResponseSchema);
  }

  putResearchCharter(projectId: string, body: CharterRequest): Promise<ResearchCharter> {
    return this.request('PUT', researchApiRoutes.charter(projectId), researchCharterSchema, { body });
  }

  researchQuestions(projectId: string): Promise<ResearchQuestionListResponse> {
    return this.request('GET', researchApiRoutes.questions(projectId), researchQuestionListResponseSchema);
  }

  createResearchQuestion(projectId: string, body: CreateResearchQuestionRequest): Promise<ResearchQuestion> {
    return this.request('POST', researchApiRoutes.questions(projectId), researchQuestionSchema, { body });
  }

  patchResearchQuestion(id: string, body: PatchResearchQuestionRequest): Promise<ResearchQuestion> {
    return this.request('PATCH', researchApiRoutes.question(id), researchQuestionSchema, { body });
  }

  researchEvidence(projectId: string, query: EvidenceListQuery = {}): Promise<EvidenceListResponse> {
    return this.request(
      'GET',
      withQuery(researchApiRoutes.evidence(projectId), query),
      evidenceListResponseSchema,
    );
  }

  createResearchEvidence(projectId: string, body: CreateEvidenceRequest): Promise<Evidence> {
    return this.request('POST', researchApiRoutes.evidence(projectId), evidenceSchema, { body });
  }

  patchResearchEvidence(id: string, body: PatchEvidenceRequest): Promise<Evidence> {
    return this.request('PATCH', researchApiRoutes.evidenceItem(id), evidenceSchema, { body });
  }

  researchClaims(projectId: string, query: ClaimListQuery = {}): Promise<ClaimListResponse> {
    return this.request('GET', withQuery(researchApiRoutes.claims(projectId), query), claimListResponseSchema);
  }

  createResearchClaim(projectId: string, body: CreateClaimRequest): Promise<Claim> {
    return this.request('POST', researchApiRoutes.claims(projectId), claimSchema, { body });
  }

  patchResearchClaim(id: string, body: PatchClaimRequest): Promise<Claim> {
    return this.request('PATCH', researchApiRoutes.claim(id), claimSchema, { body });
  }

  researchSections(projectId: string): Promise<SectionListResponse> {
    return this.request('GET', researchApiRoutes.sections(projectId), sectionListResponseSchema);
  }

  createResearchSection(projectId: string, body: CreateSectionRequest): Promise<ManuscriptSection> {
    return this.request('POST', researchApiRoutes.sections(projectId), manuscriptSectionSchema, { body });
  }

  patchResearchSection(id: string, body: PatchSectionRequest): Promise<ManuscriptSection> {
    return this.request('PATCH', researchApiRoutes.section(id), manuscriptSectionSchema, { body });
  }

  researchRelations(projectId: string, query: RelationListQuery = {}): Promise<RelationListResponse> {
    return this.request(
      'GET',
      withQuery(researchApiRoutes.relations(projectId), query),
      relationListResponseSchema,
    );
  }

  createResearchRelation(projectId: string, body: CreateEntityRelationRequest): Promise<EntityRelation> {
    return this.request('POST', researchApiRoutes.relations(projectId), entityRelationSchema, { body });
  }

  deleteResearchRelation(id: string): Promise<DeleteRelationResponse> {
    return this.request('DELETE', researchApiRoutes.relation(id), deleteRelationResponseSchema);
  }

  researchDecisions(projectId: string): Promise<ResearchDecisionListResponse> {
    return this.request('GET', researchApiRoutes.decisions(projectId), researchDecisionListResponseSchema);
  }

  createResearchDecision(projectId: string, body: CreateResearchDecisionRequest): Promise<ResearchDecision> {
    return this.request('POST', researchApiRoutes.decisions(projectId), researchDecisionSchema, { body });
  }

  researchChanges(projectId: string, query: ChangeListQuery = {}): Promise<ResearchChangeListResponse> {
    return this.request(
      'GET',
      withQuery(researchApiRoutes.changes(projectId), query),
      researchChangeListResponseSchema,
    );
  }

  createResearchChange(projectId: string, body: CreateResearchChangeRequest): Promise<ResearchChange> {
    return this.request('POST', researchApiRoutes.changes(projectId), researchChangeSchema, { body });
  }

  researchTimeline(projectId: string): Promise<TimelineListResponse> {
    return this.request('GET', researchApiRoutes.timeline(projectId), timelineListResponseSchema);
  }

  createResearchTimelineEvent(projectId: string, body: CreateTimelineEventRequest): Promise<TimelineEvent> {
    return this.request('POST', researchApiRoutes.timeline(projectId), timelineEventSchema, { body });
  }

  runResearchDriftCheck(projectId: string, body: DriftCheckRequest = {}): Promise<DriftCheckResponse> {
    return this.request('POST', researchApiRoutes.driftCheck(projectId), driftCheckResponseSchema, {
      body,
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
  }

  researchDriftFindings(
    projectId: string,
    query: DriftFindingListQuery = {},
  ): Promise<DriftFindingListResponse> {
    return this.request(
      'GET',
      withQuery(researchApiRoutes.driftFindings(projectId), query),
      driftFindingListResponseSchema,
    );
  }

  patchResearchDriftFinding(id: string, body: PatchDriftFindingRequest): Promise<DriftFinding> {
    return this.request('PATCH', researchApiRoutes.driftFinding(id), driftFindingSchema, { body });
  }

  researchMap(projectId: string): Promise<ResearchMapResponse> {
    return this.request('GET', researchApiRoutes.map(projectId), researchMapResponseSchema);
  }

  researchContextPack(projectId: string): Promise<ResearchContextPackResponse> {
    return this.request('GET', researchApiRoutes.contextPack(projectId), researchContextPackResponseSchema);
  }

  private async request<Output>(
    method: string,
    path: string,
    responseSchema: z.ZodType<Output>,
    init: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<Output> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiClientError(0, 'internal_error', describeNetworkError(error));
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await readJson(response);

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      if (parsed.success) {
        throw new ApiClientError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
      }
      throw new ApiClientError(response.status, 'internal_error', `Request failed with status ${response.status}`, payload);
    }

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      throw new ApiClientError(
        502,
        'internal_error',
        `Knowledge Core response did not match the shared contract for ${method} ${path}`,
        validated.error.issues,
      );
    }
    return validated.data;
  }
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Request timed out';
    return error.message;
  }
  return 'Network request failed';
}
