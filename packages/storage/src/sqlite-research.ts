/**
 * SQLite implementation of `ResearchRepository` — the Research half of the local-desktop profile.
 *
 * Same discipline as `sqlite.ts`: semantics come from `test/research-repository-contract.ts`, which
 * runs the identical assertion set against this driver and the in-memory one, so both agree on
 * scoping, charter upsert, relation idempotence, append-only history, ordering and error codes. The
 * small row-coercion helpers are re-declared here rather than shared because each driver reads a
 * different column set; the names and behaviour match `sqlite.ts` deliberately.
 *
 * Every statement is prepared against bound parameters. The table names, column names and the
 * `and …` fragments below all come from literals in this file — a filter value is a parameter, never
 * SQL text.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  charterFieldNameSchema,
  researchCharterSchema,
  type CharterFields,
  type CharterFieldName,
  type CharterVersion,
  type Claim,
  type ClaimStatus,
  type ClaimType,
  type CreateCharterVersionInput,
  type CreateClaimInput,
  type CreateDriftFindingInput,
  type CreateEntityRelationInput,
  type CreateEvidenceInput,
  type CreateManuscriptSectionInput,
  type CreateResearchChangeInput,
  type CreateResearchDecisionInput,
  type CreateResearchProjectInput,
  type CreateResearchQuestionInput,
  type CreateReviewMarkInput,
  type CreateTimelineEventInput,
  type DriftFinding,
  type DriftFindingStatus,
  type DriftType,
  type EntityRelation,
  type Evidence,
  type EvidenceType,
  type JsonValue,
  type ManuscriptSection,
  type ResearchChange,
  type ResearchChangeType,
  type ResearchCharter,
  type ResearchDecision,
  type ResearchEntityType,
  type ResearchProject,
  type ResearchProjectStatus,
  type ResearchQuestion,
  type ResearchQuestionStatus,
  type ResearchRelationType,
  type ResearchReviewMark,
  type ReviewMarkRaisedBy,
  type ReviewMarkStatus,
  type TimelineEvent,
  type TimelineEventType,
  type TimelineSource,
} from '@noltri/schema';
import { isKnowledgeError, knowledgeError, createId, nowIso } from '@noltri/shared';
import { SQLITE_SCHEMA_VERSION, openSqlite, type SqlitePragmas } from './sqlite-schema';
import type {
  ClaimListOptions,
  DriftFindingListOptions,
  EvidenceListOptions,
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

export interface SqliteResearchStorageStatus {
  driver: StorageDriverName;
  schemaVersion: number;
  /** The version this build writes; a lower `schemaVersion` means the file was never migrated up. */
  expectedSchemaVersion: number;
  projects: number;
}

export interface SqliteResearchRepositoryOptions {
  /** The same profile file `KnowledgeRepository` uses, or `:memory:` for a throw-away store. */
  file: string;
  synchronous?: 'FULL' | 'NORMAL' | 'OFF';
  busyTimeoutMs?: number;
}

type DbRow = Record<string, unknown>;
type Bind = string | number | null;

const text = (value: unknown): string => String(value);
const optText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number => Number(value);

/** A stored payload that no longer parses degrades to `{}` rather than failing the whole read. */
function json(value: unknown): JsonValue {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '{}'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonValue) : {};
  } catch {
    return {};
  }
}

const PROJECT_FIELDS = 'id, user_id, name, description, status, created_at, updated_at';

const CHARTER_FIELDS = `id, project_id, user_id, working_title, research_topic, research_problem,
  research_gap, research_questions_text, core_contribution, theoretical_lens, research_context,
  unit_of_analysis, research_method, target_article_type, target_journal, research_boundary,
  claim_boundary, current_stage, created_at, updated_at`;

const QUESTION_FIELDS = `id, project_id, user_id, question_code, question_text, status, rationale,
  related_method, created_at, updated_at`;

const EVIDENCE_FIELDS = `id, project_id, user_id, type, title, description, source_reference,
  source_location, reliability_note, created_at, updated_at`;

const CLAIM_FIELDS = `id, project_id, user_id, claim_code, claim_text, claim_type, status,
  confidence, boundary, created_at, updated_at`;

const SECTION_FIELDS = 'id, project_id, user_id, section_name, section_reference, sort_order, created_at, updated_at';

const RELATION_FIELDS = `id, project_id, user_id, source_type, source_id, relation_type, target_type,
  target_id, note, created_at`;

const DECISION_FIELDS = `id, project_id, user_id, title, decision, reason, alternatives,
  rejected_alternatives, impact, related_entities_json, created_at`;

const CHANGE_FIELDS = `id, project_id, user_id, change_type, before_text, after_text, reason,
  impact, related_entities_json, created_at`;

const FINDING_FIELDS = `id, project_id, user_id, drift_type, severity, description, source_entity_type,
  source_entity_id, target_entity_type, target_entity_id, reason, recommended_action, status,
  created_at, updated_at`;

const TIMELINE_FIELDS = `id, project_id, user_id, event_type, occurred_at, title, summary, source_type,
  source_id, related_entities_json, created_at`;

const CHARTER_VERSION_FIELDS = `id, project_id, user_id, version, previous_version, charter_json,
  changed_fields_json, revision_reason, decision_id, approved_at`;

const REVIEW_MARK_FIELDS = `id, project_id, user_id, entity_type, entity_id, reason, raised_by,
  charter_version, status, created_at, updated_at`;

/** The charter is the whole document: an unstated field is a cleared field, not an unchanged one. */
const CHARTER_COLUMNS = [
  'working_title',
  'research_topic',
  'research_problem',
  'research_gap',
  'research_questions_text',
  'core_contribution',
  'theoretical_lens',
  'research_context',
  'unit_of_analysis',
  'research_method',
  'target_article_type',
  'target_journal',
  'research_boundary',
  'claim_boundary',
  'current_stage',
] as const;

function toProject(row: DbRow): ResearchProject {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    name: text(row.name),
    description: optText(row.description),
    status: text(row.status) as ResearchProjectStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toCharter(row: DbRow): ResearchCharter {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    workingTitle: text(row.working_title),
    researchTopic: optText(row.research_topic),
    researchProblem: optText(row.research_problem),
    researchGap: optText(row.research_gap),
    researchQuestionsText: optText(row.research_questions_text),
    coreContribution: optText(row.core_contribution),
    theoreticalLens: optText(row.theoretical_lens),
    researchContext: optText(row.research_context),
    unitOfAnalysis: optText(row.unit_of_analysis),
    researchMethod: optText(row.research_method),
    targetArticleType: optText(row.target_article_type),
    targetJournal: optText(row.target_journal),
    researchBoundary: optText(row.research_boundary),
    claimBoundary: optText(row.claim_boundary),
    currentStage: optText(row.current_stage),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/**
 * A baseline snapshot is a domain record the user approved, so a row that no longer parses is reported
 * instead of degrading to `{}` — an empty charter would read as 「批准时什么都没写」.
 */
function toStoredCharter(value: unknown): ResearchCharter {
  const parsed = researchCharterSchema.safeParse(json(value));
  if (!parsed.success) {
    throw knowledgeError('storage_error', '章程基线快照损坏 / charter baseline snapshot is corrupt');
  }
  return parsed.data;
}

/** A diff list names charter fields; a name this build no longer declares reads as no diff. */
function toChangedFields(value: unknown): CharterFieldName[] {
  const parsed = charterFieldNameSchema.array().safeParse(json(value));
  return parsed.success ? [...parsed.data] : [];
}

function toCharterVersion(row: DbRow): CharterVersion {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    version: num(row.version),
    previousVersion: row.previous_version === null ? null : num(row.previous_version),
    charter: toStoredCharter(row.charter_json),
    changedFields: toChangedFields(row.changed_fields_json),
    revisionReason: text(row.revision_reason),
    decisionId: optText(row.decision_id),
    approvedAt: text(row.approved_at),
  };
}

function toReviewMark(row: DbRow): ResearchReviewMark {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    entityType: text(row.entity_type) as ResearchEntityType,
    entityId: text(row.entity_id),
    reason: text(row.reason),
    raisedBy: text(row.raised_by) as ReviewMarkRaisedBy,
    charterVersion: row.charter_version === null ? null : num(row.charter_version),
    status: text(row.status) as ReviewMarkStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toQuestion(row: DbRow): ResearchQuestion {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    questionCode: text(row.question_code),
    questionText: text(row.question_text),
    status: text(row.status) as ResearchQuestionStatus,
    rationale: optText(row.rationale),
    relatedMethod: optText(row.related_method),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toEvidence(row: DbRow): Evidence {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    type: text(row.type) as EvidenceType,
    title: text(row.title),
    description: optText(row.description),
    sourceReference: optText(row.source_reference),
    sourceLocation: optText(row.source_location),
    reliabilityNote: optText(row.reliability_note),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toClaim(row: DbRow): Claim {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    claimCode: text(row.claim_code),
    claimText: text(row.claim_text),
    claimType: text(row.claim_type) as ClaimType,
    status: text(row.status) as ClaimStatus,
    confidence: num(row.confidence),
    boundary: optText(row.boundary),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toSection(row: DbRow): ManuscriptSection {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    sectionName: text(row.section_name),
    sectionReference: optText(row.section_reference),
    sortOrder: num(row.sort_order),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toRelation(row: DbRow): EntityRelation {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    sourceType: text(row.source_type) as ResearchEntityType,
    sourceId: text(row.source_id),
    relationType: text(row.relation_type) as ResearchRelationType,
    targetType: text(row.target_type) as ResearchEntityType,
    targetId: text(row.target_id),
    note: optText(row.note),
    createdAt: text(row.created_at),
  };
}

function toDecision(row: DbRow): ResearchDecision {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    title: text(row.title),
    decision: text(row.decision),
    reason: optText(row.reason),
    alternatives: optText(row.alternatives),
    rejectedAlternatives: optText(row.rejected_alternatives),
    impact: optText(row.impact),
    relatedEntities: json(row.related_entities_json),
    createdAt: text(row.created_at),
  };
}

function toChange(row: DbRow): ResearchChange {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    changeType: text(row.change_type) as ResearchChangeType,
    before: text(row.before_text),
    after: text(row.after_text),
    reason: optText(row.reason),
    impact: optText(row.impact),
    relatedEntities: json(row.related_entities_json),
    createdAt: text(row.created_at),
  };
}

function toFinding(row: DbRow): DriftFinding {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    driftType: text(row.drift_type) as DriftType,
    severity: text(row.severity) as DriftFinding['severity'],
    description: text(row.description),
    sourceEntityType: optText(row.source_entity_type) as ResearchEntityType | null,
    sourceEntityId: optText(row.source_entity_id),
    targetEntityType: optText(row.target_entity_type) as ResearchEntityType | null,
    targetEntityId: optText(row.target_entity_id),
    reason: optText(row.reason),
    recommendedAction: optText(row.recommended_action),
    status: text(row.status) as DriftFindingStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toTimelineEvent(row: DbRow): TimelineEvent {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    userId: text(row.user_id),
    eventType: text(row.event_type) as TimelineEventType,
    occurredAt: text(row.occurred_at),
    title: text(row.title),
    summary: optText(row.summary),
    sourceType: optText(row.source_type) as TimelineSource | null,
    sourceId: optText(row.source_id),
    relatedEntities: json(row.related_entities_json),
    createdAt: text(row.created_at),
  };
}

/**
 * Optional list filters become `and <column> = ?` fragments. The column is always a literal written
 * here; the value is always a bound parameter.
 */
function whereAll(
  filters: ReadonlyArray<readonly [string, string | undefined]>,
): { clause: string; params: string[] } {
  const fragments: string[] = [];
  const params: string[] = [];
  for (const [column, value] of filters) {
    if (value === undefined) continue;
    fragments.push(`and ${column} = ?`);
    params.push(value);
  }
  return { clause: fragments.length === 0 ? '' : ` ${fragments.join(' ')}`, params };
}

function charterColumns(fields: CharterFields): Bind[] {
  return [
    fields.workingTitle,
    fields.researchTopic ?? null,
    fields.researchProblem ?? null,
    fields.researchGap ?? null,
    fields.researchQuestionsText ?? null,
    fields.coreContribution ?? null,
    fields.theoreticalLens ?? null,
    fields.researchContext ?? null,
    fields.unitOfAnalysis ?? null,
    fields.researchMethod ?? null,
    fields.targetArticleType ?? null,
    fields.targetJournal ?? null,
    fields.researchBoundary ?? null,
    fields.claimBoundary ?? null,
    fields.currentStage ?? null,
  ];
}

export class SqliteResearchRepository implements ResearchRepository {
  readonly driver: StorageDriverName = 'sqlite';

  private readonly db: DatabaseSync;
  private readonly pragmas: SqlitePragmas;

  constructor(options: SqliteResearchRepositoryOptions) {
    const opened = openSqlite({
      file: options.file,
      synchronous: options.synchronous,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    this.db = opened.db;
    this.pragmas = opened.pragmas;
  }

  // --- statement helpers ---------------------------------------------------------------

  private fail(context: string, cause: unknown): never {
    if (isKnowledgeError(cause)) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw knowledgeError('storage_error', `${context}失败 / sqlite ${context} failed`, { reason });
  }

  private run(sql: string, params: Bind[] = []): number {
    try {
      return Number(this.db.prepare(sql).run(...params).changes);
    } catch (cause) {
      throw this.fail('写入', cause);
    }
  }

  private one(sql: string, params: Bind[] = []): DbRow | null {
    try {
      return (this.db.prepare(sql).get(...params) as DbRow | undefined) ?? null;
    } catch (cause) {
      throw this.fail('读取', cause);
    }
  }

  private many(sql: string, params: Bind[] = []): DbRow[] {
    try {
      return this.db.prepare(sql).all(...params) as DbRow[];
    } catch (cause) {
      throw this.fail('查询', cause);
    }
  }

  private insert(table: string, columns: readonly string[], values: Bind[]): void {
    const binds = columns.map(() => '?').join(', ');
    this.run(`insert into ${table} (${columns.join(', ')}) values (${binds})`, values);
  }

  /** Only the stated columns are written; a stated `null` clears the column. */
  private patchRow(table: string, id: string, sets: ReadonlyArray<readonly [string, Bind]>): void {
    const clause = sets.map(([column]) => `${column} = ?`).join(', ');
    this.run(
      `update ${table} set ${clause}, updated_at = ? where id = ?`,
      [...sets.map(([, value]) => value), nowIso(), id],
    );
  }

  private count(table: string, projectId: string, userId: string, extra?: readonly [string, string]): number {
    const row = this.one(
      `select count(*) as total from ${table} where project_id = ? and user_id = ?${
        extra === undefined ? '' : ` and ${extra[0]} = ?`
      }`,
      extra === undefined ? [projectId, userId] : [projectId, userId, extra[1]],
    );
    return row === null ? 0 : num(row.total);
  }

  /**
   * Absent and foreign projects are indistinguishable: both surface as `not_found`, so a probe cannot
   * turn a research id into an existence oracle.
   */
  private requireProject(projectId: string, userId: string): void {
    const row = this.one('select id from research_projects where id = ? and user_id = ?', [projectId, userId]);
    if (row === null) {
      throw knowledgeError('not_found', `ResearchProject ${projectId} not found`);
    }
  }

  /** Reload of a row this method just wrote, scoped to the caller so a foreign id can never be read. */
  private reload<T>(fields: string, table: string, id: string, userId: string, map: (row: DbRow) => T): T {
    const row = this.one(`select ${fields} from ${table} where id = ? and user_id = ?`, [id, userId]);
    if (row === null) throw knowledgeError('not_found', `${table} ${id} not found`);
    return map(row);
  }

  // --- project -------------------------------------------------------------------------

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
    this.insert(
      'research_projects',
      ['id', 'user_id', 'name', 'description', 'status', 'created_at', 'updated_at'],
      [record.id, record.userId, record.name, record.description, record.status, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async findResearchProject(id: string, userId: string): Promise<ResearchProject | null> {
    const row = this.one(`select ${PROJECT_FIELDS} from research_projects where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toProject(row);
  }

  async listResearchProjects(userId: string): Promise<ResearchProject[]> {
    return this.many(
      `select ${PROJECT_FIELDS} from research_projects where user_id = ?
       order by created_at asc, rowid asc`,
      [userId],
    ).map(toProject);
  }

  async updateResearchProject(
    id: string,
    userId: string,
    patch: UpdateResearchProjectPatch,
  ): Promise<ResearchProject> {
    const existing = this.one('select id from research_projects where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `ResearchProject ${id} not found`);
    const sets: Array<readonly [string, Bind]> = [];
    if (patch.name !== undefined) sets.push(['name', patch.name.trim()]);
    if (patch.description !== undefined) sets.push(['description', patch.description]);
    if (patch.status !== undefined) sets.push(['status', patch.status]);
    if (sets.length > 0) this.patchRow('research_projects', id, sets);
    return this.reload(PROJECT_FIELDS, 'research_projects', id, userId, toProject);
  }

  async researchProjectStats(projectId: string, userId: string): Promise<ResearchProjectStats> {
    this.requireProject(projectId, userId);
    return {
      questionCount: this.count('research_questions', projectId, userId),
      evidenceCount: this.count('research_evidence', projectId, userId),
      claimCount: this.count('research_claims', projectId, userId),
      decisionCount: this.count('research_decisions', projectId, userId),
      changeCount: this.count('research_changes', projectId, userId),
      openDriftCount: this.count('research_drift_findings', projectId, userId, ['status', 'open']),
    };
  }

  // --- charter -------------------------------------------------------------------------

  async findCharter(projectId: string, userId: string): Promise<ResearchCharter | null> {
    const row = this.one(
      `select ${CHARTER_FIELDS} from research_charters where project_id = ? and user_id = ?`,
      [projectId, userId],
    );
    return row === null ? null : toCharter(row);
  }

  async upsertCharter(input: CharterFields & { userId: string; projectId: string }): Promise<ResearchCharter> {
    this.requireProject(input.projectId, input.userId);
    const existing = this.one(
      'select id from research_charters where project_id = ? and user_id = ?',
      [input.projectId, input.userId],
    );
    if (existing !== null) {
      const id = text(existing.id);
      const values = charterColumns(input);
      this.patchRow(
        'research_charters',
        id,
        CHARTER_COLUMNS.map((column, index) => [column, values[index] ?? null] as const),
      );
      return this.reload(CHARTER_FIELDS, 'research_charters', id, input.userId, toCharter);
    }
    const timestamp = nowIso();
    const record: ResearchCharter = {
      id: createId(),
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.insert(
      'research_charters',
      ['id', 'project_id', 'user_id', ...CHARTER_COLUMNS, 'created_at', 'updated_at'],
      [
        record.id,
        record.projectId,
        record.userId,
        ...charterColumns(record),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  // --- approved baselines --------------------------------------------------------------

  async createCharterVersion(input: CreateCharterVersionInput): Promise<CharterVersion> {
    this.requireProject(input.projectId, input.userId);
    const clash = this.one('select id from research_charter_versions where project_id = ? and version = ?', [
      input.projectId,
      input.version,
    ]);
    if (clash !== null) {
      throw knowledgeError('storage_error', `章程版本 ${input.version} 已存在 / charter version already exists`, {
        projectId: input.projectId,
        version: input.version,
      });
    }
    const record: CharterVersion = {
      id: createId(),
      projectId: input.projectId,
      userId: input.userId,
      version: input.version,
      previousVersion: input.previousVersion,
      charter: input.charter,
      changedFields: [...input.changedFields],
      revisionReason: input.revisionReason,
      decisionId: input.decisionId,
      approvedAt: nowIso(),
    };
    this.insert(
      'research_charter_versions',
      ['id', 'project_id', 'user_id', 'version', 'previous_version', 'charter_json', 'changed_fields_json',
        'revision_reason', 'decision_id', 'approved_at'],
      [
        record.id,
        record.projectId,
        record.userId,
        record.version,
        record.previousVersion,
        JSON.stringify(record.charter),
        JSON.stringify(record.changedFields),
        record.revisionReason,
        record.decisionId,
        record.approvedAt,
      ],
    );
    return record;
  }

  async listCharterVersions(projectId: string, userId: string): Promise<CharterVersion[]> {
    this.requireProject(projectId, userId);
    return this.many(
      `select ${CHARTER_VERSION_FIELDS} from research_charter_versions
       where project_id = ? and user_id = ? order by version desc, rowid desc`,
      [projectId, userId],
    ).map(toCharterVersion);
  }

  /** An unguarded read like `findCharter`: a project the caller cannot see answers `null`, not 「exists」. */
  async findCharterBaseline(projectId: string, userId: string): Promise<CharterVersion | null> {
    const row = this.one(
      `select ${CHARTER_VERSION_FIELDS} from research_charter_versions
       where project_id = ? and user_id = ? order by version desc limit 1`,
      [projectId, userId],
    );
    return row === null ? null : toCharterVersion(row);
  }

  // --- review marks --------------------------------------------------------------------

  async raiseReviewMark(input: CreateReviewMarkInput): Promise<ResearchReviewMark> {
    this.requireProject(input.projectId, input.userId);
    const charterVersion = input.charterVersion ?? null;
    const existing = this.one(
      `select id from research_review_marks
       where user_id = ? and project_id = ? and entity_type = ? and entity_id = ? and raised_by = ?
         and coalesce(charter_version, 0) = ?`,
      [input.userId, input.projectId, input.entityType, input.entityId, input.raisedBy, charterVersion ?? 0],
    );
    if (existing !== null) {
      // One warning per (entity, cause, baseline), refreshed in place — the id and created_at survive.
      const id = text(existing.id);
      this.patchRow('research_review_marks', id, [
        ['reason', input.reason],
        ['status', 'pending'],
      ]);
      return this.reload(REVIEW_MARK_FIELDS, 'research_review_marks', id, input.userId, toReviewMark);
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
    this.insert(
      'research_review_marks',
      ['id', 'project_id', 'user_id', 'entity_type', 'entity_id', 'reason', 'raised_by', 'charter_version',
        'status', 'created_at', 'updated_at'],
      [
        record.id,
        record.projectId,
        record.userId,
        record.entityType,
        record.entityId,
        record.reason,
        record.raisedBy,
        record.charterVersion,
        record.status,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async findReviewMark(id: string, userId: string): Promise<ResearchReviewMark | null> {
    const row = this.one(`select ${REVIEW_MARK_FIELDS} from research_review_marks where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toReviewMark(row);
  }

  async listReviewMarks(
    projectId: string,
    userId: string,
    options: ReviewMarkListOptions = {},
  ): Promise<ResearchReviewMark[]> {
    this.requireProject(projectId, userId);
    const where = whereAll([
      ['status', options.status],
      ['entity_type', options.entityType],
      ['entity_id', options.entityId],
      ['raised_by', options.raisedBy],
    ]);
    return this.many(
      `select ${REVIEW_MARK_FIELDS} from research_review_marks
       where project_id = ? and user_id = ?${where.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...where.params],
    ).map(toReviewMark);
  }

  async clearReviewMark(id: string, userId: string): Promise<ResearchReviewMark> {
    const existing = this.one('select id from research_review_marks where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `ResearchReviewMark ${id} not found`);
    // A state change, not a delete: the row is the record that this warning was raised and handled.
    this.patchRow('research_review_marks', id, [['status', 'cleared']]);
    return this.reload(REVIEW_MARK_FIELDS, 'research_review_marks', id, userId, toReviewMark);
  }

  // --- research questions --------------------------------------------------------------

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
    this.insert(
      'research_questions',
      ['id', 'project_id', 'user_id', 'question_code', 'question_text', 'status', 'rationale',
        'related_method', 'created_at', 'updated_at'],
      [record.id, record.projectId, record.userId, record.questionCode, record.questionText,
        record.status, record.rationale, record.relatedMethod, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async findResearchQuestion(id: string, userId: string): Promise<ResearchQuestion | null> {
    const row = this.one(`select ${QUESTION_FIELDS} from research_questions where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toQuestion(row);
  }

  async listResearchQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]> {
    this.requireProject(projectId, userId);
    return this.many(
      `select ${QUESTION_FIELDS} from research_questions where project_id = ? and user_id = ?
       order by created_at asc, rowid asc`,
      [projectId, userId],
    ).map(toQuestion);
  }

  async updateResearchQuestion(
    id: string,
    userId: string,
    patch: UpdateResearchQuestionPatch,
  ): Promise<ResearchQuestion> {
    const existing = this.one('select id from research_questions where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `ResearchQuestion ${id} not found`);
    const sets: Array<readonly [string, Bind]> = [];
    if (patch.questionCode !== undefined) sets.push(['question_code', patch.questionCode]);
    if (patch.questionText !== undefined) sets.push(['question_text', patch.questionText]);
    if (patch.status !== undefined) sets.push(['status', patch.status]);
    if (patch.rationale !== undefined) sets.push(['rationale', patch.rationale]);
    if (patch.relatedMethod !== undefined) sets.push(['related_method', patch.relatedMethod]);
    if (sets.length > 0) this.patchRow('research_questions', id, sets);
    return this.reload(QUESTION_FIELDS, 'research_questions', id, userId, toQuestion);
  }

  // --- evidence ------------------------------------------------------------------------

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
      reliabilityNote: input.reliabilityNote ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.insert(
      'research_evidence',
      ['id', 'project_id', 'user_id', 'type', 'title', 'description', 'source_reference',
        'source_location', 'reliability_note', 'created_at', 'updated_at'],
      [record.id, record.projectId, record.userId, record.type, record.title, record.description,
        record.sourceReference, record.sourceLocation, record.reliabilityNote, record.createdAt,
        record.updatedAt],
    );
    return record;
  }

  async findEvidence(id: string, userId: string): Promise<Evidence | null> {
    const row = this.one(`select ${EVIDENCE_FIELDS} from research_evidence where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toEvidence(row);
  }

  async listEvidence(projectId: string, userId: string, options: EvidenceListOptions = {}): Promise<Evidence[]> {
    this.requireProject(projectId, userId);
    const filter = whereAll([['type', options.type]]);
    return this.many(
      `select ${EVIDENCE_FIELDS} from research_evidence where project_id = ? and user_id = ?${filter.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...filter.params],
    ).map(toEvidence);
  }

  async updateEvidence(id: string, userId: string, patch: UpdateEvidencePatch): Promise<Evidence> {
    const existing = this.one('select id from research_evidence where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `Evidence ${id} not found`);
    const sets: Array<readonly [string, Bind]> = [];
    if (patch.type !== undefined) sets.push(['type', patch.type]);
    if (patch.title !== undefined) sets.push(['title', patch.title]);
    if (patch.description !== undefined) sets.push(['description', patch.description]);
    if (patch.sourceReference !== undefined) sets.push(['source_reference', patch.sourceReference]);
    if (patch.sourceLocation !== undefined) sets.push(['source_location', patch.sourceLocation]);
    if (patch.reliabilityNote !== undefined) sets.push(['reliability_note', patch.reliabilityNote]);
    if (sets.length > 0) this.patchRow('research_evidence', id, sets);
    return this.reload(EVIDENCE_FIELDS, 'research_evidence', id, userId, toEvidence);
  }

  // --- claims --------------------------------------------------------------------------

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
    this.insert(
      'research_claims',
      ['id', 'project_id', 'user_id', 'claim_code', 'claim_text', 'claim_type', 'status',
        'confidence', 'boundary', 'created_at', 'updated_at'],
      [record.id, record.projectId, record.userId, record.claimCode, record.claimText, record.claimType,
        record.status, record.confidence, record.boundary, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async findClaim(id: string, userId: string): Promise<Claim | null> {
    const row = this.one(`select ${CLAIM_FIELDS} from research_claims where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toClaim(row);
  }

  async listClaims(projectId: string, userId: string, options: ClaimListOptions = {}): Promise<Claim[]> {
    this.requireProject(projectId, userId);
    const filter = whereAll([['status', options.status], ['claim_type', options.claimType]]);
    return this.many(
      `select ${CLAIM_FIELDS} from research_claims where project_id = ? and user_id = ?${filter.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...filter.params],
    ).map(toClaim);
  }

  async updateClaim(id: string, userId: string, patch: UpdateClaimPatch): Promise<Claim> {
    const existing = this.one('select id from research_claims where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `Claim ${id} not found`);
    const sets: Array<readonly [string, Bind]> = [];
    if (patch.claimCode !== undefined) sets.push(['claim_code', patch.claimCode]);
    if (patch.claimText !== undefined) sets.push(['claim_text', patch.claimText]);
    if (patch.claimType !== undefined) sets.push(['claim_type', patch.claimType]);
    if (patch.status !== undefined) sets.push(['status', patch.status]);
    if (patch.confidence !== undefined) sets.push(['confidence', patch.confidence]);
    if (patch.boundary !== undefined) sets.push(['boundary', patch.boundary]);
    if (sets.length > 0) this.patchRow('research_claims', id, sets);
    return this.reload(CLAIM_FIELDS, 'research_claims', id, userId, toClaim);
  }

  // --- manuscript sections -------------------------------------------------------------

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
    this.insert(
      'research_manuscript_sections',
      ['id', 'project_id', 'user_id', 'section_name', 'section_reference', 'sort_order', 'created_at',
        'updated_at'],
      [record.id, record.projectId, record.userId, record.sectionName, record.sectionReference,
        record.sortOrder, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async findManuscriptSection(id: string, userId: string): Promise<ManuscriptSection | null> {
    const row = this.one(
      `select ${SECTION_FIELDS} from research_manuscript_sections where id = ? and user_id = ?`,
      [id, userId],
    );
    return row === null ? null : toSection(row);
  }

  async listManuscriptSections(projectId: string, userId: string): Promise<ManuscriptSection[]> {
    this.requireProject(projectId, userId);
    return this.many(
      `select ${SECTION_FIELDS} from research_manuscript_sections where project_id = ? and user_id = ?
       order by created_at asc, rowid asc`,
      [projectId, userId],
    ).map(toSection);
  }

  async updateManuscriptSection(
    id: string,
    userId: string,
    patch: UpdateManuscriptSectionPatch,
  ): Promise<ManuscriptSection> {
    const existing = this.one('select id from research_manuscript_sections where id = ? and user_id = ?', [
      id,
      userId,
    ]);
    if (existing === null) throw knowledgeError('not_found', `ManuscriptSection ${id} not found`);
    const sets: Array<readonly [string, Bind]> = [];
    if (patch.sectionName !== undefined) sets.push(['section_name', patch.sectionName]);
    if (patch.sectionReference !== undefined) sets.push(['section_reference', patch.sectionReference]);
    if (patch.sortOrder !== undefined) sets.push(['sort_order', patch.sortOrder]);
    if (sets.length > 0) this.patchRow('research_manuscript_sections', id, sets);
    return this.reload(SECTION_FIELDS, 'research_manuscript_sections', id, userId, toSection);
  }

  // --- generic relations ---------------------------------------------------------------

  async createEntityRelation(input: CreateEntityRelationInput): Promise<EntityRelation> {
    this.requireProject(input.projectId, input.userId);
    // Idempotent on the five-tuple: a repeat create returns the stored row untouched, `note` included.
    const found = this.one(
      `select ${RELATION_FIELDS} from research_entity_relations
       where user_id = ? and project_id = ? and source_type = ? and source_id = ?
         and relation_type = ? and target_type = ? and target_id = ?`,
      [input.userId, input.projectId, input.sourceType, input.sourceId, input.relationType, input.targetType,
        input.targetId],
    );
    if (found !== null) return toRelation(found);
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
    this.insert(
      'research_entity_relations',
      ['id', 'project_id', 'user_id', 'source_type', 'source_id', 'relation_type', 'target_type',
        'target_id', 'note', 'created_at'],
      [record.id, record.projectId, record.userId, record.sourceType, record.sourceId, record.relationType,
        record.targetType, record.targetId, record.note, record.createdAt],
    );
    return record;
  }

  async listEntityRelations(
    projectId: string,
    userId: string,
    filter: RelationFilter = {},
  ): Promise<EntityRelation[]> {
    this.requireProject(projectId, userId);
    const optional = whereAll([
      ['source_type', filter.sourceType],
      ['source_id', filter.sourceId],
      ['target_type', filter.targetType],
      ['target_id', filter.targetId],
      ['relation_type', filter.relationType],
    ]);
    return this.many(
      `select ${RELATION_FIELDS} from research_entity_relations
       where project_id = ? and user_id = ?${optional.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...optional.params],
    ).map(toRelation);
  }

  async deleteEntityRelation(id: string, userId: string): Promise<boolean> {
    return this.run('delete from research_entity_relations where id = ? and user_id = ?', [id, userId]) > 0;
  }

  // --- decisions (append-only) ---------------------------------------------------------

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
    this.insert(
      'research_decisions',
      ['id', 'project_id', 'user_id', 'title', 'decision', 'reason', 'alternatives',
        'rejected_alternatives', 'impact', 'related_entities_json', 'created_at'],
      [record.id, record.projectId, record.userId, record.title, record.decision, record.reason,
        record.alternatives, record.rejectedAlternatives, record.impact, JSON.stringify(record.relatedEntities),
        record.createdAt],
    );
    return record;
  }

  async findResearchDecision(id: string, userId: string): Promise<ResearchDecision | null> {
    const row = this.one(`select ${DECISION_FIELDS} from research_decisions where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toDecision(row);
  }

  async listResearchDecisions(projectId: string, userId: string): Promise<ResearchDecision[]> {
    this.requireProject(projectId, userId);
    return this.many(
      `select ${DECISION_FIELDS} from research_decisions where project_id = ? and user_id = ?
       order by created_at asc, rowid asc`,
      [projectId, userId],
    ).map(toDecision);
  }

  // --- changes (append-only) -----------------------------------------------------------

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
    this.insert(
      'research_changes',
      ['id', 'project_id', 'user_id', 'change_type', 'before_text', 'after_text', 'reason', 'impact',
        'related_entities_json', 'created_at'],
      [record.id, record.projectId, record.userId, record.changeType, record.before, record.after,
        record.reason, record.impact, JSON.stringify(record.relatedEntities), record.createdAt],
    );
    return record;
  }

  async findResearchChange(id: string, userId: string): Promise<ResearchChange | null> {
    const row = this.one(`select ${CHANGE_FIELDS} from research_changes where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toChange(row);
  }

  async listResearchChanges(
    projectId: string,
    userId: string,
    options: ResearchChangeListOptions = {},
  ): Promise<ResearchChange[]> {
    this.requireProject(projectId, userId);
    const filter = whereAll([['change_type', options.changeType]]);
    return this.many(
      `select ${CHANGE_FIELDS} from research_changes where project_id = ? and user_id = ?${filter.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...filter.params],
    ).map(toChange);
  }

  // --- drift findings ------------------------------------------------------------------

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
    this.insert(
      'research_drift_findings',
      ['id', 'project_id', 'user_id', 'drift_type', 'severity', 'description', 'source_entity_type',
        'source_entity_id', 'target_entity_type', 'target_entity_id', 'reason', 'recommended_action',
        'status', 'created_at', 'updated_at'],
      [record.id, record.projectId, record.userId, record.driftType, record.severity, record.description,
        record.sourceEntityType, record.sourceEntityId, record.targetEntityType, record.targetEntityId,
        record.reason, record.recommendedAction, record.status, record.createdAt, record.updatedAt],
    );
    return record;
  }

  async findDriftFinding(id: string, userId: string): Promise<DriftFinding | null> {
    const row = this.one(`select ${FINDING_FIELDS} from research_drift_findings where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toFinding(row);
  }

  async listDriftFindings(
    projectId: string,
    userId: string,
    options: DriftFindingListOptions = {},
  ): Promise<DriftFinding[]> {
    this.requireProject(projectId, userId);
    const filter = whereAll([
      ['status', options.status],
      ['drift_type', options.driftType],
      ['severity', options.severity],
    ]);
    return this.many(
      `select ${FINDING_FIELDS} from research_drift_findings where project_id = ? and user_id = ?${filter.clause}
       order by created_at asc, rowid asc`,
      [projectId, userId, ...filter.params],
    ).map(toFinding);
  }

  async updateDriftFindingStatus(id: string, userId: string, status: DriftFindingStatus): Promise<DriftFinding> {
    const existing = this.one('select id from research_drift_findings where id = ? and user_id = ?', [id, userId]);
    if (existing === null) throw knowledgeError('not_found', `DriftFinding ${id} not found`);
    this.patchRow('research_drift_findings', id, [['status', status]]);
    return this.reload(FINDING_FIELDS, 'research_drift_findings', id, userId, toFinding);
  }

  // --- timeline ------------------------------------------------------------------------

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
    this.insert(
      'research_timeline_events',
      ['id', 'project_id', 'user_id', 'event_type', 'occurred_at', 'title', 'summary', 'source_type',
        'source_id', 'related_entities_json', 'created_at'],
      [record.id, record.projectId, record.userId, record.eventType, record.occurredAt, record.title,
        record.summary, record.sourceType, record.sourceId, JSON.stringify(record.relatedEntities),
        record.createdAt],
    );
    return record;
  }

  async listTimelineEvents(projectId: string, userId: string): Promise<TimelineEvent[]> {
    this.requireProject(projectId, userId);
    return this.many(
      `select ${TIMELINE_FIELDS} from research_timeline_events where project_id = ? and user_id = ?
       order by occurred_at desc, rowid desc`,
      [projectId, userId],
    ).map(toTimelineEvent);
  }

  /**
   * `sqlite.ts` reports FTS5 and vector widths because keyword and semantic search need them; the research
   * half reads neither, so this is the schema version plus the one count a support request asks for. Not a
   * `ResearchRepository` method — a driver fact, like `SqliteRepository.storageStatus()`.
   */
  storageStatus(): SqliteResearchStorageStatus {
    return {
      driver: 'sqlite',
      schemaVersion: this.pragmas.schemaVersion,
      expectedSchemaVersion: SQLITE_SCHEMA_VERSION,
      projects: num(this.one('select count(*) as total from research_projects', [])?.total ?? 0),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createSqliteResearchRepository(
  options: SqliteResearchRepositoryOptions,
): Promise<SqliteResearchRepository> {
  return new SqliteResearchRepository(options);
}
