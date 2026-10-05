/**
 * Research questions (contract §1 questions rows, §2 service rules).
 */
import {
  createResearchQuestionRequestSchema,
  patchResearchQuestionRequestSchema,
  type CreateResearchQuestionRequest,
  type PatchResearchQuestionRequest,
  type ResearchQuestion,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { requireProject, validateRequest } from './support';

export async function createQuestion(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: CreateResearchQuestionRequest,
): Promise<ResearchQuestion> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(createResearchQuestionRequestSchema, body, 'create research question');
  return repo.createResearchQuestion({
    userId,
    projectId,
    questionCode: request.questionCode,
    questionText: request.questionText,
    rationale: request.rationale,
    relatedMethod: request.relatedMethod,
  });
}

export async function listQuestions(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchQuestion[]> {
  await requireProject(repo, projectId, userId);
  return repo.listResearchQuestions(projectId, userId);
}

export async function updateQuestion(
  repo: ResearchRepository,
  questionId: string,
  userId: string,
  body: PatchResearchQuestionRequest,
): Promise<ResearchQuestion> {
  const existing = await repo.findResearchQuestion(questionId, userId);
  if (existing === null) {
    throw knowledgeError('not_found', '研究问题不存在或无权访问 / research question not found');
  }
  const patch = validateRequest(patchResearchQuestionRequestSchema, body, 'patch research question');
  return repo.updateResearchQuestion(questionId, userId, patch);
}
