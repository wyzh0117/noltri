/**
 * Research domain façade (contract §0–§2).
 *
 * `createResearchDomain(repo)` returns the single ResearchDomain the HTTP layer calls; every method
 * takes the caller's `userId` (from credentials only — contract §0 rule 1) and proves project
 * ownership before touching data. Decision/Change writes also append timeline events.
 *
 * P5-C added the 批准基线 group (`approveCharter` … `clearReviewMark`): the charter draft stays the
 * mutable document the user is writing, and each approval appends an immutable snapshot beside it plus
 * the 需复核 marks for the objects the caller named (R06).
 *
 * `findReferences` / `markSourceArchived` are R03's research half: the read-only 归档前检查 and the
 * 复核标记 write the knowledge side calls when a node it owns is archived. They reach across projects
 * because a 出处 may be cited by more than one 研究项目, and they never re-bind a pointer.
 *
 * P6 (R04/R05/R07) 接上归档 façade 的五个方法：`runDriftCheck` 先跑 `drift.ts` 的纯规则、再按
 * `(driftType, sourceEntityId, targetEntityId)` 对既有 open finding 去重后落库；`buildMap` /
 * `buildContextPack` 分别交给 `map.ts` / `context-pack.ts` 的纯装配，`generatedAt` 由这一层盖戳。
 */
import type {
  ApproveCharterRequest,
  ArchiveSourceRequest,
  ArchivedSourceMarks,
  ChangeListQuery,
  CharterRequest,
  CharterVersion,
  Claim,
  ClaimListQuery,
  CreateClaimRequest,
  CreateEntityRelationRequest,
  CreateEvidenceRequest,
  CreateResearchChangeRequest,
  CreateResearchDecisionRequest,
  CreateResearchProjectRequest,
  CreateResearchQuestionRequest,
  CreateSectionRequest,
  CreateTimelineEventRequest,
  DeleteRelationResponse,
  DriftCheckRequest,
  DriftCheckResponse,
  DriftFinding,
  DriftFindingListQuery,
  EntityRelation,
  Evidence,
  EvidenceListQuery,
  ManuscriptSection,
  PatchClaimRequest,
  PatchDriftFindingRequest,
  PatchEvidenceRequest,
  PatchResearchProjectRequest,
  PatchResearchQuestionRequest,
  PatchSectionRequest,
  RelationListQuery,
  ResearchChange,
  ResearchCharter,
  ResearchContextPackResponse,
  ResearchDecision,
  ResearchMapResponse,
  ResearchProject,
  ResearchQuestion,
  ResearchReferenceMatch,
  ResearchReferenceQuery,
  ResearchReviewMark,
  ReviewMarkListQuery,
  TimelineEvent,
} from '@noltri/schema';
import { driftCheckRequestSchema } from '@noltri/schema';
import { knowledgeError, nowIso } from '@noltri/shared';
import type { ResearchRepository } from '@noltri/storage';
import * as baselines from './baselines';
import * as changes from './changes';
import * as claims from './claims';
import { buildContextPack } from './context-pack';
import * as decisions from './decisions';
import { driftFindingKey, runDriftChecks } from './drift';
import * as evidence from './evidence';
import { buildResearchMap } from './map';
import * as projects from './projects';
import * as questions from './questions';
import * as references from './references';
import * as relations from './relations';
import * as sections from './sections';
import { requireProject, validateRequest } from './support';
import * as timeline from './timeline';

export interface ResearchDomain {
  createProject(userId: string, body: CreateResearchProjectRequest): Promise<ResearchProject>;
  listProjects(userId: string): Promise<ResearchProject[]>;
  getProject(projectId: string, userId: string): Promise<ResearchProject>;
  updateProject(projectId: string, userId: string, body: PatchResearchProjectRequest): Promise<ResearchProject>;
  getCharter(projectId: string, userId: string): Promise<ResearchCharter | null>;
  upsertCharter(projectId: string, userId: string, body: CharterRequest): Promise<ResearchCharter>;
  approveCharter(projectId: string, userId: string, body: ApproveCharterRequest): Promise<CharterVersion>;
  listCharterVersions(projectId: string, userId: string): Promise<CharterVersion[]>;
  getCharterBaseline(projectId: string, userId: string): Promise<CharterVersion | null>;
  listReviewMarks(projectId: string, userId: string, query: ReviewMarkListQuery): Promise<ResearchReviewMark[]>;
  clearReviewMark(markId: string, userId: string): Promise<ResearchReviewMark>;
  findReferences(userId: string, query: ResearchReferenceQuery): Promise<ResearchReferenceMatch[]>;
  markSourceArchived(userId: string, body: ArchiveSourceRequest): Promise<ArchivedSourceMarks>;
  createQuestion(projectId: string, userId: string, body: CreateResearchQuestionRequest): Promise<ResearchQuestion>;
  listQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]>;
  updateQuestion(questionId: string, userId: string, body: PatchResearchQuestionRequest): Promise<ResearchQuestion>;
  createEvidence(projectId: string, userId: string, body: CreateEvidenceRequest): Promise<Evidence>;
  listEvidence(projectId: string, userId: string, query: EvidenceListQuery): Promise<Evidence[]>;
  updateEvidence(evidenceId: string, userId: string, body: PatchEvidenceRequest): Promise<Evidence>;
  createClaim(projectId: string, userId: string, body: CreateClaimRequest): Promise<Claim>;
  listClaims(projectId: string, userId: string, query: ClaimListQuery): Promise<Claim[]>;
  updateClaim(claimId: string, userId: string, body: PatchClaimRequest): Promise<Claim>;
  createSection(projectId: string, userId: string, body: CreateSectionRequest): Promise<ManuscriptSection>;
  listSections(projectId: string, userId: string): Promise<ManuscriptSection[]>;
  updateSection(sectionId: string, userId: string, body: PatchSectionRequest): Promise<ManuscriptSection>;
  createRelation(projectId: string, userId: string, body: CreateEntityRelationRequest): Promise<EntityRelation>;
  listRelations(projectId: string, userId: string, query: RelationListQuery): Promise<EntityRelation[]>;
  deleteRelation(relationId: string, userId: string): Promise<DeleteRelationResponse>;
  createDecision(projectId: string, userId: string, body: CreateResearchDecisionRequest): Promise<ResearchDecision>;
  listDecisions(projectId: string, userId: string): Promise<ResearchDecision[]>;
  createChange(projectId: string, userId: string, body: CreateResearchChangeRequest): Promise<ResearchChange>;
  listChanges(projectId: string, userId: string, query: ChangeListQuery): Promise<ResearchChange[]>;
  listTimeline(projectId: string, userId: string): Promise<TimelineEvent[]>;
  createMilestone(projectId: string, userId: string, body: CreateTimelineEventRequest): Promise<TimelineEvent>;
  runDriftCheck(projectId: string, userId: string, body: DriftCheckRequest): Promise<DriftCheckResponse>;
  listDriftFindings(projectId: string, userId: string, query: DriftFindingListQuery): Promise<DriftFinding[]>;
  updateDriftFinding(findingId: string, userId: string, body: PatchDriftFindingRequest): Promise<DriftFinding>;
  buildMap(projectId: string, userId: string): Promise<ResearchMapResponse>;
  buildContextPack(projectId: string, userId: string): Promise<ResearchContextPackResponse>;
}

export function createResearchDomain(repo: ResearchRepository): ResearchDomain {
  return {
    // --- projects / charter ---
    createProject: (userId, body) => projects.createProject(repo, userId, body),
    listProjects: (userId) => projects.listProjects(repo, userId),
    getProject: (projectId, userId) => projects.getProject(repo, projectId, userId),
    updateProject: (projectId, userId, body) => projects.updateProject(repo, projectId, userId, body),
    getCharter: (projectId, userId) => projects.getCharter(repo, projectId, userId),
    upsertCharter: (projectId, userId, body) => projects.upsertCharter(repo, projectId, userId, body),

    // --- approved baselines / review marks (P5-C: R06 + R03 的标记面) ---
    approveCharter: (projectId, userId, body) => baselines.approveCharter(repo, projectId, userId, body),
    listCharterVersions: (projectId, userId) => baselines.listCharterVersions(repo, projectId, userId),
    getCharterBaseline: (projectId, userId) => baselines.getCharterBaseline(repo, projectId, userId),
    listReviewMarks: (projectId, userId, query) => baselines.listReviewMarks(repo, projectId, userId, query),
    clearReviewMark: (markId, userId) => baselines.clearReviewMark(repo, markId, userId),

    // --- 来源引用 (P5-C: R03 的归档前检查与归档标记) ---
    findReferences: (userId, query) => references.findResearchReferences(repo, userId, query),
    markSourceArchived: (userId, body) => references.markSourceArchived(repo, userId, body),

    // --- questions ---
    createQuestion: (projectId, userId, body) => questions.createQuestion(repo, projectId, userId, body),
    listQuestions: (projectId, userId) => questions.listQuestions(repo, projectId, userId),
    updateQuestion: (questionId, userId, body) => questions.updateQuestion(repo, questionId, userId, body),

    // --- evidence ---
    createEvidence: (projectId, userId, body) => evidence.createEvidence(repo, projectId, userId, body),
    listEvidence: (projectId, userId, query) => evidence.listEvidence(repo, projectId, userId, query),
    updateEvidence: (evidenceId, userId, body) => evidence.updateEvidence(repo, evidenceId, userId, body),

    // --- claims ---
    createClaim: (projectId, userId, body) => claims.createClaim(repo, projectId, userId, body),
    listClaims: (projectId, userId, query) => claims.listClaims(repo, projectId, userId, query),
    updateClaim: (claimId, userId, body) => claims.updateClaim(repo, claimId, userId, body),

    // --- sections ---
    createSection: (projectId, userId, body) => sections.createSection(repo, projectId, userId, body),
    listSections: (projectId, userId) => sections.listSections(repo, projectId, userId),
    updateSection: (sectionId, userId, body) => sections.updateSection(repo, sectionId, userId, body),

    // --- relations ---
    createRelation: (projectId, userId, body) => relations.createRelation(repo, projectId, userId, body),
    listRelations: (projectId, userId, query) => relations.listRelations(repo, projectId, userId, query),
    deleteRelation: (relationId, userId) => relations.deleteRelation(repo, relationId, userId),

    // --- decisions / changes (append-only; each write also appends a timeline event) ---
    createDecision: (projectId, userId, body) => decisions.createDecision(repo, projectId, userId, body),
    listDecisions: (projectId, userId) => decisions.listDecisions(repo, projectId, userId),
    createChange: (projectId, userId, body) => changes.createChange(repo, projectId, userId, body),
    listChanges: (projectId, userId, query) => changes.listChanges(repo, projectId, userId, query),

    // --- timeline ---
    listTimeline: (projectId, userId) => timeline.listTimeline(repo, projectId, userId),
    createMilestone: (projectId, userId, body) => timeline.createMilestone(repo, projectId, userId, body),

    // --- drift (P6: R04/R05 六类偏移检查与人工处理) ---
    runDriftCheck: (projectId, userId, body) => runDriftCheck(repo, projectId, userId, body),
    listDriftFindings: (projectId, userId, query) => listDriftFindings(repo, projectId, userId, query),
    updateDriftFinding: (findingId, userId, body) => updateDriftFinding(repo, findingId, userId, body),

    // --- aggregates (P6: R07 研究地图与上下文包) ---
    buildMap: (projectId, userId) => buildMap(repo, projectId, userId),
    buildContextPack: (projectId, userId) => buildContextPackOf(repo, projectId, userId),
  };
}

/**
 * Drift persistence wrapper (contract §5): run the pure rules over a fresh snapshot, skip drafts
 * whose `(driftType, sourceEntityId, targetEntityId)` already has an `open` finding, persist the
 * rest, and return everything (existing open findings included) with a summary of what is returned.
 */
async function runDriftCheck(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  body: DriftCheckRequest,
): Promise<DriftCheckResponse> {
  await requireProject(repo, projectId, userId);
  const request = validateRequest(driftCheckRequestSchema, body ?? {}, 'drift check');

  const [charter, questionsSnapshot, evidenceSnapshot, claimsSnapshot, relationsSnapshot, changesSnapshot, existingOpen] =
    await Promise.all([
      repo.findCharter(projectId, userId),
      repo.listResearchQuestions(projectId, userId),
      repo.listEvidence(projectId, userId),
      repo.listClaims(projectId, userId),
      repo.listEntityRelations(projectId, userId),
      repo.listResearchChanges(projectId, userId),
      repo.listDriftFindings(projectId, userId, { status: 'open' }),
    ]);

  const drafts = runDriftChecks({
    charter,
    questions: questionsSnapshot,
    evidence: evidenceSnapshot,
    claims: claimsSnapshot,
    relations: relationsSnapshot,
    changes: changesSnapshot,
    manuscriptText: request.manuscriptText,
  });

  const openKeys = new Set(existingOpen.map((finding) => driftFindingKey(finding)));
  const created: DriftFinding[] = [];
  for (const draft of drafts) {
    if (openKeys.has(driftFindingKey(draft))) continue; // already open: merged into the result as-is
    const finding = await repo.createDriftFinding({
      userId,
      projectId,
      driftType: draft.driftType,
      severity: draft.severity,
      description: draft.description,
      sourceEntityType: draft.sourceEntityType,
      sourceEntityId: draft.sourceEntityId,
      targetEntityType: draft.targetEntityType,
      targetEntityId: draft.targetEntityId,
      reason: draft.reason,
      recommendedAction: draft.recommendedAction,
    });
    created.push(finding);
  }

  const findings = [...existingOpen, ...created];
  const summary = {
    total: findings.length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    critical: findings.filter((finding) => finding.severity === 'critical').length,
  };
  return { findings, summary };
}

async function listDriftFindings(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
  query: DriftFindingListQuery,
): Promise<DriftFinding[]> {
  await requireProject(repo, projectId, userId);
  return repo.listDriftFindings(projectId, userId, query);
}

async function updateDriftFinding(
  repo: ResearchRepository,
  findingId: string,
  userId: string,
  body: PatchDriftFindingRequest,
): Promise<DriftFinding> {
  const existing = await repo.findDriftFinding(findingId, userId);
  if (existing === null) {
    throw knowledgeError('not_found', 'drift finding 不存在或无权访问 / drift finding not found');
  }
  return repo.updateDriftFindingStatus(findingId, userId, body.status);
}

async function buildMap(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchMapResponse> {
  const project = await requireProject(repo, projectId, userId);
  const [charter, questionRows, evidenceRows, claimRows, sectionRows, relationRows] = await Promise.all([
    repo.findCharter(projectId, userId),
    repo.listResearchQuestions(projectId, userId),
    repo.listEvidence(projectId, userId),
    repo.listClaims(projectId, userId),
    repo.listManuscriptSections(projectId, userId),
    repo.listEntityRelations(projectId, userId),
  ]);
  return buildResearchMap({
    project,
    charter,
    questions: questionRows,
    evidence: evidenceRows,
    claims: claimRows,
    sections: sectionRows,
    relations: relationRows,
  });
}

async function buildContextPackOf(
  repo: ResearchRepository,
  projectId: string,
  userId: string,
): Promise<ResearchContextPackResponse> {
  const project = await requireProject(repo, projectId, userId);
  const [charter, questionRows, claimRows, evidenceRows, relationRows, decisionRows, changeRows, openFindings] =
    await Promise.all([
      repo.findCharter(projectId, userId),
      repo.listResearchQuestions(projectId, userId),
      repo.listClaims(projectId, userId),
      repo.listEvidence(projectId, userId),
      repo.listEntityRelations(projectId, userId),
      repo.listResearchDecisions(projectId, userId),
      repo.listResearchChanges(projectId, userId),
      repo.listDriftFindings(projectId, userId, { status: 'open' }),
    ]);
  const { blocks, markdown } = buildContextPack({
    project,
    charter,
    questions: questionRows,
    claims: claimRows,
    evidence: evidenceRows,
    relations: relationRows,
    decisions: decisionRows,
    changes: changeRows,
    openFindings,
  });
  return { markdown, blocks, generatedAt: nowIso() };
}
