import type {
  Conversation,
  ConversationMessage,
  CreateRawSourceInput,
  EdgeRelation,
  ItemNodeLink,
  ItemRelation,
  JsonValue,
  KnowledgeEdge,
  KnowledgeItem,
  KnowledgeNote,
  KnowledgeNode,
  ProcessingStatus,
  RawSource,
  RawSourceReviewConfirmation,
  ReviewStatus,
  ReviewSourceRequest,
  ReviewSourceResponse,
  UpdateNodeInput,
  VersionRecord,
} from '@noltri/schema';
import { cosineSimilarity, createId, knowledgeError, nowIso, tokenize, uniqueTokens } from '@noltri/shared';
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
  ListInboxInput,
  LinkItemInput,
  MoveNodeRecordInput,
  MoveNodeRecordResult,
  NodeListItemOptions,
  NodeStats,
  NodeVectorMatch,
  PathSegment,
  StorageDriverName,
  StorageHealth,
  SaveKnowledgeNoteInput,
  KnowledgeNoteIndexEntry,
  VectorSearchOptions,
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
} from './types';

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function checkpointMap<K, V>(map: Map<K, V>): () => void {
  const before = new Map(map);
  return () => { map.clear(); for (const [key, value] of before) map.set(key, value); };
}
function checkpointSet<T>(set: Set<T>): () => void {
  const before = new Set(set);
  return () => { set.clear(); for (const value of before) set.add(value); };
}

const titleKey = (title: string) => title.trim().toLowerCase();

/** Page ceiling shared with the file-backed drivers so a caller cannot ask for the whole map. */
const MAX_INBOX_PAGE = 200;

export class InMemoryRepository implements KnowledgeRepository {
  readonly driver: StorageDriverName = 'memory';

  private readonly recognitionSnapshots = new Map<string, StoredCaptureRecognitionSnapshot>();
  private readonly reviewActions = new Map<string, { fingerprint: string; response: ReviewSourceResponse }>();
  private readonly rawSources = new Map<string, RawSource>();
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly itemEmbeddings = new Map<string, number[]>();
  private readonly nodes = new Map<string, KnowledgeNode>();
  private readonly nodeEmbeddings = new Map<string, number[]>();
  private readonly links = new Map<string, ItemNodeLink>();
  private readonly itemRelations = new Map<string, { userId: string; relation: ItemRelation }>();
  private readonly edges = new Map<string, KnowledgeEdge>();
  private readonly notes = new Map<string, KnowledgeNote>();
  private readonly versions = new Map<string, VersionRecord>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ConversationMessage>();
  private readonly captureAssets = new Map<string, StoredCaptureAsset>();
  private readonly captureBatches = new Map<string, StoredCaptureBatch>();
  private readonly capturePointItems = new Map<string, string>();
  private readonly indexedCapturePointItems = new Set<string>();
  private readonly itemCaptureAnalysisVersions = new Map<string, number>();
  private readonly captureProcessingPlans = new Map<string, Map<number, CaptureProcessingPlan>>();

  private captureAssetKey(userId: string, assetId: string): string {
    return `${userId}\u0000${assetId}`;
  }

  private captureBatchKey(userId: string, batchId: string): string {
    return `${userId}\u0000${batchId}`;
  }

  private captureProcessingPlanKey(userId: string, rawSourceId: string): string {
    return `${userId}\u0000${rawSourceId}`;
  }

  async putCaptureAsset(input: PutCaptureAssetInput): Promise<{ asset: StoredCaptureAsset; duplicate: boolean }> {
    const key = this.captureAssetKey(input.userId, input.assetId);
    const existing = this.captureAssets.get(key);
    if (existing !== undefined) {
      const sameBytes = existing.bytes.length === input.bytes.length && existing.bytes.every((byte, index) => byte === input.bytes[index]);
      if (
        existing.sessionId !== input.sessionId || existing.sha256 !== input.sha256 ||
        existing.mimeType !== input.mimeType || !sameBytes
      ) {
        throw knowledgeError('conflict', 'assetId 已绑定到不同会话或内容 / assetId is already bound to different content');
      }
      return { asset: clone(existing), duplicate: true };
    }
    const asset: StoredCaptureAsset = {
      ...input,
      bytes: new Uint8Array(input.bytes),
      byteLength: input.bytes.byteLength,
      createdAt: nowIso(),
    };
    this.captureAssets.set(key, asset);
    return { asset: clone(asset), duplicate: false };
  }

  async getCaptureAsset(userId: string, sessionId: string, assetId: string): Promise<StoredCaptureAsset | null> {
    const asset = this.captureAssets.get(this.captureAssetKey(userId, assetId));
    return asset !== undefined && asset.sessionId === sessionId ? clone(asset) : null;
  }

  async createCaptureBatch(input: CreateCaptureBatchInput): Promise<{ batch: StoredCaptureBatch; duplicate: boolean }> {
    const key = this.captureBatchKey(input.userId, input.batchId);
    const existing = this.captureBatches.get(key);
    if (existing !== undefined) {
      if (existing.sessionId !== input.sessionId || existing.payloadHash !== input.payloadHash) {
        throw knowledgeError('conflict', 'batchId 已绑定到不同请求 / batchId is already bound to a different request');
      }
      return { batch: clone(existing), duplicate: true };
    }
    for (const item of input.items) {
      for (const assetId of item.assetIds) {
        const asset = this.captureAssets.get(this.captureAssetKey(input.userId, assetId));
        if (asset === undefined || asset.sessionId !== input.sessionId) {
          throw knowledgeError('invalid_request', `批次引用了未保存的 asset ${assetId} / batch references an unsaved asset`);
        }
      }
    }
    const createdAt = nowIso();
    const items: StoredCaptureBatchItem[] = [...input.items]
      .sort((left, right) => left.userOrder - right.userOrder)
      .map((item) => ({
        ...clone(item),
        status: item.kind === 'text' ? 'queued' : 'assets_saved',
        rawSourceId: null,
        duplicate: false,
        retryable: false,
        errorReason: null,
        processingReason: null,
        updatedAt: createdAt,
      }));
    const batch: StoredCaptureBatch = { ...input, items, createdAt, updatedAt: createdAt };
    this.captureBatches.set(key, batch);
    return { batch: clone(batch), duplicate: false };
  }

  async getCaptureBatch(userId: string, batchId: string): Promise<StoredCaptureBatch | null> {
    const batch = this.captureBatches.get(this.captureBatchKey(userId, batchId));
    return batch === undefined ? null : clone(batch);
  }

  async listCaptureBatches(userId: string, limit: number): Promise<StoredCaptureBatch[]> {
    return [...this.captureBatches.values()]
      .filter((batch) => batch.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.batchId.localeCompare(left.batchId))
      .slice(0, limit)
      .map(clone);
  }

  async updateCaptureBatchItem(
    userId: string,
    batchId: string,
    requestId: string,
    patch: CaptureBatchItemPatch,
    expectedReviewRevision?: number,
  ): Promise<StoredCaptureBatch> {
    const key = this.captureBatchKey(userId, batchId);
    const batch = this.captureBatches.get(key);
    if (batch === undefined) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
    const itemIndex = batch.items.findIndex((item) => item.requestId === requestId);
    if (itemIndex < 0) throw knowledgeError('not_found', `批次项目 ${requestId} 不存在 / capture batch item not found`);
    const sourceId = patch.rawSourceId === undefined ? batch.items[itemIndex]!.rawSourceId : patch.rawSourceId;
    if (expectedReviewRevision !== undefined && sourceId !== null) {
      const source = this.rawSources.get(sourceId);
      if (!source || source.userId !== userId) throw knowledgeError('not_found', 'Raw source not found');
      if (source.reviewRevision !== expectedReviewRevision) patch = { rawSourceId: source.id, status: source.reviewStatus === 'confirmed' ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null };
    }
    const timestamp = nowIso();
    const items = batch.items.map((item, index) => index === itemIndex
      ? {
          ...item,
          ...patch,
          ...(patch.errorReason === undefined ? {} : { errorReason: patch.errorReason }),
          updatedAt: timestamp,
        }
      : item);
    const updated = { ...batch, items, updatedAt: timestamp };
    this.captureBatches.set(key, updated);
    return clone(updated);
  }

  async claimCaptureBatchItemForProcessing(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch> {
    const key = this.captureBatchKey(userId, batchId);
    const batch = this.captureBatches.get(key);
    if (batch === undefined) throw knowledgeError('not_found', `采集批次 ${batchId} 不存在 / capture batch not found`);
    const itemIndex = batch.items.findIndex((item) => item.requestId === requestId);
    if (itemIndex < 0) throw knowledgeError('not_found', `批次项目 ${requestId} 不存在 / capture batch item not found`);
    const item = batch.items[itemIndex]!;
    if (!((item.kind !== 'text' && item.status === 'assets_saved') || (item.status === 'failed' && item.retryable))) {
      throw knowledgeError('conflict', '只有可重试的失败文本项目可以重试 / only retryable failed text items can be retried');
    }
    const updatedAt = nowIso();
    const items = batch.items.map((candidate, index) => index === itemIndex
      ? { ...candidate, status: 'processing' as const, retryable: false, errorReason: null, updatedAt }
      : candidate);
    const updated = { ...batch, items, updatedAt };
    this.captureBatches.set(key, updated);
    return clone(updated);
  }

  async claimCaptureBatchItemForRetry(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch> {
    const batch = this.captureBatches.get(this.captureBatchKey(userId, batchId));
    if (!batch) throw knowledgeError('not_found', 'Capture batch not found');
    const item = batch.items.find(item => item.requestId === requestId);
    if (!item) throw knowledgeError('not_found', 'Capture batch item not found');
    if (item?.status !== 'failed' || !item.retryable) throw knowledgeError('conflict', 'Only failed retryable items can be retried');
    return this.claimCaptureBatchItemForProcessing(userId, batchId, requestId);
  }

  async recoverInterruptedCaptureBatches(): Promise<number> {
    for (const [id, source] of this.rawSources) if (source.processingStatus === 'processing') this.rawSources.set(id, { ...source, processingStatus: 'failed', errorReason: 'Capture interrupted; retry the frozen analysis' });
    let recovered = 0;
    for (const [key, batch] of this.captureBatches) {
      let changed = false;
      const timestamp = nowIso();
      const items = batch.items.map((item) => {
        if (item.status !== 'processing' && !(item.kind === 'text' && item.status === 'queued')) return item;
        changed = true;
        recovered += 1;
        return {
          ...item,
          status: 'failed' as const,
          retryable: true,
          errorReason: '服务重启期间采集处理被中断，可重试原项目',
          updatedAt: timestamp,
        };
      });
      if (changed) this.captureBatches.set(key, { ...batch, items, updatedAt: timestamp });
    }
    return recovered;
  }

  async createCaptureRecognitionSnapshot(input: CreateCaptureRecognitionSnapshotInput): Promise<StoredCaptureRecognitionSnapshot> {
    const source = this.rawSources.get(input.rawSourceId);
    if (!source || source.userId !== input.userId) throw knowledgeError('not_found', 'Raw source not found');
    if (input.expectedReviewRevision !== undefined) this.assertCaptureReview(input.userId, input.rawSourceId, input.expectedReviewRevision);
    const key = this.captureProcessingPlanKey(input.userId, input.rawSourceId);
    const prior = this.recognitionSnapshots.get(key);
    if (prior) {
      if (prior.inputFingerprint !== input.inputFingerprint || JSON.stringify(prior.inputs) !== JSON.stringify(captureRecognitionSnapshotSchema.shape.inputs.parse(input.inputs))) throw knowledgeError('conflict', 'Recognition inputs are frozen');
      return clone(prior);
    }
    const timestamp = nowIso();
    const payload = captureRecognitionSnapshotSchema.parse({ version: 1, inputFingerprint: input.inputFingerprint, inputs: input.inputs, results: [], createdAt: timestamp, updatedAt: timestamp });
    const snapshot = { ...payload, userId: input.userId, rawSourceId: input.rawSourceId };
    this.recognitionSnapshots.set(key, snapshot);
    return clone(snapshot);
  }
  async getCaptureRecognitionSnapshot(userId: string, rawSourceId: string): Promise<StoredCaptureRecognitionSnapshot | null> {
    const found = this.recognitionSnapshots.get(this.captureProcessingPlanKey(userId, rawSourceId));
    return found ? clone(found) : null;
  }
  async saveCaptureRecognitionResult(userId: string, rawSourceId: string, input: SaveCaptureRecognitionResultInput, expectedReviewRevision?: number): Promise<StoredCaptureRecognitionSnapshot> {
    if (expectedReviewRevision !== undefined) this.assertCaptureReview(userId, rawSourceId, expectedReviewRevision);
    const key = this.captureProcessingPlanKey(userId, rawSourceId);
    const snapshot = this.recognitionSnapshots.get(key);
    if (!snapshot) throw knowledgeError('not_found', 'Recognition snapshot not found');
    const entry = captureRecognitionEntrySchema.parse({ ...input, createdAt: nowIso() });
    if (!snapshot.inputs.some(asset => asset.assetId === entry.assetId)) throw knowledgeError('conflict', 'Recognition input is not in the frozen snapshot');
    const prior = snapshot.results.find(result => result.assetId === entry.assetId);
    if (prior) {
      if (JSON.stringify({ ...prior, createdAt: '' }) !== JSON.stringify({ ...entry, createdAt: '' })) throw knowledgeError('conflict', 'Recognition result is frozen');
      return clone(snapshot);
    }
    const updated = { ...snapshot, results: [...snapshot.results, entry], updatedAt: nowIso() };
    this.recognitionSnapshots.set(key, updated);
    return clone(updated);
  }

  async reserveCaptureProcessingPlan(input: ReserveCaptureProcessingPlanInput): Promise<CaptureProcessingPlan> {
    const rules = validateTaskRules(input.rulesSnapshot);
    const source = this.rawSources.get(input.rawSourceId);
    if (!source || source.userId !== input.userId) throw knowledgeError('not_found', 'Raw source not found');
    this.assertCaptureReview(input.userId, input.rawSourceId, input.expectedReviewRevision);
    if (source.processingStatus === 'processing') throw knowledgeError('conflict', 'Capture is already processing');
    const key = this.captureProcessingPlanKey(input.userId, input.rawSourceId);
    const versions = this.captureProcessingPlans.get(key);
    const prior = versions?.size ? versions.get(Math.max(...versions.keys()))! : null;
    if (input.newVersion) {
      if ((prior?.analysisVersion ?? 0) !== input.expectedAnalysisVersion) throw knowledgeError('conflict', 'Analysis version changed');
      if ([...this.reviewActions.keys()].some(key => { const [owner, id] = JSON.parse(key) as string[]; return owner === input.userId && id === input.rawSourceId; })
        || [...this.items.values()].some(item => item.userId === input.userId && item.rawSourceId === input.rawSourceId && !item.isAiDerived)
        || source.reviewStatus === 'deferred' || source.reviewStatus === 'rejected') throw knowledgeError('conflict', 'Human-reviewed source cannot be reanalyzed');
    }
    if (prior && !input.newVersion && prior.rulesSnapshot === null) throw knowledgeError('conflict', 'Historical rules unknown; explicit reanalysis required');
    let result = prior;
    if (!prior || input.newVersion) {
      const itemVersion = [...this.items.values()].filter(item => item.userId === input.userId && item.rawSourceId === input.rawSourceId).reduce((n, item) => Math.max(n, this.itemCaptureAnalysisVersions.get(item.id) ?? 1), 0);
      if (!input.newVersion && itemVersion > 0) throw knowledgeError('conflict', 'Historical partial analysis requires explicit reanalysis');
      const version = input.newVersion ? Math.max(prior?.analysisVersion ?? 0, itemVersion) + 1 : 1;
      const created = this.storeCaptureProcessingPlanVersion(input.userId, input.rawSourceId, version, []);
      result = { ...created, rulesSnapshot: rules, extractionReady: false };
      this.captureProcessingPlans.get(key)!.set(version, result);
    }
    this.rawSources.set(source.id, { ...source, processingStatus: 'processing', errorReason: null });
    return clone(result!);
  }

  async completeCaptureProcessingPlanExtraction(userId: string, rawSourceId: string, analysisVersion: number, points: CaptureProcessingPlanPoint[], expectedReviewRevision?: number): Promise<CaptureProcessingPlan> {
    if (expectedReviewRevision !== undefined) this.assertCaptureReview(userId, rawSourceId, expectedReviewRevision);
    const versions = this.captureProcessingPlans.get(this.captureProcessingPlanKey(userId, rawSourceId));
    const plan = versions?.get(analysisVersion);
    if (!plan) throw knowledgeError('not_found', 'Capture plan not found');
    if (plan.extractionReady) {
      if (JSON.stringify(plan.points) !== JSON.stringify(points)) throw knowledgeError('conflict', 'Frozen extraction cannot be replaced');
      return clone(plan);
    }
    const updated = { ...plan, points: clone(points), extractionReady: true, updatedAt: nowIso() };
    this.captureProcessingPlans.set(this.captureProcessingPlanKey(userId, rawSourceId), new Map(versions).set(analysisVersion, updated));
    return clone(updated);
  }

  async getCaptureProcessingPlan(
    userId: string, rawSourceId: string, analysisVersion?: number,
  ): Promise<CaptureProcessingPlan | null> {
    const versions = this.captureProcessingPlans.get(this.captureProcessingPlanKey(userId, rawSourceId));
    if (versions === undefined || versions.size === 0) return null;
    const version = analysisVersion ?? Math.max(...versions.keys());
    const plan = versions.get(version);
    return plan === undefined ? null : clone(plan);
  }

  async createCaptureProcessingPlan(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan> {
    const source = this.rawSources.get(rawSourceId);
    if (source === undefined || source.userId !== userId) throw knowledgeError('not_found', `RawSource ${rawSourceId} not found`);
    const key = this.captureProcessingPlanKey(userId, rawSourceId);
    const versions = this.captureProcessingPlans.get(key);
    if (versions !== undefined && versions.size > 0) return clone(versions.get(Math.max(...versions.keys()))!);
    return this.storeCaptureProcessingPlanVersion(userId, rawSourceId, 1, points);
  }

  async createCaptureProcessingPlanVersion(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan> {
    const source = this.rawSources.get(rawSourceId);
    if (source === undefined || source.userId !== userId) throw knowledgeError('not_found', `RawSource ${rawSourceId} not found`);
    const key = this.captureProcessingPlanKey(userId, rawSourceId);
    const versions = this.captureProcessingPlans.get(key);
    const latestPlanVersion = versions?.size ? Math.max(...versions.keys()) : 0;
    const latestItemVersion = [...this.items.values()]
      .filter((item) => item.userId === userId && item.rawSourceId === rawSourceId)
      .reduce((maximum, item) => Math.max(maximum, this.itemCaptureAnalysisVersions.get(item.id) ?? 1), 0);
    const nextVersion = Math.max(latestPlanVersion, latestItemVersion) + 1;
    return this.storeCaptureProcessingPlanVersion(userId, rawSourceId, nextVersion, points);
  }

  private storeCaptureProcessingPlanVersion(
    userId: string, rawSourceId: string, analysisVersion: number, points: CaptureProcessingPlanPoint[],
  ): CaptureProcessingPlan {
    const key = this.captureProcessingPlanKey(userId, rawSourceId);
    const timestamp = nowIso();
    const plan: CaptureProcessingPlan = {
      userId, rawSourceId, analysisVersion, points: clone(points), rulesSnapshot: null, extractionReady: true, createdAt: timestamp, updatedAt: timestamp,
    };
    const versions = this.captureProcessingPlans.get(key) ?? new Map<number, CaptureProcessingPlan>();
    versions.set(analysisVersion, plan);
    this.captureProcessingPlans.set(key, versions);
    return clone(plan);
  }

  async updateCaptureProcessingPlanPoint(userId: string, rawSourceId: string, analysisVersion: number, pointIndex: number, patch: CaptureProcessingPlanPointPatch, captureAuthority?: CaptureReviewAuthority): Promise<CaptureProcessingPlan> {
    return this.updateCaptureProcessingPlanPointSync(userId, rawSourceId, analysisVersion, pointIndex, patch, captureAuthority);
  }

  private updateCaptureProcessingPlanPointSync(
    userId: string, rawSourceId: string, analysisVersion: number, pointIndex: number,
    patch: CaptureProcessingPlanPointPatch, captureAuthority?: CaptureReviewAuthority,
  ): CaptureProcessingPlan {
    if (captureAuthority) this.assertCaptureReview(userId, rawSourceId, captureAuthority.expectedReviewRevision);
    const key = this.captureProcessingPlanKey(userId, rawSourceId);
    const versions = this.captureProcessingPlans.get(key);
    const plan = versions?.get(analysisVersion);
    if (plan === undefined) throw knowledgeError('not_found', '采集冻结计划不存在 / capture processing plan not found');
    const currentPointIndex = plan.points.findIndex((point) => point.pointIndex === pointIndex);
    if (currentPointIndex < 0) throw knowledgeError('not_found', '冻结计划点位不存在 / capture plan point not found');
    const current = plan.points[currentPointIndex]!;
    const isSame = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    for (const field of ['decision', 'placement', 'embedding', 'embeddingModel', 'knowledgeItemId'] as const) {
      const stored = current[field];
      const next = patch[field];
      if (stored !== null && stored !== undefined && next !== undefined && !isSame(stored, next)) {
        throw knowledgeError('conflict', '冻结计划的已保存决策、放置或副作用标记不能改写 / saved capture plan state is immutable');
      }
    }
    if (patch.status !== undefined) {
      const rank: Record<CaptureProcessingPlanPoint['status'], number> = {
        pending: 0, decision_saved: 1, placement_saved: 2, item_saved: 3, linked: 4, complete: 5,
      };
      if (rank[patch.status] < rank[current.status]) {
        throw knowledgeError('conflict', '冻结计划点位状态不能回退 / capture plan point status cannot regress');
      }
    }
    const points = plan.points.map((point, index) => index === currentPointIndex ? { ...point, ...clone(patch) } : point);
    const updated = { ...plan, points, updatedAt: nowIso() };
    this.captureProcessingPlans.set(key, new Map(versions).set(analysisVersion, updated));
    return clone(updated);
  }

  async createRawSource(input: CreateRawSourceInput): Promise<RawSource> {
    if (input.clientId && input.requestId && [...this.rawSources.values()].some(source => source.userId === input.userId && source.clientId === input.clientId && source.requestId === input.requestId)) throw knowledgeError('conflict', 'Capture request already exists');
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
      metadata: input.metadata ?? {},
      processingStatus: 'pending',
      reviewStatus: 'needs_review',
      reviewRevision: 0,
      errorReason: null,
      createdAt: nowIso(),
      requestId: input.requestId ?? null,
      clientId: input.clientId ?? null,
    };
    this.rawSources.set(record.id, record);
    return clone(record);
  }

  async findRawSourceByIdempotencyKey(userId: string, clientId: string, requestId: string): Promise<RawSource | null> {
    if (requestId.length === 0) return null;
    for (const record of this.rawSources.values()) {
      if (
        record.userId === userId &&
        record.clientId === clientId &&
        record.requestId === requestId
      ) {
        return clone(record);
      }
    }
    return null;
  }

  async finishCaptureProcessing(input: FinishCaptureProcessingInput): Promise<CaptureProcessingOutcome> {
    const source = this.rawSources.get(input.rawSourceId);
    if (!source || source.userId !== input.userId) throw knowledgeError('not_found', 'Raw source not found');
    if (source.reviewRevision !== input.expectedReviewRevision) return { source: clone(source), applied: false };
    const confirm = input.status === 'done' && input.confirmIfInitial === true && source.reviewRevision === 0 && source.reviewStatus === 'needs_review';
    const updated: RawSource = { ...source, processingStatus: input.status, errorReason: input.errorReason ?? null, reviewStatus: confirm ? 'confirmed' : source.reviewStatus, reviewRevision: source.reviewRevision + Number(confirm) };
    this.rawSources.set(source.id, updated);
    return { source: clone(updated), applied: true };
  }

  async updateRawSourceProcessing(
    id: string,
    userId: string,
    status: RawSource['processingStatus'],
    errorReason: string | null = null,
    expectedReviewRevision?: number,
  ): Promise<RawSource> {
    const existing = this.rawSources.get(id);
    if (!existing || existing.userId !== userId) throw knowledgeError('not_found', `RawSource ${id} not found`);
    if (expectedReviewRevision !== undefined && existing.reviewRevision !== expectedReviewRevision) return clone(existing);
    const updated: RawSource = { ...existing, processingStatus: status, errorReason };
    this.rawSources.set(id, updated);
    return clone(updated);
  }

  async updateRawSource(
    id: string,
    userId: string,
    patch: Partial<Pick<RawSource, 'rawText' | 'sourceType' | 'sourcePlatform' | 'sourceApp' | 'sourceTitle' | 'sourceUrl' | 'capturedAt' | 'metadata'>>,
  ): Promise<RawSource> {
    const existing = this.rawSources.get(id);
    if (!existing || existing.userId !== userId) throw knowledgeError('not_found', `RawSource ${id} not found`);
    const updated: RawSource = { ...existing, ...patch };
    this.rawSources.set(id, updated);
    return clone(updated);
  }

  async findRawSource(id: string, userId: string): Promise<RawSource | null> {
    const found = this.rawSources.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listRawSourcesByIds(ids: string[], userId: string): Promise<RawSource[]> {
    return ids
      .map((id) => this.rawSources.get(id))
      .filter((row): row is RawSource => Boolean(row && row.userId === userId))
      .map(clone);
  }

  async listInbox(input: ListInboxInput): Promise<RawSource[]> {
    const statuses = new Set<ProcessingStatus>(input.statuses ?? []);
    const mine: RawSource[] = [];
    for (const row of this.rawSources.values()) {
      if (row.userId !== input.userId) continue;
      if (input.reviewStatus !== undefined && row.reviewStatus !== input.reviewStatus) continue;
      if (statuses.size > 0 && !statuses.has(row.processingStatus)) continue;
      mine.push(row);
    }
    // Insertion order is oldest-first; the capture feed is newest-first, like the SQL drivers.
    mine.reverse();
    const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_INBOX_PAGE);
    return mine.slice(offset, offset + limit).map(clone);
  }

  async countInboxByStatus(userId: string): Promise<Record<ProcessingStatus, number>> {
    const counts: Record<ProcessingStatus, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of this.rawSources.values()) {
      if (row.userId === userId) counts[row.processingStatus] += 1;
    }
    return counts;
  }

  async countInboxByReviewStatus(userId: string): Promise<Record<ReviewStatus, number>> {
    const counts = { needs_review: 0, confirmed: 0, deferred: 0, rejected: 0 };
    for (const row of this.rawSources.values()) if (row.userId === userId) counts[row.reviewStatus] += 1;
    return counts;
  }

  async markRawSourceConfirmed(id: string, userId: string, onlyInitial = true): Promise<void> {
    const source = this.rawSources.get(id);
    if (!source || source.userId !== userId) throw knowledgeError('not_found', 'Raw source not found');
    if (source.reviewStatus === 'confirmed' || (onlyInitial && (source.reviewRevision !== 0 || source.reviewStatus !== 'needs_review'))) return;
    this.rawSources.set(id, { ...source, reviewStatus: 'confirmed', reviewRevision: source.reviewRevision + 1 });
  }

  async readReviewConfirmation(id: string, userId: string, reviewRevision: number): Promise<RawSourceReviewConfirmation | null> {
    const source = this.rawSources.get(id);
    if (!source || source.userId !== userId || source.reviewStatus !== 'confirmed' || source.reviewRevision !== reviewRevision) return null;
    const actions = [...this.reviewActions].filter(([key]) => {
      const [owner, sourceId] = JSON.parse(key) as string[];
      return owner === userId && sourceId === id;
    }).map(([, action]) => action);
    return reviewConfirmationOf(id, userId, reviewRevision, actions);
  }

  async reviewSource(id: string, userId: string, input: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    // No awaits between revision validation and committing the maps: competing calls cannot interleave.
    const source = this.rawSources.get(id);
    if (!source || source.userId !== userId) throw knowledgeError('not_found', 'Raw source not found');
    const { request, fingerprint } = reviewIntent(input);
    const key = JSON.stringify([userId, id, request.actionId]);
    const prior = this.reviewActions.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw knowledgeError('conflict', 'actionId is already bound to a different review intent');
      return { ...clone(prior.response), duplicate: true };
    }
    const reviewStatus = nextReviewStatus(source, request);
    const response: ReviewSourceResponse = { reviewStatus, reviewRevision: source.reviewRevision + 1, duplicate: false };
    let item: KnowledgeItem | undefined;
    let link: ItemNodeLink | undefined;
    if (request.action === 'confirm') {
      const node = this.nodes.get(request.nodeId);
      if (!node || node.userId !== userId) throw knowledgeError('not_found', 'Target node not found');
      if (node.status === 'archived') throw knowledgeError('conflict', 'Target node is archived');
      const normalizedText = (request.editedText ?? source.rawText).trim();
      if (!normalizedText) throw knowledgeError('invalid_request', 'Nothing to file');
      for (const existing of this.links.values()) {
        const linked = this.items.get(existing.itemId);
        if (existing.userId === userId && existing.nodeId === node.id && linked?.rawSourceId === id && linked.normalizedText.trim() === normalizedText) throw knowledgeError('conflict', 'Source text is already filed under this node');
      }
      const timestamp = nowIso();
      item = { id: createId(), userId, rawSourceId: id, normalizedText, summary: null, confidence: 1, status: 'active', isAiDerived: false, createdAt: timestamp, updatedAt: timestamp };
      link = { id: createId(), userId, itemId: item.id, nodeId: node.id, relationType: 'primary', confidence: 1, createdAt: timestamp };
      const path: PathSegment[] = [];
      const seen = new Set<string>();
      let cursor: KnowledgeNode | undefined = node;
      while (cursor && cursor.userId === userId && !seen.has(cursor.id)) {
        seen.add(cursor.id); path.unshift({ id: cursor.id, title: cursor.title });
        cursor = cursor.parentId === null ? undefined : this.nodes.get(cursor.parentId);
      }
      response.item = item; response.path = path;
    }
    const saved = clone(response);
    if (item && link) { this.items.set(item.id, item); this.links.set(link.id, link); }
    this.rawSources.set(id, { ...source, reviewStatus, reviewRevision: response.reviewRevision, ...(item ? { processingStatus: 'done' as const, errorReason: null } : source.processingStatus === 'processing' ? { processingStatus: 'pending' as const } : {}) });
    const changedAt = nowIso();
    for (const [batchKey, batch] of this.captureBatches) {
      if (batch.userId !== userId || !batch.items.some(item => item.rawSourceId === id)) continue;
      this.captureBatches.set(batchKey, { ...batch, updatedAt: changedAt, items: batch.items.map(item => item.rawSourceId !== id ? item : { ...item, status: reviewStatus === 'confirmed' ? 'done' : 'needs_review', retryable: false, errorReason: null, processingReason: null, updatedAt: changedAt }) });
    }
    this.reviewActions.set(key, { fingerprint, response: saved });
    return clone(saved);
  }

  private createKnowledgeItemSync(input: CreateKnowledgeItemRecordInput): KnowledgeItem {
    const analysisVersion = input.captureAnalysisVersion ?? 1;
    if (!Number.isSafeInteger(analysisVersion) || analysisVersion < 1) {
      throw knowledgeError('invalid_request', 'captureAnalysisVersion must be a positive safe integer');
    }
    let capturePointKey: string | undefined;
    if (input.capturePointIndex !== undefined) {
      if (!Number.isSafeInteger(input.capturePointIndex) || input.capturePointIndex < 0) {
        throw knowledgeError('invalid_request', 'capturePointIndex must be a non-negative safe integer');
      }
      capturePointKey = `${input.userId}\u0000${input.rawSourceId}\u0000${String(analysisVersion)}\u0000${String(input.capturePointIndex)}`;
      const existingId = this.capturePointItems.get(capturePointKey);
      if (existingId !== undefined) {
        const existing = this.items.get(existingId);
        if (existing !== undefined) return clone(existing);
      }
      const legacy = analysisVersion === 1 ? [...this.items.values()].find((item) =>
        item.userId === input.userId && item.rawSourceId === input.rawSourceId &&
        item.normalizedText === input.normalizedText && item.isAiDerived && !this.indexedCapturePointItems.has(item.id)) : undefined;
      if (legacy !== undefined) {
        this.capturePointItems.set(capturePointKey, legacy.id);
        this.indexedCapturePointItems.add(legacy.id);
        return clone(legacy);
      }
    }

    const timestamp = nowIso();
    const record: KnowledgeItem = {
      id: createId(),
      userId: input.userId,
      rawSourceId: input.rawSourceId,
      normalizedText: input.normalizedText,
      summary: input.summary ?? null,
      confidence: input.confidence,
      status: 'active',
      isAiDerived: input.isAiDerived ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.items.set(record.id, record);
    if (capturePointKey !== undefined) {
      this.capturePointItems.set(capturePointKey, record.id);
      this.indexedCapturePointItems.add(record.id);
      this.itemCaptureAnalysisVersions.set(record.id, input.captureAnalysisVersion ?? 1);
    }
    if (input.embedding) this.itemEmbeddings.set(record.id, input.embedding);
    return clone(record);
  }

  async findKnowledgeItem(id: string, userId: string): Promise<KnowledgeItem | null> {
    const found = this.items.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listKnowledgeItemsByIds(ids: string[], userId: string): Promise<KnowledgeItem[]> {
    return ids
      .map((id) => this.items.get(id))
      .filter((row): row is KnowledgeItem => Boolean(row && row.userId === userId))
      .map(clone);
  }

  async listKnowledgeItemsForSource(rawSourceId: string, userId: string): Promise<KnowledgeItem[]> {
    return [...this.items.values()]
      .filter((row) => row.userId === userId && row.rawSourceId === rawSourceId)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt))
      .map(clone);
  }

  async listKnowledgeItemsForNode(nodeId: string, userId: string): Promise<KnowledgeItem[]> {
    const itemIds = [...this.links.values()]
      .filter((link) => link.userId === userId && link.nodeId === nodeId)
      .map((link) => link.itemId);
    const rows = itemIds
      .map((id) => this.items.get(id))
      .filter((row): row is KnowledgeItem => Boolean(row && row.userId === userId));
    return rows.sort((first, second) => second.confidence - first.confidence).map(clone);
  }

  async updateKnowledgeItem(
    id: string,
    userId: string,
    patch: Partial<Pick<KnowledgeItem, 'normalizedText' | 'summary' | 'confidence' | 'status'>>,
  ): Promise<KnowledgeItem> {
    const existing = this.items.get(id);
    if (!existing || existing.userId !== userId) throw knowledgeError('not_found', `KnowledgeItem ${id} not found`);
    const updated: KnowledgeItem = { ...existing, ...patch, updatedAt: nowIso() };
    this.items.set(id, updated);
    return clone(updated);
  }

  private assertCaptureReview(userId: string, rawSourceId: string, expectedReviewRevision: number): void {
    const source = this.rawSources.get(rawSourceId);
    if (!source || source.userId !== userId) throw knowledgeError('not_found', 'Raw source not found');
    if (!Number.isSafeInteger(expectedReviewRevision) || source.reviewRevision !== expectedReviewRevision) throw knowledgeError('conflict', 'Capture review authority changed', { reason: 'capture_review_changed' });
  }

  async createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode> {
    const authority = input.captureAuthority;
    if (!authority) return this.createNodeSync(input);
    this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
    return this.captureMutation(() => {
      const node = this.createNodeSync(input);
      if (node.parentId !== null) this.upsertEdge({ userId: input.userId, fromNodeId: node.id, toNodeId: node.parentId, relationType: 'part_of', confidence: 1, source: 'tree_structure' });
      this.createVersionRecordSync({ userId: input.userId, entityType: 'knowledge_node', entityId: node.id, operation: 'create', before: {}, after: { title: node.title, parentId: node.parentId, nodeType: node.nodeType }, actor: authority.actor });
      return node;
    }, [checkpointMap(this.nodes), checkpointMap(this.nodeEmbeddings), checkpointMap(this.edges), checkpointMap(this.versions)]);
  }

  async createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem> {
    const authority = input.captureAuthority;
    if (!authority) return this.createKnowledgeItemSync(input);
    this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
    return this.captureMutation(() => {
      if (input.rawSourceId !== authority.rawSourceId || input.captureAnalysisVersion !== authority.analysisVersion || input.capturePointIndex !== authority.pointIndex) throw knowledgeError('invalid_request', 'Capture identity mismatch');
      const item = this.createKnowledgeItemSync(input);
      if (!item.isAiDerived) throw knowledgeError('conflict', 'Human knowledge cannot be adopted by capture');
      this.updateCaptureProcessingPlanPointSync(input.userId, authority.rawSourceId, authority.analysisVersion, authority.pointIndex, { knowledgeItemId: item.id, status: 'item_saved' }, authority);
      return item;
    }, [checkpointMap(this.items), checkpointMap(this.itemEmbeddings), checkpointMap(this.capturePointItems), checkpointSet(this.indexedCapturePointItems), checkpointMap(this.itemCaptureAnalysisVersions), checkpointMap(this.captureProcessingPlans)]);
  }

  async linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink> {
    const authority = input.captureAuthority;
    if (!authority) return this.linkItemToNodeSync(input);
    this.assertCaptureReview(input.userId, authority.rawSourceId, authority.expectedReviewRevision);
    return this.captureMutation(() => {
      const item = this.items.get(input.itemId);
      if (!item || item.userId !== input.userId) throw knowledgeError('not_found', 'Knowledge item not found');
      if (item.rawSourceId !== authority.rawSourceId || !item.isAiDerived) throw knowledgeError('conflict', 'Human knowledge cannot receive capture placement');
      const linked = this.linkItemToNodeSync(input);
      this.updateCaptureProcessingPlanPointSync(input.userId, authority.rawSourceId, authority.analysisVersion, authority.pointIndex, { status: 'linked' }, authority);
      return linked;
    }, [checkpointMap(this.links), checkpointMap(this.captureProcessingPlans)]);
  }

  // ponytail: capture-only checkpoints are O(affected map sizes); persistent profiles use SQLite transactions.
  private captureMutation<T>(work: () => T, rollback: Array<() => void>): T {
    try { return work(); } catch (error) { for (const restore of rollback) restore(); throw error; }
  }

  private createNodeSync(input: CreateNodeRecordInput): KnowledgeNode {
    if (input.parentId) {
      const parent = this.nodes.get(input.parentId);
      if (!parent || parent.userId !== input.userId) {
        throw knowledgeError('not_found', `Parent node ${input.parentId} not found`);
      }
    }
    const timestamp = nowIso();
    const record: KnowledgeNode = {
      id: createId(),
      userId: input.userId,
      title: input.title.trim(),
      summary: input.summary ?? null,
      nodeType: input.nodeType ?? 'topic',
      parentId: input.parentId ?? null,
      status: 'active',
      confidence: input.confidence ?? null,
      embeddingModel: input.embeddingModel ?? null,
      masteryLevel: 'collected',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.nodes.set(record.id, record);
    if (input.embedding) this.nodeEmbeddings.set(record.id, input.embedding);
    return clone(record);
  }

  async findNode(id: string, userId: string): Promise<KnowledgeNode | null> {
    const found = this.nodes.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async findNodeByTitle(userId: string, title: string, parentId?: string | null): Promise<KnowledgeNode | null> {
    const key = titleKey(title);
    for (const node of this.nodes.values()) {
      if (node.userId !== userId) continue;
      if (titleKey(node.title) !== key) continue;
      if (parentId !== undefined && node.parentId !== parentId) continue;
      if (node.status === 'archived') continue;
      return clone(node);
    }
    return null;
  }

  async listNodes(userId: string, options: NodeListItemOptions = {}): Promise<KnowledgeNode[]> {
    const includeArchived = options.includeArchived ?? false;
    return [...this.nodes.values()]
      .filter((node) => node.userId === userId)
      .filter((node) =>
        options.status ? node.status === options.status : includeArchived || node.status !== 'archived',
      )
      .sort((first, second) => first.title.localeCompare(second.title))
      .map(clone);
  }

  async listRootNodes(userId: string): Promise<KnowledgeNode[]> {
    return [...this.nodes.values()]
      .filter((node) => node.userId === userId && node.parentId === null && node.status !== 'archived')
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt))
      .map(clone);
  }

  async listChildNodes(userId: string, parentId: string): Promise<KnowledgeNode[]> {
    return [...this.nodes.values()]
      .filter((node) => node.userId === userId && node.parentId === parentId && node.status !== 'archived')
      .sort((first, second) => first.title.localeCompare(second.title))
      .map(clone);
  }

  async updateNode(patch: UpdateNodeInput): Promise<KnowledgeNode> {
    const existing = this.nodes.get(patch.id);
    if (!existing || existing.userId !== patch.userId) {
      throw knowledgeError('not_found', `KnowledgeNode ${patch.id} not found`);
    }
    const updated: KnowledgeNode = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.embeddingModel !== undefined ? { embeddingModel: patch.embeddingModel } : {}),
      updatedAt: nowIso(),
    };
    this.nodes.set(patch.id, updated);
    if (patch.embedding) this.nodeEmbeddings.set(patch.id, patch.embedding);
    return clone(updated);
  }

  async nodePath(userId: string, nodeId: string): Promise<PathSegment[]> {
    const segments: PathSegment[] = [];
    let cursor = this.nodes.get(nodeId);
    const guard = new Set<string>();
    while (cursor && cursor.userId === userId) {
      if (guard.has(cursor.id)) break;
      guard.add(cursor.id);
      segments.unshift({ id: cursor.id, title: cursor.title });
      cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : undefined;
    }
    return segments;
  }

  async moveNode(input: MoveNodeRecordInput): Promise<MoveNodeRecordResult> {
    const node = this.nodes.get(input.nodeId);
    if (!node || node.userId !== input.userId) {
      throw knowledgeError('not_found', `KnowledgeNode ${input.nodeId} not found`);
    }
    if (input.targetParentId === input.nodeId) {
      throw knowledgeError('conflict', 'A node cannot be moved inside itself');
    }
    if (input.targetParentId) {
      const target = this.nodes.get(input.targetParentId);
      if (!target || target.userId !== input.userId) {
        throw knowledgeError('not_found', `Target node ${input.targetParentId} not found`);
      }
      let cursor: KnowledgeNode | undefined = target;
      while (cursor) {
        if (cursor.id === input.nodeId) {
          throw knowledgeError('conflict', 'Cannot move a node inside one of its own descendants');
        }
        cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : undefined;
      }
    }

    if (node.parentId !== null && node.parentId !== input.targetParentId) {
      for (const [edgeId, edge] of this.edges) {
        if (edge.userId === input.userId && edge.fromNodeId === node.id && edge.toNodeId === node.parentId && edge.relationType === 'part_of' && edge.source === 'tree_structure') {
          this.edges.delete(edgeId);
        }
      }
    }

    const before: JsonValue = { parentId: node.parentId };
    const updated: KnowledgeNode = { ...node, parentId: input.targetParentId, updatedAt: nowIso() };
    this.nodes.set(node.id, updated);
    const after: JsonValue = { parentId: updated.parentId };

    if (input.targetParentId) {
      this.upsertEdge({
        userId: input.userId,
        fromNodeId: updated.id,
        toNodeId: input.targetParentId,
        relationType: input.relationType ?? 'part_of',
        confidence: 1,
        source: 'tree_structure',
      });
    }

    const record = await this.createVersionRecord({
      userId: input.userId,
      entityType: 'knowledge_node',
      entityId: updated.id,
      operation: node.parentId === null && input.targetParentId ? 'reparent' : 'move',
      before,
      after,
      actor: input.actor,
    });

    return {
      node: clone(updated),
      versionRecordId: record.id,
      path: await this.nodePath(input.userId, updated.id),
    };
  }

  async nodeStats(userId: string, nodeId: string): Promise<NodeStats> {
    const items = await this.listKnowledgeItemsForNode(nodeId, userId);
    const sourceIds = new Set(items.map((item) => item.rawSourceId));
    const childCount = [...this.nodes.values()].filter(
      (node) => node.userId === userId && node.parentId === nodeId && node.status !== 'archived',
    ).length;
    return { itemCount: items.length, sourceCount: sourceIds.size, childCount };
  }

  private linkItemToNodeSync(input: LinkItemInput): ItemNodeLink {
    const item = this.items.get(input.itemId);
    const node = this.nodes.get(input.nodeId);
    if (!item || item.userId !== input.userId) throw knowledgeError('not_found', `KnowledgeItem ${input.itemId} not found`);
    if (!node || node.userId !== input.userId) throw knowledgeError('not_found', `KnowledgeNode ${input.nodeId} not found`);

    for (const link of this.links.values()) {
      if (link.itemId === input.itemId && link.nodeId === input.nodeId) {
        const merged: ItemNodeLink = { ...link, confidence: Math.max(link.confidence, input.confidence) };
        this.links.set(link.id, merged);
        return clone(merged);
      }
    }
    const record: ItemNodeLink = {
      id: createId(),
      userId: input.userId,
      itemId: input.itemId,
      nodeId: input.nodeId,
      relationType: input.relationType,
      confidence: input.confidence,
      createdAt: nowIso(),
    };
    this.links.set(record.id, record);
    return clone(record);
  }

  async listLinksForItem(itemId: string, userId: string): Promise<ItemNodeLink[]> {
    return [...this.links.values()]
      .filter((link) => link.itemId === itemId && link.userId === userId)
      .map(clone);
  }

  async unlinkItemFromNodes(itemId: string, userId: string): Promise<void> {
    for (const [id, link] of this.links) {
      if (link.itemId === itemId && link.userId === userId) this.links.delete(id);
    }
  }

  async listLinksForNode(nodeId: string, userId: string): Promise<ItemNodeLink[]> {
    return [...this.links.values()]
      .filter((link) => link.nodeId === nodeId && link.userId === userId)
      .map(clone);
  }

  async countItemsForNodes(userId: string, nodeIds: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const nodeId of nodeIds) counts[nodeId] = 0;
    for (const link of this.links.values()) {
      if (link.userId !== userId) continue;
      if (Object.prototype.hasOwnProperty.call(counts, link.nodeId)) counts[link.nodeId] += 1;
    }
    return counts;
  }

  async createItemRelation(input: CreateLibraryRelationRecordInput): Promise<ItemRelation> {
    if (input.fromSourceId === input.targetId) throw knowledgeError('invalid_request', '条目不能关联自身');
    for (const sourceId of [input.fromSourceId, input.targetId]) {
      const source = this.rawSources.get(sourceId);
      if (!source || source.userId !== input.userId) throw knowledgeError('not_found', `收集条目 ${sourceId} 不存在`);
    }
    const key = `${input.fromSourceId}\u0000${input.targetId}`;
    const existing = this.itemRelations.get(key);
    const result: ItemRelation = existing
      ? { ...existing.relation, relation: input.relation, direction: 'outgoing' as const }
      : { targetId: input.targetId, relation: input.relation, direction: 'outgoing', createdAt: nowIso() };
    this.itemRelations.set(key, { userId: input.userId, relation: result });
    return clone(result);
  }

  async listItemRelations(sourceId: string, userId: string): Promise<ItemRelation[]> {
    return [...this.itemRelations.entries()]
      .flatMap(([key, value]) => {
        if (value.userId !== userId) return [];
        const [fromId, targetId] = key.split('\u0000');
        if (fromId === sourceId) return [clone(value.relation)];
        if (targetId === sourceId) return [{ ...clone(value.relation), targetId: fromId ?? '', direction: 'incoming' as const }];
        return [];
      })
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  }

  async deleteItemRelations(sourceId: string, targetId: string, userId: string): Promise<void> {
    for (const [fromId, toId] of [[sourceId, targetId], [targetId, sourceId]]) {
      const key = `${fromId}\u0000${toId}`;
      if (this.itemRelations.get(key)?.userId === userId) this.itemRelations.delete(key);
    }
  }

  async createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge> {
    if (input.captureAuthority) this.assertCaptureReview(input.userId, input.captureAuthority.rawSourceId, input.captureAuthority.expectedReviewRevision);
    return clone(this.upsertEdge(input));
  }

  private upsertEdge(input: CreateEdgeInput): KnowledgeEdge {
    for (const edge of this.edges.values()) {
      if (
        edge.userId === input.userId &&
        edge.fromNodeId === input.fromNodeId &&
        edge.toNodeId === input.toNodeId &&
        edge.relationType === input.relationType
      ) {
        return edge;
      }
    }
    const record: KnowledgeEdge = {
      id: createId(),
      userId: input.userId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relationType: input.relationType,
      confidence: input.confidence ?? null,
      source: input.source,
      createdAt: nowIso(),
    };
    this.edges.set(record.id, record);
    return record;
  }

  async findEdge(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: KnowledgeEdge['relationType'],
  ): Promise<KnowledgeEdge | null> {
    const found = [...this.edges.values()].find(
      (edge) =>
        edge.userId === userId &&
        edge.fromNodeId === fromNodeId &&
        edge.toNodeId === toNodeId &&
        edge.relationType === relationType,
    );
    return found ? clone(found) : null;
  }

  async listEdgesForNode(userId: string, nodeId: string): Promise<KnowledgeEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.userId === userId && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId))
      .map(clone);
  }

  async listEdges(userId: string): Promise<KnowledgeEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.userId === userId)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id))
      .map(clone);
  }

  async deleteEdge(userId: string, fromNodeId: string, toNodeId: string, relationType: EdgeRelation): Promise<void> {
    for (const [id, edge] of this.edges) {
      if (edge.userId === userId && edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId && edge.relationType === relationType) {
        this.edges.delete(id);
      }
    }
  }

  async getKnowledgeNote(userId: string, topicId: string, chapterId: string | null): Promise<KnowledgeNote | null> {
    const found = this.notes.get(`${userId}\u0000${topicId}\u0000${chapterId ?? ''}`);
    return found ? clone(found) : null;
  }

  async listKnowledgeNotes(userId: string, topicId: string): Promise<KnowledgeNoteIndexEntry[]> {
    return [...this.notes.values()]
      .filter((note) => note.userId === userId && note.topicId === topicId)
      .sort((first, second) => {
        if (first.chapterId === null) return second.chapterId === null ? 0 : -1;
        if (second.chapterId === null) return 1;
        return first.chapterId.localeCompare(second.chapterId);
      })
      .map(({ topicId: noteTopicId, chapterId, updatedAt }) => ({ topicId: noteTopicId, chapterId, updatedAt }));
  }

  async saveKnowledgeNote(input: SaveKnowledgeNoteInput): Promise<KnowledgeNote> {
    const topic = this.nodes.get(input.topicId);
    if (!topic || topic.userId !== input.userId) throw knowledgeError('not_found', `KnowledgeNode ${input.topicId} not found`);
    if (input.chapterId !== null) {
      const chapter = this.nodes.get(input.chapterId);
      if (!chapter || chapter.userId !== input.userId) throw knowledgeError('not_found', `KnowledgeNode ${input.chapterId} not found`);
    }
    const key = `${input.userId}\u0000${input.topicId}\u0000${input.chapterId ?? ''}`;
    const current = this.notes.get(key);
    const timestamp = nowIso();
    const saved: KnowledgeNote = {
      userId: input.userId,
      topicId: input.topicId,
      chapterId: input.chapterId,
      content: input.content,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.notes.set(key, saved);
    return clone(saved);
  }

  async searchSimilarItems(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<ItemVectorMatch[]> {
    const limit = options.limit ?? 8;
    const threshold = options.threshold ?? 0;
    const results: ItemVectorMatch[] = [];
    for (const [itemId, vector] of this.itemEmbeddings) {
      const item = this.items.get(itemId);
      if (!item || item.userId !== userId || item.status === 'archived') continue;
      if (options.excludeRawSourceId && item.rawSourceId === options.excludeRawSourceId) continue;
      const score = cosineSimilarity(embedding, vector);
      if (score < threshold) continue;
      results.push({
        itemId,
        rawSourceId: item.rawSourceId,
        nodeId: this.primaryNodeOf(itemId, userId),
        text: item.normalizedText,
        score,
      });
    }
    return results.sort((first, second) => second.score - first.score).slice(0, limit);
  }

  async searchSimilarNodes(
    userId: string,
    embedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<NodeVectorMatch[]> {
    const limit = options.limit ?? 8;
    const threshold = options.threshold ?? 0;
    const results: NodeVectorMatch[] = [];
    for (const [nodeId, vector] of this.nodeEmbeddings) {
      const node = this.nodes.get(nodeId);
      if (!node || node.userId !== userId || node.status === 'archived') continue;
      const score = cosineSimilarity(embedding, vector);
      if (score < threshold) continue;
      results.push({ nodeId, title: node.title, path: await this.nodePath(userId, nodeId), score });
    }
    return results.sort((first, second) => second.score - first.score).slice(0, limit);
  }

  async searchKeyword(userId: string, query: string, options: { limit?: number } = {}): Promise<KeywordMatch[]> {
    const limit = options.limit ?? 12;
    const queryTokens = new Set(tokenize(query));
    const matches: KeywordMatch[] = [];

    for (const item of this.items.values()) {
      if (item.userId !== userId || item.status !== 'active') continue;
      const score = overlapScore(queryTokens, item.normalizedText);
      if (score <= 0) continue;
      matches.push({
        itemId: item.id,
        nodeId: this.primaryNodeOf(item.id, userId),
        title: item.summary ?? item.normalizedText.slice(0, 40),
        text: item.normalizedText,
        score,
      });
    }

    for (const node of this.nodes.values()) {
      if (node.userId !== userId || node.status === 'archived') continue;
      const score = overlapScore(queryTokens, `${node.title} ${node.summary ?? ''}`);
      if (score <= 0) continue;
      matches.push({ itemId: null, nodeId: node.id, title: node.title, text: node.summary ?? '', score });
    }

    return matches.sort((first, second) => second.score - first.score).slice(0, limit);
  }

  async createVersionRecord(input: CreateVersionRecordInput): Promise<VersionRecord> { return this.createVersionRecordSync(input); }

  private createVersionRecordSync(input: CreateVersionRecordInput): VersionRecord {
    const record: VersionRecord = {
      id: createId(),
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      before: input.before,
      after: input.after,
      actor: input.actor,
      createdAt: nowIso(),
    };
    this.versions.set(record.id, record);
    return clone(record);
  }

  async listVersionRecords(userId: string, entityId?: string): Promise<VersionRecord[]> {
    return [...this.versions.values()]
      .filter((record) => record.userId === userId && (!entityId || record.entityId === entityId))
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .map(clone);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const timestamp = nowIso();
    const record: Conversation = {
      id: createId(),
      userId: input.userId,
      nodeId: input.nodeId,
      scope: input.scope,
      title: input.title ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.set(record.id, record);
    return clone(record);
  }

  async findConversation(id: string, userId: string): Promise<Conversation | null> {
    const found = this.conversations.get(id);
    return found && found.userId === userId ? clone(found) : null;
  }

  async listConversations(userId: string, nodeId?: string): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter((row) => row.userId === userId && (!nodeId || row.nodeId === nodeId))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      .map(clone);
  }

  async addMessage(input: AddMessageInput): Promise<ConversationMessage> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.userId !== input.userId) {
      throw knowledgeError('not_found', `Conversation ${input.conversationId} not found`);
    }
    const record: ConversationMessage = {
      id: createId(),
      conversationId: conversation.id,
      role: input.role,
      content: input.content,
      contextNodeId: input.contextNodeId ?? conversation.nodeId,
      createdAt: nowIso(),
    };
    this.messages.set(record.id, record);
    this.conversations.set(conversation.id, { ...conversation, updatedAt: record.createdAt });
    return clone(record);
  }

  async listMessages(conversationId: string, userId: string): Promise<ConversationMessage[]> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return [];
    return [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt))
      .map(clone);
  }

  private primaryNodeOf(itemId: string, userId: string): string | null {
    const link = [...this.links.values()]
      .filter((row) => row.itemId === itemId && row.userId === userId)
      .sort((first, second) => second.confidence - first.confidence)[0];
    return link ? link.nodeId : null;
  }

  /**
   * Nothing here survives the process, and the store is per-process rather than per-tenant, so the
   * totals are the caller's own. The point of reporting them is that a health check must not claim a
   * memory store is a database.
   */
  storageHealth(): StorageHealth {
    return {
      driver: 'memory',
      ok: true,
      detail: {
        volatile: true,
        rawSources: this.rawSources.size,
        knowledgeItems: this.items.size,
        knowledgeNodes: this.nodes.size,
        itemVectors: this.itemEmbeddings.size,
        nodeVectors: this.nodeEmbeddings.size,
      },
    };
  }
}

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

export function createInMemoryRepository(): KnowledgeRepository {
  return new InMemoryRepository();
}
