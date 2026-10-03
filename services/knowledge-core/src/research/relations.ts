/**
 * Generic entity relations — one vocabulary for evidence↔claim, claim↔RQ, claim↔section… (§27).
 *
 * Contract §2 rules enforced here: both endpoints must exist inside the same project (otherwise
 * `invalid_request`, a dangling edge would corrupt the map), and re-creating an identical relation is
 * idempotent — the existing row is returned, never duplicated.
 */
import {
  createEntityRelationRequestSchema,
  relationListQuerySchema,
  type CreateEntityRelationRequest,
  type DeleteRelationResponse,
  type EntityRelation,
  type RelationListQuery,
  type ResearchEntityType,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { requireProject, validateRequest } from './support';

/** Resolves one relation endpoint; `null` means "no such entity in this project". */
async function findEntityInProject(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  entityType: ResearchEntityType,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'research_project':
      return entityId === projectId;
    case 'research_charter': {
      const charter = await repo.findCharter(projectId, userId);
      return charter !== null && charter.id === entityId;
    }
    case 'research_question': {
      const question = await repo.findResearchQuestion(entityId, userId);
      return question !== null && question.projectId === projectId;
    }
    case 'evidence': {
      const evidence = await repo.findEvidence(entityId, userId);
      return evidence !== null && evidence.projectId === projectId;
    }
    case 'claim': {
      const claim = await repo.findClaim(entityId, userId);
      return claim !== null && claim.projectId === projectId;
    }
    case 'research_decision': {
      const decision = await repo.findResearchDecision(entityId, userId);
      return decision !== null && decision.projectId === projectId;
    }
    case 'research_change': {
      const change = await repo.findResearchChange(entityId, userId);
      return change !== null && change.projectId === projectId;
    }
    case 'drift_finding': {
      const finding = await repo.findDriftFinding(entityId, userId);
      return finding !== null && finding.projectId === projectId;
    }
    case 'manuscript_section': {
      const section = await repo.findManuscriptSection(entityId, userId);
      return section !== null && section.projectId === projectId;
    }
    default:
      return false;
  }
}

export async function createRelation(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateEntityRelationRequest,
): Promise<EntityRelation> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createEntityRelationRequestSchema, body, 'create entity relation');

  for (const endpoint of [
    { type: request.sourceType, id: request.sourceId, label: 'source' },
    { type: request.targetType, id: request.targetId, label: 'target' },
  ]) {
    const exists = await findEntityInProject(repo, projectId, userId, endpoint.type, endpoint.id);
    if (!exists) {
      throw knowledgeError(
        'invalid_request',
        `relation ${endpoint.label} 实体不存在于本项目 / relation ${endpoint.label} entity is not in this project`,
        { [`${endpoint.label}Type`]: endpoint.type, [`${endpoint.label}Id`]: endpoint.id },
      );
    }
  }

  // Idempotency: the same quintuple returns the row that already exists (contract §2).
  const existing = await repo.listEntityRelations(projectId, userId, {
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    relationType: request.relationType,
    targetType: request.targetType,
    targetId: request.targetId,
  });
  const duplicate = existing.find(
    (relation) =>
      relation.sourceType === request.sourceType &&
      relation.sourceId === request.sourceId &&
      relation.relationType === request.relationType &&
      relation.targetType === request.targetType &&
      relation.targetId === request.targetId,
  );
  if (duplicate !== undefined) return duplicate;

  return repo.createEntityRelation({
    userId,
    projectId,
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    relationType: request.relationType,
    targetType: request.targetType,
    targetId: request.targetId,
    note: request.note,
  });
}

export async function listRelations(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: RelationListQuery,
): Promise<EntityRelation[]> {
  await requireProject(repo, projectId, userId);
  const filter = validateRequest(relationListQuerySchema, query ?? {}, 'relation list query');
  return repo.listEntityRelations(projectId, userId, filter);
}

export async function deleteRelation(
  repo: ResearchRepository,
  relationId: string,
  userId: string,
): Promise<DeleteRelationResponse> {
  const deleted = await repo.deleteEntityRelation(relationId, userId);
  if (!deleted) {
    throw knowledgeError('not_found', '关系不存在或无权访问 / entity relation not found');
  }
  return { deleted: true, id: relationId };
}
