/**
 * SQLite implementation of `KnowledgeRepository` — the local-desktop persistence engine.
 *
 * Semantics are the contract's, not this file's: `test/repository-contract.ts` runs the same
 * assertions against this driver, the in-memory driver and the Postgres driver, so the three agree on
 * scoping, idempotency, ordering and error codes. Where SQLite genuinely differs from Postgres the
 * difference is called out at the method.
 *
 * Every statement is prepared against bound parameters; no user-supplied string is ever concatenated
 * into SQL text.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Conversation,
  type ConversationMessage,
  type CreateRawSourceInput,
  type EdgeRelation,
  type ItemNodeLink,
  type JsonValue,
  type KnowledgeEdge,
  type KnowledgeItem,
  type KnowledgeNode,
  type ProcessingStatus,
  type RawSource,
  type UpdateNodeInput,
  type VersionRecord,
} from '@noltri/schema';
import { isKnowledgeError, knowledgeError, createId, nowIso, tokenize, uniqueTokens } from '@noltri/shared';
import { SQLITE_SCHEMA_VERSION, openSqlite, type SqlitePragmas } from './sqlite-schema';
import {
  createVectorIndex,
  type VectorCandidate,
  type VectorIndex,
  type VectorNormalization,
  type VectorOwnerType,
  type VectorScanOptions,
} from './sqlite-vectors';
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
  StorageHealth,
  VectorSearchOptions,
} from './types';

export interface SqliteRepositoryOptions {
  /** Database file, or `:memory:` for a throw-away store. */
  file: string;
  synchronous?: 'FULL' | 'NORMAL' | 'OFF';
  busyTimeoutMs?: number;
  /** Recorded on every vector row so a later re-embed can tell which builder produced it. */
  vectorBuilderVersion?: string;
  /** Set when the caller normalised the vectors before storing them. */
  vectorNormalization?: VectorNormalization;
}

export interface SqliteStorageStatus {
  driver: StorageDriverName;
  /** `memory` on a `:memory:` store — WAL is a file-level mode and cannot apply there. */
  journalMode: string;
  synchronous: string;
  schemaVersion: number;
  sqliteVersion: string;
  fts5: boolean;
  vectorInventory: Array<{ modelId: string | null; dimension: number; count: number }>;
}

const DEFAULT_VECTOR_LIMIT = 8;
const DEFAULT_KEYWORD_LIMIT = 12;
/** Candidate ceiling for a keyword lookup; the shared tokenizer re-ranks whatever comes back. */
const MAX_KEYWORD_CANDIDATES = 500;
/** Depth ceiling for the recursive ancestor walk: a knowledge tree is never this deep. */
const MAX_TREE_DEPTH = 128;

type DbRow = Record<string, unknown>;

const text = (value: unknown): string => String(value);
const optText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number => Number(value);
const optNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const bool = (value: unknown): boolean => Number(value) !== 0;

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** A stored payload that no longer parses degrades to `{}` rather than failing the whole read. */
function json(value: unknown): JsonValue {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '{}'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonValue) : {};
  } catch {
    return {};
  }
}

function toRawSource(row: DbRow): RawSource {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    rawText: text(row.raw_text),
    surroundingContext: optText(row.surrounding_context),
    sourceType: text(row.source_type) as RawSource['sourceType'],
    sourcePlatform: optText(row.source_platform),
    sourceApp: optText(row.source_app),
    sourceTitle: optText(row.source_title),
    sourceUrl: optText(row.source_url),
    capturedAt: text(row.captured_at),
    metadata: json(row.metadata_json),
    processingStatus: text(row.processing_status) as ProcessingStatus,
    errorReason: optText(row.error_reason),
    createdAt: text(row.created_at),
  };
}

function toItem(row: DbRow): KnowledgeItem {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    rawSourceId: text(row.raw_source_id),
    normalizedText: text(row.normalized_text),
    summary: optText(row.summary),
    confidence: num(row.confidence),
    status: text(row.status) as KnowledgeItem['status'],
    isAiDerived: bool(row.is_ai_derived),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toNode(row: DbRow): KnowledgeNode {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    title: text(row.title),
    summary: optText(row.summary),
    nodeType: text(row.node_type),
    parentId: optText(row.parent_id),
    status: text(row.status) as KnowledgeNode['status'],
    confidence: optNum(row.confidence),
    embeddingModel: optText(row.embedding_model),
    masteryLevel: text(row.mastery_level) as KnowledgeNode['masteryLevel'],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toEdge(row: DbRow): KnowledgeEdge {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    fromNodeId: text(row.from_node_id),
    toNodeId: text(row.to_node_id),
    relationType: text(row.relation_type) as EdgeRelation,
    confidence: optNum(row.confidence),
    source: text(row.source),
    createdAt: text(row.created_at),
  };
}

function toLink(row: DbRow): ItemNodeLink {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    itemId: text(row.item_id),
    nodeId: text(row.node_id),
    relationType: text(row.relation_type) as ItemNodeLink['relationType'],
    confidence: num(row.confidence),
    createdAt: text(row.created_at),
  };
}

function toVersion(row: DbRow): VersionRecord {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    entityType: text(row.entity_type) as VersionRecord['entityType'],
    entityId: text(row.entity_id),
    operation: text(row.operation) as VersionRecord['operation'],
    before: json(row.before_json),
    after: json(row.after_json),
    actor: text(row.actor),
    createdAt: text(row.created_at),
  };
}

function toConversation(row: DbRow): Conversation {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    nodeId: optText(row.node_id),
    scope: text(row.scope) as Conversation['scope'],
    title: optText(row.title),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toMessage(row: DbRow): ConversationMessage {
  return {
    id: text(row.id),
    conversationId: text(row.conversation_id),
    role: text(row.role) as ConversationMessage['role'],
    content: text(row.content),
    contextNodeId: optText(row.context_node_id),
    createdAt: text(row.created_at),
  };
}

const RAW_SOURCE_FIELDS = `id, user_id, raw_text, surrounding_context, source_type, source_platform,
  source_app, source_title, source_url, captured_at, metadata_json, processing_status, error_reason, created_at`;

const ITEM_FIELDS = `id, user_id, raw_source_id, normalized_text, summary, confidence, status,
  is_ai_derived, created_at, updated_at`;

const NODE_FIELDS = `id, user_id, title, summary, node_type, parent_id, status, confidence,
  embedding_model, mastery_level, created_at, updated_at`;

const EDGE_FIELDS = `id, user_id, from_node_id, to_node_id, relation_type, confidence, source, created_at`;

const LINK_FIELDS = `id, user_id, item_id, node_id, relation_type, confidence, created_at`;

const VERSION_FIELDS = `id, user_id, entity_type, entity_id, operation, before_json, after_json, actor, created_at`;

const CONVERSATION_FIELDS = `id, user_id, node_id, scope, title, created_at, updated_at`;

const MESSAGE_FIELDS = `id, conversation_id, role, content, context_node_id, created_at`;

/** FTS5 wraps a term in double quotes; doubling an inner quote is the documented escape. */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function overlapScore(queryTokens: Set<string>, document: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = uniqueTokens(document);
  if (documentTokens.length === 0) return 0;
  let shared = 0;
  for (const token of queryTokens) {
    if (documentTokens.includes(token)) shared += 1;
  }
  return shared / queryTokens.size;
}

/** Placeholder list for `in (…)`, never a concatenated value. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export class SqliteRepository implements KnowledgeRepository {
  readonly driver: StorageDriverName = 'sqlite';

  private readonly db: DatabaseSync;
  private readonly vectors: VectorIndex;
  private readonly pragmas: SqlitePragmas;
  private readonly builderVersion: string;
  private readonly normalization: VectorNormalization;
  private readonly file: string;
  private depth = 0;

  constructor(options: SqliteRepositoryOptions) {
    const opened = openSqlite({
      file: options.file,
      synchronous: options.synchronous,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    this.db = opened.db;
    this.pragmas = opened.pragmas;
    this.file = options.file;
    this.builderVersion = options.vectorBuilderVersion ?? 'sqlite-exact-v1';
    this.normalization = options.vectorNormalization ?? 'unnormalized';
    if (!this.pragmas.fts5Available) {
      throw knowledgeError(
        'storage_error',
        'SQLite 构建未包含 FTS5，无法启用关键词检索 / FTS5 is required by the sqlite driver',
        { reason: this.pragmas.fts5Error },
      );
    }
    this.vectors = createVectorIndex(this.db);
  }

  get schemaInfo(): SqlitePragmas {
    return this.pragmas;
  }

  // --- statement helpers ---------------------------------------------------------------

  private fail(context: string, cause: unknown): never {
    if (isKnowledgeError(cause)) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw knowledgeError('storage_error', `${context}失败 / sqlite ${context} failed`, { reason });
  }

  private run(sql: string, params: (number | string | null | Uint8Array)[] = []): void {
    try {
      this.db.prepare(sql).run(...params);
    } catch (cause) {
      throw this.fail('写入', cause);
    }
  }

  private one(sql: string, params: (number | string | null | Uint8Array)[] = []): DbRow | null {
    try {
      const row = this.db.prepare(sql).get(...params) as DbRow | undefined;
      return row ?? null;
    } catch (cause) {
      throw this.fail('读取', cause);
    }
  }

  private many(sql: string, params: (number | string | null | Uint8Array)[] = []): DbRow[] {
    try {
      return this.db.prepare(sql).all(...params) as DbRow[];
    } catch (cause) {
      throw this.fail('查询', cause);
    }
  }

  /**
   * `begin immediate` takes the write lock up front, so a concurrent capture from another entry point
   * waits on `busy_timeout` instead of failing halfway through the transaction.
   */
  private inTransaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.exec('begin immediate');
    this.depth = 1;
    try {
      const result = work();
      this.db.exec('commit');
      return result;
    } catch (cause) {
      try {
        this.db.exec('rollback');
      } catch {
        // A failed rollback means the connection already dropped the transaction; the cause matters more.
      }
      throw cause;
    } finally {
      this.depth = 0;
    }
  }

  // --- raw sources ---------------------------------------------------------------------

  async createRawSource(input: CreateRawSourceInput): Promise<RawSource> {
    const record: RawSource = {
      id: createId(),
      userId: input.userId,
      rawText: input.rawText,
      surroundingContext: input.surroundingContext ?? null,
      sourceType: input.sourceType,
      sourcePlatform: input.sourcePlatform ?? null,
      sourceApp: input.sourceApp ?? null,
      sourceTitle: input.sourceTitle ?? null,
      sourceUrl: input.sourceUrl ?? null,
      capturedAt: input.capturedAt,
      metadata: cloneJson(input.metadata ?? {}),
      processingStatus: 'pending',
      errorReason: null,
      createdAt: nowIso(),
    };
    this.run(
      `insert into raw_sources (id, user_id, raw_text, surrounding_context, source_type, source_platform,
         source_app, source_title, source_url, captured_at, metadata_json, processing_status, error_reason, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.userId,
        record.rawText,
        record.surroundingContext,
        record.sourceType,
        record.sourcePlatform,
        record.sourceApp,
        record.sourceTitle,
        record.sourceUrl,
        record.capturedAt,
        JSON.stringify(record.metadata),
        record.processingStatus,
        record.errorReason,
        record.createdAt,
      ],
    );
    return record;
  }

  async updateRawSourceProcessing(
    id: string,
    userId: string,
    status: ProcessingStatus,
    errorReason: string | null = null,
  ): Promise<RawSource> {
    this.run(
      `update raw_sources set processing_status = ?, error_reason = ? where id = ? and user_id = ?`,
      [status, errorReason, id, userId],
    );
    return this.mustRawSource(id, userId);
  }

  private mustRawSource(id: string, userId: string): RawSource {
    const row = this.one(`select ${RAW_SOURCE_FIELDS} from raw_sources where id = ? and user_id = ?`, [id, userId]);
    if (row === null) throw knowledgeError('not_found', `RawSource ${id} not found`);
    return toRawSource(row);
  }

  async findRawSource(id: string, userId: string): Promise<RawSource | null> {
    const row = this.one(`select ${RAW_SOURCE_FIELDS} from raw_sources where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toRawSource(row);
  }

  async listRawSourcesByIds(ids: string[], userId: string): Promise<RawSource[]> {
    if (ids.length === 0) return [];
    const rows = this.many(
      `select ${RAW_SOURCE_FIELDS} from raw_sources where user_id = ? and id in (${placeholders(ids.length)})`,
      [userId, ...ids],
    );
    const byId = new Map(rows.map((row) => [text(row.id), row]));
    // The caller's order is the display order, so re-sort in memory rather than in SQL.
    return ids.map((id) => byId.get(id)).filter((row): row is DbRow => row !== undefined).map(toRawSource);
  }

  async listInbox(userId: string, limit = 50): Promise<RawSource[]> {
    const rows = this.many(
      `select ${RAW_SOURCE_FIELDS} from raw_sources
        where user_id = ? order by created_at desc, rowid desc limit ?`,
      [userId, limit],
    );
    return rows.map(toRawSource);
  }

  // --- knowledge items -----------------------------------------------------------------

  async createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem> {
    const timestamp = nowIso();
    const id = createId();
    this.run(
      `insert into knowledge_items (id, user_id, raw_source_id, normalized_text, summary, confidence, status,
         is_ai_derived, embedding_model, embedding_status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.rawSourceId,
        input.normalizedText,
        input.summary ?? null,
        input.confidence,
        input.isAiDerived ?? true ? 1 : 0,
        input.embeddingModel ?? null,
        input.embeddingStatus ?? 'none',
        timestamp,
        timestamp,
      ],
    );
    if (input.embedding) {
      this.vectors.upsert('knowledge_item', id, input.userId, input.embedding, {
        modelId: input.embeddingModel ?? null,
        normalization: this.normalization,
        sourceText: input.normalizedText,
        builderVersion: this.builderVersion,
      }, timestamp);
    }
    this.indexKeywords('knowledge_item', id, input.userId, input.normalizedText);
    return this.mustItem(id, input.userId);
  }

  private mustItem(id: string, userId: string): KnowledgeItem {
    const row = this.one(`select ${ITEM_FIELDS} from knowledge_items where id = ? and user_id = ?`, [id, userId]);
    if (row === null) throw knowledgeError('not_found', `KnowledgeItem ${id} not found`);
    return toItem(row);
  }

  async findKnowledgeItem(id: string, userId: string): Promise<KnowledgeItem | null> {
    const row = this.one(`select ${ITEM_FIELDS} from knowledge_items where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toItem(row);
  }

  async listKnowledgeItemsByIds(ids: string[], userId: string): Promise<KnowledgeItem[]> {
    if (ids.length === 0) return [];
    const rows = this.many(
      `select ${ITEM_FIELDS} from knowledge_items where user_id = ? and id in (${placeholders(ids.length)})`,
      [userId, ...ids],
    );
    const byId = new Map(rows.map((row) => [text(row.id), row]));
    return ids.map((id) => byId.get(id)).filter((row): row is DbRow => row !== undefined).map(toItem);
  }

  async listKnowledgeItemsForSource(rawSourceId: string, userId: string): Promise<KnowledgeItem[]> {
    const rows = this.many(
      `select ${ITEM_FIELDS} from knowledge_items where user_id = ? and raw_source_id = ?
        order by created_at asc, rowid asc`,
      [userId, rawSourceId],
    );
    return rows.map(toItem);
  }

  async listKnowledgeItemsForNode(nodeId: string, userId: string): Promise<KnowledgeItem[]> {
    const rows = this.many(
      `select ${ITEM_FIELDS} from knowledge_items
        where user_id = ? and id in (select item_id from item_node_links where node_id = ? and user_id = ?)
        order by confidence desc, rowid asc`,
      [userId, nodeId, userId],
    );
    return rows.map(toItem);
  }

  async updateKnowledgeItem(
    id: string,
    userId: string,
    patch: Partial<Pick<KnowledgeItem, 'normalizedText' | 'summary' | 'confidence' | 'status'>>,
  ): Promise<KnowledgeItem> {
    const columns: string[] = [];
    const params: (number | string | null)[] = [];
    if (patch.normalizedText !== undefined) {
      columns.push('normalized_text = ?');
      params.push(patch.normalizedText);
    }
    if (patch.summary !== undefined) {
      columns.push('summary = ?');
      params.push(patch.summary);
    }
    if (patch.confidence !== undefined) {
      columns.push('confidence = ?');
      params.push(patch.confidence);
    }
    if (patch.status !== undefined) {
      columns.push('status = ?');
      params.push(patch.status);
    }
    const timestamp = nowIso();
    columns.push('updated_at = ?');
    params.push(timestamp);

    const changedText = patch.normalizedText !== undefined;
    if (changedText) {
      const before = this.one('select normalized_text from knowledge_items where id = ? and user_id = ?', [id, userId]);
      if (before === null) throw knowledgeError('not_found', `KnowledgeItem ${id} not found`);
    }

    this.run(
      `update knowledge_items set ${columns.join(', ')} where id = ? and user_id = ?`,
      [...params, id, userId],
    );
    const updated = this.mustItem(id, userId);
    if (changedText) this.indexKeywords('knowledge_item', id, userId, updated.normalizedText);
    return updated;
  }

  // --- nodes ---------------------------------------------------------------------------

  async createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode> {
    if (input.parentId) {
      const parent = this.one('select id from knowledge_nodes where id = ? and user_id = ?', [
        input.parentId,
        input.userId,
      ]);
      if (parent === null) throw knowledgeError('not_found', `Parent node ${input.parentId} not found`);
    }
    const timestamp = nowIso();
    const id = createId();
    this.run(
      `insert into knowledge_nodes (id, user_id, title, summary, node_type, parent_id, status, confidence,
         embedding_model, embedding_status, mastery_level, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'collected', ?, ?)`,
      [
        id,
        input.userId,
        input.title.trim(),
        input.summary ?? null,
        input.nodeType ?? 'topic',
        input.parentId ?? null,
        input.confidence ?? null,
        input.embeddingModel ?? null,
        input.embeddingStatus ?? 'none',
        timestamp,
        timestamp,
      ],
    );
    if (input.embedding) {
      this.vectors.upsert('knowledge_node', id, input.userId, input.embedding, {
        modelId: input.embeddingModel ?? null,
        normalization: this.normalization,
        sourceText: input.title,
        builderVersion: this.builderVersion,
      }, timestamp);
    }
    this.indexKeywords('knowledge_node', id, input.userId, `${input.title.trim()} ${input.summary ?? ''}`);
    return this.mustNode(id, input.userId);
  }

  private mustNode(id: string, userId: string): KnowledgeNode {
    const row = this.one(`select ${NODE_FIELDS} from knowledge_nodes where id = ? and user_id = ?`, [id, userId]);
    if (row === null) throw knowledgeError('not_found', `KnowledgeNode ${id} not found`);
    return toNode(row);
  }

  async findNode(id: string, userId: string): Promise<KnowledgeNode | null> {
    const row = this.one(`select ${NODE_FIELDS} from knowledge_nodes where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toNode(row);
  }

  async findNodeByTitle(userId: string, title: string, parentId?: string | null): Promise<KnowledgeNode | null> {
    const row = this.one(
      `select ${NODE_FIELDS} from knowledge_nodes
        where user_id = ? and lower(trim(title)) = ?
          and (? = 0 or parent_id is ?)
          and status <> 'archived'
        order by created_at asc, rowid asc
        limit 1`,
      [userId, title.trim().toLowerCase(), parentId !== undefined ? 1 : 0, parentId ?? null],
    );
    return row === null ? null : toNode(row);
  }

  async listNodes(userId: string, options: NodeListItemOptions = {}): Promise<KnowledgeNode[]> {
    const includeArchived = options.includeArchived ?? false;
    const rows = options.status
      ? this.many(
          `select ${NODE_FIELDS} from knowledge_nodes where user_id = ? and status = ?`,
          [userId, options.status],
        )
      : includeArchived
        ? this.many(`select ${NODE_FIELDS} from knowledge_nodes where user_id = ?`, [userId])
        : this.many(`select ${NODE_FIELDS} from knowledge_nodes where user_id = ? and status <> 'archived'`, [userId]);
    // Collation differs between engines, so title ordering is normalised in JS to match the contract.
    return rows.map(toNode).sort((first, second) => first.title.localeCompare(second.title));
  }

  async listRootNodes(userId: string): Promise<KnowledgeNode[]> {
    const rows = this.many(
      `select ${NODE_FIELDS} from knowledge_nodes
        where user_id = ? and parent_id is null and status <> 'archived'
        order by created_at asc, rowid asc`,
      [userId],
    );
    return rows.map(toNode);
  }

  async listChildNodes(userId: string, parentId: string): Promise<KnowledgeNode[]> {
    const rows = this.many(
      `select ${NODE_FIELDS} from knowledge_nodes
        where user_id = ? and parent_id = ? and status <> 'archived'`,
      [userId, parentId],
    );
    return rows.map(toNode).sort((first, second) => first.title.localeCompare(second.title));
  }

  async updateNode(patch: UpdateNodeInput): Promise<KnowledgeNode> {
    const existing = this.one('select user_id from knowledge_nodes where id = ?', [patch.id]);
    if (existing === null || text(existing.user_id) !== patch.userId) {
      throw knowledgeError('not_found', `KnowledgeNode ${patch.id} not found`);
    }
    const columns: string[] = [];
    const params: (number | string | null)[] = [];
    if (patch.title !== undefined) {
      columns.push('title = ?');
      params.push(patch.title.trim());
    }
    if (patch.summary !== undefined) {
      columns.push('summary = ?');
      params.push(patch.summary);
    }
    if (patch.status !== undefined) {
      columns.push('status = ?');
      params.push(patch.status);
    }
    if (patch.parentId !== undefined) {
      columns.push('parent_id = ?');
      params.push(patch.parentId);
    }
    if (patch.confidence !== undefined) {
      columns.push('confidence = ?');
      params.push(patch.confidence);
    }
    if (patch.embeddingModel !== undefined) {
      columns.push('embedding_model = ?');
      params.push(patch.embeddingModel);
    }
    columns.push('updated_at = ?');
    params.push(nowIso());
    this.run(
      `update knowledge_nodes set ${columns.join(', ')} where id = ? and user_id = ?`,
      [...params, patch.id, patch.userId],
    );
    if (patch.embedding) {
      const node = this.mustNode(patch.id, patch.userId);
      this.vectors.upsert(
        'knowledge_node',
        patch.id,
        patch.userId,
        patch.embedding,
        {
          modelId: patch.embeddingModel ?? node.embeddingModel,
          normalization: this.normalization,
          sourceText: node.title,
          builderVersion: this.builderVersion,
        },
        node.updatedAt,
      );
    }
    const updated = this.mustNode(patch.id, patch.userId);
    if (patch.title !== undefined || patch.summary !== undefined) {
      this.indexKeywords('knowledge_node', patch.id, patch.userId, `${updated.title} ${updated.summary ?? ''}`);
    }
    return updated;
  }

  async nodePath(userId: string, nodeId: string): Promise<PathSegment[]> {
    return this.nodePathOf(userId, nodeId);
  }

  /** Ancestors are walked one query at a time; the guard stops a cycle introduced outside moveNode. */
  private nodePathOf(userId: string, nodeId: string): PathSegment[] {
    const segments: PathSegment[] = [];
    const seen = new Set<string>();
    let cursorId: string | null = nodeId;
    for (let depth = 0; depth < MAX_TREE_DEPTH && cursorId !== null; depth += 1) {
      if (seen.has(cursorId)) break;
      seen.add(cursorId);
      const row = this.one('select id, user_id, title, parent_id from knowledge_nodes where id = ?', [cursorId]);
      if (row === null || text(row.user_id) !== userId) break;
      segments.unshift({ id: text(row.id), title: text(row.title) });
      cursorId = optText(row.parent_id);
    }
    return segments;
  }

  async moveNode(input: MoveNodeRecordInput): Promise<MoveNodeRecordResult> {
    return this.inTransaction(() => {
      const node = this.mustNode(input.nodeId, input.userId);
      if (input.targetParentId === input.nodeId) {
        throw knowledgeError('conflict', 'A node cannot be moved inside itself');
      }
      if (input.targetParentId) {
        const target = this.one('select id from knowledge_nodes where id = ? and user_id = ?', [
          input.targetParentId,
          input.userId,
        ]);
        if (target === null) throw knowledgeError('not_found', `Target node ${input.targetParentId} not found`);
        let cursorId: string | null = input.targetParentId;
        for (let depth = 0; depth < MAX_TREE_DEPTH && cursorId !== null; depth += 1) {
          if (cursorId === input.nodeId) {
            throw knowledgeError('conflict', 'Cannot move a node inside one of its own descendants');
          }
          const parent = this.one('select parent_id from knowledge_nodes where id = ?', [cursorId]);
          cursorId = parent === null ? null : optText(parent.parent_id);
        }
      }

      const timestamp = nowIso();
      this.run('update knowledge_nodes set parent_id = ?, updated_at = ? where id = ? and user_id = ?', [
        input.targetParentId,
        timestamp,
        input.nodeId,
        input.userId,
      ]);
      if (input.targetParentId) {
        this.upsertEdge({
          userId: input.userId,
          fromNodeId: input.nodeId,
          toNodeId: input.targetParentId,
          relationType: input.relationType ?? 'part_of',
          confidence: 1,
          source: 'tree_structure',
        });
      }
      const record = this.createVersionRecordSync({
        userId: input.userId,
        entityType: 'knowledge_node',
        entityId: input.nodeId,
        operation: node.parentId === null && input.targetParentId ? 'reparent' : 'move',
        before: { parentId: node.parentId },
        after: { parentId: input.targetParentId },
        actor: input.actor,
      });
      return {
        node: this.mustNode(input.nodeId, input.userId),
        versionRecordId: record.id,
        path: this.nodePathOf(input.userId, input.nodeId),
      };
    });
  }

  async nodeStats(userId: string, nodeId: string): Promise<NodeStats> {
    const items = await this.listKnowledgeItemsForNode(nodeId, userId);
    const child = this.one(
      `select count(*) as n from knowledge_nodes where user_id = ? and parent_id = ? and status <> 'archived'`,
      [userId, nodeId],
    );
    return {
      itemCount: items.length,
      sourceCount: new Set(items.map((item) => item.rawSourceId)).size,
      childCount: num(child?.n ?? 0),
    };
  }

  // --- links and edges -----------------------------------------------------------------

  async linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink> {
    const item = this.one('select user_id from knowledge_items where id = ?', [input.itemId]);
    if (item === null || text(item.user_id) !== input.userId) {
      throw knowledgeError('not_found', `KnowledgeItem ${input.itemId} not found`);
    }
    const node = this.one('select user_id from knowledge_nodes where id = ?', [input.nodeId]);
    if (node === null || text(node.user_id) !== input.userId) {
      throw knowledgeError('not_found', `KnowledgeNode ${input.nodeId} not found`);
    }
    const existing = this.one('select id, confidence from item_node_links where item_id = ? and node_id = ?', [
      input.itemId,
      input.nodeId,
    ]);
    if (existing !== null) {
      // The merge key is the pair; a weaker suggestion never overwrites a stronger one.
      const confidence = Math.max(num(existing.confidence), input.confidence);
      this.run('update item_node_links set confidence = ? where id = ?', [confidence, text(existing.id)]);
      return toLink(this.mustLinkRow(text(existing.id)));
    }
    const id = createId();
    this.run(
      `insert into item_node_links (id, user_id, item_id, node_id, relation_type, confidence, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, input.itemId, input.nodeId, input.relationType, input.confidence, nowIso()],
    );
    return toLink(this.mustLinkRow(id));
  }

  private mustLinkRow(id: string): DbRow {
    const row = this.one(`select ${LINK_FIELDS} from item_node_links where id = ?`, [id]);
    if (row === null) throw knowledgeError('storage_error', 'Link row vanished after write');
    return row;
  }

  async listLinksForItem(itemId: string, userId: string): Promise<ItemNodeLink[]> {
    const rows = this.many(`select ${LINK_FIELDS} from item_node_links where item_id = ? and user_id = ?`, [
      itemId,
      userId,
    ]);
    return rows.map(toLink);
  }

  async listLinksForNode(nodeId: string, userId: string): Promise<ItemNodeLink[]> {
    const rows = this.many(`select ${LINK_FIELDS} from item_node_links where node_id = ? and user_id = ?`, [
      nodeId,
      userId,
    ]);
    return rows.map(toLink);
  }

  async countItemsForNodes(userId: string, nodeIds: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const nodeId of nodeIds) counts[nodeId] = 0;
    if (nodeIds.length === 0) return counts;
    const rows = this.many(
      `select node_id, count(*) as n from item_node_links
        where user_id = ? and node_id in (${placeholders(nodeIds.length)})
        group by node_id`,
      [userId, ...nodeIds],
    );
    for (const row of rows) counts[text(row.node_id)] = num(row.n);
    return counts;
  }

  async createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge> {
    return this.upsertEdge(input);
  }

  private upsertEdge(input: CreateEdgeInput): KnowledgeEdge {
    const existing = this.one(
      `select ${EDGE_FIELDS} from knowledge_edges
        where user_id = ? and from_node_id = ? and to_node_id = ? and relation_type = ?`,
      [input.userId, input.fromNodeId, input.toNodeId, input.relationType],
    );
    if (existing !== null) return toEdge(existing);
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into knowledge_edges (id, user_id, from_node_id, to_node_id, relation_type, confidence, source, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.fromNodeId,
        input.toNodeId,
        input.relationType,
        input.confidence ?? null,
        input.source,
        timestamp,
      ],
    );
    const row = this.one(`select ${EDGE_FIELDS} from knowledge_edges where id = ?`, [id]);
    if (row === null) throw knowledgeError('storage_error', 'Edge row vanished after write');
    return toEdge(row);
  }

  async findEdge(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: EdgeRelation,
  ): Promise<KnowledgeEdge | null> {
    const row = this.one(
      `select ${EDGE_FIELDS} from knowledge_edges
        where user_id = ? and from_node_id = ? and to_node_id = ? and relation_type = ?`,
      [userId, fromNodeId, toNodeId, relationType],
    );
    return row === null ? null : toEdge(row);
  }

  async listEdgesForNode(userId: string, nodeId: string): Promise<KnowledgeEdge[]> {
    const rows = this.many(
      `select ${EDGE_FIELDS} from knowledge_edges where user_id = ? and (from_node_id = ? or to_node_id = ?)`,
      [userId, nodeId, nodeId],
    );
    return rows.map(toEdge);
  }

  // --- search --------------------------------------------------------------------------

  async searchSimilarItems(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<ItemVectorMatch[]> {
    const limit = options.limit ?? DEFAULT_VECTOR_LIMIT;
    const where = ["e.user_id = ?", "e.status <> 'archived'"];
    const params: (number | string | null)[] = [userId];
    if (options.excludeRawSourceId) {
      where.push('e.raw_source_id <> ?');
      params.push(options.excludeRawSourceId);
    }
    const owned = this.searchVectors('knowledge_item', userId, embedding, {
      limit,
      threshold: options.threshold ?? 0,
      onOwner: { where: where.map((clause) => `and ${clause}`).join(' '), params },
    });
    if (owned.length === 0) return [];
    const ids = owned.map((candidate) => candidate.ownerId);
    const rows = this.many(
      `select ${ITEM_FIELDS} from knowledge_items where user_id = ? and id in (${placeholders(ids.length)})`,
      [userId, ...ids],
    );
    const byId = new Map(rows.map((row) => [text(row.id), row]));
    const result: ItemVectorMatch[] = [];
    for (const candidate of owned) {
      const row = byId.get(candidate.ownerId);
      if (row === undefined) continue;
      result.push({
        itemId: candidate.ownerId,
        rawSourceId: text(row.raw_source_id),
        nodeId: this.primaryNodeOf(candidate.ownerId, userId),
        text: text(row.normalized_text),
        score: candidate.score,
      });
    }
    return result;
  }

  async searchSimilarNodes(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<NodeVectorMatch[]> {
    const limit = options.limit ?? DEFAULT_VECTOR_LIMIT;
    const owned = this.searchVectors('knowledge_node', userId, embedding, {
      limit,
      threshold: options.threshold ?? 0,
      onOwner: { where: `and e.user_id = ? and e.status <> 'archived'`, params: [userId] },
    });
    const matches: NodeVectorMatch[] = [];
    for (const candidate of owned) {
      const node = this.findNodeSync(candidate.ownerId, userId);
      if (node === null) continue;
      matches.push({
        nodeId: node.id,
        title: node.title,
        path: this.nodePathOf(userId, node.id),
        score: candidate.score,
      });
    }
    return matches;
  }

  /** Vector failures arrive as raw SQLite errors; the rest of the API surface speaks KnowledgeError. */
  private searchVectors(
    ownerType: VectorOwnerType,
    userId: string,
    query: number[],
    options: VectorScanOptions,
  ): VectorCandidate[] {
    try {
      return this.vectors.search(ownerType, userId, query, options);
    } catch (cause) {
      throw this.fail('向量检索', cause);
    }
  }

  private findNodeSync(id: string, userId: string): KnowledgeNode | null {
    const row = this.one(`select ${NODE_FIELDS} from knowledge_nodes where id = ? and user_id = ?`, [id, userId]);
    return row === null ? null : toNode(row);
  }

  private primaryNodeOf(itemId: string, userId: string): string | null {
    const row = this.one(
      `select node_id from item_node_links
        where item_id = ? and user_id = ?
        order by confidence desc, created_at asc, rowid asc
        limit 1`,
      [itemId, userId],
    );
    return row === null ? null : text(row.node_id);
  }

  private indexKeywords(
    entityType: VectorOwnerType,
    entityId: string,
    userId: string,
    document: string,
  ): void {
    const terms = tokenize(document);
    this.run('delete from keyword_index where entity_id = ? and entity_type = ?', [entityId, entityType]);
    if (terms.length === 0) return;
    this.run(
      `insert into keyword_index (entity_id, entity_type, user_id, tokens) values (?, ?, ?, ?)`,
      [entityId, entityType, userId, terms.join(' ')],
    );
  }

  async searchKeyword(userId: string, query: string, options: { limit?: number } = {}): Promise<KeywordMatch[]> {
    const limit = options.limit ?? DEFAULT_KEYWORD_LIMIT;
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];
    // OR over the same bigram/word terms the indexer wrote: one shared token is enough to be a candidate.
    // Uppercase: FTS5 only recognises AND/OR/NOT as operators in that form.
    const match = [...queryTokens].map(ftsPhrase).join(' OR ');
    const rows = this.many(
      `select entity_id as id, entity_type as kind from keyword_index
        where keyword_index match ? and user_id = ?
        order by rank limit ?`,
      [match, userId, MAX_KEYWORD_CANDIDATES],
    );

    const itemIds = rows.filter((row) => text(row.kind) === 'knowledge_item').map((row) => text(row.id));
    const nodeIds = rows.filter((row) => text(row.kind) === 'knowledge_node').map((row) => text(row.id));
    const matches: KeywordMatch[] = [];

    if (itemIds.length > 0) {
      const items = this.many(
        `select ${ITEM_FIELDS} from knowledge_items
          where user_id = ? and status = 'active' and id in (${placeholders(itemIds.length)})`,
        [userId, ...itemIds],
      );
      for (const row of items) {
        const score = overlapScore(queryTokens, text(row.normalized_text));
        if (score <= 0) continue;
        matches.push({
          itemId: text(row.id),
          nodeId: this.primaryNodeOf(text(row.id), userId),
          title: optText(row.summary) ?? text(row.normalized_text).slice(0, 40),
          text: text(row.normalized_text),
          score,
        });
      }
    }

    if (nodeIds.length > 0) {
      const nodes = this.many(
        `select ${NODE_FIELDS} from knowledge_nodes
          where user_id = ? and status <> 'archived' and id in (${placeholders(nodeIds.length)})`,
        [userId, ...nodeIds],
      );
      for (const row of nodes) {
        const score = overlapScore(queryTokens, `${text(row.title)} ${optText(row.summary) ?? ''}`);
        if (score <= 0) continue;
        matches.push({
          itemId: null,
          nodeId: text(row.id),
          title: text(row.title),
          text: optText(row.summary) ?? '',
          score,
        });
      }
    }

    return matches.sort((first, second) => second.score - first.score).slice(0, limit);
  }

  // --- versions, conversations ---------------------------------------------------------

  async createVersionRecord(input: CreateVersionRecordInput): Promise<VersionRecord> {
    return this.createVersionRecordSync(input);
  }

  private createVersionRecordSync(input: CreateVersionRecordInput): VersionRecord {
    const id = createId();
    this.run(
      `insert into version_records (id, user_id, entity_type, entity_id, operation, before_json, after_json, actor, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.entityType,
        input.entityId,
        input.operation,
        JSON.stringify(input.before ?? {}),
        JSON.stringify(input.after ?? {}),
        input.actor,
        nowIso(),
      ],
    );
    const row = this.one(`select ${VERSION_FIELDS} from version_records where id = ?`, [id]);
    if (row === null) throw knowledgeError('storage_error', 'Version row vanished after write');
    return toVersion(row);
  }

  async listVersionRecords(userId: string, entityId?: string): Promise<VersionRecord[]> {
    const rows = entityId
      ? this.many(
          `select ${VERSION_FIELDS} from version_records where user_id = ? and entity_id = ?
            order by created_at desc, rowid desc`,
          [userId, entityId],
        )
      : this.many(
          `select ${VERSION_FIELDS} from version_records where user_id = ? order by created_at desc, rowid desc`,
          [userId],
        );
    return rows.map(toVersion);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const timestamp = nowIso();
    const id = createId();
    this.run(
      `insert into conversations (id, user_id, node_id, scope, title, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, input.nodeId, input.scope, input.title ?? null, timestamp, timestamp],
    );
    return this.mustConversation(id, input.userId);
  }

  private mustConversation(id: string, userId: string): Conversation {
    const row = this.one(`select ${CONVERSATION_FIELDS} from conversations where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    if (row === null) throw knowledgeError('not_found', `Conversation ${id} not found`);
    return toConversation(row);
  }

  async findConversation(id: string, userId: string): Promise<Conversation | null> {
    const row = this.one(`select ${CONVERSATION_FIELDS} from conversations where id = ? and user_id = ?`, [
      id,
      userId,
    ]);
    return row === null ? null : toConversation(row);
  }

  async listConversations(userId: string, nodeId?: string): Promise<Conversation[]> {
    const rows = nodeId
      ? this.many(
          `select ${CONVERSATION_FIELDS} from conversations where user_id = ? and node_id = ?
            order by updated_at desc, rowid desc`,
          [userId, nodeId],
        )
      : this.many(
          `select ${CONVERSATION_FIELDS} from conversations where user_id = ? order by updated_at desc, rowid desc`,
          [userId],
        );
    return rows.map(toConversation);
  }

  async addMessage(input: AddMessageInput): Promise<ConversationMessage> {
    const conversation = this.one('select id, node_id from conversations where id = ? and user_id = ?', [
      input.conversationId,
      input.userId,
    ]);
    const inherited = optText(conversation?.node_id);
    if (conversation === null) {
      throw knowledgeError('not_found', `Conversation ${input.conversationId} not found`);
    }
    const timestamp = nowIso();
    const id = createId();
    this.run(
      `insert into conversation_messages (id, conversation_id, role, content, context_node_id, created_at)
       values (?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, input.role, input.content, input.contextNodeId ?? inherited, timestamp],
    );
    this.run('update conversations set updated_at = ? where id = ?', [timestamp, input.conversationId]);
    const row = this.one(`select ${MESSAGE_FIELDS} from conversation_messages where id = ?`, [id]);
    if (row === null) throw knowledgeError('storage_error', 'Message row vanished after write');
    return toMessage(row);
  }

  async listMessages(conversationId: string, userId: string): Promise<ConversationMessage[]> {
    const conversation = this.one('select id from conversations where id = ? and user_id = ?', [
      conversationId,
      userId,
    ]);
    if (conversation === null) return [];
    const rows = this.many(
      `select ${MESSAGE_FIELDS} from conversation_messages where conversation_id = ?
        order by created_at asc, rowid asc`,
      [conversationId],
    );
    return rows.map(toMessage);
  }

  // --- lifecycle and local-only extras -------------------------------------------------

  /** What the engine actually got, so the UI never claims a capability this build does not have. */
  storageStatus(): SqliteStorageStatus {
    return {
      driver: this.driver,
      journalMode: this.pragmas.journalMode,
      synchronous: this.pragmas.synchronous,
      schemaVersion: this.pragmas.schemaVersion,
      sqliteVersion: this.pragmas.sqliteVersion,
      fts5: this.pragmas.fts5Available,
      vectorInventory: this.vectorInventory(),
    };
  }

  /**
   * The profile on disk is the user's own, so row totals are theirs to see — this is what the desktop
   * connection panel reads. Only the file name is reported, never the absolute path, because health is
   * reachable before any credential exists and a path names the account. `verify()` is deliberately not
   * called here: an integrity check scans the whole library and belongs to the restore path.
   */
  storageHealth(): StorageHealth {
    const inventory = this.vectorInventory();
    return {
      driver: 'sqlite',
      ok: this.pragmas.fts5Available && this.pragmas.schemaVersion === SQLITE_SCHEMA_VERSION,
      detail: {
        fileName: path.basename(this.file),
        journalMode: this.pragmas.journalMode,
        synchronous: this.pragmas.synchronous,
        busyTimeoutMs: this.pragmas.busyTimeout,
        schemaVersion: this.pragmas.schemaVersion,
        expectedSchemaVersion: SQLITE_SCHEMA_VERSION,
        sqliteVersion: this.pragmas.sqliteVersion,
        fts5: this.pragmas.fts5Available,
        rawSources: this.countRows('raw_sources'),
        knowledgeItems: this.countRows('knowledge_items'),
        knowledgeNodes: this.countRows('knowledge_nodes'),
        vectors: inventory.reduce((total, entry) => total + entry.count, 0),
        vectorWidths: inventory.map((entry) => `${String(entry.dimension)}×${String(entry.count)}`).join(' '),
      },
    };
  }

  /** Table names are a literal union, never a value that came from a caller. */
  private countRows(table: 'raw_sources' | 'knowledge_items' | 'knowledge_nodes'): number {
    const row = this.one(`select count(*) as total from ${table}`);
    return row === null ? 0 : num(row.total);
  }

  /** Distinct (model, width) pairs held locally — the guard against silently mixing dimensions. */
  vectorInventory(): Array<{ modelId: string | null; dimension: number; count: number }> {
    return this.many(
      `select model_id as model_id, dimension as dimension, count(*) as count
         from vectors group by model_id, dimension order by dimension, model_id`,
    ).map((row) => ({
      modelId: optText(row.model_id),
      dimension: num(row.dimension),
      count: num(row.count),
    }));
  }

  /** Integrity check used before a restore is promoted over a live profile. */
  verify(): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    try {
      const rows = this.many('pragma integrity_check');
      for (const row of rows) {
        const value = text(Object.values(row)[0] ?? '');
        if (value !== 'ok') errors.push(value);
      }
      for (const row of this.many('pragma foreign_key_check')) {
        errors.push(`foreign_key_check ${JSON.stringify(row)}`);
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }
    return { ok: errors.length === 0, errors };
  }

  /** Consistent snapshot via the SQLite backup API — a copied `.sqlite` alone would miss the WAL. */
  async backupTo(destination: string): Promise<void> {
    const { backup } = await import('node:sqlite');
    await backup(this.db, destination);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createSqliteRepository(options: SqliteRepositoryOptions): Promise<SqliteRepository> {
  return new SqliteRepository(options);
}
