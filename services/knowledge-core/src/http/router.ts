/**
 * HTTP layer in web standards only — no express, no fastify.
 *
 * The same `handle(request: Request): Promise<Response>` runs inside a node:http server (see
 * `src/server.ts`) and inside a Next.js route handler (`apps/web`), which is what keeps one Knowledge
 * Core deployable on Vercel today and embeddable in a Desktop Local Core later.
 */
import type { z } from 'zod';
import {
  captureRequestSchema,
  moveNodeRequestSchema,
  nodeChatRequestSchema,
  nodeContextRequestSchema,
  patchNodeRequestSchema,
  searchRequestSchema,
  treeQuerySchema,
  type CaptureRequest,
  type MoveNodeRequest,
  type NodeChatRequest,
  type NodeContextRequest,
  type PatchNodeRequest,
  type SearchRequest,
  type TreeQuery,
} from '@noltri/schema';
import { asKnowledgeError, knowledgeError, type Logger } from '@noltri/shared';
import type { CoreConfig } from '../config';
import type { Identity } from '../auth';
import { resolveIdentity as defaultResolveIdentity } from '../auth';
import type { KnowledgeCore } from '../core';

export type RequestHandler = (request: Request) => Promise<Response>;

export interface RouterDeps {
  core: KnowledgeCore;
  config: CoreConfig;
  logger?: Logger;
  /** Injectable so a host with its own auth can swap the strategy; identity still never comes from the body. */
  identityResolver?: (request: Request, config: CoreConfig, logger?: Logger) => Promise<Identity>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
}

/** `:param` positions are matched by shape, not by a route library. */
const ROUTES: Route[] = [
  { method: 'GET', segments: ['api', 'health'] },
  { method: 'POST', segments: ['api', 'capture'] },
  { method: 'GET', segments: ['api', 'tree'] },
  { method: 'GET', segments: ['api', 'nodes', ':id'] },
  { method: 'PATCH', segments: ['api', 'nodes', ':id'] },
  { method: 'POST', segments: ['api', 'nodes', ':id', 'move'] },
  { method: 'POST', segments: ['api', 'search'] },
  { method: 'POST', segments: ['api', 'node-context'] },
  { method: 'POST', segments: ['api', 'chat'] },
  { method: 'GET', segments: ['api', 'conversations'] },
  { method: 'GET', segments: ['api', 'conversations', ':id', 'messages'] },
  { method: 'POST', segments: ['api', 'capture', ':id', 'retry'] },
];

function matchesShape(route: readonly string[], actual: readonly string[]): boolean {
  if (route.length !== actual.length) return false;
  return route.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
}

function paramAt(route: readonly string[], actual: readonly string[], name: string): string {
  const index = route.indexOf(`:${name}`);
  return index >= 0 ? String(actual[index]) : '';
}

function corsHeaders(config: CoreConfig, request: Request): Record<string, string> {
  const requested = request.headers.get('origin');
  const wildcard = config.corsOrigin === '*';
  const origin = wildcard ? '*' : requested !== null && config.corsOrigin.split(',').includes(requested) ? requested : config.corsOrigin;
  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-noltri-client',
    'access-control-max-age': '600',
  };
  if (!wildcard) headers.vary = 'origin';
  return headers;
}

function json(status: number, payload: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, ...JSON_HEADERS } });
}

function parseWith<Output>(schema: z.ZodType<Output>, body: unknown, label: string): Output {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw knowledgeError('invalid_request', `${label} 请求体校验失败 / ${label} payload failed validation`, parsed.error.issues);
  }
  return parsed.data;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw knowledgeError('invalid_request', '请求体必须是 JSON 对象 / an empty body is not accepted');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw knowledgeError('invalid_request', '请求体不是合法 JSON / body is not valid JSON');
  }
}

export function createRequestHandler(deps: RouterDeps): RequestHandler {
  const { core, config } = deps;
  const logger = deps.logger;
  const resolve = deps.identityResolver ?? ((request, cfg) => defaultResolveIdentity(request, cfg, logger));

  return async function handle(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url, 'http://noltri.local');
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter((segment) => segment.length > 0);
    const method = request.method.toUpperCase();
    const cors = corsHeaders(config, request);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const shapeMatches = ROUTES.filter((candidate) => matchesShape(candidate.segments, segments));
    const route = shapeMatches.find((candidate) => candidate.method === method);

    if (route === undefined) {
      if (shapeMatches.length === 0) {
        return json(404, knowledgeError('not_found', `未知端点 ${url.pathname} / unknown endpoint`).toJSON(), cors);
      }
      const allowed = shapeMatches.map((candidate) => candidate.method).join(', ');
      return json(
        405,
        knowledgeError('invalid_request', `${url.pathname} 仅支持 ${allowed} / method not allowed`).toJSON(),
        cors,
      );
    }

    try {
      const payload = await dispatch({
        route: route.segments,
        segments,
        url,
        request,
        core,
        config,
        resolve,
        cors,
      });
      return payload ?? json(200, { ok: true }, cors);
    } catch (error) {
      const mapped = asKnowledgeError(error);
      if (logger) {
        logger.warn('request failed', {
          method,
          path: url.pathname,
          code: mapped.code,
          status: mapped.status,
          ms: Date.now() - startedAt,
        });
      }
      // Envelope only: no stack, no internals.
      return json(mapped.status, mapped.toJSON(), cors);
    }
  };
}

interface DispatchArgs {
  route: readonly string[];
  segments: readonly string[];
  url: URL;
  request: Request;
  core: KnowledgeCore;
  config: CoreConfig;
  resolve: (request: Request, config: CoreConfig, logger?: Logger) => Promise<Identity>;
  cors: Record<string, string>;
}

async function dispatch(args: DispatchArgs): Promise<Response | undefined> {
  const { route, segments, url, request, core, config, resolve, cors } = args;
  const path = route.join('/');

  // Health is the one public endpoint: platforms probe it before any credential exists.
  if (path === 'api/health') {
    return json(200, core.health(), cors);
  }

  const identity = await resolve(request, config);
  const actor = { userId: identity.userId, actor: identity.actor };

  switch (path) {
    case 'api/capture': {
      const payload = parseWith(captureRequestSchema, await readJsonBody(request), 'capture');
      return json(200, await core.capture(payload satisfies CaptureRequest, actor), cors);
    }
    case 'api/tree': {
      const query = parseWith(treeQuerySchema, Object.fromEntries(url.searchParams), 'tree query');
      return json(200, await core.getTree(query satisfies TreeQuery, actor), cors);
    }
    case 'api/nodes/:id': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, await core.getNodeDetail(id, actor), cors);
      }
      const patch = parseWith(patchNodeRequestSchema, await readJsonBody(request), 'patch node');
      return json(200, await core.patchNode(id, patch satisfies PatchNodeRequest, actor), cors);
    }
    case 'api/nodes/:id/move': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      const body = parseWith(moveNodeRequestSchema, await readJsonBody(request), 'move node');
      return json(200, await core.moveNode(id, body satisfies MoveNodeRequest, actor), cors);
    }
    case 'api/search': {
      const body = parseWith(searchRequestSchema, await readJsonBody(request), 'search');
      return json(200, await core.search(body satisfies SearchRequest, actor), cors);
    }
    case 'api/node-context': {
      const body = parseWith(nodeContextRequestSchema, await readJsonBody(request), 'node context');
      return json(200, await core.buildNodeContext(body satisfies NodeContextRequest, actor), cors);
    }
    case 'api/chat': {
      const body = parseWith(nodeChatRequestSchema, await readJsonBody(request), 'chat');
      return json(200, await core.chat(body satisfies NodeChatRequest, actor), cors);
    }
    case 'api/conversations': {
      const nodeId = url.searchParams.get('nodeId') ?? undefined;
      return json(200, { conversations: await core.listConversations(actor, nodeId) }, cors);
    }
    case 'api/conversations/:id/messages': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      return json(200, { messages: await core.listConversationMessages(id, actor) }, cors);
    }
    case 'api/capture/:id/retry': {
      const rawSourceId = decodeURIComponent(paramAt(route, segments, 'id'));
      return json(200, await core.retryCapture(rawSourceId, actor), cors);
    }
    default:
      return undefined;
  }
}
