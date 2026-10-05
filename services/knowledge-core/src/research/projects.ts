/**
 * Research projects and their charter (contract §1 projects/charter rows, §2 service rules).
 *
 * The project is the ownership boundary: every other research service first proves the caller owns
 * the project, and a project that is not theirs is indistinguishable from one that does not exist.
 */
import {
  createResearchProjectRequestSchema,
  charterRequestSchema,
  patchResearchProjectRequestSchema,
  type CharterRequest,
  type CreateResearchProjectRequest,
  type PatchResearchProjectRequest,
  type ResearchCharter,
  type ResearchProject,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { requireProject, validateRequest } from './support';

export async function createProject(
  repo: ResearchRepository,
  userId: string,
  body: CreateResearchProjectRequest,
): Promise<ResearchProject> {
  const request = validateRequest(createResearchProjectRequestSchema, body, 'create research project');
  return repo.createResearchProject({ userId, name: request.name, description: request.description });
}

export async function listProjects(repo: ResearchRepository, userId: string): Promise<ResearchProject[]> {
  return repo.listResearchProjects(userId);
}

export async function getProject(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchProject> {
  return requireProject(repo, projectId, userId);
}

export async function updateProject(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: PatchResearchProjectRequest,
): Promise<ResearchProject> {
  await requireProject(repo, projectId, userId);
  const patch = validateRequest(patchResearchProjectRequestSchema, body, 'patch research project');
  return repo.updateResearchProject(projectId, userId, patch);
}

export async function getCharter(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchCharter | null> {
  await requireProject(repo, projectId, userId);
  return repo.findCharter(projectId, userId);
}

/** Create-or-update: one charter per project; its history lives in ResearchChange rows. */
export async function upsertCharter(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CharterRequest,
): Promise<ResearchCharter> {
  await requireProject(repo, projectId, userId);
  const fields = validateRequest(charterRequestSchema, body, 'charter');
  return repo.upsertCharter({ ...fields, userId, projectId });
}
