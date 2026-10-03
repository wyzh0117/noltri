import {
  conversationRoleSchema,
  contextScopeSchema,
  edgeRelationSchema,
  embeddingStatusSchema,
  itemLinkRelationSchema,
  knowledgeItemStatusSchema,
  masteryLevelSchema,
  nodeStatusSchema,
  processingStatusSchema,
  sourceTypeSchema,
  structureOperationSchema,
  versionedEntitySchema,
} from '@noltri/schema';
import type {
  Conversation,
  ConversationMessage,
  CreateRawSourceInput,
  EdgeRelation,
  EmbeddingStatus,
  ItemNodeLink,
  JsonValue,
  KnowledgeEdge,
  KnowledgeItem,
  KnowledgeNode,
  ProcessingStatus,
  RawSource,
  UpdateNodeInput,
  VersionRecord,
} from '@noltri/schema';
import { createId, isKnowledgeError, knowledgeError, nowIso, tokenize, uniqueTokens } from '@noltri/shared';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type {
  AddMessageInput,
  CreateConversationInput,
  CreateEdgeInput,
  CreateKnowledgeItemRecordInput,
  CreateNodeRecordInput,
  CreateVersionRecordInput,
  ItemVectorMatch,
  KeywordMatch,
  KnowledgeRepository,
  LinkItemInput,
  MoveNodeRecordInput,
  MoveNodeRecordResult,
  NodeListItemOptions,
  NodeStats,
  NodeVectorMatch,
  PathSegment,
  StorageDriverName,
  VectorSearchOptions,
} from './types';

export interface SupabaseRepositoryOptions {
  /** Postgres wire string: Supabase session pooler or DIRECT_URL for migrations/tests. */
  databaseUrl: string;
  /** Must equal the vector column width created by the migrations. */
  embeddingDim: number;
  statementTimeoutMs?: number;
  maxConnections?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS = 5;
const DEFAULT_VECTOR_LIMIT = 8;
const DEFAULT_KEYWORD_LIMIT = 12;
const MAX_KEYWORD_CANDIDATES = 500;
/** Depth ceiling for the recursive ancestor walk: a knowledge tree is never this deep. */
const MAX_TREE_DEPTH = 128;

type DbRow = Record<string, unknown>;
type Parser<T> = { parse(data: unknown): T };

/** Column lists are written out instead of "select *" so a drifted migration is caught here. */
const RAW_SOURCE_COLUMNS = [
  'id', 'user_id', 'raw_text', 'surrounding_context', 'source_type', 'source_platform', 'source_app',
  'source_title', 'source_url', 'captured_at', 'metadata_json', 'processing_status', 'error_reason', 'created_at',
] as const;
const RAW_SOURCE_FIELDS = RAW_SOURCE_COLUMNS.join(', ');

const ITEM_COLUMNS = [
  'id', 'user_id', 'raw_source_id', 'normalized_text', 'summary', 'confidence', 'status', 'is_ai_derived',
  'created_at', 'updated_at',
] as const;
const ITEM_FIELDS = ITEM_COLUMNS.join(', ');

const NODE_COLUMNS = [
  'id', 'user_id', 'title', 'summary', 'node_type', 'parent_id', 'status', 'confidence', 'embedding_model',
  'mastery_level', 'created_at', 'updated_at',
] as const;
const NODE_FIELDS = NODE_COLUMNS.join(', ');

const EDGE_COLUMNS = [
  'id', 'user_id', 'from_node_id', 'to_node_id', 'relation_type', 'confidence', 'source', 'created_at',
] as const;
const EDGE_FIELDS = EDGE_COLUMNS.join(', ');

const LINK_COLUMNS = [
  'id', 'user_id', 'item_id', 'node_id', 'relation_type', 'confidence', 'created_at',
] as const;
const LINK_FIELDS = LINK_COLUMNS.join(', ');

const VERSION_COLUMNS = [
  'id', 'user_id', 'entity_type', 'entity_id', 'operation', 'before_json', 'after_json', 'actor', 'created_at',
] as const;
const VERSION_FIELDS = VERSION_COLUMNS.join(', ');

const CONVERSATION_COLUMNS = ['id', 'user_id', 'node_id', 'scope', 'title', 'created_at', 'updated_at'] as const;
const CONVERSATION_FIELDS = CONVERSATION_COLUMNS.join(', ');

const MESSAGE_COLUMNS = ['id', 'conversation_id', 'role', 'content', 'context_node_id', 'created_at'] as const;
const MESSAGE_FIELDS = MESSAGE_COLUMNS.join(', ');

const MATCH_ITEM_COLUMNS = [
  'item_id', 'raw_source_id', 'node_id', 'normalized_text', 'summary', 'embedding_model', 'similarity',
] as const;
const MATCH_NODE_COLUMNS = ['node_id', 'title', 'summary', 'embedding_model', 'similarity'] as const;
const KEYWORD_COLUMNS = ['item_id', 'node_id', 'title', 'content', 'score'] as const;
const PATH_COLUMNS = ['node_id', 'segment_ids', 'segment_titles'] as const;
const STATS_COLUMNS = ['item_count', 'source_count', 'child_count'] as const;
const COUNT_COLUMNS = ['node_id', 'item_count'] as const;
const HITS_COLUMNS = ['hits'] as const;

const PATH_SQL = `
  with recursive up as (
    select n.id as node_id, n.id as origin, n.parent_id, n.title, 0 as depth
    from public.knowledge_nodes n
    where n.user_id = $1 and n.id = any($2::text[])
    union
    select p.id, u.origin, p.parent_id, p.title, u.depth + 1
    from up u
    join public.knowledge_nodes p on p.user_id = $1 and p.id = u.parent_id
    where u.depth < ${String(MAX_TREE_DEPTH)}
  )
  select origin as node_id,
         array_agg(node_id order by depth desc) as segment_ids,
         array_agg(title order by depth desc) as segment_titles
  from up
  group by origin`;

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

  numberOrNull(column: string): number | null {
    return this.peek(column) === null ? null : this.number(column);
  }

  boolean(column: string): boolean {
    const value = this.peek(column);
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return this.wrong(column, 'boolean', value);
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

  stringList(column: string): string[] {
    const value = this.peek(column);
    if (!Array.isArray(value)) return this.wrong(column, 'text[]', value);
    return value.map((entry) => {
      if (typeof entry !== 'string') {
        throw knowledgeError('storage_error', `${this.table}.${column} holds non-text elements`);
      }
      return entry;
    });
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

function toRawSource(row: DbRow): RawSource {
  const r = RowAccess.of('raw_sources', RAW_SOURCE_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    rawText: r.string('raw_text'),
    surroundingContext: r.stringOrNull('surrounding_context'),
    sourceType: r.enum('source_type', sourceTypeSchema),
    sourcePlatform: r.stringOrNull('source_platform'),
    sourceApp: r.stringOrNull('source_app'),
    sourceTitle: r.stringOrNull('source_title'),
    sourceUrl: r.stringOrNull('source_url'),
    capturedAt: r.iso('captured_at'),
    metadata: r.json('metadata_json'),
    processingStatus: r.enum('processing_status', processingStatusSchema),
    errorReason: r.stringOrNull('error_reason'),
    createdAt: r.iso('created_at'),
  };
}

function toKnowledgeItem(row: DbRow): KnowledgeItem {
  const r = RowAccess.of('knowledge_items', ITEM_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    rawSourceId: r.string('raw_source_id'),
    normalizedText: r.string('normalized_text'),
    summary: r.stringOrNull('summary'),
    confidence: r.number('confidence'),
    status: r.enum('status', knowledgeItemStatusSchema),
    isAiDerived: r.boolean('is_ai_derived'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toKnowledgeNode(row: DbRow): KnowledgeNode {
  const r = RowAccess.of('knowledge_nodes', NODE_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    title: r.string('title'),
    summary: r.stringOrNull('summary'),
    nodeType: r.string('node_type'),
    parentId: r.stringOrNull('parent_id'),
    status: r.enum('status', nodeStatusSchema),
    confidence: r.numberOrNull('confidence'),
    embeddingModel: r.stringOrNull('embedding_model'),
    masteryLevel: r.enumOrNull('mastery_level', masteryLevelSchema),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toKnowledgeEdge(row: DbRow): KnowledgeEdge {
  const r = RowAccess.of('knowledge_edges', EDGE_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    fromNodeId: r.string('from_node_id'),
    toNodeId: r.string('to_node_id'),
    relationType: r.enum('relation_type', edgeRelationSchema),
    confidence: r.numberOrNull('confidence'),
    source: r.string('source'),
    createdAt: r.iso('created_at'),
  };
}

function toItemNodeLink(row: DbRow): ItemNodeLink {
  const r = RowAccess.of('item_node_links', LINK_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    itemId: r.string('item_id'),
    nodeId: r.string('node_id'),
    relationType: r.enum('relation_type', itemLinkRelationSchema),
    confidence: r.number('confidence'),
    createdAt: r.iso('created_at'),
  };
}

function toVersionRecord(row: DbRow): VersionRecord {
  const r = RowAccess.of('version_records', VERSION_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    entityType: r.enum('entity_type', versionedEntitySchema),
    entityId: r.string('entity_id'),
    operation: r.enum('operation', structureOperationSchema),
    before: r.json('before_json'),
    after: r.json('after_json'),
    actor: r.string('actor'),
    createdAt: r.iso('created_at'),
  };
}

function toConversation(row: DbRow): Conversation {
  const r = RowAccess.of('conversations', CONVERSATION_COLUMNS, row);
  return {
    id: r.string('id'),
    userId: r.string('user_id'),
    nodeId: r.stringOrNull('node_id'),
    scope: r.enum('scope', contextScopeSchema),
    title: r.stringOrNull('title'),
    createdAt: r.iso('created_at'),
    updatedAt: r.iso('updated_at'),
  };
}

function toConversationMessage(row: DbRow): ConversationMessage {
  const r = RowAccess.of('conversation_messages', MESSAGE_COLUMNS, row);
  return {
    id: r.string('id'),
    conversationId: r.string('conversation_id'),
    role: r.enum('role', conversationRoleSchema),
    content: r.string('content'),
    contextNodeId: r.stringOrNull('context_node_id'),
    createdAt: r.iso('created_at'),
  };
}

function toItemMatch(row: DbRow): ItemVectorMatch {
  const r = RowAccess.of('match_knowledge_items', MATCH_ITEM_COLUMNS, row);
  return {
    itemId: r.string('item_id'),
    rawSourceId: r.string('raw_source_id'),
    nodeId: r.stringOrNull('node_id'),
    text: r.string('normalized_text'),
    score: clampUnit(r.number('similarity')),
  };
}

function toNodeMatch(row: DbRow): { nodeId: string; title: string; score: number } {
  const r = RowAccess.of('match_knowledge_nodes', MATCH_NODE_COLUMNS, row);
  return {
    nodeId: r.string('node_id'),
    title: r.string('title'),
    score: clampUnit(r.number('similarity')),
  };
}

function toKeywordRow(row: DbRow): { itemId: string | null; nodeId: string | null; title: string; text: string } {
  const r = RowAccess.of('search_knowledge', KEYWORD_COLUMNS, row);
  return {
    itemId: r.stringOrNull('item_id'),
    nodeId: r.stringOrNull('node_id'),
    title: r.string('title'),
    text: r.string('content'),
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function intParam(value: number | undefined, fallback: number): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.trunc(raw));
}

function thresholdParam(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return value;
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

/**
 * pgvector only accepts "[f,f,...]". The literal is assembled from validated finite numbers, so no
 * caller-controlled text ever reaches the SQL string.
 */
function vectorLiteral(embedding: number[] | undefined, dim: number): string | null {
  if (embedding === undefined) return null;
  if (!Array.isArray(embedding) || embedding.length !== dim) {
    throw knowledgeError(
      'invalid_request',
      `embedding must carry exactly ${String(dim)} components, received ${String(Array.isArray(embedding) ? embedding.length : 'a non-array')}`,
    );
  }
  const components: string[] = [];
  for (const component of embedding) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw knowledgeError('invalid_request', 'embedding carries a non-finite component');
    }
    components.push(component.toString(10));
  }
  return `[${components.join(',')}]`;
}

function escapeLike(token: string): string {
  return `%${token.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * embedding_status is only ever what the caller stated: it is never derived from embedding_model or
 * from whether the vector is null, so an unstated status leaves the column at its 'none' default.
 */
function statusParam(status: EmbeddingStatus | undefined): EmbeddingStatus | null {
  if (status === undefined) return null;
  const parsed = embeddingStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw knowledgeError('invalid_request', `unknown embedding status ${describe(status)}`);
  }
  return parsed.data;
}

/** Mirrors overlapScore() in InMemoryRepository so both drivers rank identically. */
function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = uniqueTokens(text);
  if (documentTokens.length === 0) return 0;
  let shared = 0;
  for (const token of queryTokens) {
    if (documentTokens.includes(token)) shared += 1;
  }
  return shared / queryTokens.size;
}

export class SupabaseRepository implements KnowledgeRepository {
  readonly driver: StorageDriverName = 'supabase';

  private readonly pool: Pool;
  private readonly embeddingDim: number;
  private readonly statementTimeoutMs: number;

  constructor(options: SupabaseRepositoryOptions) {
    if (typeof options.databaseUrl !== 'string' || options.databaseUrl.trim().length === 0) {
      throw knowledgeError('invalid_request', 'SupabaseRepository requires a databaseUrl');
    }
    if (!Number.isInteger(options.embeddingDim) || options.embeddingDim <= 0) {
      throw knowledgeError('invalid_request', `embeddingDim must be a positive integer, received ${String(options.embeddingDim)}`);
    }
    const timeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw knowledgeError('invalid_request', 'statementTimeoutMs must be a positive number of milliseconds');
    }
    const max = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    if (!Number.isInteger(max) || max <= 0) {
      throw knowledgeError('invalid_request', 'maxConnections must be a positive integer');
    }
    this.embeddingDim = options.embeddingDim;
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

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw asStorageError(error);
    });
    try {
      await client.query('begin');
      // SET LOCAL with a bind parameter is impossible, so set_config() supplies the value instead.
      await client.query("select set_config('statement_timeout', $1, true)", [String(this.statementTimeoutMs)]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw asStorageError(error);
    } finally {
      client.release();
    }
  }

  private async vectorOf(embedding: number[] | undefined): Promise<string | null> {
    return vectorLiteral(embedding, this.embeddingDim);
  }

  private async listScoped<T extends { id: string }>(
    table: 'raw_sources' | 'knowledge_items' | 'knowledge_nodes' | 'conversations',
    ids: string[],
    userId: string,
    fields: string,
    mapper: (row: DbRow) => T,
    client?: PoolClient,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const rows = await this.rows(
      `select ${fields} from public.${table} where user_id = $1 and id = any($2::text[])`,
      [userId, ids],
      client,
    );
    const byId = new Map<string, T>();
    for (const row of rows) {
      const entity = mapper(row);
      byId.set(entity.id, entity);
    }
    const found: T[] = [];
    for (const id of ids) {
      const entity = byId.get(id);
      if (entity !== undefined) found.push(entity);
    }
    return found;
  }

  async createRawSource(input: CreateRawSourceInput): Promise<RawSource> {
    const row = await this.mustRow(
      `insert into public.raw_sources
         (id, user_id, raw_text, surrounding_context, source_type, source_platform, source_app,
          source_title, source_url, captured_at, metadata_json, processing_status, error_reason, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending', null, $12)
       returning ${RAW_SOURCE_FIELDS}`,
      [
        createId(),
        input.userId,
        input.rawText,
        input.surroundingContext ?? null,
        input.sourceType,
        input.sourcePlatform ?? null,
        input.sourceApp ?? null,
        input.sourceTitle ?? null,
        input.sourceUrl ?? null,
        input.capturedAt,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      ],
      'inserted RawSource is missing',
    );
    return toRawSource(row);
  }

  async updateRawSourceProcessing(
    id: string,
    userId: string,
    status: ProcessingStatus,
    errorReason: string | null = null,
  ): Promise<RawSource> {
    const row = await this.mustRow(
      `update public.raw_sources
         set processing_status = $3, error_reason = $4
       where id = $1 and user_id = $2
       returning ${RAW_SOURCE_FIELDS}`,
      [id, userId, status, errorReason ?? null],
      `RawSource ${id} not found`,
    );
    return toRawSource(row);
  }

  async findRawSource(id: string, userId: string): Promise<RawSource | null> {
    const row = await this.oneRow(
      `select ${RAW_SOURCE_FIELDS} from public.raw_sources where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toRawSource(row);
  }

  async listRawSourcesByIds(ids: string[], userId: string): Promise<RawSource[]> {
    return this.listScoped('raw_sources', ids, userId, RAW_SOURCE_FIELDS, toRawSource);
  }

  async createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem> {
    const embedding = await this.vectorOf(input.embedding);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.knowledge_items
         (id, user_id, raw_source_id, normalized_text, summary, confidence, status, is_ai_derived,
          embedding, embedding_model, embedding_status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'active', $7, $8::extensions.vector, $9, coalesce($10::text, 'none'), $11, $11)
       returning ${ITEM_FIELDS}`,
      [
        createId(),
        input.userId,
        input.rawSourceId,
        input.normalizedText,
        input.summary ?? null,
        input.confidence,
        input.isAiDerived ?? true,
        embedding,
        input.embeddingModel ?? null,
        statusParam(input.embeddingStatus),
        timestamp,
      ],
      'inserted KnowledgeItem is missing',
    );
    return toKnowledgeItem(row);
  }

  async findKnowledgeItem(id: string, userId: string): Promise<KnowledgeItem | null> {
    const row = await this.oneRow(
      `select ${ITEM_FIELDS} from public.knowledge_items where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toKnowledgeItem(row);
  }

  async listKnowledgeItemsByIds(ids: string[], userId: string): Promise<KnowledgeItem[]> {
    return this.listScoped('knowledge_items', ids, userId, ITEM_FIELDS, toKnowledgeItem);
  }

  async listKnowledgeItemsForSource(rawSourceId: string, userId: string): Promise<KnowledgeItem[]> {
    const rows = await this.rows(
      `select ${ITEM_FIELDS} from public.knowledge_items
       where user_id = $1 and raw_source_id = $2
       order by created_at asc, id asc`,
      [userId, rawSourceId],
    );
    return rows.map(toKnowledgeItem);
  }

  async listKnowledgeItemsForNode(nodeId: string, userId: string): Promise<KnowledgeItem[]> {
    const rows = await this.rows(
      `select ${ITEM_FIELDS}
       from public.knowledge_items i
       join public.item_node_links l on l.item_id = i.id and l.user_id = i.user_id
       where i.user_id = $1 and l.node_id = $2
       order by i.confidence desc, i.created_at asc, i.id asc`,
      [userId, nodeId],
    );
    return rows.map(toKnowledgeItem);
  }

  async updateKnowledgeItem(
    id: string,
    userId: string,
    patch: Partial<Pick<KnowledgeItem, 'normalizedText' | 'summary' | 'confidence' | 'status'>>,
  ): Promise<KnowledgeItem> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [id, userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.normalizedText !== undefined) push('normalized_text', patch.normalizedText);
    if (patch.summary !== undefined) push('summary', patch.summary);
    if (patch.confidence !== undefined) push('confidence', patch.confidence);
    if (patch.status !== undefined) push('status', patch.status);
    const row = await this.mustRow(
      `update public.knowledge_items set ${set.join(', ')} where id = $1 and user_id = $2 returning ${ITEM_FIELDS}`,
      params,
      `KnowledgeItem ${id} not found`,
    );
    return toKnowledgeItem(row);
  }

  async createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode> {
    if (input.parentId) {
      await this.mustRow(
        'select id from public.knowledge_nodes where id = $1 and user_id = $2',
        [input.parentId, input.userId],
        `Parent node ${input.parentId} not found`,
      );
    }
    const embedding = await this.vectorOf(input.embedding);
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.knowledge_nodes
         (id, user_id, title, summary, node_type, parent_id, status, confidence,
          embedding, embedding_model, embedding_status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'active', $7, $8::extensions.vector, $9, coalesce($10::text, 'none'), $11, $11)
       returning ${NODE_FIELDS}`,
      [
        createId(),
        input.userId,
        input.title.trim(),
        input.summary ?? null,
        input.nodeType ?? 'topic',
        input.parentId ?? null,
        input.confidence ?? null,
        embedding,
        input.embeddingModel ?? null,
        statusParam(input.embeddingStatus),
        timestamp,
      ],
      'inserted KnowledgeNode is missing',
    );
    return toKnowledgeNode(row);
  }

  async findNode(id: string, userId: string): Promise<KnowledgeNode | null> {
    const row = await this.oneRow(
      `select ${NODE_FIELDS} from public.knowledge_nodes where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toKnowledgeNode(row);
  }

  async findNodeByTitle(
    userId: string,
    title: string,
    parentId?: string | null,
  ): Promise<KnowledgeNode | null> {
    const row = await this.oneRow(
      `select ${NODE_FIELDS} from public.knowledge_nodes
       where user_id = $1
         and lower(trim(title)) = $2
         and ($3::boolean = false or parent_id is not distinct from $4)
         and status <> 'archived'
       order by created_at asc, id asc
       limit 1`,
      [userId, title.trim().toLowerCase(), parentId !== undefined, parentId ?? null],
    );
    return row === null ? null : toKnowledgeNode(row);
  }

  async listNodes(userId: string, options: NodeListItemOptions = {}): Promise<KnowledgeNode[]> {
    const rows = await this.rows(
      `select ${NODE_FIELDS} from public.knowledge_nodes
       where user_id = $1
         and ($2::text is null or status = $2)
         and ($3::boolean = true or status <> 'archived')
       order by title collate "C", created_at asc, id asc`,
      [userId, options.status ?? null, options.includeArchived ?? false],
    );
    return rows.map(toKnowledgeNode);
  }

  async listRootNodes(userId: string): Promise<KnowledgeNode[]> {
    const rows = await this.rows(
      `select ${NODE_FIELDS} from public.knowledge_nodes
       where user_id = $1 and parent_id is null and status <> 'archived'
       order by created_at asc, id asc`,
      [userId],
    );
    return rows.map(toKnowledgeNode);
  }

  async listChildNodes(userId: string, parentId: string): Promise<KnowledgeNode[]> {
    const rows = await this.rows(
      `select ${NODE_FIELDS} from public.knowledge_nodes
       where user_id = $1 and parent_id = $2 and status <> 'archived'
       order by title collate "C", created_at asc, id asc`,
      [userId, parentId],
    );
    return rows.map(toKnowledgeNode);
  }

  async updateNode(patch: UpdateNodeInput): Promise<KnowledgeNode> {
    const set: string[] = ['updated_at = $3'];
    const params: unknown[] = [patch.id, patch.userId, nowIso()];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      set.push(`${column} = $${String(params.length)}`);
    };
    if (patch.title !== undefined) push('title', patch.title.trim());
    if (patch.summary !== undefined) push('summary', patch.summary);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.parentId !== undefined) push('parent_id', patch.parentId);
    if (patch.confidence !== undefined) push('confidence', patch.confidence);
    if (patch.embeddingModel !== undefined) push('embedding_model', patch.embeddingModel);
    const embedding = patch.embedding === undefined ? null : vectorLiteral(patch.embedding, this.embeddingDim);
    if (embedding !== null) {
      // A new vector says nothing about embedding_status: only an explicit write may change it.
      push('embedding', embedding);
    }
    const row = await this.mustRow(
      `update public.knowledge_nodes set ${set.join(', ')} where id = $1 and user_id = $2 returning ${NODE_FIELDS}`,
      params,
      `KnowledgeNode ${patch.id} not found`,
    );
    return toKnowledgeNode(row);
  }

  async nodePath(userId: string, nodeId: string): Promise<PathSegment[]> {
    const paths = await this.pathsFor(userId, [nodeId]);
    return paths.get(nodeId) ?? [];
  }

  private async pathsFor(userId: string, nodeIds: string[], client?: PoolClient): Promise<Map<string, PathSegment[]>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await this.rows(PATH_SQL, [userId, nodeIds], client);
    const paths = new Map<string, PathSegment[]>();
    for (const row of rows) {
      const r = RowAccess.of('knowledge_node_path', PATH_COLUMNS, row);
      const ids = r.stringList('segment_ids');
      const titles = r.stringList('segment_titles');
      paths.set(
        r.string('node_id'),
        ids.map((id, index) => ({ id, title: titles[index] ?? '' })),
      );
    }
    return paths;
  }

  async moveNode(input: MoveNodeRecordInput): Promise<MoveNodeRecordResult> {
    return this.transaction(async (client) => {
      const locked = await this.mustRow(
        `select ${NODE_FIELDS} from public.knowledge_nodes where id = $1 and user_id = $2 for update`,
        [input.nodeId, input.userId],
        `KnowledgeNode ${input.nodeId} not found`,
        client,
      );
      const beforeParentId = toKnowledgeNode(locked).parentId;
      if (input.targetParentId === input.nodeId) {
        throw knowledgeError('conflict', 'A node cannot be moved inside itself');
      }
      if (input.targetParentId) {
        await this.mustRow(
          'select id from public.knowledge_nodes where id = $1 and user_id = $2',
          [input.targetParentId, input.userId],
          `Target node ${input.targetParentId} not found`,
          client,
        );
        const walk = await this.rows(
          `with recursive up as (
             select n.id, n.parent_id, 0 as depth
             from public.knowledge_nodes n
             where n.id = $1 and n.user_id = $2
             union
             select p.id, p.parent_id, u.depth + 1
             from up u
             join public.knowledge_nodes p on p.user_id = $2 and p.id = u.parent_id
             where u.depth < ${String(MAX_TREE_DEPTH)}
           )
           select count(*)::integer as hits from up w where w.id = $3`,
          [input.targetParentId, input.userId, input.nodeId],
          client,
        );
        if (walk[0] === undefined) throw knowledgeError('storage_error', 'ancestor walk returned no row');
        const hits = RowAccess.of('move_node_cycle_probe', HITS_COLUMNS, walk[0]).number('hits');
        if (hits > 0) {
          throw knowledgeError('conflict', 'Cannot move a node inside one of its own descendants');
        }
      }

      const updated = await this.mustRow(
        `update public.knowledge_nodes set parent_id = $3, updated_at = $4
         where id = $1 and user_id = $2
         returning ${NODE_FIELDS}`,
        [input.nodeId, input.userId, input.targetParentId, nowIso()],
        `KnowledgeNode ${input.nodeId} not found`,
        client,
      );
      const node = toKnowledgeNode(updated);

      if (input.targetParentId) {
        await this.upsertEdge(
          {
            userId: input.userId,
            fromNodeId: node.id,
            toNodeId: input.targetParentId,
            relationType: input.relationType ?? 'part_of',
            confidence: 1,
            source: 'tree_structure',
          },
          client,
        );
      }

      const record = await this.insertVersionRecord(
        {
          userId: input.userId,
          entityType: 'knowledge_node',
          entityId: node.id,
          operation: beforeParentId === null && input.targetParentId !== null ? 'reparent' : 'move',
          before: { parentId: beforeParentId },
          after: { parentId: node.parentId },
          actor: input.actor,
        },
        client,
      );
      const paths = await this.pathsFor(input.userId, [node.id], client);
      return { node, versionRecordId: record.id, path: paths.get(node.id) ?? [] };
    });
  }

  async nodeStats(userId: string, nodeId: string): Promise<NodeStats> {
    const row = await this.mustRow(
      `select
         (select count(*) from public.item_node_links l
            join public.knowledge_items i on i.id = l.item_id and i.user_id = l.user_id
           where l.user_id = $1 and l.node_id = $2)::integer as item_count,
         (select count(distinct i.raw_source_id) from public.item_node_links l
            join public.knowledge_items i on i.id = l.item_id and i.user_id = l.user_id
           where l.user_id = $1 and l.node_id = $2)::integer as source_count,
         (select count(*) from public.knowledge_nodes c
           where c.user_id = $1 and c.parent_id = $2 and c.status <> 'archived')::integer as child_count`,
      [userId, nodeId],
      'node statistics row is missing',
    );
    const r = RowAccess.of('node_stats', STATS_COLUMNS, row);
    return {
      itemCount: r.number('item_count'),
      sourceCount: r.number('source_count'),
      childCount: r.number('child_count'),
    };
  }

  async linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink> {
    await this.mustRow(
      'select id from public.knowledge_items where id = $1 and user_id = $2',
      [input.itemId, input.userId],
      `KnowledgeItem ${input.itemId} not found`,
    );
    await this.mustRow(
      'select id from public.knowledge_nodes where id = $1 and user_id = $2',
      [input.nodeId, input.userId],
      `KnowledgeNode ${input.nodeId} not found`,
    );

    const mergeSql = `update public.item_node_links
       set confidence = greatest(confidence, $4)
     where user_id = $1 and item_id = $2 and node_id = $3
     returning ${LINK_FIELDS}`;
    const mergeParams = [input.userId, input.itemId, input.nodeId, input.confidence];

    const merged = await this.oneRow(mergeSql, mergeParams);
    if (merged !== null) return toItemNodeLink(merged);

    const inserted = await this.rows(
      `insert into public.item_node_links (id, user_id, item_id, node_id, relation_type, confidence, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict do nothing
       returning ${LINK_FIELDS}`,
      [createId(), input.userId, input.itemId, input.nodeId, input.relationType, input.confidence, nowIso()],
    );
    const created = inserted[0];
    if (created !== undefined) return toItemNodeLink(created);

    // A concurrent writer claimed the pair first: merge into their row instead of losing evidence.
    const raced = await this.oneRow(mergeSql, mergeParams);
    if (raced === null) throw knowledgeError('storage_error', 'item-node link vanished between insert and merge');
    return toItemNodeLink(raced);
  }

  async listLinksForItem(itemId: string, userId: string): Promise<ItemNodeLink[]> {
    const rows = await this.rows(
      `select ${LINK_FIELDS} from public.item_node_links where user_id = $1 and item_id = $2
       order by created_at asc, id asc`,
      [userId, itemId],
    );
    return rows.map(toItemNodeLink);
  }

  async listLinksForNode(nodeId: string, userId: string): Promise<ItemNodeLink[]> {
    const rows = await this.rows(
      `select ${LINK_FIELDS} from public.item_node_links where user_id = $1 and node_id = $2
       order by created_at asc, id asc`,
      [userId, nodeId],
    );
    return rows.map(toItemNodeLink);
  }

  async countItemsForNodes(userId: string, nodeIds: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const nodeId of nodeIds) counts[nodeId] = 0;
    if (nodeIds.length === 0) return counts;
    const rows = await this.rows(
      `select l.node_id, count(*)::integer as item_count
       from public.item_node_links l
       join public.knowledge_items i on i.id = l.item_id and i.user_id = l.user_id
       where l.user_id = $1 and l.node_id = any($2::text[])
       group by l.node_id`,
      [userId, nodeIds],
    );
    for (const row of rows) {
      const r = RowAccess.of('item_counts', COUNT_COLUMNS, row);
      const nodeId = r.string('node_id');
      if (Object.prototype.hasOwnProperty.call(counts, nodeId)) counts[nodeId] = r.number('item_count');
    }
    return counts;
  }

  async createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge> {
    return toKnowledgeEdge(await this.upsertEdge(input));
  }

  private async upsertEdge(input: CreateEdgeInput, client?: PoolClient): Promise<DbRow> {
    const rows = await this.rows(
      `insert into public.knowledge_edges (id, user_id, from_node_id, to_node_id, relation_type, confidence, source, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (user_id, from_node_id, to_node_id, relation_type)
       do update set id = public.knowledge_edges.id
       returning ${EDGE_FIELDS}`,
      [
        createId(),
        input.userId,
        input.fromNodeId,
        input.toNodeId,
        input.relationType,
        input.confidence ?? null,
        input.source,
        nowIso(),
      ],
      client,
    );
    const row = rows[0];
    if (row === undefined) throw knowledgeError('storage_error', 'edge upsert returned no row');
    return row;
  }

  async findEdge(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: EdgeRelation,
  ): Promise<KnowledgeEdge | null> {
    const row = await this.oneRow(
      `select ${EDGE_FIELDS} from public.knowledge_edges
       where user_id = $1 and from_node_id = $2 and to_node_id = $3 and relation_type = $4`,
      [userId, fromNodeId, toNodeId, relationType],
    );
    return row === null ? null : toKnowledgeEdge(row);
  }

  async listEdgesForNode(userId: string, nodeId: string): Promise<KnowledgeEdge[]> {
    const rows = await this.rows(
      `select ${EDGE_FIELDS} from public.knowledge_edges
       where user_id = $1 and (from_node_id = $2 or to_node_id = $2)`,
      [userId, nodeId],
    );
    return rows.map(toKnowledgeEdge);
  }

  async searchSimilarItems(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<ItemVectorMatch[]> {
    const vector = vectorLiteral(embedding, this.embeddingDim);
    if (vector === null) return [];
    const rows = await this.rows(
      `select ${MATCH_ITEM_COLUMNS.join(', ')} from public.match_knowledge_items($1, $2::extensions.vector, $3, $4, $5, $6::text[])`,
      [
        userId,
        vector,
        thresholdParam(options.threshold),
        intParam(options.limit, DEFAULT_VECTOR_LIMIT),
        options.excludeRawSourceId ?? null,
        options.statusExclude && options.statusExclude.length > 0 ? options.statusExclude : null,
      ],
    );
    return rows.map(toItemMatch);
  }

  async searchSimilarNodes(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<NodeVectorMatch[]> {
    const vector = vectorLiteral(embedding, this.embeddingDim);
    if (vector === null) return [];
    const rows = await this.rows(
      `select ${MATCH_NODE_COLUMNS.join(', ')} from public.match_knowledge_nodes($1, $2::extensions.vector, $3, $4)`,
      [userId, vector, thresholdParam(options.threshold), intParam(options.limit, DEFAULT_VECTOR_LIMIT)],
    );
    const matches = rows.map(toNodeMatch);
    const paths = await this.pathsFor(
      userId,
      matches.map((match) => match.nodeId),
    );
    return matches.map((match) => ({
      nodeId: match.nodeId,
      title: match.title,
      path: paths.get(match.nodeId) ?? [],
      score: match.score,
    }));
  }

  async searchKeyword(
    userId: string,
    query: string,
    options: { limit?: number } = {},
  ): Promise<KeywordMatch[]> {
    const limit = intParam(options.limit, DEFAULT_KEYWORD_LIMIT);
    const tokens = uniqueTokens(query);
    if (tokens.length === 0) return [];
    const rows = await this.rows(
      `select ${KEYWORD_COLUMNS.join(', ')} from public.search_knowledge($1, $2, $3::text[], $4)`,
      [userId, query, tokens.map(escapeLike), Math.min(MAX_KEYWORD_CANDIDATES, Math.max(limit * 10, limit + 48))],
    );
    const queryTokens = new Set(tokens);
    const matches: KeywordMatch[] = [];
    for (const row of rows) {
      const parsed = toKeywordRow(row);
      const haystack = parsed.itemId === null ? `${parsed.title} ${parsed.text}` : parsed.text;
      const score = overlapScore(queryTokens, haystack);
      if (score <= 0) continue;
      matches.push({
        itemId: parsed.itemId,
        nodeId: parsed.nodeId,
        title: parsed.title,
        text: parsed.text,
        score,
      });
    }
    return matches.sort((first, second) => second.score - first.score).slice(0, limit);
  }

  async createVersionRecord(input: CreateVersionRecordInput): Promise<VersionRecord> {
    return toVersionRecord(await this.insertVersionRecord(input));
  }

  private async insertVersionRecord(input: CreateVersionRecordInput, client?: PoolClient): Promise<VersionRecord> {
    const row = await this.mustRow(
      `insert into public.version_records
         (id, user_id, entity_type, entity_id, operation, before_json, after_json, actor, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       returning ${VERSION_FIELDS}`,
      [
        createId(),
        input.userId,
        input.entityType,
        input.entityId,
        input.operation,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        input.actor,
        nowIso(),
      ],
      'inserted VersionRecord is missing',
      client,
    );
    return toVersionRecord(row);
  }

  async listVersionRecords(userId: string, entityId?: string): Promise<VersionRecord[]> {
    const rows = await this.rows(
      `select ${VERSION_FIELDS} from public.version_records
       where user_id = $1 and ($2::text is null or entity_id = $2)
       order by created_at desc, id desc`,
      [userId, entityId ?? null],
    );
    return rows.map(toVersionRecord);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const timestamp = nowIso();
    const row = await this.mustRow(
      `insert into public.conversations (id, user_id, node_id, scope, title, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6)
       returning ${CONVERSATION_FIELDS}`,
      [createId(), input.userId, input.nodeId, input.scope, input.title ?? null, timestamp],
      'inserted Conversation is missing',
    );
    return toConversation(row);
  }

  async findConversation(id: string, userId: string): Promise<Conversation | null> {
    const row = await this.oneRow(
      `select ${CONVERSATION_FIELDS} from public.conversations where id = $1 and user_id = $2`,
      [id, userId],
    );
    return row === null ? null : toConversation(row);
  }

  async listConversations(userId: string, nodeId?: string): Promise<Conversation[]> {
    const rows = await this.rows(
      `select ${CONVERSATION_FIELDS} from public.conversations
       where user_id = $1 and ($2::text is null or node_id = $2)
       order by updated_at desc, created_at desc, id desc`,
      [userId, nodeId ?? null],
    );
    return rows.map(toConversation);
  }

  async addMessage(input: AddMessageInput): Promise<ConversationMessage> {
    return this.transaction(async (client) => {
      const conversation = await this.mustRow(
        'select id, node_id from public.conversations where id = $1 and user_id = $2 for update',
        [input.conversationId, input.userId],
        `Conversation ${input.conversationId} not found`,
        client,
      );
      const scope = RowAccess.of('conversation_probe', ['id', 'node_id'], conversation);
      const createdAt = nowIso();
      const message = await this.mustRow(
        `insert into public.conversation_messages (id, conversation_id, role, content, context_node_id, created_at)
         values ($1, $2, $3, $4, $5, $6)
         returning ${MESSAGE_FIELDS}`,
        [
          createId(),
          input.conversationId,
          input.role,
          input.content,
          input.contextNodeId ?? scope.stringOrNull('node_id'),
          createdAt,
        ],
        'inserted ConversationMessage is missing',
        client,
      );
      await this.rows(
        'update public.conversations set updated_at = $3 where id = $1 and user_id = $2',
        [input.conversationId, input.userId, createdAt],
        client,
      );
      return toConversationMessage(message);
    });
  }

  async listMessages(conversationId: string, userId: string): Promise<ConversationMessage[]> {
    const conversation = await this.oneRow('select id from public.conversations where id = $1 and user_id = $2', [
      conversationId,
      userId,
    ]);
    if (conversation === null) return [];
    const rows = await this.rows(
      `select ${MESSAGE_FIELDS} from public.conversation_messages
       where conversation_id = $1
       order by created_at asc, id asc`,
      [conversationId],
    );
    return rows.map(toConversationMessage);
  }
}

export function createSupabaseRepository(options: SupabaseRepositoryOptions): SupabaseRepository {
  return new SupabaseRepository(options);
}


