/**
 * Shared guards for the research domain services (contract §0 / §2).
 *
 * Ownership failures are always `not_found` (never "forbidden" — that would leak existence), and
 * payload failures are always `invalid_request`, both through the shared `@noltri/shared` envelope.
 */
import type { z } from 'zod';
import type {
  CreateTimelineEventInput,
  JsonValue,
  ResearchChange,
  ResearchDecision,
  ResearchProject,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { ResearchRepository } from '@noltri/storage';

/** Loads the project or fails with `not_found` — the single ownership check every entry point uses. */
export async function requireProject(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchProject> {
  const project = await repo.findResearchProject(projectId, userId);
  if (project === null) {
    throw knowledgeError('not_found', '研究项目不存在或无权访问 / research project not found');
  }
  return project;
}

/** Runtime validation at the domain seam: callers may bypass HTTP, the rules may not move. */
export function validateRequest<Output>(
  schema: z.ZodType<Output>,
  body: unknown,
  label: string,
): Output {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw knowledgeError(
      'invalid_request',
      `${label} 参数校验失败 / ${label} payload failed validation`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** The API request shapes carry `Record<string, unknown>`; the entities store JSON values. */
export function jsonField(value: Record<string, unknown> | undefined): JsonValue | undefined {
  return value as JsonValue | undefined;
}

/** Append-only timeline record written next to a Decision (contract §2). */
export function timelineEventForDecision(
  decision: ResearchDecision,
): Omit<CreateTimelineEventInput, 'userId' | 'projectId'> {
  return {
    eventType: 'decision',
    occurredAt: decision.createdAt,
    title: decision.title,
    summary: decision.decision,
    sourceType: 'research_decision',
    sourceId: decision.id,
    relatedEntities: decision.relatedEntities,
  };
}

/** Append-only timeline record written next to a Change (contract §2). */
export function timelineEventForChange(
  change: ResearchChange,
): Omit<CreateTimelineEventInput, 'userId' | 'projectId'> {
  return {
    eventType: 'change',
    occurredAt: change.createdAt,
    title: change.changeType,
    summary: `${change.before} → ${change.after}`,
    sourceType: 'research_change',
    sourceId: change.id,
    relatedEntities: change.relatedEntities,
  };
}
