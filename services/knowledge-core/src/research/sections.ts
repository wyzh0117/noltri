/**
 * Manuscript sections (contract §1 sections rows, §2 service rules).
 */
import {
  createSectionRequestSchema,
  patchSectionRequestSchema,
  type CreateSectionRequest,
  type ManuscriptSection,
  type PatchSectionRequest,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { requireProject, validateRequest } from './support';

export async function createSection(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateSectionRequest,
): Promise<ManuscriptSection> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createSectionRequestSchema, body, 'create manuscript section');
  return repo.createManuscriptSection({ userId, projectId, ...request });
}

export async function listSections(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ManuscriptSection[]> {
  await requireProject(repo, projectId, userId);
  return repo.listManuscriptSections(projectId, userId);
}

export async function updateSection(
  repo: ResearchRepository,
  sectionId: string,
  userId: string,
  body: PatchSectionRequest,
): Promise<ManuscriptSection> {
  const existing = await repo.findManuscriptSection(sectionId, userId);
  if (existing === null) {
    throw knowledgeError('not_found', '稿件章节不存在或无权访问 / manuscript section not found');
  }
  const patch = validateRequest(patchSectionRequestSchema, body, 'patch manuscript section');
  return repo.updateManuscriptSection(sectionId, userId, patch);
}
