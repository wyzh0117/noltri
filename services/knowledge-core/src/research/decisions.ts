/**
 * Research decisions — append-only history (contract §0 rule 3, §2 timeline rule).
 *
 * There is no update or delete: a superseded decision is a new decision (or a ResearchChange).
 * Creating one always writes the matching `decision` timeline event in the same turn.
 */
import {
  createResearchDecisionRequestSchema,
  type CreateResearchDecisionRequest,
  type ResearchDecision,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { jsonField, requireProject, timelineEventForDecision, validateRequest } from './support';

export async function createDecision(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateResearchDecisionRequest,
): Promise<ResearchDecision> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createResearchDecisionRequestSchema, body, 'create research decision');
  const decision = await repo.createResearchDecision({
    userId,
    projectId,
    title: request.title,
    decision: request.decision,
    reason: request.reason,
    alternatives: request.alternatives,
    rejectedAlternatives: request.rejectedAlternatives,
    impact: request.impact,
    relatedEntities: jsonField(request.relatedEntities),
  });
  await repo.createTimelineEvent({ userId, projectId, ...timelineEventForDecision(decision) });
  return decision;
}

export async function listDecisions(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchDecision[]> {
  await requireProject(repo, projectId, userId);
  return repo.listResearchDecisions(projectId, userId);
}
