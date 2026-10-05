/**
 * Research test double — offline and deterministic (research contract §6).
 *
 * `FakeResearchRepository` is a second, throwaway `ResearchRepository` beside the storage package's own
 * in-memory driver. It exists for the clock: every write stamps `createdAt` a second ahead of the last,
 * so tests can assert the ordering the domain promises (timeline newest-first, `occurredAt` pinned to the
 * object it came from) without sleeping or mocking timers — and the real drivers' contract tests keep
 * testing the real SQL.
 *
 * The drift-finding and stats methods here are not P5 behaviour: they are part of the `ResearchRepository`
 * interface, so an honest fake implements them. Nothing in P5 produces a finding, and the plain entity
 * fixtures the pure drift rules will need arrive with those rules in P6.
 */
import type {
  CharterFields,
  Claim,
  CreateClaimInput,
  CreateDriftFindingInput,
  CreateEntityRelationInput,
  CreateEvidenceInput,
  CreateManuscriptSectionInput,
  CreateResearchChangeInput,
  CreateResearchDecisionInput,
  CreateResearchProjectInput,
  CreateResearchQuestionInput,
  CreateTimelineEventInput,
  DriftFinding,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
  TimelineEvent,
} from '@noltri/schema';
import { createId, knowledgeError } from '@noltri/shared';
import type {
  ClaimListOptions,
  DriftFindingListOptions,
  EvidenceListOptions,
  RelationFilter,
  ResearchChangeListOptions,
  ResearchProjectStats,
  ResearchRepository,
  UpdateEvidencePatch,
  UpdateClaimPatch,
  UpdateManuscriptSectionPatch,
  UpdateResearchProjectPatch,
  UpdateResearchQuestionPatch,
} from '@noltri/storage';

const START_CLOCK = '2026-01-01T00:00:00.000Z';

export class FakeResearchRepository implements ResearchRepository {
  readonly driver = 'memory' as const;

  private clockMs = Date.parse(START_CLOCK);
  private readonly projects = new Map<string, ResearchProject>();
  private readonly charters = new Map<string, ResearchCharter>();
  private readonly questions = new Map<string, ResearchQuestion>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly claims = new Map<string, Claim>();
  private readonly sections = new Map<string, ManuscriptSection>();
  private readonly relations = new Map<string, EntityRelation>();
  private readonly decisions = new Map<string, ResearchDecision>();
  private readonly changes = new Map<string, ResearchChange>();
  private readonly findings = new Map<string, DriftFinding>();
  private readonly events = new Map<string, TimelineEvent>();

  /** Each stamped time is 1s apart, so write order is observable without any real clock involved. */
  private stamp(): string {
    const iso = new Date(this.clockMs).toISOString();
    this.clockMs += 1_000;
    return iso;
  }

  // --- projects ---

  async createResearchProject(input: CreateResearchProjectInput): Promise<ResearchProject> {
    const now = this.stamp();
    const project: ResearchProject = {
      id: createId(),
      userId: input.userId,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async findResearchProject(id: string, userId: string): Promise<ResearchProject | null> {
    const project = this.projects.get(id);
    return project !== undefined && project.userId === userId ? project : null;
  }

  async listResearchProjects(userId: string): Promise<ResearchProject[]> {
    return [...this.projects.values()].filter((project) => project.userId === userId);
  }

  async updateResearchProject(
    id: string,
    userId: string,
    patch: UpdateResearchProjectPatch,
  ): Promise<ResearchProject> {
    const project = await this.findResearchProject(id, userId);
    if (project === null) throw knowledgeError('not_found', 'research project not found');
    const updated: ResearchProject = {
      ...project,
      ...pickDefined(patch),
      updatedAt: this.stamp(),
    };
    this.projects.set(id, updated);
    return updated;
  }

  async researchProjectStats(projectId: string, userId: string): Promise<ResearchProjectStats> {
    await this.findResearchProject(projectId, userId);
    return {
      questionCount: this.questions.size,
      evidenceCount: this.evidence.size,
      claimCount: this.claims.size,
      decisionCount: this.decisions.size,
      changeCount: this.changes.size,
      openDriftCount: [...this.findings.values()].filter((finding) => finding.status === 'open').length,
    };
  }

  // --- charter ---

  async findCharter(projectId: string, userId: string): Promise<ResearchCharter | null> {
    const charter = [...this.charters.values()].find(
      (candidate) => candidate.projectId === projectId && candidate.userId === userId,
    );
    return charter ?? null;
  }

  async upsertCharter(input: CharterFields & { userId: string; projectId: string }): Promise<ResearchCharter> {
    const existing = await this.findCharter(input.projectId, input.userId);
    const now = this.stamp();
    const charter: ResearchCharter = {
      id: existing?.id ?? createId(),
      projectId: input.projectId,
      userId: input.userId,
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
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.charters.set(charter.id, charter);
    return charter;
  }

  // --- questions ---

  async createResearchQuestion(input: CreateResearchQuestionInput): Promise<ResearchQuestion> {
    const now = this.stamp();
    const question: ResearchQuestion = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      questionCode: input.questionCode,
      questionText: input.questionText,
      status: input.status ?? 'open',
      rationale: input.rationale ?? null,
      relatedMethod: input.relatedMethod ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.questions.set(question.id, question);
    return question;
  }

  async findResearchQuestion(id: string, userId: string): Promise<ResearchQuestion | null> {
    const question = this.questions.get(id);
    return question !== undefined && question.userId === userId ? question : null;
  }

  async listResearchQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]> {
    return [...this.questions.values()].filter(
      (question) => question.projectId === projectId && question.userId === userId,
    );
  }

  async updateResearchQuestion(
    id: string,
    userId: string,
    patch: UpdateResearchQuestionPatch,
  ): Promise<ResearchQuestion> {
    const question = await this.findResearchQuestion(id, userId);
    if (question === null) throw knowledgeError('not_found', 'research question not found');
    const updated: ResearchQuestion = { ...question, ...pickDefined(patch), updatedAt: this.stamp() };
    this.questions.set(id, updated);
    return updated;
  }

  // --- evidence ---

  async createEvidence(input: CreateEvidenceInput): Promise<Evidence> {
    const now = this.stamp();
    const evidence: Evidence = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      sourceReference: input.sourceReference ?? null,
      sourceLocation: input.sourceLocation ?? null,
      reliabilityNote: input.reliabilityNote ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.evidence.set(evidence.id, evidence);
    return evidence;
  }

  async findEvidence(id: string, userId: string): Promise<Evidence | null> {
    const evidence = this.evidence.get(id);
    return evidence !== undefined && evidence.userId === userId ? evidence : null;
  }

  async listEvidence(projectId: string, userId: string, options?: EvidenceListOptions): Promise<Evidence[]> {
    return [...this.evidence.values()].filter(
      (evidence) =>
        evidence.projectId === projectId &&
        evidence.userId === userId &&
        (options?.type === undefined || evidence.type === options.type),
    );
  }

  async updateEvidence(id: string, userId: string, patch: UpdateEvidencePatch): Promise<Evidence> {
    const evidence = await this.findEvidence(id, userId);
    if (evidence === null) throw knowledgeError('not_found', 'evidence not found');
    const updated: Evidence = { ...evidence, ...pickDefined(patch), updatedAt: this.stamp() };
    this.evidence.set(id, updated);
    return updated;
  }

  // --- claims ---

  async createClaim(input: CreateClaimInput): Promise<Claim> {
    const now = this.stamp();
    const claim: Claim = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      claimCode: input.claimCode,
      claimText: input.claimText,
      claimType: input.claimType,
      status: input.status ?? 'draft',
      confidence: input.confidence ?? 0.5,
      boundary: input.boundary ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.claims.set(claim.id, claim);
    return claim;
  }

  async findClaim(id: string, userId: string): Promise<Claim | null> {
    const claim = this.claims.get(id);
    return claim !== undefined && claim.userId === userId ? claim : null;
  }

  async listClaims(projectId: string, userId: string, options?: ClaimListOptions): Promise<Claim[]> {
    return [...this.claims.values()].filter(
      (claim) =>
        claim.projectId === projectId &&
        claim.userId === userId &&
        (options?.status === undefined || claim.status === options.status) &&
        (options?.claimType === undefined || claim.claimType === options.claimType),
    );
  }

  async updateClaim(id: string, userId: string, patch: UpdateClaimPatch): Promise<Claim> {
    const claim = await this.findClaim(id, userId);
    if (claim === null) throw knowledgeError('not_found', 'claim not found');
    const updated: Claim = { ...claim, ...pickDefined(patch), updatedAt: this.stamp() };
    this.claims.set(id, updated);
    return updated;
  }

  // --- sections ---

  async createManuscriptSection(input: CreateManuscriptSectionInput): Promise<ManuscriptSection> {
    const now = this.stamp();
    const section: ManuscriptSection = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      sectionName: input.sectionName,
      sectionReference: input.sectionReference ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sections.set(section.id, section);
    return section;
  }

  async findManuscriptSection(id: string, userId: string): Promise<ManuscriptSection | null> {
    const section = this.sections.get(id);
    return section !== undefined && section.userId === userId ? section : null;
  }

  async listManuscriptSections(projectId: string, userId: string): Promise<ManuscriptSection[]> {
    return [...this.sections.values()].filter(
      (section) => section.projectId === projectId && section.userId === userId,
    );
  }

  async updateManuscriptSection(
    id: string,
    userId: string,
    patch: UpdateManuscriptSectionPatch,
  ): Promise<ManuscriptSection> {
    const section = await this.findManuscriptSection(id, userId);
    if (section === null) throw knowledgeError('not_found', 'manuscript section not found');
    const updated: ManuscriptSection = { ...section, ...pickDefined(patch), updatedAt: this.stamp() };
    this.sections.set(id, updated);
    return updated;
  }

  // --- relations ---

  async createEntityRelation(input: CreateEntityRelationInput): Promise<EntityRelation> {
    const relation: EntityRelation = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      relationType: input.relationType,
      targetType: input.targetType,
      targetId: input.targetId,
      note: input.note ?? null,
      createdAt: this.stamp(),
    };
    this.relations.set(relation.id, relation);
    return relation;
  }

  async listEntityRelations(
    projectId: string,
    userId: string,
    filter?: RelationFilter,
  ): Promise<EntityRelation[]> {
    return [...this.relations.values()].filter(
      (relation) =>
        relation.projectId === projectId &&
        relation.userId === userId &&
        (filter?.sourceType === undefined || relation.sourceType === filter.sourceType) &&
        (filter?.sourceId === undefined || relation.sourceId === filter.sourceId) &&
        (filter?.targetType === undefined || relation.targetType === filter.targetType) &&
        (filter?.targetId === undefined || relation.targetId === filter.targetId) &&
        (filter?.relationType === undefined || relation.relationType === filter.relationType),
    );
  }

  async deleteEntityRelation(id: string, userId: string): Promise<boolean> {
    const relation = this.relations.get(id);
    if (relation === undefined || relation.userId !== userId) return false;
    this.relations.delete(id);
    return true;
  }

  // --- decisions (append-only) ---

  async createResearchDecision(input: CreateResearchDecisionInput): Promise<ResearchDecision> {
    const decision: ResearchDecision = {
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
      createdAt: this.stamp(),
    };
    this.decisions.set(decision.id, decision);
    return decision;
  }

  async findResearchDecision(id: string, userId: string): Promise<ResearchDecision | null> {
    const decision = this.decisions.get(id);
    return decision !== undefined && decision.userId === userId ? decision : null;
  }

  async listResearchDecisions(projectId: string, userId: string): Promise<ResearchDecision[]> {
    return [...this.decisions.values()].filter(
      (decision) => decision.projectId === projectId && decision.userId === userId,
    );
  }

  // --- changes (append-only) ---

  async createResearchChange(input: CreateResearchChangeInput): Promise<ResearchChange> {
    const change: ResearchChange = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      changeType: input.changeType,
      before: input.before,
      after: input.after,
      reason: input.reason ?? null,
      impact: input.impact ?? null,
      relatedEntities: input.relatedEntities ?? {},
      createdAt: this.stamp(),
    };
    this.changes.set(change.id, change);
    return change;
  }

  async findResearchChange(id: string, userId: string): Promise<ResearchChange | null> {
    const change = this.changes.get(id);
    return change !== undefined && change.userId === userId ? change : null;
  }

  async listResearchChanges(
    projectId: string,
    userId: string,
    options?: ResearchChangeListOptions,
  ): Promise<ResearchChange[]> {
    return [...this.changes.values()].filter(
      (change) =>
        change.projectId === projectId &&
        change.userId === userId &&
        (options?.changeType === undefined || change.changeType === options.changeType),
    );
  }

  // --- drift findings ---

  async createDriftFinding(input: CreateDriftFindingInput): Promise<DriftFinding> {
    const now = this.stamp();
    const finding: DriftFinding = {
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
      createdAt: now,
      updatedAt: now,
    };
    this.findings.set(finding.id, finding);
    return finding;
  }

  async findDriftFinding(id: string, userId: string): Promise<DriftFinding | null> {
    const finding = this.findings.get(id);
    return finding !== undefined && finding.userId === userId ? finding : null;
  }

  async listDriftFindings(
    projectId: string,
    userId: string,
    options?: DriftFindingListOptions,
  ): Promise<DriftFinding[]> {
    return [...this.findings.values()].filter(
      (finding) =>
        finding.projectId === projectId &&
        finding.userId === userId &&
        (options?.status === undefined || finding.status === options.status) &&
        (options?.driftType === undefined || finding.driftType === options.driftType) &&
        (options?.severity === undefined || finding.severity === options.severity),
    );
  }

  async updateDriftFindingStatus(id: string, userId: string, status: DriftFinding['status']): Promise<DriftFinding> {
    const finding = await this.findDriftFinding(id, userId);
    if (finding === null) throw knowledgeError('not_found', 'drift finding not found');
    const updated: DriftFinding = { ...finding, status, updatedAt: this.stamp() };
    this.findings.set(id, updated);
    return updated;
  }

  // --- timeline ---

  async createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEvent> {
    const event: TimelineEvent = {
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
      createdAt: this.stamp(),
    };
    this.events.set(event.id, event);
    return event;
  }

  async listTimelineEvents(projectId: string, userId: string): Promise<TimelineEvent[]> {
    return [...this.events.values()].filter(
      (event) => event.projectId === projectId && event.userId === userId,
    );
  }
}

function pickDefined<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
