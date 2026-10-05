/**
 * Timeline (contract §2): Decision / Change writes their events at creation time, and POST timeline
 * is reserved for `milestone` events (`sourceType='manual'`). Newest `occurredAt` first.
 */
import {
  createTimelineEventRequestSchema,
  type CreateTimelineEventRequest,
  type TimelineEvent,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { jsonField, requireProject, validateRequest } from './support';

export async function listTimeline(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<TimelineEvent[]> {
  await requireProject(repo, projectId, userId);
  const events = await repo.listTimelineEvents(projectId, userId);
  return [...events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
}

export async function createMilestone(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateTimelineEventRequest,
): Promise<TimelineEvent> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createTimelineEventRequestSchema, body, 'create timeline event');
  if (Number.isNaN(new Date(request.occurredAt).getTime())) {
    throw knowledgeError('invalid_request', 'occurredAt 必须是合法时间 / occurredAt must be a valid timestamp');
  }
  return repo.createTimelineEvent({
    userId,
    projectId,
    eventType: 'milestone',
    occurredAt: request.occurredAt,
    title: request.title,
    summary: request.summary,
    sourceType: 'manual',
    sourceId: null,
    relatedEntities: jsonField(request.relatedEntities),
  });
}
