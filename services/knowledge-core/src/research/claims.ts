/**
 * Claims (contract §1 claims rows, §2 service rules).
 */
import {
  claimListQuerySchema,
  createClaimRequestSchema,
  patchClaimRequestSchema,
  type Claim,
  type ClaimListQuery,
  type CreateClaimRequest,
  type PatchClaimRequest,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { requireProject, validateRequest } from './support';

export async function createClaim(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateClaimRequest,
): Promise<Claim> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createClaimRequestSchema, body, 'create claim');
  return repo.createClaim({ userId, projectId, ...request });
}

export async function listClaims(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: ClaimListQuery,
): Promise<Claim[]> {
  await requireProject(repo, projectId, userId);
  const options = validateRequest(claimListQuerySchema, query ?? {}, 'claim list query');
  return repo.listClaims(projectId, userId, options);
}

export async function updateClaim(
  repo: ResearchRepository,
  claimId: string,
  userId: string,
  body: PatchClaimRequest,
): Promise<Claim> {
  const existing = await repo.findClaim(claimId, userId);
  if (existing === null) {
    throw knowledgeError('not_found', '主张不存在或无权访问 / claim not found');
  }
  const patch = validateRequest(patchClaimRequestSchema, body, 'patch claim');
  return repo.updateClaim(claimId, userId, patch);
}
