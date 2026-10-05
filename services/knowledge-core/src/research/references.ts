/**
 * 来源引用的安全检查 —— R03（开发文档 §13「删除/归档前检查研究引用」，验收矩阵 R03「引用不会静默失效」）。
 *
 * `Evidence.nodeId` / `Evidence.rawSourceId` are plain pointers, and this module is the only place the
 * research side reads them. It never rewrites one: re-binding a 出处 to different text after a node is
 * archived would put words under a 论点 the user never re-checked, which is the failure R03 exists to
 * prevent. So the pointer stays, the archive lands, and everything citing it gets a 复核标记 that says
 * 「这条引用的出处已经不可用」.
 *
 * Two entry points share one walk: `findResearchReferences` is the read-only 归档前检查 a caller uses
 * before deciding, `markSourceArchived` is what the knowledge side calls once the archive actually
 * happens. The walk is 证据 → 它连着的论点, over the five evidence→claim relation kinds (R02 的词汇表);
 * a `relates_to` edge is not one of the 五种证据作用类型, so it does not make a 论点 affected.
 */
import {
  archiveSourceRequestSchema,
  EVIDENCE_TO_CLAIM_RELATION_TYPES,
  researchReferenceQuerySchema,
  type ArchivedSourceMarks,
  type ArchiveSourceRequest,
  type Evidence,
  type ResearchReferenceMatch,
  type ResearchReferenceQuery,
} from '@noltri/schema';
import type { EvidenceSourceFilter, ResearchRepository } from '@noltri/storage';
import { validateRequest } from './support';

/** The 论点 this 证据 is wired to by any of the five evidence→claim relation kinds, deduplicated. */
async function claimsOf(
  repo: ResearchRepository,
  userId: string,
  evidence: Evidence,
): Promise<string[]> {
  const relations = await repo.listEntityRelations(evidence.projectId, userId, {
    sourceType: 'evidence',
    sourceId: evidence.id,
    targetType: 'claim',
  });
  const ids = new Set<string>();
  for (const relation of relations) {
    if (EVIDENCE_TO_CLAIM_RELATION_TYPES.includes(relation.relationType)) ids.add(relation.targetId);
  }
  return [...ids];
}

/** One `listResearchProjects` for the whole result set: a cited 证据 can span projects. */
async function namesOf(
  repo: ResearchRepository,
  userId: string,
): Promise<Map<string, string>> {
  const entries = await repo.listResearchProjects(userId);
  return new Map(entries.map((project) => [project.id, project.name]));
}

async function matchesFor(
  repo: ResearchRepository,
  userId: string,
  filter: EvidenceSourceFilter,
): Promise<ResearchReferenceMatch[]> {
  const rows = await repo.listEvidenceBySource(userId, filter);
  if (rows.length === 0) return [];
  const names = await namesOf(repo, userId);
  const matches: ResearchReferenceMatch[] = [];
  for (const row of rows) {
    matches.push({
      projectId: row.projectId,
      projectName: names.get(row.projectId) ?? row.projectId,
      evidenceId: row.id,
      evidenceTitle: row.title,
      evidenceType: row.type,
      claimIds: await claimsOf(repo, userId, row),
    });
  }
  return matches;
}

/**
 * 「删除/归档前检查研究引用」. Read-only: it reports what is connected and marks nothing, so a caller can
 * ask before it decides. An absent id means "not looked up", and a source nothing cites answers `[]`.
 */
export async function findResearchReferences(
  repo: ResearchRepository,
  userId: string,
  query: ResearchReferenceQuery,
): Promise<ResearchReferenceMatch[]> {
  const filter = validateRequest(researchReferenceQuerySchema, query, 'research reference query');
  return matchesFor(repo, userId, {
    ...(filter.nodeId === undefined ? {} : { nodeId: filter.nodeId }),
    ...(filter.rawSourceId === undefined ? {} : { rawSourceId: filter.rawSourceId }),
  });
}

/** What the 复核理由 shows the user: a bare id tells them nothing about which 出处 just went away. */
function archivedReason(input: ArchiveSourceRequest): string {
  const source = input.sourceTitle ?? input.nodeId ?? input.rawSourceId ?? '';
  return `出处「${source}」已归档，这条引用需要重新确认`;
}

/**
 * The knowledge side calls this when a node's status becomes `archived`. Every 证据 that cites it — and
 * every 论点 those 证据 support — gets a `source_archived` 复核标记.
 *
 * 归档一个没人引用的节点 is the normal case and answers with three empty lists. Archiving a source with
 * no research wired is not this module's problem: the caller in `services/node.ts` skips it entirely, so
 * a knowledge-only host keeps archiving without a second thought.
 */
export async function markSourceArchived(
  repo: ResearchRepository,
  userId: string,
  body: ArchiveSourceRequest,
): Promise<ArchivedSourceMarks> {
  const input = validateRequest(archiveSourceRequestSchema, body, 'archive source');
  const references = await matchesFor(repo, userId, {
    ...(input.nodeId === null || input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.rawSourceId === null || input.rawSourceId === undefined ? {} : { rawSourceId: input.rawSourceId }),
  });

  const reason = archivedReason(input);
  const markedEvidenceIds: string[] = [];
  const markedClaimIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const reference of references) {
    await repo.raiseReviewMark({
      userId,
      projectId: reference.projectId,
      entityType: 'evidence',
      entityId: reference.evidenceId,
      reason,
      raisedBy: 'source_archived',
    });
    markedEvidenceIds.push(reference.evidenceId);
    projectIds.add(reference.projectId);
    // One 论点 supported by two archived 证据 is one warning, so the claim ids are a set; the driver
    // refreshes the row it already has either way.
    for (const claimId of reference.claimIds) {
      await repo.raiseReviewMark({
        userId,
        projectId: reference.projectId,
        entityType: 'claim',
        entityId: claimId,
        reason,
        raisedBy: 'source_archived',
      });
      markedClaimIds.add(claimId);
    }
  }
  return { markedEvidenceIds, markedClaimIds: [...markedClaimIds], projectIds: [...projectIds] };
}
