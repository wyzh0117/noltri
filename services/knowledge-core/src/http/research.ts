/**
 * `/api/research/*` — the 32 REST endpoints of the Research chain (research contract §1).
 *
 * They live here instead of inside `router.ts` for the same reason 连接中心 does: the router owns
 * identity, scope, CORS and the error envelope, and a handler module owns one API surface's payload
 * shapes. Every branch returns a plain JSON payload; `router.ts` is what turns it into a Response.
 *
 * Identity follows contract §0 rule 1: `userId` is the caller's from the credential and `projectId`
 * comes from the path — no research body may carry either. Ownership is then proven by the domain,
 * which answers `not_found` for a project that is not the caller's.
 *
 * There is deliberately **no `SCOPE_BY_ACTION` entry** for any of these paths. A request that arrives
 * with a 本地客户端授权 grant is refused with `route_not_granted` before reaching this file, because
 * research text — 章程、证据描述、论点正文 — has not been routed through `capText`, so §435「限制返回片段」
 * could not be honoured here even if a grant asked for it. The desktop workbench authenticates with the
 * device credential (`via` dev-token / dev-open, no grant), which is unaffected. Opening Research to
 * Agent clients is a decision that has to come with capping, not before it.
 */
import type { z } from 'zod';
import {
  approveCharterRequestSchema,
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
  evidenceListQuerySchema,
  patchClaimRequestSchema,
  patchEvidenceRequestSchema,
  patchResearchProjectRequestSchema,
  patchResearchQuestionRequestSchema,
  patchSectionRequestSchema,
  relationListQuerySchema,
  reviewMarkListQuerySchema,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { ResearchDomain } from '../research';
import { parseWith, readJsonBody } from './parse';

export interface ResearchArgs {
  /** Uppercased verb, already matched against `ROUTES`. */
  readonly method: string;
  /** The matched route shape, e.g. `api/research/projects/:projectId/charter`. */
  readonly path: string;
  /** The single `:`-segment of that shape, already percent-decoded. Empty when the route has none. */
  readonly id: string;
  readonly url: URL;
  readonly request: Request;
  /** Absent when this host's storage driver has no research implementation. */
  readonly domain: ResearchDomain | undefined;
  readonly userId: string;
}

function domainOf(args: ResearchArgs): ResearchDomain {
  if (args.domain === undefined) {
    throw knowledgeError('internal_error', 'Research 未装配到本机 Core / research is not wired into this core', {
      reason: 'research_not_wired',
    });
  }
  return args.domain;
}

export async function handleResearch(args: ResearchArgs): Promise<unknown> {
  const domain = domainOf(args);
  const { userId } = args;

  /** Read-then-validate, the one thing every write branch does before calling the domain. */
  const readBody = async <Output>(schema: z.ZodType<Output>, label: string): Promise<Output> =>
    parseWith(schema, await readJsonBody(args.request), label);

  /** `?type=` / `?status=` / … validated by the same schema the domain uses. */
  const readQuery = <Output>(schema: z.ZodType<Output>, label: string): Output =>
    parseWith(schema, Object.fromEntries(args.url.searchParams), label);

  switch (args.path) {
    case 'api/research/projects': {
      if (args.method === 'GET') return { projects: await domain.listProjects(userId) };
      const body = await readBody(createResearchProjectRequestSchema, 'create research project');
      return domain.createProject(userId, body);
    }
    case 'api/research/projects/:projectId': {
      if (args.method === 'GET') return domain.getProject(args.id, userId);
      const body = await readBody(patchResearchProjectRequestSchema, 'patch research project');
      return domain.updateProject(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/charter': {
      if (args.method === 'GET') return { charter: await domain.getCharter(args.id, userId) };
      return domain.upsertCharter(args.id, userId, await readBody(charterRequestSchema, 'charter'));
    }
    case 'api/research/projects/:projectId/charter/approve': {
      const body = await readBody(approveCharterRequestSchema, 'approve charter');
      return domain.approveCharter(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/charter/versions': {
      return { versions: await domain.listCharterVersions(args.id, userId) };
    }
    case 'api/research/projects/:projectId/charter/baseline': {
      return { baseline: await domain.getCharterBaseline(args.id, userId) };
    }
    case 'api/research/projects/:projectId/review-marks': {
      const query = readQuery(reviewMarkListQuerySchema, 'review mark query');
      return { marks: await domain.listReviewMarks(args.id, userId, query) };
    }
    case 'api/research/review-marks/:markId/clear': {
      return domain.clearReviewMark(args.id, userId);
    }
    case 'api/research/projects/:projectId/questions': {
      if (args.method === 'GET') return { questions: await domain.listQuestions(args.id, userId) };
      const body = await readBody(createResearchQuestionRequestSchema, 'create research question');
      return domain.createQuestion(args.id, userId, body);
    }
    case 'api/research/questions/:questionId': {
      const body = await readBody(patchResearchQuestionRequestSchema, 'patch research question');
      return domain.updateQuestion(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/evidence': {
      if (args.method === 'GET') {
        const query = readQuery(evidenceListQuerySchema, 'evidence query');
        return { evidence: await domain.listEvidence(args.id, userId, query) };
      }
      return domain.createEvidence(args.id, userId, await readBody(createEvidenceRequestSchema, 'create evidence'));
    }
    case 'api/research/evidence/:evidenceId': {
      const body = await readBody(patchEvidenceRequestSchema, 'patch evidence');
      return domain.updateEvidence(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/claims': {
      if (args.method === 'GET') {
        return { claims: await domain.listClaims(args.id, userId, readQuery(claimListQuerySchema, 'claim query')) };
      }
      return domain.createClaim(args.id, userId, await readBody(createClaimRequestSchema, 'create claim'));
    }
    case 'api/research/claims/:claimId': {
      const body = await readBody(patchClaimRequestSchema, 'patch claim');
      return domain.updateClaim(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/sections': {
      if (args.method === 'GET') return { sections: await domain.listSections(args.id, userId) };
      return domain.createSection(args.id, userId, await readBody(createSectionRequestSchema, 'create section'));
    }
    case 'api/research/sections/:sectionId': {
      const body = await readBody(patchSectionRequestSchema, 'patch section');
      return domain.updateSection(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/relations': {
      if (args.method === 'GET') {
        const query = readQuery(relationListQuerySchema, 'relation query');
        return { relations: await domain.listRelations(args.id, userId, query) };
      }
      const body = await readBody(createEntityRelationRequestSchema, 'create relation');
      return domain.createRelation(args.id, userId, body);
    }
    case 'api/research/relations/:relationId': {
      return domain.deleteRelation(args.id, userId);
    }
    case 'api/research/projects/:projectId/decisions': {
      if (args.method === 'GET') return { decisions: await domain.listDecisions(args.id, userId) };
      const body = await readBody(createResearchDecisionRequestSchema, 'create research decision');
      return domain.createDecision(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/changes': {
      if (args.method === 'GET') {
        return { changes: await domain.listChanges(args.id, userId, readQuery(changeListQuerySchema, 'change query')) };
      }
      const body = await readBody(createResearchChangeRequestSchema, 'create research change');
      return domain.createChange(args.id, userId, body);
    }
    case 'api/research/projects/:projectId/timeline': {
      if (args.method === 'GET') return { events: await domain.listTimeline(args.id, userId) };
      const body = await readBody(createTimelineEventRequestSchema, 'create timeline event');
      return domain.createMilestone(args.id, userId, body);
    }
    default:
      throw knowledgeError('not_found', `未知的研究端点 ${args.path} / unknown research endpoint`);
  }
}
