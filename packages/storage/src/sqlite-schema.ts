/**
 * SQLite schema ownership: pragmas, versioned DDL and the migration runner.
 *
 * Versions 1–2 mirror `supabase/migrations/20261002000200_core_tables.sql` minus Postgres-only
 * machinery (no roles, no RLS, no `extensions.vector`). Enum CHECK labels are copied from the same
 * source of truth as the Postgres file — `packages/schema/src/enums.ts` — and `sqlite-schema.test.ts`
 * fails if the two drift.
 *
 * Version 3 adds the Research tables. They have no Postgres counterpart in this repository: the
 * archived `research-supabase.ts` driver and its two migrations were left in `ad1d0c6`, so the zod
 * enums in `packages/schema/src/research.ts` are the only source of truth for these labels, and
 * `research-schema.test.ts` is what keeps the two from drifting.
 *
 * Durability choices follow the local-desktop brief: WAL for reader/writer concurrency, `FULL`
 * synchronous so a confirmed write survives a power loss, foreign keys on per connection, and a busy
 * timeout instead of an immediate `SQLITE_BUSY` when the runtime briefly shares the file.
 */
import { DatabaseSync } from 'node:sqlite';

/** Bumped by appending a new entry to MIGRATIONS; stored in `PRAGMA user_version`. */
export const SQLITE_SCHEMA_VERSION = 3;

export interface SqliteOpenOptions {
  /** Absolute path to the database file, or `:memory:`. */
  file: string;
  /** Default FULL; `NORMAL` is only acceptable when the caller documents the durability trade. */
  synchronous?: 'FULL' | 'NORMAL' | 'OFF';
  busyTimeoutMs?: number;
  /** Open read-only: no migration, no WAL upgrade. */
  readOnly?: boolean;
}

export interface SqliteConnection {
  db: DatabaseSync;
  pragmas: SqlitePragmas;
}

export interface SqlitePragmas {
  journalMode: string;
  synchronous: string;
  foreignKeys: number;
  busyTimeout: number;
  schemaVersion: number;
  sqliteVersion: string;
  fts5Available: boolean;
  /** Populated only when the probe failed, so the startup error can name the cause. */
  fts5Error: string | null;
}

const ENUM_CHECKS = {
  sourceType: "('web', 'desktop_app', 'agent', 'manual')",
  processingStatus: "('pending', 'processing', 'done', 'failed')",
  itemStatus: "('active', 'merged', 'archived')",
  nodeStatus: "('active', 'archived', 'needs_review')",
  embeddingStatus: "('none', 'ready', 'failed')",
  masteryLevel:
    "('collected', 'organized', 'understood', 'explainable', 'applicable', 'mastered')",
  edgeRelation:
    "('part_of', 'prerequisite_of', 'similar_to', 'contrast_with', 'causes', 'implements', 'example_of', 'supports', 'contradicts', 'derived_from')",
  linkRelation: "('primary', 'example_of', 'supports')",
  versionedEntity: "('knowledge_node', 'knowledge_item', 'raw_source')",
  structureOperation:
    "('create', 'rename', 'move', 'reparent', 'merge', 'split', 'archive', 'restore')",
  contextScope: "('current_node', 'section', 'tree', 'whole_library')",
  conversationRole: "('system', 'user', 'assistant')",
  researchProjectStatus: "('active', 'archived', 'completed')",
  researchQuestionStatus: "('open', 'answered', 'revised', 'dropped')",
  evidenceType:
    "('literature', 'dataset', 'analysis_result', 'figure', 'table', 'interview', 'expert_judgement', 'document', 'note', 'external_source', 'other')",
  claimType:
    "('descriptive', 'empirical', 'methodological', 'interpretive', 'theoretical', 'contribution', 'limitation')",
  claimStatus: "('draft', 'proposed', 'confirmed', 'revised', 'dropped')",
  researchChangeType:
    "('research_question', 'method', 'scope', 'claim', 'contribution', 'journal', 'structure', 'evidence', 'other')",
  researchEntityType:
    "('research_project', 'research_charter', 'research_question', 'evidence', 'claim', 'research_decision', 'research_change', 'drift_finding', 'manuscript_section')",
  researchRelationType:
    "('supports', 'partially_supports', 'contradicts', 'qualifies', 'contextualizes', 'answers', 'appears_in', 'changes', 'affects', 'relates_to')",
  driftType:
    "('rq_drift', 'contribution_drift', 'evidence_drift', 'causality_drift', 'method_drift', 'journal_drift')",
  driftSeverity: "('info', 'warning', 'critical')",
  driftFindingStatus: "('open', 'acknowledged', 'resolved', 'dismissed')",
  timelineEventType: "('decision', 'change', 'milestone')",
  timelineSource: "('research_decision', 'research_change', 'manual')",
} as const;

const DDL_V1 = `
create table if not exists raw_sources (
  id text primary key,
  user_id text not null,
  raw_text text not null,
  surrounding_context text,
  source_type text not null constraint raw_sources_source_type_enum_check check (source_type in ${ENUM_CHECKS.sourceType}),
  source_platform text,
  source_app text,
  source_title text,
  source_url text,
  captured_at text not null,
  metadata_json text not null default '{}',
  processing_status text not null default 'pending'
    constraint raw_sources_processing_status_enum_check check (processing_status in ${ENUM_CHECKS.processingStatus}),
  error_reason text,
  created_at text not null
);
create index if not exists raw_sources_user_idx on raw_sources (user_id, created_at);

create table if not exists knowledge_nodes (
  id text primary key,
  user_id text not null,
  title text not null constraint knowledge_nodes_title_length_check check (length(trim(title)) between 1 and 200),
  summary text,
  node_type text not null default 'topic',
  parent_id text references knowledge_nodes (id) on delete restrict,
  status text not null default 'active'
    constraint knowledge_nodes_status_enum_check check (status in ${ENUM_CHECKS.nodeStatus}),
  confidence real constraint knowledge_nodes_confidence_range_check
    check (confidence is null or (confidence between 0 and 1)),
  embedding_model text,
  embedding_status text not null default 'none'
    constraint knowledge_nodes_embedding_status_enum_check check (embedding_status in ${ENUM_CHECKS.embeddingStatus}),
  mastery_level text not null default 'collected'
    constraint knowledge_nodes_mastery_level_enum_check check (mastery_level in ${ENUM_CHECKS.masteryLevel}),
  created_at text not null,
  updated_at text not null,
  constraint knowledge_nodes_not_self_parent_check check (parent_id is null or parent_id <> id)
);
create index if not exists knowledge_nodes_parent_idx on knowledge_nodes (user_id, parent_id);
create index if not exists knowledge_nodes_title_idx on knowledge_nodes (user_id, title);

create table if not exists knowledge_items (
  id text primary key,
  user_id text not null,
  raw_source_id text not null references raw_sources (id) on delete restrict,
  normalized_text text not null,
  summary text,
  confidence real not null constraint knowledge_items_confidence_range_check check (confidence between 0 and 1),
  status text not null default 'active'
    constraint knowledge_items_status_enum_check check (status in ${ENUM_CHECKS.itemStatus}),
  is_ai_derived integer not null default 1 check (is_ai_derived in (0, 1)),
  embedding_model text,
  embedding_status text not null default 'none'
    constraint knowledge_items_embedding_status_enum_check check (embedding_status in ${ENUM_CHECKS.embeddingStatus}),
  parent_candidate_node_id text references knowledge_nodes (id) on delete set null,
  parent_confidence real constraint knowledge_items_parent_confidence_range_check
    check (parent_confidence is null or (parent_confidence between 0 and 1)),
  created_at text not null,
  updated_at text not null
);
create index if not exists knowledge_items_source_idx on knowledge_items (user_id, raw_source_id, created_at);

create table if not exists knowledge_edges (
  id text primary key,
  user_id text not null,
  from_node_id text not null references knowledge_nodes (id) on delete cascade,
  to_node_id text not null references knowledge_nodes (id) on delete cascade,
  relation_type text not null
    constraint knowledge_edges_relation_type_enum_check check (relation_type in ${ENUM_CHECKS.edgeRelation}),
  confidence real constraint knowledge_edges_confidence_range_check
    check (confidence is null or (confidence between 0 and 1)),
  source text not null,
  created_at text not null,
  constraint knowledge_edges_no_self_loop_check check (from_node_id <> to_node_id)
);
create unique index if not exists knowledge_edges_upsert_idx
  on knowledge_edges (user_id, from_node_id, to_node_id, relation_type);
create index if not exists knowledge_edges_node_idx on knowledge_edges (user_id, from_node_id, to_node_id);

create table if not exists item_node_links (
  id text primary key,
  user_id text not null,
  item_id text not null references knowledge_items (id) on delete cascade,
  node_id text not null references knowledge_nodes (id) on delete cascade,
  relation_type text not null default 'primary'
    constraint item_node_links_relation_type_enum_check check (relation_type in ${ENUM_CHECKS.linkRelation}),
  confidence real not null constraint item_node_links_confidence_range_check check (confidence between 0 and 1),
  created_at text not null
);
create unique index if not exists item_node_links_upsert_idx on item_node_links (item_id, node_id);
create index if not exists item_node_links_node_idx on item_node_links (user_id, node_id);

create table if not exists version_records (
  id text primary key,
  user_id text not null,
  entity_type text not null
    constraint version_records_entity_type_enum_check check (entity_type in ${ENUM_CHECKS.versionedEntity}),
  entity_id text not null,
  operation text not null
    constraint version_records_operation_enum_check check (operation in ${ENUM_CHECKS.structureOperation}),
  before_json text not null default '{}',
  after_json text not null default '{}',
  actor text not null,
  created_at text not null
);
create index if not exists version_records_user_idx on version_records (user_id, created_at);
create index if not exists version_records_entity_idx on version_records (user_id, entity_id);

create table if not exists conversations (
  id text primary key,
  user_id text not null,
  node_id text references knowledge_nodes (id) on delete cascade,
  scope text not null constraint conversations_scope_enum_check check (scope in ${ENUM_CHECKS.contextScope}),
  title text,
  context_summary text,
  token_estimate integer,
  created_at text not null,
  updated_at text not null
);
create index if not exists conversations_user_idx on conversations (user_id, updated_at);

create table if not exists conversation_messages (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  role text not null
    constraint conversation_messages_role_enum_check check (role in ${ENUM_CHECKS.conversationRole}),
  content text not null,
  context_node_id text,
  created_at text not null
);
create index if not exists conversation_messages_list_idx
  on conversation_messages (conversation_id, created_at);

-- One row per embedded entity. Postgres fixed the width in the column type; a local file must be able
-- to hold several models over time, so the width travels with the vector and search refuses to mix.
create table if not exists vectors (
  owner_type text not null check (owner_type in ('knowledge_item', 'knowledge_node')),
  owner_id text not null,
  user_id text not null,
  model_id text,
  dimension integer not null check (dimension > 0),
  normalization text not null default 'unnormalized'
    check (normalization in ('unnormalized', 'l2')),
  source_hash text,
  builder_version text,
  embedding blob not null,
  created_at text not null,
  updated_at text not null,
  primary key (owner_type, owner_id)
) without rowid;
create index if not exists vectors_owner_idx on vectors (user_id, owner_type, dimension);

-- FTS5 over pre-split terms rather than over raw text: the default tokenizers treat a CJK run as one
-- token, which cannot match a two-character Chinese query. tokenize() from @noltri/shared emits
-- bigrams for CJK runs and whole words for latin, and those terms are what gets indexed here. The
-- untouched text stays in knowledge_items / knowledge_nodes.
create virtual table if not exists keyword_index using fts5(
  entity_id unindexed,
  entity_type unindexed,
  user_id unindexed,
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Version 2 gives a capture the key the local Core replays on: `(user_id, client_id, request_id)`.
 *
 * `ALTER TABLE ADD COLUMN` carries the CHECK because SQLite cannot add a constraint to an existing
 * table any other way, and the pair rule has to be enforced in the file rather than only in the
 * pipeline — a half-stated key would silently split one capture across two idempotency rows. A fresh
 * database reaches the same shape by running version 1 and then this step, so nothing here duplicates
 * `DDL_V1` except the index names.
 */
const DDL_V2 = `
alter table raw_sources add column request_id text;
alter table raw_sources add column client_id text
  constraint raw_sources_idempotency_pair_check check (request_id is null or client_id is not null);
create unique index if not exists raw_sources_idempotency_uq
  on raw_sources (user_id, client_id, request_id) where request_id is not null;
`;

/**
 * Version 3 is the Research domain: eleven additive tables hanging off `research_projects`.
 *
 * Nothing in versions 1–2 changes, so a knowledge-only profile upgrades without touching a row it
 * already had. Two shapes here are enforced in the file rather than only in the driver because the
 * in-memory driver guarantees them anyway: one charter per project, and one row per
 * (user, project, source, relation, target) tuple — a repeat `createEntityRelation` returns the
 * existing relation untouched, so a duplicate must be impossible rather than merely unlikely.
 *
 * `project_id` cascades: deleting a project removes its research objects. No code path does that in
 * V1 (research projects are only archived), but a stray row must never be able to outlive its owner.
 */
const DDL_V3 = `
create table if not exists research_projects (
  id text primary key,
  user_id text not null,
  name text not null,
  description text,
  status text not null default 'active'
    constraint research_projects_status_enum_check check (status in ${ENUM_CHECKS.researchProjectStatus}),
  created_at text not null,
  updated_at text not null
);
create index if not exists research_projects_user_idx on research_projects (user_id, created_at);

create table if not exists research_charters (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  working_title text not null,
  research_topic text,
  research_problem text,
  research_gap text,
  research_questions_text text,
  core_contribution text,
  theoretical_lens text,
  research_context text,
  unit_of_analysis text,
  research_method text,
  target_article_type text,
  target_journal text,
  research_boundary text,
  claim_boundary text,
  current_stage text,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists research_charters_project_uq on research_charters (project_id);

create table if not exists research_questions (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  question_code text not null,
  question_text text not null,
  status text not null default 'open'
    constraint research_questions_status_enum_check check (status in ${ENUM_CHECKS.researchQuestionStatus}),
  rationale text,
  related_method text,
  created_at text not null,
  updated_at text not null
);
create index if not exists research_questions_list_idx on research_questions (user_id, project_id, created_at);

create table if not exists research_evidence (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  type text not null constraint research_evidence_type_enum_check check (type in ${ENUM_CHECKS.evidenceType}),
  title text not null,
  description text,
  source_reference text,
  source_location text,
  reliability_note text,
  created_at text not null,
  updated_at text not null
);
create index if not exists research_evidence_list_idx on research_evidence (user_id, project_id, created_at);

create table if not exists research_claims (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  claim_code text not null,
  claim_text text not null,
  claim_type text not null
    constraint research_claims_claim_type_enum_check check (claim_type in ${ENUM_CHECKS.claimType}),
  status text not null default 'draft'
    constraint research_claims_status_enum_check check (status in ${ENUM_CHECKS.claimStatus}),
  confidence real not null default 0 constraint research_claims_confidence_range_check
    check (confidence between 0 and 1),
  boundary text,
  created_at text not null,
  updated_at text not null
);
create index if not exists research_claims_list_idx on research_claims (user_id, project_id, created_at);

create table if not exists research_manuscript_sections (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  section_name text not null,
  section_reference text,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create index if not exists research_sections_list_idx
  on research_manuscript_sections (user_id, project_id, created_at);

create table if not exists research_entity_relations (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  source_type text not null
    constraint research_entity_relations_source_type_enum_check
      check (source_type in ${ENUM_CHECKS.researchEntityType}),
  source_id text not null,
  relation_type text not null
    constraint research_entity_relations_relation_type_enum_check
      check (relation_type in ${ENUM_CHECKS.researchRelationType}),
  target_type text not null
    constraint research_entity_relations_target_type_enum_check
      check (target_type in ${ENUM_CHECKS.researchEntityType}),
  target_id text not null,
  note text,
  created_at text not null
);
create unique index if not exists research_entity_relations_quintuple_uq
  on research_entity_relations (user_id, project_id, source_type, source_id, relation_type, target_type, target_id);
create index if not exists research_entity_relations_list_idx
  on research_entity_relations (user_id, project_id, created_at);

create table if not exists research_decisions (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  title text not null,
  decision text not null,
  reason text,
  alternatives text,
  rejected_alternatives text,
  impact text,
  related_entities_json text not null default '{}',
  created_at text not null
);
create index if not exists research_decisions_list_idx
  on research_decisions (user_id, project_id, created_at);

create table if not exists research_changes (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  change_type text not null
    constraint research_changes_change_type_enum_check check (change_type in ${ENUM_CHECKS.researchChangeType}),
  before_text text not null,
  after_text text not null,
  reason text,
  impact text,
  related_entities_json text not null default '{}',
  created_at text not null
);
create index if not exists research_changes_list_idx on research_changes (user_id, project_id, created_at);

create table if not exists research_drift_findings (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  drift_type text not null constraint research_drift_findings_drift_type_enum_check
    check (drift_type in ${ENUM_CHECKS.driftType}),
  severity text not null constraint research_drift_findings_severity_enum_check
    check (severity in ${ENUM_CHECKS.driftSeverity}),
  description text not null,
  source_entity_type text
    constraint research_drift_findings_source_entity_type_enum_check
    check (source_entity_type is null or source_entity_type in ${ENUM_CHECKS.researchEntityType}),
  source_entity_id text,
  target_entity_type text
    constraint research_drift_findings_target_entity_type_enum_check
    check (target_entity_type is null or target_entity_type in ${ENUM_CHECKS.researchEntityType}),
  target_entity_id text,
  reason text,
  recommended_action text,
  status text not null default 'open'
    constraint research_drift_findings_status_enum_check check (status in ${ENUM_CHECKS.driftFindingStatus}),
  created_at text not null,
  updated_at text not null
);
create index if not exists research_drift_findings_list_idx
  on research_drift_findings (user_id, project_id, created_at);

create table if not exists research_timeline_events (
  id text primary key,
  project_id text not null references research_projects (id) on delete cascade,
  user_id text not null,
  event_type text not null
    constraint research_timeline_events_event_type_enum_check check (event_type in ${ENUM_CHECKS.timelineEventType}),
  occurred_at text not null,
  title text not null,
  summary text,
  source_type text
    constraint research_timeline_events_source_type_enum_check
    check (source_type is null or source_type in ${ENUM_CHECKS.timelineSource}),
  source_id text,
  related_entities_json text not null default '{}',
  created_at text not null
);
create index if not exists research_timeline_events_list_idx
  on research_timeline_events (user_id, project_id, occurred_at);
`;

const MIGRATIONS: ReadonlyArray<{ version: number; apply: (db: DatabaseSync) => void }> = [
  { version: 1, apply: (db) => db.exec(DDL_V1) },
  { version: 2, apply: (db) => db.exec(DDL_V2) },
  { version: 3, apply: (db) => db.exec(DDL_V3) },
];

function readString(db: DatabaseSync, sql: string): string {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return String(Object.values(row ?? { '': '' })[0] ?? '');
}

/** `pragma synchronous` answers with a number (0 off / 1 normal / 2 full / 3 extra). */
const SYNCHRONOUS_BY_CODE: Record<string, string> = {
  '0': 'off',
  '1': 'normal',
  '2': 'full',
  '3': 'extra',
};

function readNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? { 0: 0 })[0] ?? 0);
}

/** Probed rather than assumed: `compile_options` reports intent, the probe reports this build. */
export function probeFts5(db: DatabaseSync): { ok: boolean; error: string | null } {
  try {
    db.exec('create virtual table temp.__fts_probe using fts5(body)');
    db.exec('drop table temp.__fts_probe');
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Applies every migration above the stored `user_version`. Idempotent. */
export function migrateSqlite(db: DatabaseSync): number {
  const current = readNumber(db, 'pragma user_version');
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec('begin immediate');
    try {
      step.apply(db);
      db.exec(`pragma user_version = ${String(step.version)}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
  return readNumber(db, 'pragma user_version');
}

export function openSqlite(options: SqliteOpenOptions): SqliteConnection {
  const synchronous = options.synchronous ?? 'FULL';
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  const db = new DatabaseSync(options.file, {
    readOnly: options.readOnly === true,
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  });

  // `journal_mode = wal` is a file-level setting that survives reopen; on `:memory:` SQLite reports
  // `memory` back and we keep whatever it answered rather than asserting a mode we did not get.
  if (options.readOnly !== true) db.exec('pragma journal_mode = wal');
  db.exec(`pragma synchronous = ${synchronous}`);
  db.exec(`pragma busy_timeout = ${String(busyTimeoutMs)}`);
  // Applied after the journal mode so a file-level change never races the schema upgrade.
  const version = options.readOnly === true ? readNumber(db, 'pragma user_version') : migrateSqlite(db);

  const fts5 = probeFts5(db);
  const pragmas: SqlitePragmas = {
    journalMode: readString(db, 'pragma journal_mode'),
    synchronous: SYNCHRONOUS_BY_CODE[readString(db, 'pragma synchronous')] ?? 'unknown',
    foreignKeys: readNumber(db, 'pragma foreign_keys'),
    busyTimeout: readNumber(db, 'pragma busy_timeout'),
    schemaVersion: version,
    sqliteVersion: readString(db, 'select sqlite_version()'),
    fts5Available: fts5.ok,
    fts5Error: fts5.error,
  };

  return { db, pragmas };
}

export {
  MIGRATIONS as SQLITE_MIGRATIONS,
  DDL_V1 as SQLITE_DDL_V1,
  DDL_V2 as SQLITE_DDL_V2,
  DDL_V3 as SQLITE_DDL_V3,
};
