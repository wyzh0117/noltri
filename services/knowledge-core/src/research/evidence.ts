/**
 * Evidence records (contract §1 evidence rows, §2 service rules).
 */
import {
  createEvidenceRequestSchema,
  evidenceListQuerySchema,
  patchEvidenceRequestSchema,
  type CreateEvidenceRequest,
  type Evidence,
  type EvidenceListQuery,
  type PatchEvidenceRequest,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { requireProject, validateRequest } from './support';

export async function createEvidence(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateEvidenceRequest,
): Promise<Evidence> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createEvidenceRequestSchema, body, 'create evidence');
  return repo.createEvidence({ userId, projectId, ...request });
}

export async function listEvidence(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: EvidenceListQuery,
): Promise<Evidence[]> {
  await requireProject(repo, projectId, userId);
  const options = validateRequest(evidenceListQuerySchema, query ?? {}, 'evidence list query');
  return repo.listEvidence(projectId, userId, options);
}

export async function updateEvidence(
  repo: ResearchRepository,
  evidenceId: string,
  userId: string,
  body: PatchEvidenceRequest,
): Promise<Evidence> {
  const existing = await repo.findEvidence(evidenceId, userId);
  if (existing === null) {
    throw knowledgeError('not_found', '证据不存在或无权访问 / evidence not found');
  }
  const patch = validateRequest(patchEvidenceRequestSchema, body, 'patch evidence');
  return repo.updateEvidence(evidenceId, userId, patch);
}
