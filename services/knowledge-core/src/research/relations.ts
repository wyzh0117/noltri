/**
 * Generic entity relations — one vocabulary for evidence↔claim, claim↔RQ, claim↔section… (§27).
 *
 * Contract §2 rules enforced here: the pair must be one the vocabulary means (R02 — `RELATION_PAIRINGS`
 * says `supports` joins an evidence to a claim, and a claim→evidence `supports` is a malformed edge, not
 * a weaker statement); both endpoints must exist inside the same project (otherwise `invalid_request`, a
 * dangling edge would corrupt the map); and re-creating an identical relation is idempotent — the existing
 * row is returned, never duplicated.
 */
import {
  createEntityRelationRequestSchema,
  relationListQuerySchema,
  RELATION_PAIRINGS,
  type CreateEntityRelationRequest,
  type DeleteRelationResponse,
  type EntityRelation,
  type RelationListQuery,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { entityIsInProject, requireProject, validateRequest } from './support';

export async function createRelation(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateEntityRelationRequest,
): Promise<EntityRelation> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createEntityRelationRequestSchema, body, 'create entity relation');

  // Vocabulary before database reads: a pair the relation type cannot mean is a caller error whatever
  // happens to exist in this project.
  const pairing = RELATION_PAIRINGS[request.relationType];
  if (!pairing.sourceTypes.includes(request.sourceType) || !pairing.targetTypes.includes(request.targetType)) {
    throw knowledgeError(
      'invalid_request',
      `「${request.relationType}」只能连接 ${pairing.sourceTypes.join('/')} → ${pairing.targetTypes.join('/')}，`
        + `收到的却是 ${request.sourceType} → ${request.targetType} / `
        + `${request.relationType} cannot join ${request.sourceType} to ${request.targetType}`,
      { relationType: request.relationType, sourceType: request.sourceType, targetType: request.targetType },
    );
  }

  for (const endpoint of [
    { type: request.sourceType, id: request.sourceId, label: 'source' },
    { type: request.targetType, id: request.targetId, label: 'target' },
  ]) {
    const exists = await entityIsInProject(repo, projectId, userId, endpoint.type, endpoint.id);
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
