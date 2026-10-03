import { z } from 'zod';
import {
  apiErrorSchema,
  captureRequestSchema,
  captureResultSchema,
  healthResponseSchema,
  knowledgeNodeSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
  searchResponseSchema,
  treeResponseSchema,
  type CaptureRequest,
  type CaptureResult,
  type HealthResponse,
  type KnowledgeNode,
  type MoveNodeRequest,
  type MoveNodeResponse,
  type NodeChatRequest,
  type NodeChatResponse,
  type NodeContext,
  type NodeContextRequest,
  type NodeDetail,
  type PatchNodeRequest,
  type SearchRequest,
  type SearchResponse,
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
