/**
 * 批准的章程基线与它留下的复核标记 —— R06（开发文档 §13「不可变批准版本＋当前草稿」、§14「批准新章程后
 * 保留旧结果」，验收矩阵 R06「历史保留、影响对象被标记；后续检查绑定新基线」）。
 *
 * The draft stays mutable and one-per-project; an approval appends a frozen snapshot next to it. That is
 * why `research_charter_versions` is a separate table: freezing the draft in place would take away the
 * document the user is still writing, and `findCharterBaseline` is what P6's drift checks bind to.
 *
 * 影响对象由调用方点名。The domain proves each one belongs to this project and marks exactly those —
 * guessing which 论点 a revision touched would turn a guess into a 偏移规则 nobody agreed to.
 */
import {
  approveCharterRequestSchema,
  CHARTER_FIELD_NAMES,
  reviewMarkListQuerySchema,
  type ApproveCharterRequest,
  type CharterFieldName,
  type CharterVersion,
  type ResearchCharter,
  type ResearchEntityRef,
  type ResearchReviewMark,
  type ReviewMarkListQuery,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import { entityIsInProject, requireProject, validateRequest } from './support';

/**
 * Which fields the draft moved since the previous baseline. With no earlier baseline the list is empty:
 * 「没有可对比的上一版」 is not the same statement as 「每个字段都改了」.
 */
function changedFieldsAgainst(previous: ResearchCharter | null, draft: ResearchCharter): CharterFieldName[] {
  if (previous === null) return [];
  return CHARTER_FIELD_NAMES.filter((field) => previous[field] !== draft[field]);
}

/** Proves each named entity belongs here, dropping repeats so one object gets one mark per baseline. */
async function affectedInProject(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  refs: readonly ResearchEntityRef[],
): Promise<ResearchEntityRef[]> {
  const seen = new Set<string>();
  const unique: ResearchEntityRef[] = [];
  for (const ref of refs) {
    const key = `${ref.entityType}:${ref.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await entityIsInProject(repo, projectId, userId, ref.entityType, ref.entityId))) {
      throw knowledgeError(
        'invalid_request',
        `受影响对象 ${ref.entityType}/${ref.entityId} 不存在于本项目 / affected entity is not in this project`,
        { entityType: ref.entityType, entityId: ref.entityId },
      );
    }
    unique.push(ref);
  }
  return unique;
}

export async function approveCharter(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: ApproveCharterRequest,
): Promise<CharterVersion> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(approveCharterRequestSchema, body, 'approve charter');
  const draft = await repo.findCharter(projectId, userId);
  if (draft === null) {
    throw knowledgeError('invalid_request', '还没有可批准的章程草稿 / there is no charter draft to approve yet');
  }

  // Prove before writing: an approval lands in two tables and `ResearchRepository` has no transaction, so
  // every rejection a caller could cause must happen while nothing has been appended yet.
  if (request.decisionId !== undefined && request.decisionId !== null) {
    const owned = await entityIsInProject(repo, projectId, userId, 'research_decision', request.decisionId);
    if (!owned) {
      throw knowledgeError(
        'invalid_request',
        `批准所依据的决策 ${request.decisionId} 不存在于本项目 / decision is not in this project`,
        { decisionId: request.decisionId },
      );
    }
  }
  const affected = await affectedInProject(repo, projectId, userId, request.affectedEntities ?? []);

  const previous = (await repo.listCharterVersions(projectId, userId))[0] ?? null;
  const version = await repo.createCharterVersion({
    userId,
    projectId,
    version: (previous?.version ?? 0) + 1,
    previousVersion: previous?.version ?? null,
    charter: draft,
    changedFields: changedFieldsAgainst(previous?.charter ?? null, draft),
    revisionReason: request.revisionReason,
    decisionId: request.decisionId ?? null,
  });

  // 标记影响对象（R06）。An empty list means the user said this revision touched nothing.
  const reason = `第 ${version.version} 版章程基线：${request.revisionReason}`;
  for (const entity of affected) {
    await repo.raiseReviewMark({
      userId,
      projectId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      reason,
      raisedBy: 'charter_baseline',
      charterVersion: version.version,
    });
  }
  return version;
}

export async function listCharterVersions(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<CharterVersion[]> {
  await requireProject(repo, projectId, userId);
  return repo.listCharterVersions(projectId, userId);
}

/** What 后续检查 binds to: the newest approved baseline, or `null` while nothing has been approved. */
export async function getCharterBaseline(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<CharterVersion | null> {
  await requireProject(repo, projectId, userId);
  return repo.findCharterBaseline(projectId, userId);
}

export async function listReviewMarks(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: ReviewMarkListQuery,
): Promise<ResearchReviewMark[]> {
  await requireProject(repo, projectId, userId);
  const filter = validateRequest(reviewMarkListQuerySchema, query ?? {}, 'review mark query');
  return repo.listReviewMarks(projectId, userId, filter);
}

/**
 * 处理完了。Only the status moves: the row stays, because deleting the warning is how a project ends up
 * looking like it never needed a second look (开发文档 §14).
 */
export async function clearReviewMark(
  repo: ResearchRepository,
  markId: string,
  userId: string,
): Promise<ResearchReviewMark> {
  return repo.clearReviewMark(markId, userId);
}
