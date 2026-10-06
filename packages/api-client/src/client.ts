import { z } from 'zod';
import {
  apiErrorSchema,
  approveCharterRequestSchema,
  assignSourceRequestSchema,
  assignSourceResponseSchema,
  captureRequestSchema,
  captureResultSchema,
  charterBaselineResponseSchema,
  charterRequestSchema,
  charterResponseSchema,
  charterVersionListResponseSchema,
  charterVersionSchema,
  claimListResponseSchema,
  claimSchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
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
  driftFindingListResponseSchema,
  driftFindingSchema,
  entityRelationSchema,
  evidenceListResponseSchema,
  evidenceSchema,
  grantListResponseSchema,
  healthResponseSchema,
  inboxResponseSchema,
  issueGrantRequestSchema,
  issueGrantResponseSchema,
  knowledgeNodeSchema,
  manuscriptSectionSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
  patchClaimRequestSchema,
  patchDriftFindingRequestSchema,
  patchEvidenceRequestSchema,
  patchResearchProjectRequestSchema,
  patchResearchQuestionRequestSchema,
  patchSectionRequestSchema,
  rawSourceSchema,
  relationListResponseSchema,
  RETRYABLE_ERROR_CODES,
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
  researchReferenceQuerySchema,
  researchReferenceResponseSchema,
  researchReviewMarkSchema,
  revokeGrantResponseSchema,
  reviewMarkListResponseSchema,
  searchResponseSchema,
  sectionListResponseSchema,
  timelineEventSchema,
  timelineListResponseSchema,
  treeResponseSchema,
  type ApproveCharterRequest,
  type AssignSourceRequest,
  type AssignSourceResponse,
  type CaptureRequest,
  type CaptureResult,
  type ChangeListQuery,
  type CharterRequest,
  type CharterVersion,
  type Claim,
  type ClaimListQuery,
  type Conversation,
  type ConversationMessage,
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
  type EntityRelation,
  type Evidence,
  type EvidenceListQuery,
  type HealthResponse,
  type InboxResponse,
  type IssueGrantRequest,
  type IssueGrantResponse,
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
  type PublicGrant,
  type RawSource,
  type RelationListQuery,
  type ResearchChange,
  type ResearchCharter,
  type ResearchContextPackResponse,
  type ResearchDecision,
  type ResearchMapResponse,
  type ResearchProject,
  type ResearchQuestion,
  type ResearchReferenceMatch,
  type ResearchReferenceQuery,
  type ResearchReviewMark,
  type ReviewMarkListQuery,
  type SearchRequest,
  type SearchResponse,
  type TimelineEvent,
  type TreeQuery,
  type TreeResponse,
} from '@noltri/schema';
import { createId, nowIso } from '@noltri/shared';

/** The grant payload and response types, re-exported so a UI can build one without the schema package. */
export type { GrantScope, IssueGrantRequest, IssueGrantResponse, PublicGrant } from '@noltri/schema';
/** The 限制返回片段 bounds, re-exported as values so a panel can enforce what the Core will accept. */
export { MAX_SNIPPET_CHARS, MIN_SNIPPET_CHARS } from '@noltri/schema';

export const apiRoutes = {
  health: '/api/health',
  capture: '/api/capture',
  tree: '/api/tree',
  inbox: '/api/inbox',
  inboxSource: (id: string) => `/api/inbox/${encodeURIComponent(id)}`,
  inboxAssign: (id: string) => `/api/inbox/${encodeURIComponent(id)}/assign`,
  captureRetry: (id: string) => `/api/capture/${encodeURIComponent(id)}/retry`,
  node: (id: string) => `/api/nodes/${encodeURIComponent(id)}`,
  move: (id: string) => `/api/nodes/${encodeURIComponent(id)}/move`,
  search: '/api/search',
  nodeContext: '/api/node-context',
  chat: '/api/chat',
  conversations: '/api/conversations',
  conversationMessages: (id: string) => `/api/conversations/${encodeURIComponent(id)}/messages`,
  grants: '/api/admin/grants',
  grantRevoke: (id: string) => `/api/admin/grants/${encodeURIComponent(id)}/revoke`,
  /**
   * `/api/research/*` (research contract §1). Two shapes a caller must keep apart: the project-scoped
   * collection (`researchEvidence(projectId)`) and the row-scoped patch (`researchEvidenceItem(id)`) —
   * the Core routes them differently, so a mix-up answers `not_found` instead of the row the caller meant.
   *
   * None of these paths has a `SCOPE_BY_ACTION` entry, so a 本地客户端授权 grant is refused before it
   * reaches the handler; the desktop workbench calls them with the device credential.
   */
  researchProjects: '/api/research/projects',
  researchProject: (id: string) => `/api/research/projects/${encodeURIComponent(id)}`,
  researchCharter: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/charter`,
  researchCharterApprove: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/charter/approve`,
  researchCharterVersions: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/charter/versions`,
  researchCharterBaseline: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/charter/baseline`,
  researchReviewMarks: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/review-marks`,
  researchReviewMarkClear: (id: string) => `/api/research/review-marks/${encodeURIComponent(id)}/clear`,
  /** The one research route with no project in its path: a 出处 can be cited by several projects (R03). */
  researchReferences: '/api/research/references',
  researchQuestions: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/questions`,
  researchQuestion: (id: string) => `/api/research/questions/${encodeURIComponent(id)}`,
  researchEvidence: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/evidence`,
  researchEvidenceItem: (id: string) => `/api/research/evidence/${encodeURIComponent(id)}`,
  researchClaims: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/claims`,
  researchClaim: (id: string) => `/api/research/claims/${encodeURIComponent(id)}`,
  researchSections: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/sections`,
  researchSection: (id: string) => `/api/research/sections/${encodeURIComponent(id)}`,
  researchRelations: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/relations`,
  researchRelation: (id: string) => `/api/research/relations/${encodeURIComponent(id)}`,
  researchDecisions: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/decisions`,
  researchChanges: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/changes`,
  researchTimeline: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/timeline`,
  /** P6: 六类偏移检查与人工处理（R04/R05）+ 研究地图 / 上下文包（R07）。 */
  researchDriftCheck: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/drift-check`,
  researchDriftFindings: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/drift-findings`,
  researchDriftFinding: (id: string) => `/api/research/drift-findings/${encodeURIComponent(id)}`,
  researchMap: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/map`,
  researchContextPack: (id: string) => `/api/research/projects/${encodeURIComponent(id)}/context-pack`,
} as const;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * Whether resending can help. Read from the server envelope when it states one, otherwise derived from
   * the same shared table the server uses, so a queue and a Core never disagree about what may be resent —
   * including for a transport failure that never reached one.
   */
  readonly retryable: boolean;
  /** Correlates this failure with the line the server logged; undefined when no trace was returned. */
  readonly traceId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    envelope: { retryable?: boolean; traceId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = envelope.retryable ?? isRetryableCode(code);
    this.traceId = envelope.traceId;
  }
}

/** Codes the shared table marks as worth resending; a code the client does not know is not retryable. */
function isRetryableCode(code: string): boolean {
  const retryable: ReadonlySet<string> = RETRYABLE_ERROR_CODES;
  return retryable.has(code);
}

/**
 * `?a=&b=` from the set half of a query object, or `''` when nothing was asked for. The knowledge
 * calls build their query strings inline; the research surface has enough of them that the rule
 * 'never send an empty key' deserves one place instead of six copies.
 */
function searchSuffix(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix.length === 0 ? '' : `?${suffix}`;
}

/**
 * Check a write payload against the shared contract before the network call, so a form that produced
 * an unsendable 章程 or 证据 gets the zod issues back from the caller's own stack instead of a
 * round-trip to a Core that would reject it anyway.
 */
function validatedRequest<Output>(schema: z.ZodType<Output>, request: unknown, label: string): Output {
  const validated = schema.safeParse(request);
  if (!validated.success) {
    throw new ApiClientError(400, 'invalid_request', `${label} payload is not sendable`, validated.error.issues);
  }
  return validated.data;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token: Supabase JWT in the web app, device token for extension/desktop. */
  token?: string;
  /**
   * Which entry point is calling. The core writes it onto version records for provenance; it is a
   * display hint only and never selects a user.
   */
  clientHint?: 'extension' | 'desktop' | 'mcp' | 'web_app';
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
  /**
   * The idempotency key. A caller that has none — a button press — gets a generated one; a caller that is
   * resending from a queue MUST pass the key it stored, or the resend becomes a second capture.
   */
  requestId?: string;
}

export function buildCaptureRequest(input: BuildCaptureRequestInput): CaptureRequest {
  return {
    requestId: input.requestId ?? createId(),
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
  private readonly clientHint?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.clientHint = options.clientHint;
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

  /** 收件箱 feed. `status` is comma-separated, matching the server's query contract. */
  inbox(query: { status?: string; limit?: number; offset?: number } = {}): Promise<InboxResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const suffix = params.toString();
    return this.request('GET', `${apiRoutes.inbox}${suffix ? `?${suffix}` : ''}`, inboxResponseSchema);
  }

  rawSource(id: string): Promise<RawSource> {
    return this.request('GET', apiRoutes.inboxSource(id), rawSourceSchema);
  }

  assignSource(rawSourceId: string, request: AssignSourceRequest): Promise<AssignSourceResponse> {
    const validated = assignSourceRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Assign payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.inboxAssign(rawSourceId), assignSourceResponseSchema, { body: validated.data });
  }

  /**
   * Re-run the compile pipeline for a saved capture. Body-less POST: the server already owns the text,
   * so a retry can never resend content the user did not capture.
   */
  retryCapture(rawSourceId: string): Promise<CaptureResult> {
    return this.request('POST', apiRoutes.captureRetry(rawSourceId), captureResultSchema);
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

  /** Threads Core kept for this caller, optionally narrowed to one node. */
  async conversations(nodeId?: string): Promise<Conversation[]> {
    const suffix = nodeId === undefined ? '' : `?nodeId=${encodeURIComponent(nodeId)}`;
    const result = await this.request('GET', `${apiRoutes.conversations}${suffix}`, conversationListResponseSchema);
    return result.conversations;
  }

  /** The stored transcript, in the order Knowledge Core wrote it. */
  async conversationMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.request(
      'GET',
      apiRoutes.conversationMessages(conversationId),
      conversationMessagesResponseSchema,
    );
    return result.messages;
  }

  /**
   * 连接中心's list: every local client this Core knows, its scopes and whether it is still live.
   * Deliberately credential-free, so a screenshot of this panel never leaks a key.
   */
  async grants(): Promise<PublicGrant[]> {
    return (await this.request('GET', apiRoutes.grants, grantListResponseSchema)).grants;
  }

  /**
   * Mint a per-client credential. The plaintext `secret` exists in this one response only — the store
   * keeps a digest, so there is no call that reads a live key back.
   */
  issueGrant(request: IssueGrantRequest): Promise<IssueGrantResponse> {
    const validated = issueGrantRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Grant payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.grants, issueGrantResponseSchema, { body: validated.data });
  }

  /** Revocation is immediate: a connection that is already open fails on its next request. */
  async revokeGrant(id: string): Promise<PublicGrant> {
    return (await this.request('POST', apiRoutes.grantRevoke(id), revokeGrantResponseSchema)).grant;
  }

  // --- 研究项目 / 章程 / 复核标记 / 引用检查 (research contract §1) ---------------------------------

  async researchProjects(): Promise<ResearchProject[]> {
    return (await this.request('GET', apiRoutes.researchProjects, researchProjectListResponseSchema)).projects;
  }

  createResearchProject(request: CreateResearchProjectRequest): Promise<ResearchProject> {
    return this.request('POST', apiRoutes.researchProjects, researchProjectSchema, {
      body: validatedRequest(createResearchProjectRequestSchema, request, 'research project'),
    });
  }

  researchProject(projectId: string): Promise<ResearchProject> {
    return this.request('GET', apiRoutes.researchProject(projectId), researchProjectSchema);
  }

  patchResearchProject(projectId: string, request: PatchResearchProjectRequest): Promise<ResearchProject> {
    return this.request('PATCH', apiRoutes.researchProject(projectId), researchProjectSchema, {
      body: validatedRequest(patchResearchProjectRequestSchema, request, 'research project patch'),
    });
  }

  /** A project without a 章程 is a normal state: this answers `null`, not an error. */
  async researchCharter(projectId: string): Promise<ResearchCharter | null> {
    return (await this.request('GET', apiRoutes.researchCharter(projectId), charterResponseSchema)).charter;
  }

  /** PUT is an upsert here — one 章程 row per project. Approving is a separate call (R06). */
  saveResearchCharter(projectId: string, request: CharterRequest): Promise<ResearchCharter> {
    return this.request('PUT', apiRoutes.researchCharter(projectId), researchCharterSchema, {
      body: validatedRequest(charterRequestSchema, request, 'charter'),
    });
  }

  /**
   * 批准 freezes the current draft as an append-only version and marks the objects the caller named.
   * It does not lock the draft: the 章程 stays editable after approval.
   */
  approveResearchCharter(projectId: string, request: ApproveCharterRequest): Promise<CharterVersion> {
    return this.request('POST', apiRoutes.researchCharterApprove(projectId), charterVersionSchema, {
      body: validatedRequest(approveCharterRequestSchema, request, 'charter approval'),
    });
  }

  async researchCharterVersions(projectId: string): Promise<CharterVersion[]> {
    return (await this.request('GET', apiRoutes.researchCharterVersions(projectId), charterVersionListResponseSchema))
      .versions;
  }

  /** The version later checks bind to; `null` until the first 批准. */
  async researchCharterBaseline(projectId: string): Promise<CharterVersion | null> {
    return (await this.request('GET', apiRoutes.researchCharterBaseline(projectId), charterBaselineResponseSchema))
      .baseline;
  }

  async researchReviewMarks(
    projectId: string,
    query: ReviewMarkListQuery = {},
  ): Promise<ResearchReviewMark[]> {
    const suffix = searchSuffix(query);
    return (await this.request('GET', `${apiRoutes.researchReviewMarks(projectId)}${suffix}`, reviewMarkListResponseSchema))
      .marks;
  }

  /** Clearing writes `status='cleared'`; the row stays — it is the record of when the mark was handled. */
  clearResearchReviewMark(markId: string): Promise<ResearchReviewMark> {
    return this.request('POST', apiRoutes.researchReviewMarkClear(markId), researchReviewMarkSchema);
  }

  /**
   * 「这个出处被谁引用了」 — the read-only check to make before archiving a node or a capture (R03).
   * Refused before the network when neither id is given: a filter-less reference query is a
   * cross-project table scan wearing the clothes of a check.
   */
  async researchReferences(query: ResearchReferenceQuery): Promise<ResearchReferenceMatch[]> {
    const validated = researchReferenceQuerySchema.safeParse(query);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Reference query is not sendable', validated.error.issues);
    }
    const suffix = searchSuffix(validated.data);
    return (await this.request('GET', `${apiRoutes.researchReferences}${suffix}`, researchReferenceResponseSchema))
      .references;
  }

  // --- 研究问题 / 证据 / 论点 / 章节 ----------------------------------------------------------------

  async researchQuestions(projectId: string): Promise<ResearchQuestion[]> {
    return (await this.request('GET', apiRoutes.researchQuestions(projectId), researchQuestionListResponseSchema))
      .questions;
  }

  createResearchQuestion(projectId: string, request: CreateResearchQuestionRequest): Promise<ResearchQuestion> {
    return this.request('POST', apiRoutes.researchQuestions(projectId), researchQuestionSchema, {
      body: validatedRequest(createResearchQuestionRequestSchema, request, 'research question'),
    });
  }

  patchResearchQuestion(questionId: string, request: PatchResearchQuestionRequest): Promise<ResearchQuestion> {
    return this.request('PATCH', apiRoutes.researchQuestion(questionId), researchQuestionSchema, {
      body: validatedRequest(patchResearchQuestionRequestSchema, request, 'research question patch'),
    });
  }

  async researchEvidence(projectId: string, query: EvidenceListQuery = {}): Promise<Evidence[]> {
    const suffix = searchSuffix(query);
    return (await this.request('GET', `${apiRoutes.researchEvidence(projectId)}${suffix}`, evidenceListResponseSchema))
      .evidence;
  }

  createResearchEvidence(projectId: string, request: CreateEvidenceRequest): Promise<Evidence> {
    return this.request('POST', apiRoutes.researchEvidence(projectId), evidenceSchema, {
      body: validatedRequest(createEvidenceRequestSchema, request, 'evidence'),
    });
  }

  patchResearchEvidence(evidenceId: string, request: PatchEvidenceRequest): Promise<Evidence> {
    return this.request('PATCH', apiRoutes.researchEvidenceItem(evidenceId), evidenceSchema, {
      body: validatedRequest(patchEvidenceRequestSchema, request, 'evidence patch'),
    });
  }

  async researchClaims(projectId: string, query: ClaimListQuery = {}): Promise<Claim[]> {
    const suffix = searchSuffix(query);
    return (await this.request('GET', `${apiRoutes.researchClaims(projectId)}${suffix}`, claimListResponseSchema))
      .claims;
  }

  createResearchClaim(projectId: string, request: CreateClaimRequest): Promise<Claim> {
    return this.request('POST', apiRoutes.researchClaims(projectId), claimSchema, {
      body: validatedRequest(createClaimRequestSchema, request, 'claim'),
    });
  }

  patchResearchClaim(claimId: string, request: PatchClaimRequest): Promise<Claim> {
    return this.request('PATCH', apiRoutes.researchClaim(claimId), claimSchema, {
      body: validatedRequest(patchClaimRequestSchema, request, 'claim patch'),
    });
  }

  async researchSections(projectId: string): Promise<ManuscriptSection[]> {
    return (await this.request('GET', apiRoutes.researchSections(projectId), sectionListResponseSchema)).sections;
  }

  createResearchSection(projectId: string, request: CreateSectionRequest): Promise<ManuscriptSection> {
    return this.request('POST', apiRoutes.researchSections(projectId), manuscriptSectionSchema, {
      body: validatedRequest(createSectionRequestSchema, request, 'section'),
    });
  }

  patchResearchSection(sectionId: string, request: PatchSectionRequest): Promise<ManuscriptSection> {
    return this.request('PATCH', apiRoutes.researchSection(sectionId), manuscriptSectionSchema, {
      body: validatedRequest(patchSectionRequestSchema, request, 'section patch'),
    });
  }

  // --- 关系 / 决策 / 变更 / 时间线 ------------------------------------------------------------------

  async researchRelations(projectId: string, query: RelationListQuery = {}): Promise<EntityRelation[]> {
    const suffix = searchSuffix(query);
    return (await this.request('GET', `${apiRoutes.researchRelations(projectId)}${suffix}`, relationListResponseSchema))
      .relations;
  }

  /** The direction is part of the meaning (R02): a rejected pairing is a server-side `invalid_request`. */
  createResearchRelation(projectId: string, request: CreateEntityRelationRequest): Promise<EntityRelation> {
    return this.request('POST', apiRoutes.researchRelations(projectId), entityRelationSchema, {
      body: validatedRequest(createEntityRelationRequestSchema, request, 'relation'),
    });
  }

  deleteResearchRelation(relationId: string): Promise<DeleteRelationResponse> {
    return this.request('DELETE', apiRoutes.researchRelation(relationId), deleteRelationResponseSchema);
  }

  async researchDecisions(projectId: string): Promise<ResearchDecision[]> {
    return (await this.request('GET', apiRoutes.researchDecisions(projectId), researchDecisionListResponseSchema))
      .decisions;
  }

  /** Append-only: a wrong 决策 is answered by another 决策, never by an edit (contract §0 rule 3). */
  createResearchDecision(projectId: string, request: CreateResearchDecisionRequest): Promise<ResearchDecision> {
    return this.request('POST', apiRoutes.researchDecisions(projectId), researchDecisionSchema, {
      body: validatedRequest(createResearchDecisionRequestSchema, request, 'research decision'),
    });
  }

  async researchChanges(projectId: string, query: ChangeListQuery = {}): Promise<ResearchChange[]> {
    const suffix = searchSuffix(query);
    return (await this.request('GET', `${apiRoutes.researchChanges(projectId)}${suffix}`, researchChangeListResponseSchema))
      .changes;
  }

  createResearchChange(projectId: string, request: CreateResearchChangeRequest): Promise<ResearchChange> {
    return this.request('POST', apiRoutes.researchChanges(projectId), researchChangeSchema, {
      body: validatedRequest(createResearchChangeRequestSchema, request, 'research change'),
    });
  }

  /** Newest first: the server orders by `occurredAt` descending. */
  async researchTimeline(projectId: string): Promise<TimelineEvent[]> {
    return (await this.request('GET', apiRoutes.researchTimeline(projectId), timelineListResponseSchema)).events;
  }

  /** A 里程碑 is the only hand-written timeline entry; 决策 and 变更 write their own row on creation. */
  createResearchMilestone(projectId: string, request: CreateTimelineEventRequest): Promise<TimelineEvent> {
    return this.request('POST', apiRoutes.researchTimeline(projectId), timelineEventSchema, {
      body: validatedRequest(createTimelineEventRequestSchema, request, 'timeline event'),
    });
  }

  // --- P6: 六类偏移检查 / 研究地图 / 上下文包 --------------------------------------------------------

  /** Deterministic rules, no model call (contract §5); a re-run merges into the still-open findings. */
  researchDriftCheck(projectId: string, request: DriftCheckRequest = {}): Promise<DriftCheckResponse> {
    return this.request('POST', apiRoutes.researchDriftCheck(projectId), driftCheckResponseSchema, {
      body: validatedRequest(driftCheckRequestSchema, request, 'drift check'),
    });
  }

  async researchDriftFindings(projectId: string, query: DriftFindingListQuery = {}): Promise<DriftFinding[]> {
    const suffix = searchSuffix(query);
    return (
      await this.request('GET', `${apiRoutes.researchDriftFindings(projectId)}${suffix}`, driftFindingListResponseSchema)
    ).findings;
  }

  /**
   * Only `status` moves — a finding is closed by acknowledging it, never by deleting the row
   * (`drift_findings` 与 knowledge 侧一样是台账).
   */
  patchResearchDriftFinding(findingId: string, request: PatchDriftFindingRequest): Promise<DriftFinding> {
    return this.request('PATCH', apiRoutes.researchDriftFinding(findingId), driftFindingSchema, {
      body: validatedRequest(patchDriftFindingRequestSchema, request, 'drift finding patch'),
    });
  }

  /** Layers + edges only: the server never lays the graph out, the UI decides how to draw it (§12). */
  researchMap(projectId: string): Promise<ResearchMapResponse> {
    return this.request('GET', apiRoutes.researchMap(projectId), researchMapResponseSchema);
  }

  /** The twelve-block snapshot (contract §5). `markdown` carries the same content as `blocks`. */
  researchContextPack(projectId: string): Promise<ResearchContextPackResponse> {
    return this.request('GET', apiRoutes.researchContextPack(projectId), researchContextPackResponseSchema);
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
    if (this.clientHint) headers['x-noltri-client'] = this.clientHint;

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
        throw new ApiClientError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
          { retryable: parsed.data.error.retryable, traceId: parsed.data.error.traceId },
        );
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
