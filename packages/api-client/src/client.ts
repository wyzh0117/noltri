import { z } from 'zod';
import {
  apiErrorSchema,
  assignSourceRequestSchema,
  assignSourceResponseSchema,
  captureRequestSchema,
  captureResultSchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  healthResponseSchema,
  grantListResponseSchema,
  inboxResponseSchema,
  issueGrantRequestSchema,
  issueGrantResponseSchema,
  knowledgeNodeSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
  rawSourceSchema,
  RETRYABLE_ERROR_CODES,
  revokeGrantResponseSchema,
  searchResponseSchema,
  treeResponseSchema,
  type AssignSourceRequest,
  type AssignSourceResponse,
  type CaptureRequest,
  type CaptureResult,
  type Conversation,
  type ConversationMessage,
  type HealthResponse,
  type InboxResponse,
  type IssueGrantRequest,
  type IssueGrantResponse,
  type KnowledgeNode,
  type MoveNodeRequest,
  type MoveNodeResponse,
  type NodeChatRequest,
  type NodeChatResponse,
  type NodeContext,
  type NodeContextRequest,
  type NodeDetail,
  type PatchNodeRequest,
  type PublicGrant,
  type RawSource,
  type SearchRequest,
  type SearchResponse,
  type TreeQuery,
  type TreeResponse,
} from '@noltri/schema';
import { createId, nowIso } from '@noltri/shared';

/** The grant payload and response types, re-exported so a UI can build one without the schema package. */
export type { GrantScope, IssueGrantRequest, IssueGrantResponse, PublicGrant } from '@noltri/schema';

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
