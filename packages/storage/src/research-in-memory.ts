import type {
  CharterVersion,
  Claim,
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
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
  ResearchReviewMark,
  TimelineEvent,
} from '@noltri/schema';
import { createId, knowledgeError, nowIso } from '@noltri/shared';
import type {
  CharterFields,
  ClaimListOptions,
  DriftFindingListOptions,
  EvidenceListOptions,
  EvidenceSourceFilter,
  RelationFilter,
  ResearchChangeListOptions,
  ResearchProjectStats,
  ResearchRepository,
  ReviewMarkListOptions,
  StorageDriverName,
  UpdateClaimPatch,
  UpdateEvidencePatch,
  UpdateManuscriptSectionPatch,
  UpdateResearchProjectPatch,
  UpdateResearchQuestionPatch,
} from './research-types';

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** created_at asc for every list except the timeline, which reads newest-first (research doc §20).
 *  Ties keep creation order: Map iteration is insertion-ordered and the sort is stable. */
function byCreatedAt(first: { createdAt: string }, second: { createdAt: string }): number {
  return first.createdAt.localeCompare(second.createdAt);
}

function byOccurredAtDesc(first: { occurredAt: string }, second: { occurredAt: string }): number {
  return second.occurredAt.localeCompare(first.occurredAt);
}

export class InMemoryResearchRepository implements ResearchRepository {
  readonly driver: StorageDriverName = 'memory';

  private readonly projects = new Map<string, ResearchProject>();
  private readonly charters = new Map<string, ResearchCharter>();
  private readonly charterVersions = new Map<string, CharterVersion>();
  private readonly reviewMarks = new Map<string, ResearchReviewMark>();
  private readonly questions = new Map<string, ResearchQuestion>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly claims = new Map<string, Claim>();
  private readonly sections = new Map<string, ManuscriptSection>();
  private readonly relations = new Map<string, EntityRelation>();
  private readonly decisions = new Map<string, ResearchDecision>();
  private readonly changes = new Map<string, ResearchChange>();
  private readonly findings = new Map<string, DriftFinding>();
  private readonly timeline = new Map<string, TimelineEvent>();

  // --- project ---

  async createResearchProject(input: CreateResearchProjectInput): Promise<ResearchProject> {
    const timestamp = nowIso();
    const record: ResearchProject = {
      id: createId(),
      userId: input.userId,
      name: input.name.trim(),
      description: input.description ?? null,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(record.id, record);
    return clone(record);
  }

  async findResearchProject(id: string, userId: string): Promise<ResearchProject | null> {
    const found = this.projects.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listResearchProjects(userId: string): Promise<ResearchProject[]> {
    return [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateResearchProject(
    id: string,
    userId: string,
    patch: UpdateResearchProjectPatch,
  ): Promise<ResearchProject> {
    const existing = this.projects.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `ResearchProject ${id} not found`);
    }
    const updated: ResearchProject = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: nowIso(),
    };
    this.projects.set(id, updated);
    return clone(updated);
  }

  async researchProjectStats(projectId: string, userId: string): Promise<ResearchProjectStats> {
    this.requireProject(projectId, userId);
    return {
      questionCount: this.countIn(this.questions, projectId),
      evidenceCount: this.countIn(this.evidence, projectId),
      claimCount: this.countIn(this.claims, projectId),
      decisionCount: this.countIn(this.decisions, projectId),
      changeCount: this.countIn(this.changes, projectId),
      openDriftCount: [...this.findings.values()].filter(
        (finding) => finding.projectId === projectId && finding.status === 'open',
      ).length,
    };
  }

  // --- charter (one per project) ---

  async findCharter(projectId: string, userId: string): Promise<ResearchCharter | null> {
    const found = [...this.charters.values()].find(
      (charter) => charter.projectId === projectId && charter.userId === userId,
    );
    return found ? clone(found) : null;
  }

  async upsertCharter(input: CharterFields & { userId: string; projectId: string }): Promise<ResearchCharter> {
    this.requireProject(input.projectId, input.userId);
    const fields = {
      workingTitle: input.workingTitle,
      researchTopic: input.researchTopic ?? null,
      researchProblem: input.researchProblem ?? null,
      researchGap: input.researchGap ?? null,
      researchQuestionsText: input.researchQuestionsText ?? null,
      coreContribution: input.coreContribution ?? null,
      theoreticalLens: input.theoreticalLens ?? null,
      researchContext: input.researchContext ?? null,
      unitOfAnalysis: input.unitOfAnalysis ?? null,
      researchMethod: input.researchMethod ?? null,
      targetArticleType: input.targetArticleType ?? null,
      targetJournal: input.targetJournal ?? null,
      researchBoundary: input.researchBoundary ?? null,
      claimBoundary: input.claimBoundary ?? null,
      currentStage: input.currentStage ?? null,
    };
    const existing = [...this.charters.values()].find(
      (charter) => charter.projectId === input.projectId && charter.userId === input.userId,
    );
    if (existing) {
      const updated: ResearchCharter = { ...existing, ...fields, updatedAt: nowIso() };
      this.charters.set(updated.id, updated);
      return clone(updated);
    }
    const timestamp = nowIso();
    const record: ResearchCharter = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      ...fields,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.charters.set(record.id, record);
    return clone(record);
  }

  // --- approved baselines ---

  async createCharterVersion(input: CreateCharterVersionInput): Promise<CharterVersion> {
    this.requireProject(input.projectId, input.userId);
    const clash = [...this.charterVersions.values()].find(
      (row) => row.projectId === input.projectId && row.version === input.version,
    );
    if (clash !== undefined) {
      throw knowledgeError('storage_error', `章程版本 ${input.version} 已存在 / charter version already exists`, {
        projectId: input.projectId,
        version: input.version,
      });
    }
    const record: CharterVersion = {
      id: createId(),
      userId: input.userId,
      projectId: input.projectId,
      version: input.version,
      previousVersion: input.previousVersion,
      charter: clone(input.charter),
      changedFields: [...input.changedFields],
      revisionReason: input.revisionReason,
      decisionId: input.decisionId,
      approvedAt: nowIso(),
    };
    this.charterVersions.set(record.id, record);
    return clone(record);
  }

  async listCharterVersions(projectId: string, userId: string): Promise<CharterVersion[]> {
    this.requireProject(projectId, userId);
    return [...this.charterVersions.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .sort((first, second) => second.version - first.version)
      .map(clone);
  }

  /**
   * A plain read, not an ownership-guarded one: like `findCharter`, it answers `null` for a project the
   * caller cannot see rather than confirming that the id exists.
   */
  async findCharterBaseline(projectId: string, userId: string): Promise<CharterVersion | null> {
    const newest = [...this.charterVersions.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .sort((first, second) => second.version - first.version)[0];
    return newest === undefined ? null : clone(newest);
  }

  // --- review marks ---

  async raiseReviewMark(input: CreateReviewMarkInput): Promise<ResearchReviewMark> {
    this.requireProject(input.projectId, input.userId);
    const charterVersion = input.charterVersion ?? null;
    const existing = [...this.reviewMarks.values()].find(
      (mark) =>
        mark.projectId === input.projectId &&
        mark.userId === input.userId &&
        mark.entityType === input.entityType &&
        mark.entityId === input.entityId &&
        mark.raisedBy === input.raisedBy &&
        mark.charterVersion === charterVersion,
    );
    if (existing !== undefined) {
      // The same cause on the same object is one warning, refreshed — not a pile of duplicates.
      const raised: ResearchReviewMark = {
        ...existing,
        reason: input.reason,
        status: 'pending',
        updatedAt: nowIso(),
      };
      this.reviewMarks.set(raised.id, raised);
      return clone(raised);
    }
    const timestamp = nowIso();
    const record: ResearchReviewMark = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      reason: input.reason,
      raisedBy: input.raisedBy,
      charterVersion,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.reviewMarks.set(record.id, record);
    return clone(record);
  }

  async findReviewMark(id: string, userId: string): Promise<ResearchReviewMark | null> {
    const found = this.reviewMarks.get(id);
    return found === undefined || found.userId !== userId ? null : clone(found);
  }

  async listReviewMarks(
    projectId: string,
    userId: string,
    options: ReviewMarkListOptions = {},
  ): Promise<ResearchReviewMark[]> {
    this.requireProject(projectId, userId);
    return [...this.reviewMarks.values()]
      .filter(
        (mark) =>
          mark.projectId === projectId &&
          mark.userId === userId &&
          (options.status === undefined || mark.status === options.status) &&
          (options.entityType === undefined || mark.entityType === options.entityType) &&
          (options.entityId === undefined || mark.entityId === options.entityId) &&
          (options.raisedBy === undefined || mark.raisedBy === options.raisedBy),
      )
      .sort(byCreatedAt)
      .map(clone);
  }

  async clearReviewMark(id: string, userId: string): Promise<ResearchReviewMark> {
    const found = this.reviewMarks.get(id);
    if (found === undefined || found.userId !== userId) {
      throw knowledgeError('not_found', `ResearchReviewMark ${id} not found`);
    }
    const cleared: ResearchReviewMark = { ...found, status: 'cleared', updatedAt: nowIso() };
    this.reviewMarks.set(id, cleared);
    return clone(cleared);
  }

  // --- research questions ---

  async createResearchQuestion(input: CreateResearchQuestionInput): Promise<ResearchQuestion> {
    this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const record: ResearchQuestion = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      questionCode: input.questionCode,
      questionText: input.questionText,
      status: input.status ?? 'open',
      rationale: input.rationale ?? null,
      relatedMethod: input.relatedMethod ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.questions.set(record.id, record);
    return clone(record);
  }

  async findResearchQuestion(id: string, userId: string): Promise<ResearchQuestion | null> {
    const found = this.questions.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listResearchQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]> {
    this.requireProject(projectId, userId);
    return [...this.questions.values()]
      .filter((question) => question.projectId === projectId && question.userId === userId)
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateResearchQuestion(
    id: string,
    userId: string,
    patch: UpdateResearchQuestionPatch,
  ): Promise<ResearchQuestion> {
    const existing = this.questions.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `ResearchQuestion ${id} not found`);
    }
    const updated: ResearchQuestion = {
      ...existing,
      ...(patch.questionCode !== undefined ? { questionCode: patch.questionCode } : {}),
      ...(patch.questionText !== undefined ? { questionText: patch.questionText } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
      ...(patch.relatedMethod !== undefined ? { relatedMethod: patch.relatedMethod } : {}),
      updatedAt: nowIso(),
    };
    this.questions.set(id, updated);
    return clone(updated);
  }

  // --- evidence ---

  async createEvidence(input: CreateEvidenceInput): Promise<Evidence> {
    this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const record: Evidence = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      sourceReference: input.sourceReference ?? null,
      sourceLocation: input.sourceLocation ?? null,
      rawSourceId: input.rawSourceId ?? null,
      nodeId: input.nodeId ?? null,
      locationOrigin: input.locationOrigin ?? null,
      reliabilityNote: input.reliabilityNote ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.evidence.set(record.id, record);
    return clone(record);
  }

  async findEvidence(id: string, userId: string): Promise<Evidence | null> {
    const found = this.evidence.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listEvidence(projectId: string, userId: string, options: EvidenceListOptions = {}): Promise<Evidence[]> {
    this.requireProject(projectId, userId);
    return [...this.evidence.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .filter((row) => (options.type ? row.type === options.type : true))
      .sort(byCreatedAt)
      .map(clone);
  }

  async listEvidenceBySource(userId: string, filter: EvidenceSourceFilter): Promise<Evidence[]> {
    const { nodeId, rawSourceId } = filter;
    if (nodeId === undefined && rawSourceId === undefined) return [];
    return [...this.evidence.values()]
      .filter((row) => row.userId === userId)
      .filter(
        (row) =>
          (nodeId !== undefined && row.nodeId === nodeId) ||
          (rawSourceId !== undefined && row.rawSourceId === rawSourceId),
      )
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateEvidence(id: string, userId: string, patch: UpdateEvidencePatch): Promise<Evidence> {
    const existing = this.evidence.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `Evidence ${id} not found`);
    }
    const updated: Evidence = {
      ...existing,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sourceReference !== undefined ? { sourceReference: patch.sourceReference } : {}),
      ...(patch.sourceLocation !== undefined ? { sourceLocation: patch.sourceLocation } : {}),
      ...(patch.rawSourceId !== undefined ? { rawSourceId: patch.rawSourceId } : {}),
      ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
      ...(patch.locationOrigin !== undefined ? { locationOrigin: patch.locationOrigin } : {}),
      ...(patch.reliabilityNote !== undefined ? { reliabilityNote: patch.reliabilityNote } : {}),
      updatedAt: nowIso(),
    };
    this.evidence.set(id, updated);
    return clone(updated);
  }

  // --- claims ---

  async createClaim(input: CreateClaimInput): Promise<Claim> {
    this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const record: Claim = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      claimCode: input.claimCode,
      claimText: input.claimText,
      claimType: input.claimType,
      status: input.status ?? 'draft',
      confidence: input.confidence ?? 0,
      boundary: input.boundary ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.claims.set(record.id, record);
    return clone(record);
  }

  async findClaim(id: string, userId: string): Promise<Claim | null> {
    const found = this.claims.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listClaims(projectId: string, userId: string, options: ClaimListOptions = {}): Promise<Claim[]> {
    this.requireProject(projectId, userId);
    return [...this.claims.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .filter((row) => (options.status ? row.status === options.status : true))
      .filter((row) => (options.claimType ? row.claimType === options.claimType : true))
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateClaim(id: string, userId: string, patch: UpdateClaimPatch): Promise<Claim> {
    const existing = this.claims.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `Claim ${id} not found`);
    }
    const updated: Claim = {
      ...existing,
      ...(patch.claimCode !== undefined ? { claimCode: patch.claimCode } : {}),
      ...(patch.claimText !== undefined ? { claimText: patch.claimText } : {}),
      ...(patch.claimType !== undefined ? { claimType: patch.claimType } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.boundary !== undefined ? { boundary: patch.boundary } : {}),
      updatedAt: nowIso(),
    };
    this.claims.set(id, updated);
    return clone(updated);
  }

  // --- manuscript sections ---

  async createManuscriptSection(input: CreateManuscriptSectionInput): Promise<ManuscriptSection> {
    this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const record: ManuscriptSection = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      sectionName: input.sectionName,
      sectionReference: input.sectionReference ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sections.set(record.id, record);
    return clone(record);
  }

  async findManuscriptSection(id: string, userId: string): Promise<ManuscriptSection | null> {
    const found = this.sections.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listManuscriptSections(projectId: string, userId: string): Promise<ManuscriptSection[]> {
    this.requireProject(projectId, userId);
    return [...this.sections.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateManuscriptSection(
    id: string,
    userId: string,
    patch: UpdateManuscriptSectionPatch,
  ): Promise<ManuscriptSection> {
    const existing = this.sections.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `ManuscriptSection ${id} not found`);
    }
    const updated: ManuscriptSection = {
      ...existing,
      ...(patch.sectionName !== undefined ? { sectionName: patch.sectionName } : {}),
      ...(patch.sectionReference !== undefined ? { sectionReference: patch.sectionReference } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      updatedAt: nowIso(),
    };
    this.sections.set(id, updated);
    return clone(updated);
  }

  // --- generic relations ---

  async createEntityRelation(input: CreateEntityRelationInput): Promise<EntityRelation> {
    this.requireProject(input.projectId, input.userId);
    // Idempotent on the five-tuple (research doc §16/§17, contract §2): a repeat create returns
    // the existing row untouched instead of stacking duplicates.
    for (const relation of this.relations.values()) {
      if (
        relation.userId === input.userId &&
        relation.projectId === input.projectId &&
        relation.sourceType === input.sourceType &&
        relation.sourceId === input.sourceId &&
        relation.relationType === input.relationType &&
        relation.targetType === input.targetType &&
        relation.targetId === input.targetId
      ) {
        return clone(relation);
      }
    }
    const record: EntityRelation = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      relationType: input.relationType,
      targetType: input.targetType,
      targetId: input.targetId,
      note: input.note ?? null,
      createdAt: nowIso(),
    };
    this.relations.set(record.id, record);
    return clone(record);
  }

  async listEntityRelations(
    projectId: string,
    userId: string,
    filter: RelationFilter = {},
  ): Promise<EntityRelation[]> {
    this.requireProject(projectId, userId);
    return [...this.relations.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .filter((row) => (filter.sourceType ? row.sourceType === filter.sourceType : true))
      .filter((row) => (filter.sourceId ? row.sourceId === filter.sourceId : true))
      .filter((row) => (filter.targetType ? row.targetType === filter.targetType : true))
      .filter((row) => (filter.targetId ? row.targetId === filter.targetId : true))
      .filter((row) => (filter.relationType ? row.relationType === filter.relationType : true))
      .sort(byCreatedAt)
      .map(clone);
  }

  async deleteEntityRelation(id: string, userId: string): Promise<boolean> {
    const found = this.relations.get(id);
    if (!found || found.userId !== userId) return false;
    this.relations.delete(id);
    return true;
  }

  // --- decisions (append-only) ---

  async createResearchDecision(input: CreateResearchDecisionInput): Promise<ResearchDecision> {
    this.requireProject(input.projectId, input.userId);
    const record: ResearchDecision = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      title: input.title,
      decision: input.decision,
      reason: input.reason ?? null,
      alternatives: input.alternatives ?? null,
      rejectedAlternatives: input.rejectedAlternatives ?? null,
      impact: input.impact ?? null,
      relatedEntities: input.relatedEntities ?? {},
      createdAt: nowIso(),
    };
    this.decisions.set(record.id, record);
    return clone(record);
  }

  async findResearchDecision(id: string, userId: string): Promise<ResearchDecision | null> {
    const found = this.decisions.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listResearchDecisions(projectId: string, userId: string): Promise<ResearchDecision[]> {
    this.requireProject(projectId, userId);
    return [...this.decisions.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .sort(byCreatedAt)
      .map(clone);
  }

  // --- changes (append-only) ---

  async createResearchChange(input: CreateResearchChangeInput): Promise<ResearchChange> {
    this.requireProject(input.projectId, input.userId);
    const record: ResearchChange = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      changeType: input.changeType,
      before: input.before,
      after: input.after,
      reason: input.reason ?? null,
      impact: input.impact ?? null,
      relatedEntities: input.relatedEntities ?? {},
      createdAt: nowIso(),
    };
    this.changes.set(record.id, record);
    return clone(record);
  }

  async findResearchChange(id: string, userId: string): Promise<ResearchChange | null> {
    const found = this.changes.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listResearchChanges(
    projectId: string,
    userId: string,
    options: ResearchChangeListOptions = {},
  ): Promise<ResearchChange[]> {
    this.requireProject(projectId, userId);
    return [...this.changes.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .filter((row) => (options.changeType ? row.changeType === options.changeType : true))
      .sort(byCreatedAt)
      .map(clone);
  }

  // --- drift findings ---

  async createDriftFinding(input: CreateDriftFindingInput): Promise<DriftFinding> {
    this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const record: DriftFinding = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      driftType: input.driftType,
      severity: input.severity,
      description: input.description,
      sourceEntityType: input.sourceEntityType ?? null,
      sourceEntityId: input.sourceEntityId ?? null,
      targetEntityType: input.targetEntityType ?? null,
      targetEntityId: input.targetEntityId ?? null,
      reason: input.reason ?? null,
      recommendedAction: input.recommendedAction ?? null,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.findings.set(record.id, record);
    return clone(record);
  }

  async findDriftFinding(id: string, userId: string): Promise<DriftFinding | null> {
    const found = this.findings.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listDriftFindings(
    projectId: string,
    userId: string,
    options: DriftFindingListOptions = {},
  ): Promise<DriftFinding[]> {
    this.requireProject(projectId, userId);
    return [...this.findings.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .filter((row) => (options.status ? row.status === options.status : true))
      .filter((row) => (options.driftType ? row.driftType === options.driftType : true))
      .filter((row) => (options.severity ? row.severity === options.severity : true))
      .sort(byCreatedAt)
      .map(clone);
  }

  async updateDriftFindingStatus(
    id: string,
    userId: string,
    status: DriftFindingStatus,
  ): Promise<DriftFinding> {
    const existing = this.findings.get(id);
    if (!existing || existing.userId !== userId) {
      throw knowledgeError('not_found', `DriftFinding ${id} not found`);
    }
    const updated: DriftFinding = { ...existing, status, updatedAt: nowIso() };
    this.findings.set(id, updated);
    return clone(updated);
  }

  // --- timeline ---

  async createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEvent> {
    this.requireProject(input.projectId, input.userId);
    const record: TimelineEvent = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      title: input.title,
      summary: input.summary ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      relatedEntities: input.relatedEntities ?? {},
      createdAt: nowIso(),
    };
    this.timeline.set(record.id, record);
    return clone(record);
  }

  async listTimelineEvents(projectId: string, userId: string): Promise<TimelineEvent[]> {
    this.requireProject(projectId, userId);
    return [...this.timeline.values()]
      .filter((row) => row.projectId === projectId && row.userId === userId)
      .sort(byOccurredAtDesc)
      .map(clone);
  }

  // --- shared guards ---

  /** Project-scoped calls never touch another user's project (contract §2): absent and foreign
   *  projects are indistinguishable — both surface as `not_found`. */
  private requireProject(projectId: string, userId: string): void {
    const project = this.projects.get(projectId);
    if (!project || project.userId !== userId) {
      throw knowledgeError('not_found', `ResearchProject ${projectId} not found`);
    }
  }

  private countIn(rows: Map<string, { projectId: string }>, projectId: string): number {
    return [...rows.values()].filter((row) => row.projectId === projectId).length;
  }
}

export function createInMemoryResearchRepository(): ResearchRepository {
  return new InMemoryResearchRepository();
}
