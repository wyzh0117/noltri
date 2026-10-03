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
import {
  changeListQuerySchema,
  charterRequestSchema,
  claimListQuerySchema,
  createClaimRequestSchema,
  createEntityRelationRequestSchema,
  createEvidenceRequestSchema,
  createResearchChangeRequestSchema,
  createResearchDecisionRequestSchema,
  createResearchProjectRequestSchema,
  createResearchQuestionRequestSchema,
  createSectionRequestSchema,
  createTimelineEventRequestSchema,
  driftCheckRequestSchema,
  driftFindingListQuerySchema,
  evidenceListQuerySchema,
  patchClaimRequestSchema,
  patchDriftFindingRequestSchema,
  patchEvidenceRequestSchema,
  patchResearchProjectRequestSchema,
  patchResearchQuestionRequestSchema,
  patchSectionRequestSchema,
  relationListQuerySchema,
} from '@noltri/schema';
import type { CoreConfig } from '../config';
import type { Identity } from '../auth';
import { resolveIdentity as defaultResolveIdentity } from '../auth';
import type { KnowledgeCore } from '../core';
import type { ResearchDomain } from '../research';

export type RequestHandler = (request: Request) => Promise<Response>;

export interface RouterDeps {
  core: KnowledgeCore;
  config: CoreConfig;
  logger?: Logger;
  /** Research Domain (Research V1); falls back to `core.research` when omitted. */
  research?: ResearchDomain;
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
  // Research Domain (Research V1, docs/research-contract.md §1)
  { method: 'GET', segments: ['api', 'research', 'projects'] },
  { method: 'POST', segments: ['api', 'research', 'projects'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId'] },
  { method: 'PATCH', segments: ['api', 'research', 'projects', ':projectId'] },
  { method: 'GET', segments: ['api', 'research', 'projects', ':projectId', 'charter'] },
  { method: 'PUT', segments: ['api', 'research', 'projects', ':projectId', 'charter'] },
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
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
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
  const research = deps.research ?? core.research;
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
        research,
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
  research: ResearchDomain | undefined;
  config: CoreConfig;
  resolve: (request: Request, config: CoreConfig, logger?: Logger) => Promise<Identity>;
  cors: Record<string, string>;
}

async function dispatch(args: DispatchArgs): Promise<Response | undefined> {
  const { route, segments, url, request, core, research, config, resolve, cors } = args;
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

    // --- Research Domain (Research V1) -------------------------------------
    case 'api/research/projects': {
      const domain = requireResearch(research);
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { projects: await domain.listProjects(actor.userId) }, cors);
      }
      const body = parseWith(createResearchProjectRequestSchema, await readJsonBody(request), 'create research project');
      return json(200, await domain.createProject(actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, await domain.getProject(projectId, actor.userId), cors);
      }
      const body = parseWith(patchResearchProjectRequestSchema, await readJsonBody(request), 'patch research project');
      return json(200, await domain.updateProject(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/charter': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { charter: await domain.getCharter(projectId, actor.userId) }, cors);
      }
      const body = parseWith(charterRequestSchema, await readJsonBody(request), 'charter');
      return json(200, await domain.upsertCharter(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/questions': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { questions: await domain.listQuestions(projectId, actor.userId) }, cors);
      }
      const body = parseWith(createResearchQuestionRequestSchema, await readJsonBody(request), 'create research question');
      return json(200, await domain.createQuestion(projectId, actor.userId, body), cors);
    }
    case 'api/research/questions/:questionId': {
      const domain = requireResearch(research);
      const questionId = decodeURIComponent(paramAt(route, segments, 'questionId'));
      const body = parseWith(patchResearchQuestionRequestSchema, await readJsonBody(request), 'patch research question');
      return json(200, await domain.updateQuestion(questionId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/evidence': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        const query = parseWith(evidenceListQuerySchema, Object.fromEntries(url.searchParams), 'evidence query');
        return json(200, { evidence: await domain.listEvidence(projectId, actor.userId, query) }, cors);
      }
      const body = parseWith(createEvidenceRequestSchema, await readJsonBody(request), 'create evidence');
      return json(200, await domain.createEvidence(projectId, actor.userId, body), cors);
    }
    case 'api/research/evidence/:evidenceId': {
      const domain = requireResearch(research);
      const evidenceId = decodeURIComponent(paramAt(route, segments, 'evidenceId'));
      const body = parseWith(patchEvidenceRequestSchema, await readJsonBody(request), 'patch evidence');
      return json(200, await domain.updateEvidence(evidenceId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/claims': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        const query = parseWith(claimListQuerySchema, Object.fromEntries(url.searchParams), 'claim query');
        return json(200, { claims: await domain.listClaims(projectId, actor.userId, query) }, cors);
      }
      const body = parseWith(createClaimRequestSchema, await readJsonBody(request), 'create claim');
      return json(200, await domain.createClaim(projectId, actor.userId, body), cors);
    }
    case 'api/research/claims/:claimId': {
      const domain = requireResearch(research);
      const claimId = decodeURIComponent(paramAt(route, segments, 'claimId'));
      const body = parseWith(patchClaimRequestSchema, await readJsonBody(request), 'patch claim');
      return json(200, await domain.updateClaim(claimId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/sections': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { sections: await domain.listSections(projectId, actor.userId) }, cors);
      }
      const body = parseWith(createSectionRequestSchema, await readJsonBody(request), 'create section');
      return json(200, await domain.createSection(projectId, actor.userId, body), cors);
    }
    case 'api/research/sections/:sectionId': {
      const domain = requireResearch(research);
      const sectionId = decodeURIComponent(paramAt(route, segments, 'sectionId'));
      const body = parseWith(patchSectionRequestSchema, await readJsonBody(request), 'patch section');
      return json(200, await domain.updateSection(sectionId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/relations': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        const query = parseWith(relationListQuerySchema, Object.fromEntries(url.searchParams), 'relation query');
        return json(200, { relations: await domain.listRelations(projectId, actor.userId, query) }, cors);
      }
      const body = parseWith(createEntityRelationRequestSchema, await readJsonBody(request), 'create relation');
      return json(200, await domain.createRelation(projectId, actor.userId, body), cors);
    }
    case 'api/research/relations/:relationId': {
      const domain = requireResearch(research);
      const relationId = decodeURIComponent(paramAt(route, segments, 'relationId'));
      return json(200, await domain.deleteRelation(relationId, actor.userId), cors);
    }
    case 'api/research/projects/:projectId/decisions': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { decisions: await domain.listDecisions(projectId, actor.userId) }, cors);
      }
      const body = parseWith(createResearchDecisionRequestSchema, await readJsonBody(request), 'create research decision');
      return json(200, await domain.createDecision(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/changes': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        const query = parseWith(changeListQuerySchema, Object.fromEntries(url.searchParams), 'change query');
        return json(200, { changes: await domain.listChanges(projectId, actor.userId, query) }, cors);
      }
      const body = parseWith(createResearchChangeRequestSchema, await readJsonBody(request), 'create research change');
      return json(200, await domain.createChange(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/timeline': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      if (request.method.toUpperCase() === 'GET') {
        return json(200, { events: await domain.listTimeline(projectId, actor.userId) }, cors);
      }
      const body = parseWith(createTimelineEventRequestSchema, await readJsonBody(request), 'create timeline event');
      return json(200, await domain.createMilestone(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/drift-check': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      const body = parseWith(driftCheckRequestSchema, await readOptionalJsonBody(request), 'drift check');
      return json(200, await domain.runDriftCheck(projectId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/drift-findings': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      const query = parseWith(driftFindingListQuerySchema, Object.fromEntries(url.searchParams), 'drift finding query');
      return json(200, { findings: await domain.listDriftFindings(projectId, actor.userId, query) }, cors);
    }
    case 'api/research/drift-findings/:findingId': {
      const domain = requireResearch(research);
      const findingId = decodeURIComponent(paramAt(route, segments, 'findingId'));
      const body = parseWith(patchDriftFindingRequestSchema, await readJsonBody(request), 'patch drift finding');
      return json(200, await domain.updateDriftFinding(findingId, actor.userId, body), cors);
    }
    case 'api/research/projects/:projectId/map': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      return json(200, await domain.buildMap(projectId, actor.userId), cors);
    }
    case 'api/research/projects/:projectId/context-pack': {
      const domain = requireResearch(research);
      const projectId = decodeURIComponent(paramAt(route, segments, 'projectId'));
      return json(200, await domain.buildContextPack(projectId, actor.userId), cors);
    }
    default:
      return undefined;
  }
}

function requireResearch(research: ResearchDomain | undefined): ResearchDomain {
  if (research === undefined) {
    throw knowledgeError('internal_error', 'Research Domain 未装配 / research domain is not wired into this host');
  }
  return research;
}

/** Drift checks accept an empty body (meaning "no manuscript text"). */
async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw knowledgeError('invalid_request', '请求体不是合法 JSON / body is not valid JSON');
  }
}
