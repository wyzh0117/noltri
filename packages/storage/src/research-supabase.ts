import {
  claimStatusSchema,
  claimTypeSchema,
  driftFindingStatusSchema,
  driftSeveritySchema,
  driftTypeSchema,
  evidenceTypeSchema,
  researchChangeTypeSchema,
  researchEntityTypeSchema,
  researchProjectStatusSchema,
  researchQuestionStatusSchema,
  researchRelationTypeSchema,
  timelineEventTypeSchema,
  timelineSourceSchema,
} from '@noltri/schema';
import type {
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
  DriftFindingStatus,
  EntityRelation,
  Evidence,
  JsonValue,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
  TimelineEvent,
} from '@noltri/schema';
import { createId, isKnowledgeError, knowledgeError, nowIso } from '@noltri/shared';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type {
  CharterFields,
  ClaimListOptions,
  DriftFindingListOptions,
  EvidenceListOptions,
  RelationFilter,
  ResearchChangeListOptions,
  ResearchProjectStats,
  ResearchRepository,
  StorageDriverName,
  UpdateClaimPatch,
  UpdateEvidencePatch,
  UpdateManuscriptSectionPatch,
  UpdateResearchProjectPatch,
  UpdateResearchQuestionPatch,
} from './research-types';

export interface SupabaseResearchRepositoryOptions {
  /** Postgres wire string: Supabase session pooler or DIRECT_URL for migrations/tests. */
  databaseUrl: string;
  statementTimeoutMs?: number;
  maxConnections?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS = 5;

type DbRow = Record<string, unknown>;
type Parser<T> = { parse(data: unknown): T };

/** Column lists are written out instead of "select *" so a drifted migration is caught here. */
const PROJECT_COLUMNS = ['id', 'user_id', 'name', 'description', 'status', 'created_at', 'updated_at'] as const;
const PROJECT_FIELDS = PROJECT_COLUMNS.join(', ');

const CHARTER_COLUMNS = [
  'id', 'project_id', 'user_id', 'working_title', 'research_topic', 'research_problem', 'research_gap',
  'research_questions_text', 'core_contribution', 'theoretical_lens', 'research_context', 'unit_of_analysis',
  'research_method', 'target_article_type', 'target_journal', 'research_boundary', 'claim_boundary',
  'current_stage', 'created_at', 'updated_at',
] as const;
const CHARTER_FIELDS = CHARTER_COLUMNS.join(', ');

const QUESTION_COLUMNS = [
  'id', 'project_id', 'user_id', 'question_code', 'question_text', 'status', 'rationale', 'related_method',
  'created_at', 'updated_at',
] as const;
const QUESTION_FIELDS = QUESTION_COLUMNS.join(', ');

const EVIDENCE_COLUMNS = [
  'id', 'project_id', 'user_id', 'type', 'title', 'description', 'source_reference', 'source_location',
  'reliability_note', 'created_at', 'updated_at',
] as const;
const EVIDENCE_FIELDS = EVIDENCE_COLUMNS.join(', ');

const CLAIM_COLUMNS = [
  'id', 'project_id', 'user_id', 'claim_code', 'claim_text', 'claim_type', 'status', 'confidence', 'boundary',
  'created_at', 'updated_at',
] as const;
const CLAIM_FIELDS = CLAIM_COLUMNS.join(', ');

const SECTION_COLUMNS = [
  'id', 'project_id', 'user_id', 'section_name', 'section_reference', 'sort_order', 'created_at', 'updated_at',
] as const;
const SECTION_FIELDS = SECTION_COLUMNS.join(', ');

const RELATION_COLUMNS = [
  'id', 'project_id', 'user_id', 'source_type', 'source_id', 'relation_type', 'target_type', 'target_id',
  'note', 'created_at',
] as const;
const RELATION_FIELDS = RELATION_COLUMNS.join(', ');

const DECISION_COLUMNS = [
  'id', 'project_id', 'user_id', 'title', 'decision', 'reason', 'alternatives', 'rejected_alternatives',
  'impact', 'related_entities', 'created_at',
] as const;
const DECISION_FIELDS = DECISION_COLUMNS.join(', ');

const CHANGE_COLUMNS = [
  'id', 'project_id', 'user_id', 'change_type', 'before', 'after', 'reason', 'impact', 'related_entities',
  'created_at',
] as const;
const CHANGE_FIELDS = CHANGE_COLUMNS.join(', ');

const FINDING_COLUMNS = [
  'id', 'project_id', 'user_id', 'drift_type', 'severity', 'description', 'source_entity_type',
  'source_entity_id', 'target_entity_type', 'target_entity_id', 'reason', 'recommended_action', 'status',
  'created_at', 'updated_at',
] as const;
const FINDING_FIELDS = FINDING_COLUMNS.join(', ');

const TIMELINE_COLUMNS = [
  'id', 'project_id', 'user_id', 'event_type', 'occurred_at', 'title', 'summary', 'source_type', 'source_id',
  'related_entities', 'created_at',
] as const;
const TIMELINE_FIELDS = TIMELINE_COLUMNS.join(', ');

const STATS_COLUMNS = [
  'question_count', 'evidence_count', 'claim_count', 'decision_count', 'change_count', 'open_drift_count',
] as const;

/** Reads a row the way the schema types promise it, and refuses to guess about unknown columns. */
class RowAccess {
  private constructor(private readonly table: string, private readonly row: DbRow) {}

  static of(table: string, columns: readonly string[], row: DbRow): RowAccess {
    const keys = Object.keys(row);
    const missing = columns.filter((column) => !keys.includes(column));
    const unexpected = keys.filter((column) => !columns.includes(column));
    if (missing.length > 0 || unexpected.length > 0) {
      throw knowledgeError(
        'storage_error',
        `${table} result shape drifted: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`,
      );
    }
    return new RowAccess(table, row);
  }

  private peek(column: string): unknown {
    const value = this.row[column];
    if (value === undefined) {
      throw knowledgeError('storage_error', `${this.table}.${column} is missing from the query result`);
    }
    return value;
  }

  private wrong(column: string, expected: string, value: unknown): never {
    throw knowledgeError(
      'storage_error',
      `${this.table}.${column} expected ${expected} but received ${describe(value)}`,
    );
  }

  string(column: string): string {
    const value = this.peek(column);
    if (typeof value !== 'string') return this.wrong(column, 'text', value);
    return value;
  }

  stringOrNull(column: string): string | null {
    const value = this.peek(column);
    if (value === null) return null;
    if (typeof value !== 'string') return this.wrong(column, 'text or null', value);
    return value;
  }

  number(column: string): number {
    const value = this.peek(column);
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return this.wrong(column, 'a finite number', value);
    return parsed;
  }

  /** timestamptz arrives as a Date through pg's default parser; ISO text is accepted too. */
  iso(column: string): string {
    const value = this.peek(column);
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return this.wrong(column, 'a valid timestamp', value);
      return value.toISOString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return this.wrong(column, 'a valid timestamp', value);
      return parsed.toISOString();
    }
    return this.wrong(column, 'timestamp', value);
  }

  json(column: string): JsonValue {
    const value = this.peek(column);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return this.wrong(column, 'a json object', value);
    }
    return value as JsonValue;
  }

  enum<T>(column: string, schema: Parser<T>): T {
    try {
      return schema.parse(this.peek(column));
    } catch {
      throw knowledgeError(
        'storage_error',
        `${this.table}.${column} holds a label the schema does not define`,
      );
    }
  }

  enumOrNull<T>(column: string, schema: Parser<T>): T | null {
    return this.peek(column) === null ? null : this.enum(column, schema);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function toResearchProject(row: DbRow): ResearchProject {
  const r = RowAccess.of('research_projects', PROJECT_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    name: r.string('name'),
    description: r.stringOrNull('description'),
    status: r.enum('status', researchProjectStatusSchema),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toResearchCharter(row: DbRow): ResearchCharter {
  const r = RowAccess.of('research_charters', CHARTER_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    workingTitle: r.string('working_title'),
    researchTopic: r.stringOrNull('research_topic'),
    researchProblem: r.stringOrNull('research_problem'),
    researchGap: r.stringOrNull('research_gap'),
    researchQuestionsText: r.stringOrNull('research_questions_text'),
    coreContribution: r.stringOrNull('core_contribution'),
    theoreticalLens: r.stringOrNull('theoretical_lens'),
    researchContext: r.stringOrNull('research_context'),
    unitOfAnalysis: r.stringOrNull('unit_of_analysis'),
    researchMethod: r.stringOrNull('research_method'),
    targetArticleType: r.stringOrNull('target_article_type'),
    targetJournal: r.stringOrNull('target_journal'),
    researchBoundary: r.stringOrNull('research_boundary'),
    claimBoundary: r.stringOrNull('claim_boundary'),
    currentStage: r.stringOrNull('current_stage'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toResearchQuestion(row: DbRow): ResearchQuestion {
  const r = RowAccess.of('research_questions', QUESTION_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    questionCode: r.string('question_code'),
    questionText: r.string('question_text'),
    status: r.enum('status', researchQuestionStatusSchema),
    rationale: r.stringOrNull('rationale'),
    relatedMethod: r.stringOrNull('related_method'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toEvidence(row: DbRow): Evidence {
  const r = RowAccess.of('evidence', EVIDENCE_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    type: r.enum('type', evidenceTypeSchema),
    title: r.string('title'),
    description: r.stringOrNull('description'),
    sourceReference: r.stringOrNull('source_reference'),
    sourceLocation: r.stringOrNull('source_location'),
    reliabilityNote: r.stringOrNull('reliability_note'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toClaim(row: DbRow): Claim {
  const r = RowAccess.of('claims', CLAIM_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    claimCode: r.string('claim_code'),
    claimText: r.string('claim_text'),
    claimType: r.enum('claim_type', claimTypeSchema),
    status: r.enum('status', claimStatusSchema),
    confidence: r.number('confidence'),
    boundary: r.stringOrNull('boundary'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toManuscriptSection(row: DbRow): ManuscriptSection {
  const r = RowAccess.of('manuscript_sections', SECTION_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    sectionName: r.string('section_name'),
    sectionReference: r.stringOrNull('section_reference'),
    sortOrder: r.number('sort_order'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toEntityRelation(row: DbRow): EntityRelation {
  const r = RowAccess.of('entity_relations', RELATION_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    sourceType: r.enum('source_type', researchEntityTypeSchema),
    sourceId: r.string('source_id'),
    relationType: r.enum('relation_type', researchRelationTypeSchema),
    targetType: r.enum('target_type', researchEntityTypeSchema),
    targetId: r.string('target_id'),
    note: r.stringOrNull('note'),
    createdAt: r.iso('created_at'),
  };
}

function toResearchDecision(row: DbRow): ResearchDecision {
  const r = RowAccess.of('research_decisions', DECISION_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    title: r.string('title'),
    decision: r.string('decision'),
    reason: r.stringOrNull('reason'),
    alternatives: r.stringOrNull('alternatives'),
    rejectedAlternatives: r.stringOrNull('rejected_alternatives'),
    impact: r.stringOrNull('impact'),
    relatedEntities: r.json('related_entities'),
    createdAt: r.iso('created_at'),
  };
}

function toResearchChange(row: DbRow): ResearchChange {
  const r = RowAccess.of('research_changes', CHANGE_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    changeType: r.enum('change_type', researchChangeTypeSchema),
    before: r.string('before'),
    after: r.string('after'),
    reason: r.stringOrNull('reason'),
    impact: r.stringOrNull('impact'),
    relatedEntities: r.json('related_entities'),
    createdAt: r.iso('created_at'),
  };
}

function toDriftFinding(row: DbRow): DriftFinding {
  const r = RowAccess.of('drift_findings', FINDING_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    driftType: r.enum('drift_type', driftTypeSchema),
    severity: r.enum('severity', driftSeveritySchema),
    description: r.string('description'),
    sourceEntityType: r.enumOrNull('source_entity_type', researchEntityTypeSchema),
    sourceEntityId: r.stringOrNull('source_entity_id'),
    targetEntityType: r.enumOrNull('target_entity_type', researchEntityTypeSchema),
    targetEntityId: r.stringOrNull('target_entity_id'),
    reason: r.stringOrNull('reason'),
    recommendedAction: r.stringOrNull('recommended_action'),
    status: r.enum('status', driftFindingStatusSchema),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toTimelineEvent(row: DbRow): TimelineEvent {
  const r = RowAccess.of('timeline_events', TIMELINE_COLUMNS, row);
  return {
    id: r.string('id'),
    projectId: r.string('project_id'),
    userId: r.string('user_id'),
    eventType: r.enum('event_type', timelineEventTypeSchema),
    occurredAt: r.iso('occurred_at'),
    title: r.string('title'),
    summary: r.stringOrNull('summary'),
    sourceType: r.enumOrNull('source_type', timelineSourceSchema),
    sourceId: r.stringOrNull('source_id'),
    relatedEntities: r.json('related_entities'),
    createdAt: r.iso('created_at'),
  };
}

const PG_ERROR_AS_KNOWLEDGE_CODE: Record<string, 'not_found' | 'conflict' | 'invalid_request' | 'storage_error'> = {
  '23503': 'not_found',
  '23505': 'conflict',
  '23514': 'invalid_request',
  '57014': 'storage_error',
};

function asStorageError(error: unknown): unknown {
  if (isKnowledgeError(error)) return error;
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  const message = error instanceof Error ? error.message : 'Postgres request failed';
  if (typeof code === 'string' && code in PG_ERROR_AS_KNOWLEDGE_CODE) {
    return knowledgeError(PG_ERROR_AS_KNOWLEDGE_CODE[code] ?? 'storage_error', `${message} (pg ${code})`);
  }
  return knowledgeError('storage_error', message);
}

export class SupabaseResearchRepository implements ResearchRepository {
  readonly driver: StorageDriverName = 'supabase';

  private readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(options: SupabaseResearchRepositoryOptions) {
    if (typeof options.databaseUrl !== 'string' || options.databaseUrl.trim().length === 0) {
      throw knowledgeError('invalid_request', 'SupabaseResearchRepository requires a databaseUrl');
    }
    const timeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw knowledgeError('invalid_request', 'statementTimeoutMs must be a positive number of milliseconds');
    }
    const max = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    if (!Number.isInteger(max) || max <= 0) {
      throw knowledgeError('invalid_request', 'maxConnections must be a positive integer');
    }
    this.statementTimeoutMs = Math.trunc(timeout);
    this.pool = new Pool({
      connectionString: options.databaseUrl,
      max,
      // A startup parameter, because SET cannot take bind parameters: every pooled connection then
      // carries the same guard without a per-query round trip.
      options: `-c statement_timeout=${String(Math.trunc(timeout))}`,
    });
    // An idle client that dies must not take the process down; the next query surfaces the error.
    this.pool.on('error', () => undefined);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    const rows = await this.rows('select 1 as ok', []);
    return rows[0]?.['ok'] === 1;
  }

  private async rows(sql: string, params: unknown[], client?: PoolClient): Promise<DbRow[]> {
    try {
      const result = client === undefined
        ? await this.pool.query(sql, params)
        : await client.query(sql, params);
      return result.rows as unknown as DbRow[];
    } catch (error) {
      throw asStorageError(error);
    }
  }

  private async oneRow(sql: string, params: unknown[], client?: PoolClient): Promise<DbRow | null> {
    const rows = await this.rows(sql, params, client);
    return rows[0] ?? null;
  }

  private async mustRow(sql: string, params: unknown[], message: string, client?: PoolClient): Promise<DbRow> {
    const row = await this.oneRow(sql, params, client);
    if (row === null) throw knowledgeError('not_found', message);
    return row;
  }

  /** Project-scoped calls never touch another user's project (contract §2): absent and foreign
   *  projects are indistinguishable — both surface as `not_found`. */
  private async requireProject(projectId: string, userId: string, client?: PoolClient): Promise<void> {
    await this.mustRow(
      'select id from public.research_projects where id = $1 and user_id = $2',
      [projectId, userId],
      `ResearchProject ${projectId} not found`,
      client,
    );
  }

  // --- project ---

  async createResearchProject(input: CreateResearchProjectInput): Promise<ResearchProject> {
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.research_projects (id, user_id, name, description, status, created_at, updated_at)
       values ($1, $2, $3, $4, 'active', $5, $5)
       returning ${PROJECT_FIELDS}`,
      [createId(), input.userId, input.name.trim(), input.description ?? null, timestamp],
      'inserted ResearchProject is missing',
    );
    return toResearchProject(row);
  }

  async findResearchProject(id: string, userId: string): Promise<ResearchProject | null> {
    const row = await this.oneRow(
      `select ${PROJECT_FIELDS} from public.research_projects where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toResearchProject(row);
  }

  async listResearchProjects(userId: string): Promise<ResearchProject[]> {
    const rows = await this.rows(
      `select ${PROJECT_FIELDS} from public.research_projects
       where user_id = $1
       order by created_at asc, id asc`,
      [userId],
    );
    return rows.map(toResearchProject);
  }

  async updateResearchProject(
    id: string,
    userId: string,
    patch: UpdateResearchProjectPatch,
  ): Promise<ResearchProject> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.name !== undefined) push('name', patch.name.trim());
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.status !== undefined) push('status', patch.status);
    const row = await this.mustRow(
      `update public.research_projects set ${set.join(', ')}
       where id = $1 and user_id = $2
       returning ${PROJECT_FIELDS}`,
      params,
      `ResearchProject ${id} not found`,
    );
    return toResearchProject(row);
  }

  async researchProjectStats(projectId: string, userId: string): Promise<ResearchProjectStats> {
    await this.requireProject(projectId, userId);
    const row = await this.mustRow(
      `select
         (select count(*) from public.research_questions q
           where q.project_id = $1 and q.user_id = $2)::integer as question_count,
         (select count(*) from public.evidence e
           where e.project_id = $1 and e.user_id = $2)::integer as evidence_count,
         (select count(*) from public.claims c
           where c.project_id = $1 and c.user_id = $2)::integer as claim_count,
         (select count(*) from public.research_decisions d
           where d.project_id = $1 and d.user_id = $2)::integer as decision_count,
         (select count(*) from public.research_changes ch
           where ch.project_id = $1 and ch.user_id = $2)::integer as change_count,
         (select count(*) from public.drift_findings f
           where f.project_id = $1 and f.user_id = $2 and f.status = 'open')::integer as open_drift_count`,
      [projectId, userId],
      'project statistics row is missing',
    );
    const r = RowAccess.of('research_project_stats', STATS_COLUMNS, row);
    return {
      questionCount: r.number('question_count'),
      evidenceCount: r.number('evidence_count'),
      claimCount: r.number('claim_count'),
      decisionCount: r.number('decision_count'),
      changeCount: r.number('change_count'),
      openDriftCount: r.number('open_drift_count'),
    };
  }

  // --- charter (one per project) ---

  async findCharter(projectId: string, userId: string): Promise<ResearchCharter | null> {
    const row = await this.oneRow(
      `select ${CHARTER_FIELDS} from public.research_charters where project_id = $1 and user_id = $2`,
      [projectId, userId],
    );
    return row === null ? null : toResearchCharter(row);
  }

  async upsertCharter(input: CharterFields & { userId: string; projectId: string }): Promise<ResearchCharter> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    // research_charters_project_unique makes (project_id) the merge key: one charter per project,
    // the update branch keeps id and created_at while refreshing every field and updated_at.
    const row = await this.mustRow(
      `insert into public.research_charters
         (id, project_id, user_id, working_title, research_topic, research_problem, research_gap,
          research_questions_text, core_contribution, theoretical_lens, research_context, unit_of_analysis,
          research_method, target_article_type, target_journal, research_boundary, claim_boundary,
          current_stage, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
       on conflict (project_id) do update set
         working_title = excluded.working_title,
         research_topic = excluded.research_topic,
         research_problem = excluded.research_problem,
         research_gap = excluded.research_gap,
         research_questions_text = excluded.research_questions_text,
         core_contribution = excluded.core_contribution,
         theoretical_lens = excluded.theoretical_lens,
         research_context = excluded.research_context,
         unit_of_analysis = excluded.unit_of_analysis,
         research_method = excluded.research_method,
         target_article_type = excluded.target_article_type,
         target_journal = excluded.target_journal,
         research_boundary = excluded.research_boundary,
         claim_boundary = excluded.claim_boundary,
         current_stage = excluded.current_stage,
         updated_at = excluded.updated_at
       returning ${CHARTER_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.workingTitle,
        input.researchTopic ?? null,
        input.researchProblem ?? null,
        input.researchGap ?? null,
        input.researchQuestionsText ?? null,
        input.coreContribution ?? null,
        input.theoreticalLens ?? null,
        input.researchContext ?? null,
        input.unitOfAnalysis ?? null,
        input.researchMethod ?? null,
        input.targetArticleType ?? null,
        input.targetJournal ?? null,
        input.researchBoundary ?? null,
        input.claimBoundary ?? null,
        input.currentStage ?? null,
        timestamp,
      ],
      'upserted ResearchCharter is missing',
    );
    return toResearchCharter(row);
  }

  // --- research questions ---

  async createResearchQuestion(input: CreateResearchQuestionInput): Promise<ResearchQuestion> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.research_questions
         (id, project_id, user_id, question_code, question_text, status, rationale, related_method,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, coalesce($6::text, 'open'), $7, $8, $9, $9)
       returning ${QUESTION_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.questionCode,
        input.questionText,
        input.status ?? null,
        input.rationale ?? null,
        input.relatedMethod ?? null,
        timestamp,
      ],
      'inserted ResearchQuestion is missing',
    );
    return toResearchQuestion(row);
  }

  async findResearchQuestion(id: string, userId: string): Promise<ResearchQuestion | null> {
    const row = await this.oneRow(
      `select ${QUESTION_FIELDS} from public.research_questions where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toResearchQuestion(row);
  }

  async listResearchQuestions(projectId: string, userId: string): Promise<ResearchQuestion[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${QUESTION_FIELDS} from public.research_questions
       where project_id = $1 and user_id = $2
       order by created_at asc, id asc`,
      [projectId, userId],
    );
    return rows.map(toResearchQuestion);
  }

  async updateResearchQuestion(
    id: string,
    userId: string,
    patch: UpdateResearchQuestionPatch,
  ): Promise<ResearchQuestion> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.questionCode !== undefined) push('question_code', patch.questionCode);
    if (patch.questionText !== undefined) push('question_text', patch.questionText);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.rationale !== undefined) push('rationale', patch.rationale);
    if (patch.relatedMethod !== undefined) push('related_method', patch.relatedMethod);
    const row = await this.mustRow(
      `update public.research_questions set ${set.join(', ')}
       where id = $1 and user_id = $2
       returning ${QUESTION_FIELDS}`,
      params,
      `ResearchQuestion ${id} not found`,
    );
    return toResearchQuestion(row);
  }

  // --- evidence ---

  async createEvidence(input: CreateEvidenceInput): Promise<Evidence> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.evidence
         (id, project_id, user_id, type, title, description, source_reference, source_location,
          reliability_note, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       returning ${EVIDENCE_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.type,
        input.title,
        input.description ?? null,
        input.sourceReference ?? null,
        input.sourceLocation ?? null,
        input.reliabilityNote ?? null,
        timestamp,
      ],
      'inserted Evidence is missing',
    );
    return toEvidence(row);
  }

  async findEvidence(id: string, userId: string): Promise<Evidence | null> {
    const row = await this.oneRow(
      `select ${EVIDENCE_FIELDS} from public.evidence where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toEvidence(row);
  }

  async listEvidence(projectId: string, userId: string, options: EvidenceListOptions = {}): Promise<Evidence[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${EVIDENCE_FIELDS} from public.evidence
       where project_id = $1 and user_id = $2
         and ($3::text is null or type = $3)
       order by created_at asc, id asc`,
      [projectId, userId, options.type ?? null],
    );
    return rows.map(toEvidence);
  }

  async updateEvidence(id: string, userId: string, patch: UpdateEvidencePatch): Promise<Evidence> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.type !== undefined) push('type', patch.type);
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.sourceReference !== undefined) push('source_reference', patch.sourceReference);
    if (patch.sourceLocation !== undefined) push('source_location', patch.sourceLocation);
    if (patch.reliabilityNote !== undefined) push('reliability_note', patch.reliabilityNote);
    const row = await this.mustRow(
      `update public.evidence set ${set.join(', ')}
       where id = $1 and user_id = $2
       returning ${EVIDENCE_FIELDS}`,
      params,
      `Evidence ${id} not found`,
    );
    return toEvidence(row);
  }

  // --- claims ---

  async createClaim(input: CreateClaimInput): Promise<Claim> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.claims
         (id, project_id, user_id, claim_code, claim_text, claim_type, status, confidence, boundary,
          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::text, 'draft'), coalesce($8::double precision, 0), $9, $10, $10)
       returning ${CLAIM_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.claimCode,
        input.claimText,
        input.claimType,
        input.status ?? null,
        input.confidence ?? null,
        input.boundary ?? null,
        timestamp,
      ],
      'inserted Claim is missing',
    );
    return toClaim(row);
  }

  async findClaim(id: string, userId: string): Promise<Claim | null> {
    const row = await this.oneRow(
      `select ${CLAIM_FIELDS} from public.claims where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toClaim(row);
  }

  async listClaims(projectId: string, userId: string, options: ClaimListOptions = {}): Promise<Claim[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${CLAIM_FIELDS} from public.claims
       where project_id = $1 and user_id = $2
         and ($3::text is null or status = $3)
         and ($4::text is null or claim_type = $4)
       order by created_at asc, id asc`,
      [projectId, userId, options.status ?? null, options.claimType ?? null],
    );
    return rows.map(toClaim);
  }

  async updateClaim(id: string, userId: string, patch: UpdateClaimPatch): Promise<Claim> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.claimCode !== undefined) push('claim_code', patch.claimCode);
    if (patch.claimText !== undefined) push('claim_text', patch.claimText);
    if (patch.claimType !== undefined) push('claim_type', patch.claimType);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.confidence !== undefined) push('confidence', patch.confidence);
    if (patch.boundary !== undefined) push('boundary', patch.boundary);
    const row = await this.mustRow(
      `update public.claims set ${set.join(', ')}
       where id = $1 and user_id = $2
       returning ${CLAIM_FIELDS}`,
      params,
      `Claim ${id} not found`,
    );
    return toClaim(row);
  }

  // --- manuscript sections ---

  async createManuscriptSection(input: CreateManuscriptSectionInput): Promise<ManuscriptSection> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.manuscript_sections
         (id, project_id, user_id, section_name, section_reference, sort_order, created_at, updated_at)
       values ($1, $2, $3, $4, $5, coalesce($6::integer, 0), $7, $7)
       returning ${SECTION_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.sectionName,
        input.sectionReference ?? null,
        input.sortOrder ?? null,
        timestamp,
      ],
      'inserted ManuscriptSection is missing',
    );
    return toManuscriptSection(row);
  }

  async findManuscriptSection(id: string, userId: string): Promise<ManuscriptSection | null> {
    const row = await this.oneRow(
      `select ${SECTION_FIELDS} from public.manuscript_sections where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toManuscriptSection(row);
  }

  async listManuscriptSections(projectId: string, userId: string): Promise<ManuscriptSection[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${SECTION_FIELDS} from public.manuscript_sections
       where project_id = $1 and user_id = $2
       order by created_at asc, id asc`,
      [projectId, userId],
    );
    return rows.map(toManuscriptSection);
  }

  async updateManuscriptSection(
    id: string,
    userId: string,
    patch: UpdateManuscriptSectionPatch,
  ): Promise<ManuscriptSection> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.sectionName !== undefined) push('section_name', patch.sectionName);
    if (patch.sectionReference !== undefined) push('section_reference', patch.sectionReference);
    if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);
    const row = await this.mustRow(
      `update public.manuscript_sections set ${set.join(', ')}
       where id = $1 and user_id = $2
       returning ${SECTION_FIELDS}`,
      params,
      `ManuscriptSection ${id} not found`,
    );
    return toManuscriptSection(row);
  }

  // --- generic relations ---

  async createEntityRelation(input: CreateEntityRelationInput): Promise<EntityRelation> {
    await this.requireProject(input.projectId, input.userId);
    const findSql = `select ${RELATION_FIELDS} from public.entity_relations
       where user_id = $1 and project_id = $2
         and source_type = $3 and source_id = $4 and relation_type = $5
         and target_type = $6 and target_id = $7`;
    const findParams = [
      input.userId,
      input.projectId,
      input.sourceType,
      input.sourceId,
      input.relationType,
      input.targetType,
      input.targetId,
    ];
    // Idempotent on the five-tuple (contract §2): a repeat create returns the existing row untouched.
    const existing = await this.oneRow(findSql, findParams);
    if (existing !== null) return toEntityRelation(existing);

    const inserted = await this.rows(
      `insert into public.entity_relations
         (id, project_id, user_id, source_type, source_id, relation_type, target_type, target_id, note, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict do nothing
       returning ${RELATION_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.sourceType,
        input.sourceId,
        input.relationType,
        input.targetType,
        input.targetId,
        input.note ?? null,
        nowIso(),
      ],
    );
    const created = inserted[0];
    if (created !== undefined) return toEntityRelation(created);

    // A concurrent writer claimed the tuple first: return their row instead of duplicating history.
    const raced = await this.oneRow(findSql, findParams);
    if (raced === null) throw knowledgeError('storage_error', 'entity relation vanished between insert and lookup');
    return toEntityRelation(raced);
  }

  async listEntityRelations(
    projectId: string,
    userId: string,
    filter: RelationFilter = {},
  ): Promise<EntityRelation[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${RELATION_FIELDS} from public.entity_relations
       where project_id = $1 and user_id = $2
         and ($3::text is null or source_type = $3)
         and ($4::text is null or source_id = $4)
         and ($5::text is null or target_type = $5)
         and ($6::text is null or target_id = $6)
         and ($7::text is null or relation_type = $7)
       order by created_at asc, id asc`,
      [
        projectId,
        userId,
        filter.sourceType ?? null,
        filter.sourceId ?? null,
        filter.targetType ?? null,
        filter.targetId ?? null,
        filter.relationType ?? null,
      ],
    );
    return rows.map(toEntityRelation);
  }

  async deleteEntityRelation(id: string, userId: string): Promise<boolean> {
    const rows = await this.rows(
      'delete from public.entity_relations where id = $1 and user_id = $2 returning id',
      [id, userId],
    );
    return rows.length > 0;
  }

  // --- decisions (append-only) ---

  async createResearchDecision(input: CreateResearchDecisionInput): Promise<ResearchDecision> {
    await this.requireProject(input.projectId, input.userId);
    const row = await this.mustRow(
      `insert into public.research_decisions
         (id, project_id, user_id, title, decision, reason, alternatives, rejected_alternatives,
          impact, related_entities, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       returning ${DECISION_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.title,
        input.decision,
        input.reason ?? null,
        input.alternatives ?? null,
        input.rejectedAlternatives ?? null,
        input.impact ?? null,
        JSON.stringify(input.relatedEntities ?? {}),
        nowIso(),
      ],
      'inserted ResearchDecision is missing',
    );
    return toResearchDecision(row);
  }

  async findResearchDecision(id: string, userId: string): Promise<ResearchDecision | null> {
    const row = await this.oneRow(
      `select ${DECISION_FIELDS} from public.research_decisions where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toResearchDecision(row);
  }

  async listResearchDecisions(projectId: string, userId: string): Promise<ResearchDecision[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${DECISION_FIELDS} from public.research_decisions
       where project_id = $1 and user_id = $2
       order by created_at asc, id asc`,
      [projectId, userId],
    );
    return rows.map(toResearchDecision);
  }

  // --- changes (append-only) ---

  async createResearchChange(input: CreateResearchChangeInput): Promise<ResearchChange> {
    await this.requireProject(input.projectId, input.userId);
    const row = await this.mustRow(
      `insert into public.research_changes
         (id, project_id, user_id, change_type, before, after, reason, impact, related_entities, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning ${CHANGE_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.changeType,
        input.before,
        input.after,
        input.reason ?? null,
        input.impact ?? null,
        JSON.stringify(input.relatedEntities ?? {}),
        nowIso(),
      ],
      'inserted ResearchChange is missing',
    );
    return toResearchChange(row);
  }

  async findResearchChange(id: string, userId: string): Promise<ResearchChange | null> {
    const row = await this.oneRow(
      `select ${CHANGE_FIELDS} from public.research_changes where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toResearchChange(row);
  }

  async listResearchChanges(
    projectId: string,
    userId: string,
    options: ResearchChangeListOptions = {},
  ): Promise<ResearchChange[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${CHANGE_FIELDS} from public.research_changes
       where project_id = $1 and user_id = $2
         and ($3::text is null or change_type = $3)
       order by created_at asc, id asc`,
      [projectId, userId, options.changeType ?? null],
    );
    return rows.map(toResearchChange);
  }

  // --- drift findings ---

  async createDriftFinding(input: CreateDriftFindingInput): Promise<DriftFinding> {
    await this.requireProject(input.projectId, input.userId);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.drift_findings
         (id, project_id, user_id, drift_type, severity, description, source_entity_type, source_entity_id,
          target_entity_type, target_entity_id, reason, recommended_action, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', $13, $13)
       returning ${FINDING_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.driftType,
        input.severity,
        input.description,
        input.sourceEntityType ?? null,
        input.sourceEntityId ?? null,
        input.targetEntityType ?? null,
        input.targetEntityId ?? null,
        input.reason ?? null,
        input.recommendedAction ?? null,
        timestamp,
      ],
      'inserted DriftFinding is missing',
    );
    return toDriftFinding(row);
  }

  async findDriftFinding(id: string, userId: string): Promise<DriftFinding | null> {
    const row = await this.oneRow(
      `select ${FINDING_FIELDS} from public.drift_findings where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toDriftFinding(row);
  }

  async listDriftFindings(
    projectId: string,
    userId: string,
    options: DriftFindingListOptions = {},
  ): Promise<DriftFinding[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${FINDING_FIELDS} from public.drift_findings
       where project_id = $1 and user_id = $2
         and ($3::text is null or status = $3)
         and ($4::text is null or drift_type = $4)
         and ($5::text is null or severity = $5)
       order by created_at asc, id asc`,
      [projectId, userId, options.status ?? null, options.driftType ?? null, options.severity ?? null],
    );
    return rows.map(toDriftFinding);
  }

  async updateDriftFindingStatus(
    id: string,
    userId: string,
    status: DriftFindingStatus,
  ): Promise<DriftFinding> {
    const row = await this.mustRow(
      `update public.drift_findings set status = $3, updated_at = $4
       where id = $1 and user_id = $2
       returning ${FINDING_FIELDS}`,
      [id, userId, status, nowIso()],
      `DriftFinding ${id} not found`,
    );
    return toDriftFinding(row);
  }

  // --- timeline ---

  async createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEvent> {
    await this.requireProject(input.projectId, input.userId);
    const row = await this.mustRow(
      `insert into public.timeline_events
         (id, project_id, user_id, event_type, occurred_at, title, summary, source_type, source_id,
          related_entities, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       returning ${TIMELINE_FIELDS}`,
      [
        createId(),
        input.projectId,
        input.userId,
        input.eventType,
        input.occurredAt,
        input.title,
        input.summary ?? null,
        input.sourceType ?? null,
        input.sourceId ?? null,
        JSON.stringify(input.relatedEntities ?? {}),
        nowIso(),
      ],
      'inserted TimelineEvent is missing',
    );
    return toTimelineEvent(row);
  }

  async listTimelineEvents(projectId: string, userId: string): Promise<TimelineEvent[]> {
    await this.requireProject(projectId, userId);
    const rows = await this.rows(
      `select ${TIMELINE_FIELDS} from public.timeline_events
       where project_id = $1 and user_id = $2
       order by occurred_at desc, id desc`,
      [projectId, userId],
    );
    return rows.map(toTimelineEvent);
  }
}

export function createSupabaseResearchRepository(
  options: SupabaseResearchRepositoryOptions,
): SupabaseResearchRepository {
  return new SupabaseResearchRepository(options);
}
