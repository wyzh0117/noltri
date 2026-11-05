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
  type ItemRelation,
  type JsonValue,
  type KnowledgeEdge,
  type KnowledgeItem,
  type KnowledgeNote,
  type KnowledgeNode,
  type ProcessingStatus,
  type RawSource,
  type RawSourceReviewConfirmation,
  type ReviewStatus,
  type ReviewSourceRequest,
  type ReviewSourceResponse,
  type UpdateNodeInput,
  type VersionRecord,
  type CaptureAssetMime,
  type CaptureBatchItemRequest,
  type CaptureBatchItemStatus,
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
import { captureRecognitionSnapshotSchema, captureRecognitionEntrySchema } from '@noltri/schema';
import { validateTaskRules } from './task-rules';
import { nextReviewStatus, reviewConfirmationOf, reviewIntent } from './review';
import type {
  AddMessageInput,
  CreateConversationInput,
  CreateEdgeInput,
  CreateLibraryRelationRecordInput,
  CreateKnowledgeItemRecordInput,
  CreateNodeRecordInput,
  CreateVersionRecordInput,
  ItemVectorMatch,
  KeywordMatch,
  KnowledgeRepository,
  LinkItemInput,
  ListInboxInput,
  MoveNodeRecordInput,
  MoveNodeRecordResult,
  NodeListItemOptions,
  NodeStats,
  NodeVectorMatch,
  PathSegment,
  StorageDriverName,
  CaptureBatchItemPatch,
  StoredCaptureRecognitionSnapshot,
  CreateCaptureRecognitionSnapshotInput,
  SaveCaptureRecognitionResultInput,
  CreateCaptureBatchInput,
  StoredCaptureBatch,
  StoredCaptureBatchItem,
  StoredCaptureAsset,
  PutCaptureAssetInput,
  CaptureProcessingPlan,
  CaptureProcessingPlanPoint,
  CaptureProcessingPlanPointPatch,
  ReserveCaptureProcessingPlanInput,
  CaptureReviewAuthority,
  FinishCaptureProcessingInput,
  CaptureProcessingOutcome,
  StorageHealth,
  SaveKnowledgeNoteInput,
  KnowledgeNoteIndexEntry,
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
/** Page ceiling for the capture feed; the Inbox never asks the disk for the whole library. */
const MAX_INBOX_PAGE = 200;

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
    reviewStatus: text(row.review_status) as ReviewStatus,
    reviewRevision: num(row.review_revision),
    errorReason: optText(row.error_reason),
    requestId: optText(row.request_id),
    clientId: optText(row.client_id),
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

function toKnowledgeNote(row: DbRow): KnowledgeNote {
  return {
    userId: text(row.user_id),
    topicId: text(row.topic_id),
    chapterId: optText(row.chapter_id),
    content: text(row.content),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
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

function toCaptureAsset(row: DbRow): StoredCaptureAsset {
  const bytes = row.bytes instanceof Uint8Array ? new Uint8Array(row.bytes) : new Uint8Array();
  return {
    userId: text(row.user_id),
    assetId: text(row.asset_id),
    sessionId: text(row.session_id),
    mimeType: text(row.mime_type) as CaptureAssetMime,
    sha256: text(row.sha256),
    byteLength: num(row.byte_length),
    bytes,
    createdAt: text(row.created_at),
  };
}

function toCaptureBatchItem(row: DbRow): StoredCaptureBatchItem {
  return {
    ...(JSON.parse(text(row.request_json)) as CaptureBatchItemRequest),
    status: text(row.status) as CaptureBatchItemStatus,
    rawSourceId: optText(row.raw_source_id),
    duplicate: bool(row.duplicate),
    retryable: bool(row.retryable),
    errorReason: optText(row.error_reason),
    processingReason: optText(row.processing_reason) as StoredCaptureBatchItem['processingReason'],
    updatedAt: text(row.updated_at),
  };
}

function toCaptureProcessingPlan(row: DbRow): CaptureProcessingPlan {
  let points: CaptureProcessingPlanPoint[];
  try {
    points = JSON.parse(text(row.points_json)) as CaptureProcessingPlanPoint[];
  } catch (error) {
    throw knowledgeError('storage_error', `采集冻结计划 JSON 无效 / invalid capture processing plan: ${String(error)}`);
  }
  return {
    userId: text(row.user_id),
    rawSourceId: text(row.raw_source_id),
    analysisVersion: num(row.analysis_version),
    points,
    rulesSnapshot: row.rules_snapshot_json == null ? null : validateTaskRules(JSON.parse(text(row.rules_snapshot_json))),
    extractionReady: row.extraction_ready == null || num(row.extraction_ready) === 1,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

const CAPTURE_POINT_STATUS_RANK = {
  pending: 0, decision_saved: 1, placement_saved: 2, item_saved: 3, linked: 4, complete: 5,
} as const;

function toCaptureBatch(batchRow: DbRow, itemRows: DbRow[]): StoredCaptureBatch {
  return {
    userId: text(batchRow.user_id),
    batchId: text(batchRow.batch_id),
    sessionId: text(batchRow.session_id),
    payloadHash: text(batchRow.payload_hash),
    items: itemRows.map(toCaptureBatchItem).sort((left, right) => left.userOrder - right.userOrder),
    createdAt: text(batchRow.created_at),
    updatedAt: text(batchRow.updated_at),
  };
}

const RAW_SOURCE_FIELDS = `id, user_id, raw_text, surrounding_context, source_type, source_platform,
  source_app, source_title, source_url, captured_at, metadata_json, processing_status, error_reason,
  request_id, client_id, created_at, review_status, review_revision`;

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

  private readCaptureBatch(userId: string, batchId: string): StoredCaptureBatch | null {
    const batch = this.one(
      'select user_id, batch_id, session_id, payload_hash, created_at, updated_at from capture_batches where user_id = ? and batch_id = ?',
      [userId, batchId],
    );
    if (batch === null) return null;
    const items = this.many(
      `select request_id, user_order, kind, status, request_json, raw_source_id, duplicate, retryable, error_reason, processing_reason, updated_at
       from capture_batch_items where user_id = ? and batch_id = ? order by user_order asc`,
      [userId, batchId],
    );
    return toCaptureBatch(batch, items);
  }

  async putCaptureAsset(input: PutCaptureAssetInput): Promise<{ asset: StoredCaptureAsset; duplicate: boolean }> {
    return this.inTransaction(() => {
      const existingRow = this.one(
        'select user_id, asset_id, session_id, mime_type, sha256, byte_length, bytes, created_at from capture_assets where user_id = ? and asset_id = ?',
        [input.userId, input.assetId],
      );
      if (existingRow !== null) {
        const existing = toCaptureAsset(existingRow);
        const sameBytes = existing.bytes.byteLength === input.bytes.byteLength &&
          existing.bytes.every((byte, index) => byte === input.bytes[index]);
        if (
          existing.sessionId !== input.sessionId || existing.mimeType !== input.mimeType ||
          existing.sha256 !== input.sha256 || !sameBytes
        ) {
          throw knowledgeError('conflict', 'assetId 已绑定到不同会话或内容 / assetId is already bound to different content');
        }
        return { asset: existing, duplicate: true };
      }
      const asset: StoredCaptureAsset = {
        ...input,
        bytes: new Uint8Array(input.bytes),
        byteLength: input.bytes.byteLength,
        createdAt: nowIso(),
      };
      this.run(
        `insert into capture_assets (user_id, asset_id, session_id, mime_type, sha256, byte_length, bytes, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [asset.userId, asset.assetId, asset.sessionId, asset.mimeType, asset.sha256, asset.byteLength, asset.bytes, asset.createdAt],
      );
      return { asset, duplicate: false };
    });
  }

  async getCaptureAsset(userId: string, sessionId: string, assetId: string): Promise<StoredCaptureAsset | null> {
    const row = this.one(
      `select user_id, asset_id, session_id, mime_type, sha256, byte_length, bytes, created_at
       from capture_assets where user_id = ? and session_id = ? and asset_id = ?`,
      [userId, sessionId, assetId],
    );
    return row === null ? null : toCaptureAsset(row);
  }

  async createCaptureBatch(input: CreateCaptureBatchInput): Promise<{ batch: StoredCaptureBatch; duplicate: boolean }> {
    return this.inTransaction(() => {
      const existing = this.readCaptureBatch(input.userId, input.batchId);
      if (existing !== null) {
        if (existing.sessionId !== input.sessionId || existing.payloadHash !== input.payloadHash) {
          throw knowledgeError('conflict', 'batchId 已绑定到不同请求 / batchId is already bound to a different request');
        }
        return { batch: existing, duplicate: true };
      }
      for (const item of input.items) {
        for (const assetId of item.assetIds) {
          const asset = this.one(
            'select asset_id from capture_assets where user_id = ? and session_id = ? and asset_id = ?',
            [input.userId, input.sessionId, assetId],
          );
          if (asset === null) {
            throw knowledgeError('invalid_request', `批次引用了未保存的 asset ${assetId} / batch references an unsaved asset`);
          }
        }
      }
      const createdAt = nowIso();
      this.run(
        'insert into capture_batches (user_id, batch_id, session_id, payload_hash, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
        [input.userId, input.batchId, input.sessionId, input.payloadHash, createdAt, createdAt],
      );
      for (const item of [...input.items].sort((left, right) => left.userOrder - right.userOrder)) {
        this.run(
          `insert into capture_batch_items
           (user_id, batch_id, request_id, user_order, kind, status, request_json, raw_source_id, duplicate, retryable, error_reason, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, null, 0, 0, null, ?)`,
          [input.userId, input.batchId, item.requestId, item.userOrder, item.kind, item.kind === 'text' ? 'queued' : 'assets_saved', JSON.stringify(item), createdAt],
        );
      }
      const batch = this.readCaptureBatch(input.userId, input.batchId);
      if (batch === null) throw knowledgeError('storage_error', '无法读取刚写入的采集批次 / could not read newly stored capture batch');
      return { batch, duplicate: false };
    });
  }

  async getCaptureBatch(userId: string, batchId: string): Promise<StoredCaptureBatch | null> {
    return this.readCaptureBatch(userId, batchId);
  }

  async listCaptureBatches(userId: string, limit: number): Promise<StoredCaptureBatch[]> {
    const rows = this.many(
      'select batch_id from capture_batches where user_id = ? order by updated_at desc, batch_id desc limit ?',
      [userId, limit],
    );
    return rows.flatMap((row) => {
      const batch = this.readCaptureBatch(userId, text(row.batch_id));
      return batch === null ? [] : [batch];
    });
  }

  async updateCaptureBatchItem(
    userId: string,
    batchId: string,
    requestId: string,
    patch: CaptureBatchItemPatch,
    expectedReviewRevision?: number,
  ): Promise<StoredCaptureBatch> {
    return this.inTransaction(() => {
      const batch = this.readCaptureBatch(userId, batchId);
      if (batch === null) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
      const item = batch.items.find((candidate) => candidate.requestId === requestId);
      if (item === undefined) throw knowledgeError('not_found', `批次项目 ${requestId} 不存在 / capture batch item not found`);
      const boundSourceId = patch.rawSourceId === undefined ? item.rawSourceId : patch.rawSourceId;
      if (expectedReviewRevision !== undefined && boundSourceId !== null) {
        const source = this.mustRawSource(boundSourceId, userId);
        if (source.reviewRevision !== expectedReviewRevision) patch = { rawSourceId: source.id, status: source.reviewStatus === 'confirmed' ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null };
      }
      const updatedAt = nowIso();
      const status = patch.status ?? item.status;
      const rawSourceId = patch.rawSourceId === undefined ? item.rawSourceId : patch.rawSourceId;
      const duplicate = patch.duplicate ?? item.duplicate;
      const retryable = patch.retryable ?? item.retryable;
      const errorReason = patch.errorReason === undefined ? item.errorReason : patch.errorReason;
      const processingReason = patch.processingReason === undefined ? item.processingReason : patch.processingReason;
      this.run(
        `update capture_batch_items set status = ?, raw_source_id = ?, duplicate = ?, retryable = ?, error_reason = ?, processing_reason = ?, updated_at = ?
         where user_id = ? and batch_id = ? and request_id = ?`,
        [status, rawSourceId, Number(duplicate), Number(retryable), errorReason, processingReason, updatedAt, userId, batchId, requestId],
      );
      this.run('update capture_batches set updated_at = ? where user_id = ? and batch_id = ?', [updatedAt, userId, batchId]);
      const updated = this.readCaptureBatch(userId, batchId);
      if (updated === null) throw knowledgeError('storage_error', '更新后无法读取采集批次 / could not read updated capture batch');
      return updated;
    });
  }

  async claimCaptureBatchItemForProcessing(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch> {
    return this.inTransaction(() => {
      const batch = this.readCaptureBatch(userId, batchId);
      if (batch === null) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
      const item = batch.items.find((candidate) => candidate.requestId === requestId);
      if (item === undefined) throw knowledgeError('not_found', `批次项目 ${requestId} 不存在 / capture batch item not found`);
      if (!((item.kind !== 'text' && item.status === 'assets_saved') || (item.status === 'failed' && item.retryable))) {
        throw knowledgeError('conflict', '只有可重试的失败文本项目可以重试 / only retryable failed text items can be retried');
      }
      const updatedAt = nowIso();
      this.run(
        `update capture_batch_items set status = 'processing', retryable = 0, error_reason = null, updated_at = ?
         where user_id = ? and batch_id = ? and request_id = ? and ((kind != 'text' and status = 'assets_saved') or (status = 'failed' and retryable = 1))`,
        [updatedAt, userId, batchId, requestId],
      );
      if (num(this.one('select changes() as count')?.count) !== 1) {
        throw knowledgeError('conflict', '该批次项目已被处理或重试 / batch item is already being processed or retried');
      }
      this.run('update capture_batches set updated_at = ? where user_id = ? and batch_id = ?', [updatedAt, userId, batchId]);
      const updated = this.readCaptureBatch(userId, batchId);
      if (updated === null) throw knowledgeError('storage_error', '更新后无法读取采集批次 / could not read updated capture batch');
      return updated;
    });
  }

  async claimCaptureBatchItemForRetry(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch> {
    const batch = this.readCaptureBatch(userId, batchId);
    if (!batch) throw knowledgeError('not_found', 'Capture batch not found');
    const item = batch.items.find(item => item.requestId === requestId);
    if (!item) throw knowledgeError('not_found', 'Capture batch item not found');
    if (item?.status !== 'failed' || !item.retryable) throw knowledgeError('conflict', 'Only failed retryable items can be retried');
    return this.claimCaptureBatchItemForProcessing(userId, batchId, requestId);
  }

  async recoverInterruptedCaptureBatches(): Promise<number> {
    return this.inTransaction(() => {
      this.run("update raw_sources set processing_status = 'failed', error_reason = 'Capture interrupted; retry the frozen analysis' where processing_status = 'processing'");
      const pending = this.many(
        `select distinct user_id, batch_id from capture_batch_items
         where (kind = 'text' and status = 'queued') or status = 'processing'`,
      );
      const count = num(this.one(
        `select count(*) as count from capture_batch_items
         where (kind = 'text' and status = 'queued') or status = 'processing'`,
      )?.count);
      if (count === 0) return 0;
      const updatedAt = nowIso();
      const errorReason = '服务重启期间采集处理被中断，可重试原项目';
      this.run(
        `update capture_batch_items set status = 'failed', retryable = 1, error_reason = ?, updated_at = ?
         where (kind = 'text' and status = 'queued') or status = 'processing'`,
        [errorReason, updatedAt],
      );
      for (const row of pending) {
        this.run('update capture_batches set updated_at = ? where user_id = ? and batch_id = ?', [updatedAt, text(row.user_id), text(row.batch_id)]);
      }
      return count;
    });
  }

  async createCaptureRecognitionSnapshot(input: CreateCaptureRecognitionSnapshotInput): Promise<StoredCaptureRecognitionSnapshot> {
    return this.inTransaction(() => {
      this.mustRawSource(input.rawSourceId, input.userId);
      if (input.expectedReviewRevision !== undefined) this.assertCaptureReview(input.userId, input.rawSourceId, input.expectedReviewRevision);
      const prior = this.readRecognitionSnapshot(input.userId, input.rawSourceId);
      if (prior) {
        if (prior.inputFingerprint !== input.inputFingerprint || JSON.stringify(prior.inputs) !== JSON.stringify(captureRecognitionSnapshotSchema.shape.inputs.parse(input.inputs))) throw knowledgeError('conflict', 'Recognition inputs are frozen');
        return prior;
      }
      const timestamp = nowIso();
      const payload = captureRecognitionSnapshotSchema.parse({ version: 1, inputFingerprint: input.inputFingerprint, inputs: input.inputs, results: [], createdAt: timestamp, updatedAt: timestamp });
      this.run('insert into capture_image_recognition_snapshots (user_id, raw_source_id, version, snapshot_json) values (?, ?, 1, ?)', [input.userId, input.rawSourceId, JSON.stringify(payload)]);
      return { ...payload, userId: input.userId, rawSourceId: input.rawSourceId };
    });
  }
  private readRecognitionSnapshot(userId: string, rawSourceId: string): StoredCaptureRecognitionSnapshot | null {
    const row = this.one('select snapshot_json from capture_image_recognition_snapshots where user_id = ? and raw_source_id = ? and version = 1', [userId, rawSourceId]);
    if (row === null) return null;
    try { return { ...captureRecognitionSnapshotSchema.parse(JSON.parse(text(row.snapshot_json))), userId, rawSourceId }; }
    catch { throw knowledgeError('storage_error', 'Invalid saved recognition snapshot'); }
  }
  async getCaptureRecognitionSnapshot(userId: string, rawSourceId: string): Promise<StoredCaptureRecognitionSnapshot | null> {
    return this.readRecognitionSnapshot(userId, rawSourceId);
  }
  async saveCaptureRecognitionResult(userId: string, rawSourceId: string, input: SaveCaptureRecognitionResultInput, expectedReviewRevision?: number): Promise<StoredCaptureRecognitionSnapshot> {
    return this.inTransaction(() => {
      if (expectedReviewRevision !== undefined) this.assertCaptureReview(userId, rawSourceId, expectedReviewRevision);
      const snapshot = this.readRecognitionSnapshot(userId, rawSourceId);
      if (!snapshot) throw knowledgeError('not_found', 'Recognition snapshot not found');
      const entry = captureRecognitionEntrySchema.parse({ ...input, createdAt: nowIso() });
      if (!snapshot.inputs.some(asset => asset.assetId === entry.assetId)) throw knowledgeError('conflict', 'Recognition input is not in the frozen snapshot');
      const prior = snapshot.results.find(result => result.assetId === entry.assetId);
      if (prior) {
        if (JSON.stringify({ ...prior, createdAt: '' }) !== JSON.stringify({ ...entry, createdAt: '' })) throw knowledgeError('conflict', 'Recognition result is frozen');
        return snapshot;
      }
      const { userId: owner, rawSourceId: sourceId, ...payload } = snapshot;
      const updated = { ...payload, results: [...payload.results, entry], updatedAt: nowIso() };
      this.run('update capture_image_recognition_snapshots set snapshot_json = ? where user_id = ? and raw_source_id = ? and version = 1', [JSON.stringify(updated), userId, rawSourceId]);
      return { ...updated, userId: owner, rawSourceId: sourceId };
    });
  }

  async reserveCaptureProcessingPlan(input: ReserveCaptureProcessingPlanInput): Promise<CaptureProcessingPlan> {
    const rules = validateTaskRules(input.rulesSnapshot);
    return this.inTransaction(() => {
      const source = this.mustRawSource(input.rawSourceId, input.userId);
      this.assertCaptureReview(input.userId, input.rawSourceId, input.expectedReviewRevision);
      if (source.processingStatus === 'processing') throw knowledgeError('conflict', 'Capture is already processing');
      const latest = this.one('select * from capture_processing_plans where user_id = ? and raw_source_id = ? order by analysis_version desc limit 1', [input.userId, input.rawSourceId]);
      const prior = latest === null ? null : toCaptureProcessingPlan(latest);
      if (input.newVersion) {
        if ((prior?.analysisVersion ?? 0) !== input.expectedAnalysisVersion) throw knowledgeError('conflict', 'Analysis version changed');
        if (this.one('select action_id from source_review_actions where user_id = ? and raw_source_id = ? limit 1', [input.userId, input.rawSourceId]) !== null
          || this.one('select id from knowledge_items where user_id = ? and raw_source_id = ? and is_ai_derived = 0 limit 1', [input.userId, input.rawSourceId]) !== null) throw knowledgeError('conflict', 'Human-reviewed source cannot be reanalyzed');
      }
      if (prior && !input.newVersion && prior.rulesSnapshot === null) throw knowledgeError('conflict', 'Historical rules unknown; explicit reanalysis required');
      const timestamp = nowIso();
      let result = prior;
      if (!prior || input.newVersion) {
        const itemVersion = num(this.one('select max(capture_analysis_version) as version from knowledge_items where user_id = ? and raw_source_id = ?', [input.userId, input.rawSourceId])?.version);
        if (!input.newVersion && itemVersion > 0) throw knowledgeError('conflict', 'Historical partial analysis requires explicit reanalysis');
        const version = input.newVersion ? Math.max(prior?.analysisVersion ?? 0, itemVersion) + 1 : 1;
        this.run('insert into capture_processing_plans (user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at) values (?, ?, ?, ?, ?, 0, ?, ?)', [input.userId, input.rawSourceId, version, '[]', JSON.stringify(rules), timestamp, timestamp]);
        result = toCaptureProcessingPlan(this.one('select * from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = ?', [input.userId, input.rawSourceId, version])!);
      }
      this.run("update raw_sources set processing_status = 'processing', error_reason = null where id = ? and user_id = ?", [input.rawSourceId, input.userId]);
      return result!;
    });
  }

  async completeCaptureProcessingPlanExtraction(userId: string, rawSourceId: string, analysisVersion: number, points: CaptureProcessingPlanPoint[], expectedReviewRevision?: number): Promise<CaptureProcessingPlan> {
    return this.inTransaction(() => {
      if (expectedReviewRevision !== undefined) this.assertCaptureReview(userId, rawSourceId, expectedReviewRevision);
      const row = this.one('select * from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = ?', [userId, rawSourceId, analysisVersion]);
      if (row === null) throw knowledgeError('not_found', 'Capture plan not found');
      const plan = toCaptureProcessingPlan(row);
      if (plan.extractionReady) {
        if (JSON.stringify(plan.points) !== JSON.stringify(points)) throw knowledgeError('conflict', 'Frozen extraction cannot be replaced');
        return plan;
      }
      const updatedAt = nowIso();
      this.run('update capture_processing_plans set points_json = ?, extraction_ready = 1, updated_at = ? where user_id = ? and raw_source_id = ? and analysis_version = ?', [JSON.stringify(points), updatedAt, userId, rawSourceId, analysisVersion]);
      return { ...plan, points: structuredClone(points), extractionReady: true, updatedAt };
    });
  }

  async getCaptureProcessingPlan(
    userId: string, rawSourceId: string, analysisVersion?: number,
  ): Promise<CaptureProcessingPlan | null> {
    const row = analysisVersion === undefined
      ? this.one(
          `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
             from capture_processing_plans where user_id = ? and raw_source_id = ?
             order by analysis_version desc limit 1`,
          [userId, rawSourceId],
        )
      : this.one(
          `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
             from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = ?`,
          [userId, rawSourceId, analysisVersion],
        );
    return row === null ? null : toCaptureProcessingPlan(row);
  }

  async createCaptureProcessingPlan(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan> {
    return this.inTransaction(() => {
      if (this.one('select id from raw_sources where id = ? and user_id = ?', [rawSourceId, userId]) === null) {
        throw knowledgeError('not_found', `RawSource ${rawSourceId} not found`);
      }
      const existing = this.one(
        `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
           from capture_processing_plans where user_id = ? and raw_source_id = ?
           order by analysis_version desc limit 1`,
        [userId, rawSourceId],
      );
      if (existing !== null) return toCaptureProcessingPlan(existing);
      const timestamp = nowIso();
      this.run(
        `insert into capture_processing_plans (user_id, raw_source_id, analysis_version, points_json, created_at, updated_at)
         values (?, ?, 1, ?, ?, ?)`,
        [userId, rawSourceId, JSON.stringify(points), timestamp, timestamp],
      );
      const created = this.one(
        `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
           from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = 1`,
        [userId, rawSourceId],
      );
      if (created === null) throw knowledgeError('storage_error', '写入采集冻结计划后无法读取 / capture plan vanished after write');
      return toCaptureProcessingPlan(created);
    });
  }

  async createCaptureProcessingPlanVersion(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan> {
    return this.inTransaction(() => {
      if (this.one('select id from raw_sources where id = ? and user_id = ?', [rawSourceId, userId]) === null) {
        throw knowledgeError('not_found', `RawSource ${rawSourceId} not found`);
      }
      const planVersion = num(this.one(
        'select max(analysis_version) as version from capture_processing_plans where user_id = ? and raw_source_id = ?',
        [userId, rawSourceId],
      )?.version);
      const itemVersion = num(this.one(
        'select max(capture_analysis_version) as version from knowledge_items where user_id = ? and raw_source_id = ?',
        [userId, rawSourceId],
      )?.version);
      const analysisVersion = Math.max(planVersion, itemVersion) + 1;
      const timestamp = nowIso();
      this.run(
        `insert into capture_processing_plans (user_id, raw_source_id, analysis_version, points_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [userId, rawSourceId, analysisVersion, JSON.stringify(points), timestamp, timestamp],
      );
      const created = this.one(
        `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
           from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = ?`,
        [userId, rawSourceId, analysisVersion],
      );
      if (created === null) throw knowledgeError('storage_error', '写入新分析版本后无法读取 / capture plan version vanished after write');
      return toCaptureProcessingPlan(created);
    });
  }

  async updateCaptureProcessingPlanPoint(userId: string, rawSourceId: string, analysisVersion: number, pointIndex: number, patch: CaptureProcessingPlanPointPatch, captureAuthority?: CaptureReviewAuthority): Promise<CaptureProcessingPlan> {
    return this.updateCaptureProcessingPlanPointSync(userId, rawSourceId, analysisVersion, pointIndex, patch, captureAuthority);
  }

  private updateCaptureProcessingPlanPointSync(
    userId: string, rawSourceId: string, analysisVersion: number, pointIndex: number,
    patch: CaptureProcessingPlanPointPatch, captureAuthority?: CaptureReviewAuthority,
  ): CaptureProcessingPlan {
    return this.inTransaction(() => {
      if (captureAuthority) this.assertCaptureReview(userId, rawSourceId, captureAuthority.expectedReviewRevision);
      const row = this.one(
        `select user_id, raw_source_id, analysis_version, points_json, rules_snapshot_json, extraction_ready, created_at, updated_at
           from capture_processing_plans where user_id = ? and raw_source_id = ? and analysis_version = ?`,
        [userId, rawSourceId, analysisVersion],
      );
      if (row === null) throw knowledgeError('not_found', '采集冻结计划不存在 / capture processing plan not found');
      const plan = toCaptureProcessingPlan(row);
      const currentIndex = plan.points.findIndex((point) => point.pointIndex === pointIndex);
      if (currentIndex < 0) throw knowledgeError('not_found', '冻结计划点位不存在 / capture plan point not found');
      const current = plan.points[currentIndex]!;
      const isSame = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      for (const field of ['decision', 'placement', 'embedding', 'embeddingModel', 'knowledgeItemId'] as const) {
        const stored = current[field];
        const next = patch[field];
        if (stored !== null && stored !== undefined && next !== undefined && !isSame(stored, next)) {
          throw knowledgeError('conflict', '冻结计划的已保存决策、放置或副作用标记不能改写 / saved capture plan state is immutable');
        }
      }
      if (patch.status !== undefined && CAPTURE_POINT_STATUS_RANK[patch.status] < CAPTURE_POINT_STATUS_RANK[current.status]) {
        throw knowledgeError('conflict', '冻结计划点位状态不能回退 / capture plan point status cannot regress');
      }
      const points = plan.points.map((point, index) => index === currentIndex ? { ...point, ...patch } : point);
      const updatedAt = nowIso();
      this.run(
        `update capture_processing_plans set points_json = ?, updated_at = ?
         where user_id = ? and raw_source_id = ? and analysis_version = ?`,
        [JSON.stringify(points), updatedAt, userId, rawSourceId, analysisVersion],
      );
      return { ...plan, points, updatedAt };
    });
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
      reviewStatus: 'needs_review',
      reviewRevision: 0,
      errorReason: null,
      requestId: input.requestId ?? null,
      clientId: input.clientId ?? null,
      createdAt: nowIso(),
    };
    this.run(
      `insert into raw_sources (id, user_id, raw_text, surrounding_context, source_type, source_platform,
         source_app, source_title, source_url, captured_at, metadata_json, processing_status, error_reason,
         request_id, client_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.requestId,
        record.clientId,
        record.createdAt,
      ],
    );
    return record;
  }

  async finishCaptureProcessing(input: FinishCaptureProcessingInput): Promise<CaptureProcessingOutcome> {
    return this.inTransaction(() => {
      const source = this.mustRawSource(input.rawSourceId, input.userId);
      if (source.reviewRevision !== input.expectedReviewRevision) return { source, applied: false };
      const confirm = input.status === 'done' && input.confirmIfInitial === true && source.reviewRevision === 0 && source.reviewStatus === 'needs_review';
      this.run('update raw_sources set processing_status = ?, error_reason = ?, review_status = ?, review_revision = ? where id = ? and user_id = ? and review_revision = ?', [input.status, input.errorReason ?? null, confirm ? 'confirmed' : source.reviewStatus, source.reviewRevision + Number(confirm), input.rawSourceId, input.userId, input.expectedReviewRevision]);
      return { source: this.mustRawSource(input.rawSourceId, input.userId), applied: true };
    });
  }

  async updateRawSourceProcessing(
    id: string,
    userId: string,
    status: ProcessingStatus,
    errorReason: string | null = null,
    expectedReviewRevision?: number,
  ): Promise<RawSource> {
    this.run(
      `update raw_sources set processing_status = ?, error_reason = ? where id = ? and user_id = ? ${expectedReviewRevision === undefined ? '' : 'and review_revision = ?'}`,
      [status, errorReason, id, userId, ...(expectedReviewRevision === undefined ? [] : [expectedReviewRevision])],
    );
    return this.mustRawSource(id, userId);
  }

  async updateRawSource(
    id: string,
    userId: string,
    patch: Partial<Pick<RawSource, 'rawText' | 'sourceType' | 'sourcePlatform' | 'sourceApp' | 'sourceTitle' | 'sourceUrl' | 'capturedAt' | 'metadata'>>,
  ): Promise<RawSource> {
    const columns: string[] = [];
    const params: (string | null)[] = [];
    const fields = [
      ['rawText', 'raw_text'],
      ['sourceType', 'source_type'],
      ['sourcePlatform', 'source_platform'],
      ['sourceApp', 'source_app'],
      ['sourceTitle', 'source_title'],
      ['sourceUrl', 'source_url'],
      ['capturedAt', 'captured_at'],
    ] as const;
    for (const [key, column] of fields) {
      const value = patch[key];
      if (value === undefined) continue;
      columns.push(`${column} = ?`);
      params.push(value);
    }
    if (patch.metadata !== undefined) {
      columns.push('metadata_json = ?');
      params.push(JSON.stringify(patch.metadata));
    }
    if (columns.length > 0) {
      this.run(`update raw_sources set ${columns.join(', ')} where id = ? and user_id = ?`, [...params, id, userId]);
    }
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

  /**
   * The replay lookup. Empty `requestId` never matches: a capture that stated no key is not a key, and
   * treating an absent one as a wildcard would collapse every unkeyed row of a user into a single replay.
   */
  async findRawSourceByIdempotencyKey(userId: string, clientId: string, requestId: string): Promise<RawSource | null> {
    if (requestId.length === 0) return null;
    const row = this.one(
      `select ${RAW_SOURCE_FIELDS} from raw_sources
        where user_id = ? and client_id = ? and request_id = ? limit 1`,
      [userId, clientId, requestId],
    );
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

  async listInbox(input: ListInboxInput): Promise<RawSource[]> {
    const statuses = input.statuses ?? [];
    const reviewFilter = input.reviewStatus === undefined ? '' : 'and review_status = ?';
    const statusFilter = statuses.length > 0 ? `and processing_status in (${placeholders(statuses.length)})` : '';
    const rows = this.many(
      `select ${RAW_SOURCE_FIELDS} from raw_sources
        where user_id = ? ${statusFilter} ${reviewFilter}
        order by created_at desc, rowid desc
        limit ? offset ?`,
      [
        input.userId,
        ...statuses,
        ...(input.reviewStatus === undefined ? [] : [input.reviewStatus]),
        Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_INBOX_PAGE),
        Math.max(Math.trunc(input.offset ?? 0), 0),
      ],
    );
    return rows.map(toRawSource);
  }

  async countInboxByStatus(userId: string): Promise<Record<ProcessingStatus, number>> {
    const rows = this.many(
      `select processing_status, count(*) as total from raw_sources where user_id = ? group by processing_status`,
      [userId],
    );
    const counts: Record<ProcessingStatus, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of rows) {
      const status = text(row.processing_status) as ProcessingStatus;
      if (status in counts) counts[status] = num(row.total);
    }
    return counts;
  }

  async countInboxByReviewStatus(userId: string): Promise<Record<ReviewStatus, number>> {
    const counts: Record<ReviewStatus, number> = { needs_review: 0, confirmed: 0, deferred: 0, rejected: 0 };
    for (const row of this.many('select review_status, count(*) as total from raw_sources where user_id = ? group by review_status', [userId])) counts[text(row.review_status) as ReviewStatus] = num(row.total);
    return counts;
  }

  async markRawSourceConfirmed(id: string, userId: string, onlyInitial = true): Promise<void> {
    this.run(`update raw_sources set review_status = 'confirmed', review_revision = review_revision + 1 where id = ? and user_id = ? and review_status != 'confirmed' ${onlyInitial ? "and review_revision = 0 and review_status = 'needs_review'" : ''}`, [id, userId]);
  }

  async readReviewConfirmation(id: string, userId: string, reviewRevision: number): Promise<RawSourceReviewConfirmation | null> {
    const source = await this.findRawSource(id, userId);
    if (!source || source.reviewStatus !== 'confirmed' || source.reviewRevision !== reviewRevision) return null;
    const actions = this.many('select intent_json, response_json from source_review_actions where user_id = ? and raw_source_id = ?', [userId, id]);
    return reviewConfirmationOf(id, userId, reviewRevision, actions.map(row => ({ fingerprint: String(row.intent_json), response: row.response_json })));
  }

  async reviewSource(id: string, userId: string, input: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    return this.inTransaction(() => {
      const source = this.mustRawSource(id, userId);
      const { request, fingerprint } = reviewIntent(input);
      const prior = this.one('select intent_json, response_json from source_review_actions where user_id = ? and raw_source_id = ? and action_id = ?', [userId, id, request.actionId]);
      if (prior !== null) {
        if (text(prior.intent_json) !== fingerprint) throw knowledgeError('conflict', 'actionId is already bound to a different review intent');
        return { ...JSON.parse(text(prior.response_json)) as ReviewSourceResponse, duplicate: true };
      }
      const reviewStatus = nextReviewStatus(source, request);
      const response: ReviewSourceResponse = { reviewStatus, reviewRevision: source.reviewRevision + 1, duplicate: false };
      if (request.action === 'confirm') {
        const node = this.one('select id, status from knowledge_nodes where id = ? and user_id = ?', [request.nodeId, userId]);
        if (node === null) throw knowledgeError('not_found', 'Target node not found');
        if (text(node.status) === 'archived') throw knowledgeError('conflict', 'Target node is archived');
        const normalizedText = (request.editedText ?? source.rawText).trim();
        if (!normalizedText) throw knowledgeError('invalid_request', 'Nothing to file');
        // Use the same Unicode boundary trimming as manual assign and the memory driver.
        const alreadyLinked = this.many(`select i.normalized_text from knowledge_items i join item_node_links l on l.item_id = i.id and l.user_id = i.user_id where i.user_id = ? and i.raw_source_id = ? and l.node_id = ?`, [userId, id, request.nodeId]);
        if (alreadyLinked.some((row) => text(row.normalized_text).trim() === normalizedText)) throw knowledgeError('conflict', 'Source text is already filed under this node');
        const itemId = createId();
        const timestamp = nowIso();
        this.run(`insert into knowledge_items (id, user_id, raw_source_id, normalized_text, summary, confidence, status, is_ai_derived, embedding_model, embedding_status, created_at, updated_at) values (?, ?, ?, ?, null, 1, 'active', 0, null, 'none', ?, ?)`, [itemId, userId, id, normalizedText, timestamp, timestamp]);
        this.indexKeywords('knowledge_item', itemId, userId, normalizedText);
        this.run(`insert into item_node_links (id, user_id, item_id, node_id, relation_type, confidence, created_at) values (?, ?, ?, ?, 'primary', 1, ?)`, [createId(), userId, itemId, request.nodeId, timestamp]);
        response.item = this.mustItem(itemId, userId);
        response.path = this.nodePathOf(userId, request.nodeId);
      }
      this.run(`update raw_sources set review_status = ?, review_revision = ? ${request.action === 'confirm' ? ", processing_status = 'done', error_reason = null" : ", processing_status = case when processing_status = 'processing' then 'pending' else processing_status end"} where id = ? and user_id = ?`, [reviewStatus, response.reviewRevision, id, userId]);
      const changedAt = nowIso();
      const batches = this.many('select distinct batch_id from capture_batch_items where user_id = ? and raw_source_id = ?', [userId, id]);
      this.run('update capture_batch_items set status = ?, retryable = 0, error_reason = null, processing_reason = null, updated_at = ? where user_id = ? and raw_source_id = ?', [reviewStatus === 'confirmed' ? 'done' : 'needs_review', changedAt, userId, id]);
      for (const batch of batches) this.run('update capture_batches set updated_at = ? where user_id = ? and batch_id = ?', [changedAt, userId, text(batch.batch_id)]);
      this.run('insert into source_review_actions (user_id, raw_source_id, action_id, intent_json, response_json, created_at) values (?, ?, ?, ?, ?, ?)', [userId, id, request.actionId, fingerprint, JSON.stringify(response), nowIso()]);
      return response;
    });
  }

  // --- knowledge items -----------------------------------------------------------------

  private createKnowledgeItemSync(input: CreateKnowledgeItemRecordInput): KnowledgeItem {
    return this.inTransaction(() => {
      const pointIndex = input.capturePointIndex;
      const analysisVersion = input.captureAnalysisVersion ?? 1;
      if (!Number.isSafeInteger(analysisVersion) || analysisVersion < 1) {
        throw knowledgeError('invalid_request', 'captureAnalysisVersion must be a positive safe integer');
      }
      if (pointIndex !== undefined) {
        if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) {
          throw knowledgeError('invalid_request', 'capturePointIndex must be a non-negative safe integer');
        }
        const existing = this.one(
          `select ${ITEM_FIELDS} from knowledge_items
           where user_id = ? and raw_source_id = ? and capture_analysis_version = ? and capture_point_index = ?`,
          [input.userId, input.rawSourceId, analysisVersion, pointIndex],
        );
        if (existing !== null) return toItem(existing);

        // Only v1 can adopt exact-text records written before frozen plans existed. Later analyses are distinct.
        const legacy = analysisVersion === 1 ? this.one(
          `select ${ITEM_FIELDS} from knowledge_items
           where user_id = ? and raw_source_id = ? and normalized_text = ? and capture_analysis_version = 1 and capture_point_index is null and is_ai_derived = 1
           order by created_at asc, rowid asc limit 1`,
          [input.userId, input.rawSourceId, input.normalizedText],
        ) : null;
        if (legacy !== null) {
          this.run(
            'update knowledge_items set capture_point_index = ? where user_id = ? and id = ? and capture_point_index is null',
            [pointIndex, input.userId, text(legacy.id)],
          );
          return toItem(legacy);
        }
      }

      const timestamp = nowIso();
      const id = createId();
      this.run(
        `insert into knowledge_items (id, user_id, raw_source_id, normalized_text, summary, confidence, status,
           is_ai_derived, embedding_model, embedding_status, created_at, updated_at, capture_analysis_version, capture_point_index)
         values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
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
          analysisVersion,
          pointIndex ?? null,
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
    });
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

  private assertCaptureReview(userId: string, rawSourceId: string, expectedReviewRevision: number): void {
    const source = this.mustRawSource(rawSourceId, userId);
    if (!Number.isSafeInteger(expectedReviewRevision) || source.reviewRevision !== expectedReviewRevision) throw knowledgeError('conflict', 'Capture review authority changed', { reason: 'capture_review_changed' });
  }

  async createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode> {
    const authority = input.captureAuthority;
    if (!authority) return this.createNodeSync(input);
    return this.inTransaction(() => {
      this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
      const node = this.createNodeSync(input);
      if (node.parentId !== null) this.upsertEdge({ userId: input.userId, fromNodeId: node.id, toNodeId: node.parentId, relationType: 'part_of', confidence: 1, source: 'tree_structure' });
      this.createVersionRecordSync({ userId: input.userId, entityType: 'knowledge_node', entityId: node.id, operation: 'create', before: {}, after: { title: node.title, parentId: node.parentId, nodeType: node.nodeType }, actor: authority.actor });
      return node;
    });
  }

  async createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem> {
    const authority = input.captureAuthority;
    if (!authority) return this.createKnowledgeItemSync(input);
    return this.inTransaction(() => {
      this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
      if (input.rawSourceId !== authority.rawSourceId || input.captureAnalysisVersion !== authority.analysisVersion || input.capturePointIndex !== authority.pointIndex) throw knowledgeError('invalid_request', 'Capture identity mismatch');
      const item = this.createKnowledgeItemSync(input);
      if (!item.isAiDerived) throw knowledgeError('conflict', 'Human knowledge cannot be adopted by capture');
      this.updateCaptureProcessingPlanPointSync(input.userId, authority.rawSourceId, authority.analysisVersion, authority.pointIndex, { knowledgeItemId: item.id, status: 'item_saved' }, authority);
      return item;
    });
  }

  async linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink> {
    const authority = input.captureAuthority;
    if (!authority) return this.linkItemToNodeSync(input);
    return this.inTransaction(() => {
      this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
      const item = this.mustItem(input.itemId, input.userId);
      if (item.rawSourceId !== authority.rawSourceId || !item.isAiDerived) throw knowledgeError('conflict', 'Human knowledge cannot receive capture placement');
      const linked = this.linkItemToNodeSync(input);
      this.updateCaptureProcessingPlanPointSync(input.userId, authority.rawSourceId, authority.analysisVersion, authority.pointIndex, { status: 'linked' }, authority);
      return linked;
    });
  }

  private createNodeSync(input: CreateNodeRecordInput): KnowledgeNode {
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
      if (node.parentId !== null && node.parentId !== input.targetParentId) {
        this.run(
          `delete from knowledge_edges
            where user_id = ? and from_node_id = ? and to_node_id = ?
              and relation_type = 'part_of' and source = 'tree_structure'`,
          [input.userId, node.id, node.parentId],
        );
      }
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

  private linkItemToNodeSync(input: LinkItemInput): ItemNodeLink {
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

  async unlinkItemFromNodes(itemId: string, userId: string): Promise<void> {
    this.run('delete from item_node_links where item_id = ? and user_id = ?', [itemId, userId]);
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

  async createItemRelation(input: CreateLibraryRelationRecordInput): Promise<ItemRelation> {
    if (input.fromSourceId === input.targetId) throw knowledgeError('invalid_request', '条目不能关联自身');
    for (const sourceId of [input.fromSourceId, input.targetId]) {
      const row = this.one('select user_id from raw_sources where id = ?', [sourceId]);
      if (row === null || text(row.user_id) !== input.userId) {
        throw knowledgeError('not_found', `收集条目 ${sourceId} 不存在`);
      }
    }
    this.run(
      `insert into library_item_relations (user_id, from_source_id, target_id, relation, created_at)
       values (?, ?, ?, ?, ?)
       on conflict (from_source_id, target_id) do update set relation = excluded.relation`,
      [input.userId, input.fromSourceId, input.targetId, input.relation, nowIso()],
    );
    const row = this.one(
      'select target_id, relation, created_at from library_item_relations where user_id = ? and from_source_id = ? and target_id = ?',
      [input.userId, input.fromSourceId, input.targetId],
    );
    if (row === null) throw knowledgeError('storage_error', '关联记录写入后未找到');
    return {
      targetId: text(row.target_id),
      relation: text(row.relation) as ItemRelation['relation'],
      direction: 'outgoing',
      createdAt: text(row.created_at),
    };
  }

  async listItemRelations(sourceId: string, userId: string): Promise<ItemRelation[]> {
    const rows = this.many(
      `select case when relations.from_source_id = ? then relations.target_id else relations.from_source_id end as target_id,
              relations.relation, relations.created_at,
              case when relations.from_source_id = ? then 'outgoing' else 'incoming' end as direction
       from library_item_relations as relations
       join raw_sources as targets
         on targets.id = case when relations.from_source_id = ? then relations.target_id else relations.from_source_id end
        and targets.user_id = relations.user_id
       where (relations.from_source_id = ? or relations.target_id = ?) and relations.user_id = ?
       order by relations.created_at desc, relations.target_id`,
      [sourceId, sourceId, sourceId, sourceId, sourceId, userId],
    );
    return rows.map((row) => ({
      targetId: text(row.target_id),
      relation: text(row.relation) as ItemRelation['relation'],
      direction: text(row.direction) as ItemRelation['direction'],
      createdAt: text(row.created_at),
    }));
  }

  async deleteItemRelations(sourceId: string, targetId: string, userId: string): Promise<void> {
    this.run(
      'delete from library_item_relations where user_id = ? and ((from_source_id = ? and target_id = ?) or (from_source_id = ? and target_id = ?))',
      [userId, sourceId, targetId, targetId, sourceId],
    );
  }

  async createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge> {
    if (!input.captureAuthority) return this.upsertEdge(input);
    return this.inTransaction(() => {
      this.assertCaptureReview(input.userId, input.captureAuthority!.rawSourceId, input.captureAuthority!.expectedReviewRevision);
      return this.upsertEdge(input);
    });
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

  async listEdges(userId: string): Promise<KnowledgeEdge[]> {
    return this.many(`select ${EDGE_FIELDS} from knowledge_edges where user_id = ? order by created_at, id`, [userId]).map(toEdge);
  }

  async deleteEdge(userId: string, fromNodeId: string, toNodeId: string, relationType: EdgeRelation): Promise<void> {
    this.run(
      'delete from knowledge_edges where user_id = ? and from_node_id = ? and to_node_id = ? and relation_type = ?',
      [userId, fromNodeId, toNodeId, relationType],
    );
  }

  async getKnowledgeNote(userId: string, topicId: string, chapterId: string | null): Promise<KnowledgeNote | null> {
    const row = this.one(
      `select user_id, topic_id, chapter_id, content, created_at, updated_at
         from knowledge_notes
        where user_id = ? and topic_id = ? and ${chapterId === null ? 'chapter_id is null' : 'chapter_id = ?'}`,
      chapterId === null ? [userId, topicId] : [userId, topicId, chapterId],
    );
    return row === null ? null : toKnowledgeNote(row);
  }

  async listKnowledgeNotes(userId: string, topicId: string): Promise<KnowledgeNoteIndexEntry[]> {
    return this.many(
      `select topic_id, chapter_id, updated_at from knowledge_notes
        where user_id = ? and topic_id = ? order by chapter_id is not null, chapter_id`,
      [userId, topicId],
    ).map((row) => ({
      topicId: row.topic_id as string,
      chapterId: row.chapter_id as string | null,
      updatedAt: row.updated_at as string,
    }));
  }

  async saveKnowledgeNote(input: SaveKnowledgeNoteInput): Promise<KnowledgeNote> {
    this.mustNode(input.topicId, input.userId);
    if (input.chapterId !== null) this.mustNode(input.chapterId, input.userId);
    const timestamp = nowIso();
    if (input.chapterId === null) {
      this.run(
        `insert into knowledge_notes (user_id, topic_id, chapter_id, content, created_at, updated_at)
         values (?, ?, null, ?, ?, ?)
         on conflict (user_id, topic_id) where chapter_id is null
         do update set content = excluded.content, updated_at = excluded.updated_at`,
        [input.userId, input.topicId, input.content, timestamp, timestamp],
      );
    } else {
      this.run(
        `insert into knowledge_notes (user_id, topic_id, chapter_id, content, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict (user_id, topic_id, chapter_id) where chapter_id is not null
         do update set content = excluded.content, updated_at = excluded.updated_at`,
        [input.userId, input.topicId, input.chapterId, input.content, timestamp, timestamp],
      );
    }
    const saved = await this.getKnowledgeNote(input.userId, input.topicId, input.chapterId);
    if (saved === null) throw knowledgeError('storage_error', 'Knowledge note vanished after write');
    return saved;
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
