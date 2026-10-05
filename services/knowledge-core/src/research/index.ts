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
 * The archived façade also carried `runDriftCheck`, `listDriftFindings`, `updateDriftFinding`,
 * `buildMap` and `buildContextPack`. They are deliberately absent here: 六类偏移检查、研究地图与上下文包
 * is phase P6 of the local-desktop plan, and shipping the storage rows for a finding is not the same as
 * shipping the rule that produces one. `research_projects` … `research_timeline_events` all persist
 * today, including the drift-finding table, so P6 extends this file rather than reshaping it.
 */
import type {
  ApproveCharterRequest,
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
  EntityRelation,
  Evidence,
  EvidenceListQuery,
  ManuscriptSection,
  PatchClaimRequest,
  PatchEvidenceRequest,
  PatchResearchProjectRequest,
  PatchResearchQuestionRequest,
  PatchSectionRequest,
  RelationListQuery,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
  ResearchReviewMark,
  ReviewMarkListQuery,
  TimelineEvent,
} from '@noltri/schema';
import type { ResearchRepository } from '@noltri/storage';
import * as baselines from './baselines';
import * as changes from './changes';
import * as claims from './claims';
import * as decisions from './decisions';
import * as evidence from './evidence';
import * as projects from './projects';
import * as questions from './questions';
import * as relations from './relations';
import * as sections from './sections';
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
  };
}
