/**
 * Research changes — append-only history (contract §0 rule 3, §2 timeline rule).
 *
 * Changes are the only way the research record says "this moved"; creating one always writes the
 * matching `change` timeline event. No update, no delete — ever.
 */
import {
  changeListQuerySchema,
  createResearchChangeRequestSchema,
  type ChangeListQuery,
  type CreateResearchChangeRequest,
  type ResearchChange,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { jsonField, requireProject, timelineEventForChange, validateRequest } from './support';

export async function createChange(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateResearchChangeRequest,
): Promise<ResearchChange> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createResearchChangeRequestSchema, body, 'create research change');
  const change = await repo.createResearchChange({
    userId,
    projectId,
    changeType: request.changeType,
    before: request.before,
    after: request.after,
    reason: request.reason,
    impact: request.impact,
    relatedEntities: jsonField(request.relatedEntities),
  });
  await repo.createTimelineEvent({ userId, projectId, ...timelineEventForChange(change) });
  return change;
}

export async function listChanges(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: ChangeListQuery,
): Promise<ResearchChange[]> {
  await requireProject(repo, projectId, userId);
  const options = validateRequest(changeListQuerySchema, query ?? {}, 'change list query');
  return repo.listResearchChanges(projectId, userId, options);
}
