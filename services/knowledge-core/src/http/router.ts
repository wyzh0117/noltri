/**
 * HTTP layer in web standards only — no express, no fastify.
 *
 * The same `handle(request: Request): Promise<Response>` runs inside a node:http server (see
 * `src/server.ts`) and inside the MCP stdio transport, which is what keeps one Knowledge Core
 * embeddable in the desktop build without a hosting runtime.
 */
import {
  assignSourceRequestSchema,
  captureRequestSchema,
  inboxQuerySchema,
  moveNodeRequestSchema,
  nodeChatRequestSchema,
  nodeContextRequestSchema,
  patchNodeRequestSchema,
  searchRequestSchema,
  treeQuerySchema,
  type AssignSourceRequest,
  type CaptureRequest,
  type InboxQuery,
  type MoveNodeRequest,
  type NodeChatRequest,
  type NodeContextRequest,
  type PatchNodeRequest,
  type SearchRequest,
  type TreeQuery,
} from '@noltri/schema';
import { asKnowledgeError, createId, errorResponseBody, knowledgeError, type Logger } from '@noltri/shared';
import type { CoreConfig } from '../config';
import { resolveIdentity as defaultResolveIdentity, type IdentityResolver } from '../auth';
import { requireNodeAccess, requireScope, type GrantStore } from '../authorization';
import type { KnowledgeCore } from '../core';
import type { ActorContext } from '../types';
import { handleAdminGrants } from './admin';
import { parseWith, readJsonBody } from './parse';
import { handleResearch } from './research';

export type RequestHandler = (request: Request) => Promise<Response>;

export interface RouterDeps {
  core: KnowledgeCore;
  config: CoreConfig;
  logger?: Logger;
  /** Injectable so a host with its own auth can swap the strategy; identity still never comes from the body. */
  identityResolver?: IdentityResolver;
  /** Presence of a store is what turns 连接中心's own endpoints on. */
  grants?: GrantStore | null;
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
  { method: 'GET', segments: ['api', 'inbox'] },
  { method: 'GET', segments: ['api', 'inbox', ':id'] },
  { method: 'POST', segments: ['api', 'inbox', ':id', 'assign'] },
  { method: 'GET', segments: ['api', 'nodes', ':id'] },
  { method: 'PATCH', segments: ['api', 'nodes', ':id'] },
  { method: 'POST', segments: ['api', 'nodes', ':id', 'move'] },
  { method: 'POST', segments: ['api', 'search'] },
  { method: 'POST', segments: ['api', 'node-context'] },
  { method: 'POST', segments: ['api', 'chat'] },
  { method: 'GET', segments: ['api', 'conversations'] },
  { method: 'GET', segments: ['api', 'conversations', ':id', 'messages'] },
  { method: 'POST', segments: ['api', 'capture', ':id', 'retry'] },
  // 连接中心: the device credential manages the clients, and no client manages itself.
  { method: 'GET', segments: ['api', 'admin', 'grants'] },
  { method: 'POST', segments: ['api', 'admin', 'grants'] },
  { method: 'POST', segments: ['api', 'admin', 'grants', ':id', 'revoke'] },
  // Research chain: 章程 → 研究问题 → 证据 → 论点 → 章节, plus 关系 / 决策 / 变更 / 时间线 (contract §1).
  // Every shape carries at most one `:`-segment, which is what lets the router hand `research.ts` one id.
  { method: 'GET', segments: ['api', 'research', 'projects'] },
  { method: 'POST', segments: ['api', 'research', 'projects'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId'] },
  { method: 'PATCH', segments: ['api', 'research', 'projects', ':projectId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'charter'] },
  { method: 'PUT', segments: ['api', 'research', 'projects', ':projectId', 'charter'] },
  // 批准的基线与复核标记 (P5-C, R06/R03): 批准追加不可变快照，影响对象被标记，处理完只改状态。
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'charter', 'approve'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'charter', 'versions'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'charter', 'baseline'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'review-marks'] },
  { method: 'POST', segments: ['api', 'research', 'review-marks', ':markId', 'clear'] },
  // 归档/删除前检查研究引用 (R03): read-only, and it spans projects, so it is keyed by the source, not a project.
  { method: 'GET', segments: ['api', 'research', 'references'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'questions'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'questions'] },
  { method: 'PATCH', segments: ['api', 'research', 'questions', ':questionId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'evidence'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'evidence'] },
  { method: 'PATCH', segments: ['api', 'research', 'evidence', ':evidenceId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'claims'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'claims'] },
  { method: 'PATCH', segments: ['api', 'research', 'claims', ':claimId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'sections'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'sections'] },
  { method: 'PATCH', segments: ['api', 'research', 'sections', ':sectionId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'relations'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'relations'] },
  { method: 'DELETE', segments: ['api', 'research', 'relations', ':relationId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'decisions'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'decisions'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'changes'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'changes'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'timeline'] },
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'timeline'] },
  // P6: 六类偏移检查与人工处理（R04/R05）+ 研究地图 / 上下文包（R07）。全部沿用单 `:`-段形状。
  { method: 'POST', segments: ['api', 'research', 'projects', ':projectId', 'drift-check'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'drift-findings'] },
  { method: 'PATCH', segments: ['api', 'research', 'drift-findings', ':findingId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'map'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'context-pack'] },
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
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-noltri-client',
    'access-control-max-age': '600',
  };
  if (!wildcard) headers.vary = 'origin';
  return headers;
}

function json(status: number, payload: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, ...JSON_HEADERS } });
}

export function createRequestHandler(deps: RouterDeps): RequestHandler {
  const { core, config } = deps;
  const logger = deps.logger;
  const grants = deps.grants ?? null;
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
        return json(404, errorResponseBody(knowledgeError('not_found', `未知端点 ${url.pathname} / unknown endpoint`), createId()), cors);
      }
      const allowed = shapeMatches.map((candidate) => candidate.method).join(', ');
      return json(
        405,
        errorResponseBody(
          knowledgeError('invalid_request', `${url.pathname} 仅支持 ${allowed} / method not allowed`),
          createId(),
        ),
        cors,
      );
    }

    try {
      const payload = await dispatch({
        route: route.segments,
        segments,
        method,
        url,
        request,
        core,
        config,
        grants,
        resolve,
        cors,
      });
      return payload ?? json(200, { ok: true }, cors);
    } catch (error) {
      const mapped = asKnowledgeError(error);
      // One id per failed attempt: it goes into the envelope and into the log line, so a client's report
      // and the server's record of that report are the same event.
      const traceId = createId();
      mapped.traceId ??= traceId;
      if (logger) {
        logger.warn('request failed', {
          method,
          path: url.pathname,
          code: mapped.code,
          status: mapped.status,
          retryable: mapped.retryable,
          traceId,
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
  /** Uppercased HTTP verb, already matched against ROUTES; scope checks key on method + path. */
  method: string;
  url: URL;
  request: Request;
  core: KnowledgeCore;
  config: CoreConfig;
  grants: GrantStore | null;
  resolve: IdentityResolver;
  cors: Record<string, string>;
}

async function dispatch(args: DispatchArgs): Promise<Response | undefined> {
  const { route, segments, method, url, request, core, config, grants, resolve, cors } = args;
  const path = route.join('/');

  // Health is the one public endpoint: platforms probe it before any credential exists.
  if (path === 'api/health') {
    return json(200, core.health(), cors);
  }

  const identity = await resolve(request, config);
  const grant = identity.grant;
  // Cheap rejection before any body is read: the credential decides what this client may do at all.
  requireScope(grant, method, path);
  // §435 限制返回片段 rides on the actor, so every read service cuts the text it hands back. The device
  // credential and the legacy path carry no cap: 收件箱 triage has to be able to see the whole capture.
  const snippetChars = grant?.snippetChars ?? undefined;
  const actor: ActorContext = {
    userId: identity.userId,
    actor: identity.actor,
    ...(snippetChars === undefined ? {} : { snippetChars }),
  };

  if (path === 'api/admin/grants' || path === 'api/admin/grants/:id/revoke') {
    return json(
      200,
      await handleAdminGrants({
        method,
        path,
        identity,
        store: grants,
        ...(path === 'api/admin/grants/:id/revoke' ? { id: decodeURIComponent(paramAt(route, segments, 'id')) } : {}),
        body: method === 'POST' && path === 'api/admin/grants' ? await readJsonBody(request) : undefined,
      }),
      cors,
    );
  }

  // Research runs through its own handler module. The scope check above is what keeps a granted client
  // out of it: no `api/research/*` path has a SCOPE_BY_ACTION entry, so a grant is refused here with
  // `route_not_granted` while the device credential the desktop workbench uses passes through.
  if (path.startsWith('api/research')) {
    const index = route.findIndex((segment) => segment.startsWith(':'));
    return json(
      200,
      await handleResearch({
        method,
        path,
        url,
        request,
        userId: actor.userId,
        domain: core.research,
        id: index < 0 ? '' : decodeURIComponent(segments[index] ?? ''),
      }),
      cors,
    );
  }

  switch (path) {
    case 'api/capture': {
      // 自动归类 picks the node, so a client limited to specific projects cannot capture: it would write
      // wherever the classifier decided. It files through the inbox or gets a 全部项目 grant instead.
      requireNodeAccess(grant, null, '自动归类写入');
      const payload = parseWith(captureRequestSchema, await readJsonBody(request), 'capture');
      return json(200, await core.capture(payload satisfies CaptureRequest, actor), cors);
    }
    case 'api/tree': {
      const query = parseWith(treeQuerySchema, Object.fromEntries(url.searchParams), 'tree query');
      requireNodeAccess(grant, query.rootId ?? null, '整棵知识树');
      return json(200, await core.getTree(query satisfies TreeQuery, actor), cors);
    }
    case 'api/inbox': {
      const query = parseWith(inboxQuerySchema, Object.fromEntries(url.searchParams), 'inbox query');
      requireNodeAccess(grant, null, '收件箱列表');
      return json(200, await core.listInbox(query satisfies InboxQuery, actor), cors);
    }
    case 'api/inbox/:id': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      requireNodeAccess(grant, null, '收件箱原文');
      const source = await core.readRawSource(id, actor);
      if (source === null) throw knowledgeError('not_found', `原文 ${id} 不存在 / raw source not found`);
      return json(200, source, cors);
    }
    case 'api/inbox/:id/assign': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      const body = parseWith(assignSourceRequestSchema, await readJsonBody(request), 'assign source');
      requireNodeAccess(grant, body.nodeId, '归档目标项目');
      return json(200, await core.assignSource(id, body satisfies AssignSourceRequest, actor), cors);
    }
    case 'api/nodes/:id': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      requireNodeAccess(grant, id, '节点');
      if (request.method.toUpperCase() === 'GET') {
        return json(200, await core.getNodeDetail(id, actor), cors);
      }
      const patch = parseWith(patchNodeRequestSchema, await readJsonBody(request), 'patch node');
      return json(200, await core.patchNode(id, patch satisfies PatchNodeRequest, actor), cors);
    }
    case 'api/nodes/:id/move': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      const body = parseWith(moveNodeRequestSchema, await readJsonBody(request), 'move node');
      requireNodeAccess(grant, id, '被移动的节点');
      // Both ends of a move have to be inside the grant: reparenting out of an authorised project is a
      // write to the project it lands in.
      requireNodeAccess(grant, body.targetParentId, '移动目标项目');
      return json(200, await core.moveNode(id, body satisfies MoveNodeRequest, actor), cors);
    }
    case 'api/search': {
      const body = parseWith(searchRequestSchema, await readJsonBody(request), 'search');
      requireNodeAccess(grant, body.scopeNodeId ?? null, '全库检索');
      return json(200, await core.search(body satisfies SearchRequest, actor), cors);
    }
    case 'api/node-context': {
      const body = parseWith(nodeContextRequestSchema, await readJsonBody(request), 'node context');
      requireNodeAccess(grant, body.nodeId, '上下文范围');
      return json(200, await core.buildNodeContext(body satisfies NodeContextRequest, actor), cors);
    }
    case 'api/chat': {
      const body = parseWith(nodeChatRequestSchema, await readJsonBody(request), 'chat');
      requireNodeAccess(grant, body.nodeId, '对话节点');
      return json(200, await core.chat(body satisfies NodeChatRequest, actor), cors);
    }
    case 'api/conversations': {
      const nodeId = url.searchParams.get('nodeId') ?? undefined;
      requireNodeAccess(grant, nodeId ?? null, '会话列表');
      return json(200, { conversations: await core.listConversations(actor, nodeId) }, cors);
    }
    case 'api/conversations/:id/messages': {
      const id = decodeURIComponent(paramAt(route, segments, 'id'));
      const messages = await core.listConversationMessages(id, actor);
      // A conversation is not addressable by project in its URL, so the rows themselves decide.
      for (const message of messages) requireNodeAccess(grant, message.contextNodeId, '会话记录');
      return json(200, { messages }, cors);
    }
    case 'api/capture/:id/retry': {
      const rawSourceId = decodeURIComponent(paramAt(route, segments, 'id'));
      requireNodeAccess(grant, null, '重跑采集归类');
      return json(200, await core.retryCapture(rawSourceId, actor), cors);
    }
    default:
      return undefined;
  }
}
