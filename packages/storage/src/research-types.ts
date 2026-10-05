import type {
  CharterFields,
  CharterVersion,
  Claim,
  ClaimStatus,
  ClaimType,
  CreateCharterVersionInput,
  CreateClaimInput,
  CreateDriftFindingInput,
  CreateEntityRelationInput,
  CreateEvidenceInput,
  CreateManuscriptSectionInput,
  CreateResearchChangeInput,
  CreateResearchDecisionInput,
  CreateResearchProjectInput,
  CreateResearchQuestionInput,
  CreateReviewMarkInput,
  CreateTimelineEventInput,
  DriftFinding,
  DriftFindingStatus,
  DriftSeverity,
  DriftType,
  EntityRelation,
  Evidence,
  EvidenceType,
  ManuscriptSection,
  ResearchChange,
  ResearchChangeType,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchProjectStatus,
  ResearchQuestion,
  ResearchRelationType,
  ResearchEntityType,
  ResearchReviewMark,
  ReviewMarkRaisedBy,
  ReviewMarkStatus,
  TimelineEvent,
} from '@noltri/schema';
import type { StorageDriverName } from './types';

/**
 * The research half of the storage seam (research doc §27–§29).
 *
 * Kept as its own interface so the knowledge repository stays untouched — Research V1 adds
 * tables and a driver pair, it never rewrites the coding/knowledge domain. Same rules apply:
 * identity is supplied by the caller (from credentials), timestamps are written by the driver,
 * and decisions/changes are append-only.
 */

export interface ResearchProjectStats {
  questionCount: number;
  evidenceCount: number;
  claimCount: number;
  decisionCount: number;
  changeCount: number;
  openDriftCount: number;
}

export interface EvidenceListOptions {
  type?: EvidenceType;
}

export interface ClaimListOptions {
  status?: ClaimStatus;
  claimType?: ClaimType;
}

export interface RelationFilter {
  sourceType?: ResearchEntityType;
  sourceId?: string;
  targetType?: ResearchEntityType;
  targetId?: string;
  relationType?: ResearchRelationType;
}

export interface ResearchChangeListOptions {
  changeType?: ResearchChangeType;
}

export interface DriftFindingListOptions {
  status?: DriftFindingStatus;
  driftType?: DriftType;
  severity?: DriftSeverity;
}

export interface ReviewMarkListOptions {
  status?: ReviewMarkStatus;
  entityType?: ResearchEntityType;
  entityId?: string;
  raisedBy?: ReviewMarkRaisedBy;
}

export type UpdateResearchProjectPatch = Partial<
  Pick<ResearchProject, 'name' | 'description' | 'status'>
>;
export type UpdateResearchQuestionPatch = Partial<
  Pick<ResearchQuestion, 'questionCode' | 'questionText' | 'status' | 'rationale' | 'relatedMethod'>
>;
export type UpdateEvidencePatch = Partial<
  Pick<
    Evidence,
    'type' | 'title' | 'description' | 'sourceReference' | 'sourceLocation' | 'reliabilityNote'
  >
>;
export type UpdateClaimPatch = Partial<
  Pick<Claim, 'claimCode' | 'claimText' | 'claimType' | 'status' | 'confidence' | 'boundary'>
>;
export type UpdateManuscriptSectionPatch = Partial<
  Pick<ManuscriptSection, 'sectionName' | 'sectionReference' | 'sortOrder'>
>;

export interface ResearchRepository {
  readonly driver: StorageDriverName;

  // --- project (common layer identity/state) ---
  createResearchProject(input: CreateResearchProjectInput): Promise<ResearchProject>;
  findResearchProject(id: string, userId: string): Promise<ResearchProject | null>;
  listResearchProjects(userId: string): Promise<ResearchProject[]>;
  updateResearchProject(
    id: string,
    userId: string,
    patch: UpdateResearchProjectPatch,
  ): Promise<ResearchProject>;
  researchProjectStats(projectId: string, userId: string): Promise<ResearchProjectStats>;

  // --- charter (one per project; create-or-update, history via ResearchChange) ---
  findCharter(projectId: string, userId: string): Promise<ResearchCharter | null>;
  upsertCharter(input: CharterFields & { userId: string; projectId: string }): Promise<ResearchCharter>;

  // --- approved baselines (R06: 不可变批准版本 + 当前草稿) ---
  /**
   * Appends one frozen snapshot. The domain picks `version` and computes `changedFields` — a driver that
   * numbered or diffed on its own would give the same database two histories — and the
   * `(project_id, version)` uniqueness is what turns a lost race into an error instead of a second v2.
   */
  createCharterVersion(input: CreateCharterVersionInput): Promise<CharterVersion>;
  /** Newest baseline first, or `[]` while nothing has ever been approved. */
  listCharterVersions(projectId: string, userId: string): Promise<CharterVersion[]>;
  /** The highest-numbered version: what 后续检查 bind to. `null` before the first approval. */
  findCharterBaseline(projectId: string, userId: string): Promise<CharterVersion | null>;

  // --- review marks (R03/R06: 影响对象被标记) ---
  /** One mark per (entity, cause, baseline): raising twice refreshes it instead of stacking duplicates. */
  raiseReviewMark(input: CreateReviewMarkInput): Promise<ResearchReviewMark>;
  findReviewMark(id: string, userId: string): Promise<ResearchReviewMark | null>;
  listReviewMarks(
    projectId: string,
    userId: string,
    options?: ReviewMarkListOptions,
  ): Promise<ResearchReviewMark[]>;
  /** 处理完了。The row stays — a cleared mark is history, and deleting warnings is how a project
   *  ends up looking like it never drifted (开发文档 §14). */
  clearReviewMark(id: string, userId: string): Promise<ResearchReviewMark>;

  // --- research questions ---
  createResearchQuestion(input: CreateResearchQuestionInput): Promise<ResearchQuestion>;
  findResearchQuestion(id: string, userId: string): Promise<ResearchQuestion | null>;
  listResearchQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]>;
  updateResearchQuestion(
    id: string,
    userId: string,
    patch: UpdateResearchQuestionPatch,
  ): Promise<ResearchQuestion>;

  // --- evidence ---
  createEvidence(input: CreateEvidenceInput): Promise<Evidence>;
  findEvidence(id: string, userId: string): Promise<Evidence | null>;
  listEvidence(projectId: string, userId: string, options?: EvidenceListOptions): Promise<Evidence[]>;
  updateEvidence(id: string, userId: string, patch: UpdateEvidencePatch): Promise<Evidence>;

  // --- claims ---
  createClaim(input: CreateClaimInput): Promise<Claim>;
  findClaim(id: string, userId: string): Promise<Claim | null>;
  listClaims(projectId: string, userId: string, options?: ClaimListOptions): Promise<Claim[]>;
  updateClaim(id: string, userId: string, patch: UpdateClaimPatch): Promise<Claim>;

  // --- manuscript sections ---
  createManuscriptSection(input: CreateManuscriptSectionInput): Promise<ManuscriptSection>;
  findManuscriptSection(id: string, userId: string): Promise<ManuscriptSection | null>;
  listManuscriptSections(projectId: string, userId: string): Promise<ManuscriptSection[]>;
  updateManuscriptSection(
    id: string,
    userId: string,
    patch: UpdateManuscriptSectionPatch,
  ): Promise<ManuscriptSection>;

  // --- generic relations (one table for evidence↔claim, claim↔rq, claim↔section, …) ---
  createEntityRelation(input: CreateEntityRelationInput): Promise<EntityRelation>;
  listEntityRelations(
    projectId: string,
    userId: string,
    filter?: RelationFilter,
  ): Promise<EntityRelation[]>;
  /** Removing a link is allowed; the entities it connected are never deleted with it. */
  deleteEntityRelation(id: string, userId: string): Promise<boolean>;

  // --- decisions (append-only history) ---
  createResearchDecision(input: CreateResearchDecisionInput): Promise<ResearchDecision>;
  findResearchDecision(id: string, userId: string): Promise<ResearchDecision | null>;
  listResearchDecisions(projectId: string, userId: string): Promise<ResearchDecision[]>;

  // --- changes (append-only history) ---
  createResearchChange(input: CreateResearchChangeInput): Promise<ResearchChange>;
  findResearchChange(id: string, userId: string): Promise<ResearchChange | null>;
  listResearchChanges(
    projectId: string,
    userId: string,
    options?: ResearchChangeListOptions,
  ): Promise<ResearchChange[]>;

  // --- drift findings ---
  createDriftFinding(input: CreateDriftFindingInput): Promise<DriftFinding>;
  findDriftFinding(id: string, userId: string): Promise<DriftFinding | null>;
  listDriftFindings(
    projectId: string,
    userId: string,
    options?: DriftFindingListOptions,
  ): Promise<DriftFinding[]>;
  updateDriftFindingStatus(
    id: string,
    userId: string,
    status: DriftFindingStatus,
  ): Promise<DriftFinding>;

  // --- timeline (decision + change + milestone events, research doc §20) ---
  createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEvent>;
  listTimelineEvents(projectId: string, userId: string): Promise<TimelineEvent[]>;
}

export type { StorageDriverName };
export type { CharterFields };
