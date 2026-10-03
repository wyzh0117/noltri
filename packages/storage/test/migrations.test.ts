import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  claimStatusSchema,
  claimTypeSchema,
  conversationRoleSchema,
  contextScopeSchema,
  driftFindingStatusSchema,
  driftSeveritySchema,
  driftTypeSchema,
  edgeRelationSchema,
  embeddingStatusSchema,
  evidenceTypeSchema,
  itemLinkRelationSchema,
  knowledgeItemStatusSchema,
  masteryLevelSchema,
  nodeStatusSchema,
  processingStatusSchema,
  researchChangeTypeSchema,
  researchEntityTypeSchema,
  researchProjectStatusSchema,
  researchQuestionStatusSchema,
  researchRelationTypeSchema,
  sourceTypeSchema,
  structureOperationSchema,
  timelineEventTypeSchema,
  timelineSourceSchema,
  versionedEntitySchema,
} from '@noltri/schema';

const MIGRATIONS = new URL('../../../supabase/migrations/', import.meta.url);

const NINE_TABLES = [
  'conversation_messages',
  'conversations',
  'item_node_links',
  'knowledge_edges',
  'knowledge_items',
  'knowledge_nodes',
  'raw_sources',
  'users',
  'version_records',
] as const;

/** Research V1 is additive (research doc §29): new tables only, the nine V1 tables never change. */
const RESEARCH_TABLES = [
  'claims',
  'drift_findings',
  'entity_relations',
  'evidence',
  'manuscript_sections',
  'research_changes',
  'research_charters',
  'research_decisions',
  'research_projects',
  'research_questions',
  'timeline_events',
] as const;

/** The slice of a zod enum this file needs, kept structural so every enum fits. */
interface EnumLike {
  readonly options: readonly string[];
  safeParse(data: unknown): { success: boolean };
}

/** Each text column that carries an enum: its CHECK labels and the zod enum must agree exactly. */
const ENUM_COLUMNS: ReadonlyArray<{ table: string; column: string; schema: EnumLike }> = [
  { table: 'raw_sources', column: 'source_type', schema: sourceTypeSchema },
  { table: 'raw_sources', column: 'processing_status', schema: processingStatusSchema },
  { table: 'knowledge_items', column: 'status', schema: knowledgeItemStatusSchema },
  { table: 'knowledge_items', column: 'embedding_status', schema: embeddingStatusSchema },
  { table: 'knowledge_nodes', column: 'status', schema: nodeStatusSchema },
  { table: 'knowledge_nodes', column: 'embedding_status', schema: embeddingStatusSchema },
  { table: 'knowledge_nodes', column: 'mastery_level', schema: masteryLevelSchema },
  { table: 'knowledge_edges', column: 'relation_type', schema: edgeRelationSchema },
  { table: 'item_node_links', column: 'relation_type', schema: itemLinkRelationSchema },
  { table: 'version_records', column: 'entity_type', schema: versionedEntitySchema },
  { table: 'version_records', column: 'operation', schema: structureOperationSchema },
  { table: 'conversations', column: 'scope', schema: contextScopeSchema },
  { table: 'conversation_messages', column: 'role', schema: conversationRoleSchema },
  { table: 'research_projects', column: 'status', schema: researchProjectStatusSchema },
  { table: 'research_questions', column: 'status', schema: researchQuestionStatusSchema },
  { table: 'evidence', column: 'type', schema: evidenceTypeSchema },
  { table: 'claims', column: 'claim_type', schema: claimTypeSchema },
  { table: 'claims', column: 'status', schema: claimStatusSchema },
  { table: 'research_changes', column: 'change_type', schema: researchChangeTypeSchema },
  { table: 'drift_findings', column: 'drift_type', schema: driftTypeSchema },
  { table: 'drift_findings', column: 'severity', schema: driftSeveritySchema },
  { table: 'drift_findings', column: 'status', schema: driftFindingStatusSchema },
  { table: 'drift_findings', column: 'source_entity_type', schema: researchEntityTypeSchema },
  { table: 'drift_findings', column: 'target_entity_type', schema: researchEntityTypeSchema },
  { table: 'entity_relations', column: 'source_type', schema: researchEntityTypeSchema },
  { table: 'entity_relations', column: 'target_type', schema: researchEntityTypeSchema },
  { table: 'entity_relations', column: 'relation_type', schema: researchRelationTypeSchema },
  { table: 'timeline_events', column: 'event_type', schema: timelineEventTypeSchema },
  { table: 'timeline_events', column: 'source_type', schema: timelineSourceSchema },
];

/** Only labels quoted inside a CHECK clause count, so the comparison cannot be steered by comments. */
const CODE = migrationFiles()
  .map((file) => stripComments(readFileSync(new URL(file, MIGRATIONS), 'utf8')))
  .join('\n');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function lower(text: string): string {
  return text.toLowerCase();
}

function zodLabels(schema: EnumLike): string[] {
  return [...schema.options].sort();
}

function checkLabels(table: string, column: string): string[] {
  const pattern = new RegExp(
    `constraint ${table}_${column}_enum_check\\s+check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
    'i',
  );
  const found = pattern.exec(CODE);
  const list = found?.[1];
  if (list === undefined) {
    throw new Error(`${table}.${column} has no ${table}_${column}_enum_check CHECK clause`);
  }
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '').sort();
}

describe('supabase/migrations', () => {
  it('ships forward-only migrations in a sortable order', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      const sql = lower(stripComments(readFileSync(new URL(file, MIGRATIONS), 'utf8')));
      // Forward-only: nothing shipped here may destroy data or roll a schema back.
      for (const forbidden of ['drop table', 'drop schema', 'drop database', 'truncate ', 'delete from', 'drop index']) {
        expect(sql, `${file} contains "${forbidden.trim()}"`).not.toContain(forbidden);
      }
    }
  });

  it('creates the nine V1 tables', () => {
    const sql = lower(CODE);
    expect(NINE_TABLES).toHaveLength(9);
    for (const table of NINE_TABLES) {
      expect(sql, `missing table ${table}`).toContain(`create table if not exists public.${table}`);
    }
  });

  it('enables the vector extension before any vector column', () => {
    const sql = lower(CODE);
    expect(sql).toContain('create extension if not exists vector');
    expect(sql).toContain('create extension if not exists pg_trgm');
    expect(sql).toContain('extensions.vector(1536)');
    const files = migrationFiles();
    const extensionIndex = files.findIndex((file) =>
      lower(stripComments(readFileSync(new URL(file, MIGRATIONS), 'utf8'))).includes('create extension if not exists vector'),
    );
    const columnIndex = files.findIndex((file) =>
      lower(stripComments(readFileSync(new URL(file, MIGRATIONS), 'utf8'))).includes('extensions.vector(1536)'),
    );
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    expect(columnIndex).toBeGreaterThanOrEqual(0);
    expect(extensionIndex).toBeLessThan(columnIndex);
  });

  it('defines both semantic match functions with a clamped cosine score', () => {
    expect(CODE).toContain('function public.match_knowledge_items(');
    expect(CODE).toContain('function public.match_knowledge_nodes(');
    expect(CODE).toContain('1::double precision - (k.embedding <=> p_query_embedding)');
    expect(CODE).toContain('1::double precision - (n.embedding <=> p_query_embedding)');
    expect(CODE).toContain('p_match_threshold');
    expect(CODE).toContain('p_match_count');
    expect(CODE).toContain('p_exclude_raw_source');
    // Semantic search must not condition on the model name or on the vector width.
    const itemsFunction = /create or replace function public\.match_knowledge_items\([\s\S]*?\$\$;/.exec(CODE)?.[0] ?? '';
    expect(itemsFunction.length).toBeGreaterThan(0);
    const filterRegion = /where k\.user_id = p_user_id[\s\S]*?limit p_match_count/.exec(itemsFunction)?.[0] ?? '';
    expect(filterRegion.length).toBeGreaterThan(0);
    expect(filterRegion).not.toContain('embedding_model');
    expect(filterRegion).not.toContain('1536');
    expect(lower(CODE)).toContain('using hnsw (embedding extensions.vector_cosine_ops)');
    expect(lower(CODE)).toContain('create index if not exists knowledge_items_embedding_status_idx');
    expect(lower(CODE)).toContain("where embedding_status <> 'ready'");
  });

  it('defines one keyword function that serves Latin and CJK', () => {
    const sql = lower(CODE);
    expect(sql).toContain('create or replace function public.search_knowledge(');
    expect(sql).toContain("to_tsvector('simple'");
    expect(sql).toContain("websearch_to_tsquery('simple'");
    expect(sql).toContain('ilike');
    expect(sql).toContain('unnest(p_patterns)');
  });

  it('keeps every enum CHECK label in sync with the zod enums, in both directions', () => {
    for (const { table, column, schema } of ENUM_COLUMNS) {
      const sqlLabels = checkLabels(table, column);
      const expected = zodLabels(schema);
      // zod -> SQL: every label the domain allows is accepted by the database.
      for (const label of expected) {
        expect(sqlLabels, `${table}.${column} is missing the zod label "${label}"`).toContain(label);
      }
      // SQL -> zod: the database accepts nothing the domain does not define.
      for (const label of sqlLabels) {
        expect(expected, `${table}.${column} carries the undeclared label "${label}"`).toContain(label);
        expect(schema.safeParse(label).success, `${label} no longer parses`).toBe(true);
      }
      expect(sqlLabels).toEqual(expected);
    }
  });

  it('carries the forward-compatible data-model columns', () => {
    const sql = lower(CODE);
    expect(sql).toContain("embedding_status text not null default 'none'");
    expect(sql.match(/embedding_status text not null/g)).toHaveLength(2);
    expect(sql.match(/extensions\.vector\(1536\)/g)).toHaveLength(2);
    expect(sql.match(/embedding_model text/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain('parent_candidate_node_id text');
    expect(sql).toContain('parent_confidence double precision');
    expect(sql).toContain('mastery_level text not null default ');
    expect(sql).toContain('context_summary text');
    expect(sql).toContain('token_estimate integer');
  });

  it('protects every table with owner-scoped row level security', () => {
    const sql = lower(CODE);
    const enabled = [...sql.matchAll(/alter table public\.(\w+) enable row level security/g)]
      .map((match) => match[1] ?? '')
      .sort();
    expect(enabled).toEqual([...NINE_TABLES, ...RESEARCH_TABLES].sort());
    expect(sql.match(/create policy/g)?.length).toBeGreaterThanOrEqual(NINE_TABLES.length + RESEARCH_TABLES.length);
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('user_id = auth.uid()::text');
    expect(sql).toContain('to authenticated');
    // conversation_messages has no user_id: ownership follows the parent conversation.
    expect(sql).toContain('create policy conversation_messages_owner_write on public.conversation_messages');
    expect(sql).toContain('c.id = conversation_id');
  });

  it('indexes the access patterns Knowledge Core uses', () => {
    const sql = lower(CODE);
    expect(sql).toContain('on public.knowledge_items (user_id)');
    expect(sql).toContain('on public.knowledge_nodes (user_id, parent_id)');
    expect(sql).toContain('create unique index if not exists item_node_links_pair_uq');
    expect(sql).toContain('on public.item_node_links (item_id, node_id)');
    expect(sql).toContain('where user_id is not null');
    expect(sql).toContain('gin');
    expect(sql).toContain('gin_trgm_ops');
    expect(sql).toContain('on public.knowledge_nodes (user_id, lower(title))');
  });

  it('stamps rows with timestamptz rather than naive timestamps', () => {
    const sql = lower(CODE);
    expect(sql).toContain('timestamptz');
    expect(sql).not.toContain('timestamp without time zone');
    expect(sql).not.toContain('timestamp (');
  });
});
