import type {
  Conversation,
  ConversationMessage,
  CreateKnowledgeItemInput,
  CreateNodeInput,
  CreateRawSourceInput,
  EdgeRelation,
  EmbeddingStatus,
  ItemLinkRelation,
  ItemNodeLink,
  KnowledgeEdge,
  KnowledgeItem,
  KnowledgeNote,
  KnowledgeNode,
  ItemRelation,
  ItemRelationKind,
  NodeStatus,
  ProcessingStatus,
  RawSource,
  RawSourceReviewConfirmation,
  ReviewStatus,
  ReviewSourceRequest,
  ReviewSourceResponse,
  UpdateNodeInput,
  VersionedEntity,
  VersionRecord,
  StructureOperation,
  JsonValue,
  CaptureAssetMime,
  CaptureAction,
  CaptureBatchItemRequest,
  CaptureBatchItemStatus,
  CaptureProcessingReason,
  ProcessingRulesSnapshot,
  CaptureAssetRef,
  CaptureRecognitionSnapshot,
  CaptureRecognitionEntry,
} from '@noltri/schema';

export type StorageDriverName = 'memory' | 'sqlite';

/**
 * What a driver can state about itself without a network round trip or a full scan — the payload
 * `GET /api/health` shows. `ok` means "this driver believes it can serve reads and writes"; a driver
 * that is missing a capability it needs (SQLite without FTS5, a schema it did not migrate) reports false.
 */
export interface StorageHealth {
  readonly driver: StorageDriverName;
  readonly ok: boolean;
  /** Driver-specific facts. Never a credential, a connection string or anything else worth leaking. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PathSegment {
  id: string;
  title: string;
}

export interface ItemVectorMatch {
  itemId: string;
  rawSourceId: string;
  nodeId: string | null;
  text: string;
  score: number;
}

export interface NodeVectorMatch {
  nodeId: string;
  title: string;
  path: PathSegment[];
  score: number;
}

export interface KeywordMatch {
  itemId: string | null;
  nodeId: string | null;
  title: string;
  text: string;
  score: number;
}

export interface VectorSearchOptions {
  limit?: number;
  threshold?: number;
  /** Skip matches produced by the capture currently being processed. */
  excludeRawSourceId?: string;
  statusExclude?: ProcessingStatus[];
}

/**
 * `embeddingStatus` is written only when the caller states it. Repositories must never derive it
 * from `embeddingModel` or from whether a vector happens to be present.
 */
export interface FinishCaptureProcessingInput {
  userId: string;
  rawSourceId: string;
  expectedReviewRevision: number;
  status: 'pending' | 'done' | 'failed';
  errorReason?: string | null;
  confirmIfInitial?: boolean;
}
export interface CaptureProcessingOutcome { source: RawSource; applied: boolean }

export interface CaptureReviewAuthority {
  rawSourceId: string;
  expectedReviewRevision: number;
  analysisVersion: number;
  pointIndex: number;
  actor: string;
}

export interface CreateKnowledgeItemRecordInput extends CreateKnowledgeItemInput {
  captureAuthority?: CaptureReviewAuthority;
  /** Zero-based extracted-point identity, scoped to rawSourceId so retry does not duplicate one source. */
  capturePointIndex?: number;
  /** Explicit reanalysis receives a separate identity; ordinary retries reuse the same frozen version. */
  captureAnalysisVersion?: number;
  embedding?: number[];
  embeddingModel?: string | null;
  embeddingStatus?: EmbeddingStatus;
}

export interface CreateNodeRecordInput extends CreateNodeInput {
  captureAuthority?: CaptureReviewAuthority;
  embedding?: number[];
  embeddingModel?: string | null;
  embeddingStatus?: EmbeddingStatus;
}

export interface LinkItemInput {
  captureAuthority?: CaptureReviewAuthority;
  userId: string;
  itemId: string;
  nodeId: string;
  relationType: ItemLinkRelation;
  confidence: number;
}

export interface CreateEdgeInput {
  captureAuthority?: CaptureReviewAuthority;
  userId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: EdgeRelation;
  confidence?: number | null;
  source: string;
}

export interface SaveKnowledgeNoteInput {
  userId: string;
  topicId: string;
  chapterId: string | null;
  content: string;
}

export type KnowledgeNoteIndexEntry = Pick<KnowledgeNote, 'topicId' | 'chapterId' | 'updatedAt'>;

export interface MoveNodeRecordInput {
  userId: string;
  nodeId: string;
  /** null moves the node to the root of the tree. */
  targetParentId: string | null;
  actor: string;
  relationType?: EdgeRelation;
}

export interface MoveNodeRecordResult {
  node: KnowledgeNode;
  versionRecordId: string;
  path: PathSegment[];
}

export interface CreateVersionRecordInput {
  userId: string;
  entityType: VersionedEntity;
  entityId: string;
  operation: StructureOperation;
  before: JsonValue;
  after: JsonValue;
  actor: string;
}

export interface CreateConversationInput {
  userId: string;
  nodeId: string | null;
  scope: Conversation['scope'];
  title?: string | null;
}

export interface AddMessageInput {
  userId: string;
  conversationId: string;
  role: ConversationMessage['role'];
  content: string;
  contextNodeId?: string | null;
}

export interface NodeListItemOptions {
  status?: NodeStatus;
  includeArchived?: boolean;
}

export interface ListInboxInput {
  userId: string;
  /** Omitted means "every status"; the Inbox passes the ones still needing attention. */
  statuses?: ProcessingStatus[];
  reviewStatus?: ReviewStatus;
  limit?: number;
  offset?: number;
}

export interface CreateLibraryRelationRecordInput {
  userId: string;
  fromSourceId: string;
  targetId: string;
  relation: ItemRelationKind;
}

export interface NodeStats {
  itemCount: number;
  sourceCount: number;
  childCount: number;
}

export interface PutCaptureAssetInput {
  userId: string;
  sessionId: string;
  assetId: string;
  mimeType: CaptureAssetMime;
  sha256: string;
  bytes: Uint8Array;
}

export interface StoredCaptureAsset extends PutCaptureAssetInput {
  byteLength: number;
  createdAt: string;
}

export type CapturePlanPointStatus = 'pending' | 'decision_saved' | 'placement_saved' | 'item_saved' | 'linked' | 'complete';

export interface CapturePlanDecision {
  strategy: 'manual' | 'merge' | 'attach' | 'create';
  action: CaptureAction;
  nodeId: string | null;
  path: string[];
  linkConfidence: number;
  nodeConfidence: number;
  provenanceNodeId: string | null;
  relatedNodeId: string | null;
}

export interface CapturePlanPlacement {
  targetNodeId: string;
  action: CaptureAction;
  linkConfidence: number;
  provenanceNodeId: string | null;
  relatedNodeId: string | null;
}

export interface CaptureProcessingPlanPoint {
  pointIndex: number;
  point: { text: string; summary: string | null; confidence: number; title: string };
  embedding: number[] | null;
  embeddingModel: string | null;
  decision: CapturePlanDecision | null;
  placement: CapturePlanPlacement | null;
  knowledgeItemId: string | null;
  status: CapturePlanPointStatus;
}

export interface CaptureProcessingPlan {
  userId: string;
  rawSourceId: string;
  analysisVersion: number;
  points: CaptureProcessingPlanPoint[];
  rulesSnapshot: ProcessingRulesSnapshot | null;
  extractionReady: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCaptureProcessingPlanInput {
  expectedReviewRevision: number;
  userId: string;
  rawSourceId: string;
  rulesSnapshot: ProcessingRulesSnapshot;
  newVersion?: boolean;
  expectedAnalysisVersion?: number;
}

export type CaptureProcessingPlanPointPatch = Partial<Omit<CaptureProcessingPlanPoint, 'pointIndex' | 'point'>>;

export interface CreateCaptureBatchInput {
  userId: string;
  batchId: string;
  sessionId: string;
  payloadHash: string;
  items: CaptureBatchItemRequest[];
}

export interface StoredCaptureBatchItem extends CaptureBatchItemRequest {
  status: CaptureBatchItemStatus;
  rawSourceId: string | null;
  duplicate: boolean;
  retryable: boolean;
  errorReason: string | null;
  processingReason: CaptureProcessingReason | null;
  updatedAt: string;
}

export interface StoredCaptureBatch {
  userId: string;
  batchId: string;
  sessionId: string;
  payloadHash: string;
  items: StoredCaptureBatchItem[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredCaptureRecognitionSnapshot extends CaptureRecognitionSnapshot { userId: string; rawSourceId: string }
export interface CreateCaptureRecognitionSnapshotInput { expectedReviewRevision?: number; userId: string; rawSourceId: string; inputFingerprint: string; inputs: CaptureAssetRef[] }
export type SaveCaptureRecognitionResultInput = Omit<CaptureRecognitionEntry, 'createdAt'>;

export interface CaptureBatchItemPatch {
  status?: CaptureBatchItemStatus;
  rawSourceId?: string | null;
  duplicate?: boolean;
  retryable?: boolean;
  errorReason?: string | null;
  processingReason?: CaptureProcessingReason | null;
}

/**
 * The single seam between business logic and persistence.
 * Local-first ships another implementation of this interface without touching
 * Knowledge Core — see PROJECT_MASTER §7.2.
 */
export interface KnowledgeRepository {
  readonly driver: StorageDriverName;

  putCaptureAsset(input: PutCaptureAssetInput): Promise<{ asset: StoredCaptureAsset; duplicate: boolean }>;
  getCaptureAsset(userId: string, sessionId: string, assetId: string): Promise<StoredCaptureAsset | null>;
  createCaptureBatch(input: CreateCaptureBatchInput): Promise<{ batch: StoredCaptureBatch; duplicate: boolean }>;
  listCaptureBatches(userId: string, limit: number): Promise<StoredCaptureBatch[]>;
  getCaptureBatch(userId: string, batchId: string): Promise<StoredCaptureBatch | null>;
  updateCaptureBatchItem(
    userId: string,
    batchId: string,
    requestId: string,
    patch: CaptureBatchItemPatch,
    expectedReviewRevision?: number,
  ): Promise<StoredCaptureBatch>;
  createCaptureRecognitionSnapshot(input: CreateCaptureRecognitionSnapshotInput): Promise<StoredCaptureRecognitionSnapshot>;
  getCaptureRecognitionSnapshot(userId: string, rawSourceId: string): Promise<StoredCaptureRecognitionSnapshot | null>;
  saveCaptureRecognitionResult(userId: string, rawSourceId: string, entry: SaveCaptureRecognitionResultInput, expectedReviewRevision?: number): Promise<StoredCaptureRecognitionSnapshot>;
  claimCaptureBatchItemForProcessing(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch>;
  claimCaptureBatchItemForRetry(userId: string, batchId: string, requestId: string): Promise<StoredCaptureBatch>;
  /** Marks queued text and interrupted processing items as retryable after a process restart. */
  recoverInterruptedCaptureBatches(): Promise<number>;

  reserveCaptureProcessingPlan(input: ReserveCaptureProcessingPlanInput): Promise<CaptureProcessingPlan>;
  completeCaptureProcessingPlanExtraction(userId: string, rawSourceId: string, analysisVersion: number, points: CaptureProcessingPlanPoint[], expectedReviewRevision?: number): Promise<CaptureProcessingPlan>;
  /** Returns the requested immutable analysis version, or the latest version when omitted. */
  getCaptureProcessingPlan(userId: string, rawSourceId: string, analysisVersion?: number): Promise<CaptureProcessingPlan | null>;
  /** Creates version 1 once; if a plan already exists, returns its latest frozen version unchanged. */
  createCaptureProcessingPlan(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan>;
  /** Explicit reanalysis appends a new version without replacing prior snapshots or KnowledgeItems. */
  createCaptureProcessingPlanVersion(
    userId: string, rawSourceId: string, points: CaptureProcessingPlanPoint[],
  ): Promise<CaptureProcessingPlan>;
  updateCaptureProcessingPlanPoint(
    userId: string, rawSourceId: string, analysisVersion: number, pointIndex: number,
    patch: CaptureProcessingPlanPointPatch,
    captureAuthority?: CaptureReviewAuthority,
  ): Promise<CaptureProcessingPlan>;

  /** One atomic source-scoped revision/action/item/link commit; replay precedes revision checks. */
  reviewSource(id: string, userId: string, request: ReviewSourceRequest): Promise<ReviewSourceResponse>;
  /** Exact read-only human confirmation snapshot; unavailable/corrupt/ambiguous actions return null. */
  readReviewConfirmation(id: string, userId: string, reviewRevision: number): Promise<RawSourceReviewConfirmation | null>;
  countInboxByReviewStatus(userId: string): Promise<Record<ReviewStatus, number>>;
  /** Automatic confirmation cannot overwrite any human action. Legacy assign may explicitly confirm. */
  markRawSourceConfirmed(id: string, userId: string, onlyInitial?: boolean): Promise<void>;

  createRawSource(input: CreateRawSourceInput): Promise<RawSource>;
  /**
   * The capture's idempotency pair. Returns the source a client already submitted under this key, or null
   * when nothing was written for it — including when another user or another entry point holds that key,
   * because the pair is scoped to one owner.
   */
  findRawSourceByIdempotencyKey(
    userId: string,
    clientId: string,
    requestId: string,
  ): Promise<RawSource | null>;
  finishCaptureProcessing(input: FinishCaptureProcessingInput): Promise<CaptureProcessingOutcome>;
  updateRawSourceProcessing(
    id: string,
    userId: string,
    status: ProcessingStatus,
    errorReason?: string | null,
    expectedReviewRevision?: number,
  ): Promise<RawSource>;
  updateRawSource(
    id: string,
    userId: string,
    patch: Partial<Pick<RawSource, 'rawText' | 'sourceType' | 'sourcePlatform' | 'sourceApp' | 'sourceTitle' | 'sourceUrl' | 'capturedAt' | 'metadata'>>,
  ): Promise<RawSource>;
  findRawSource(id: string, userId: string): Promise<RawSource | null>;
  listRawSourcesByIds(ids: string[], userId: string): Promise<RawSource[]>;
  /** Newest-first capture feed behind 收件箱; `statuses` narrows it to the unfinished rows. */
  listInbox(input: ListInboxInput): Promise<RawSource[]>;
  /** Whole-library totals per status, so a paginated list can still show honest badges. */
  countInboxByStatus(userId: string): Promise<Record<ProcessingStatus, number>>;

  createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem>;
  findKnowledgeItem(id: string, userId: string): Promise<KnowledgeItem | null>;
  listKnowledgeItemsByIds(ids: string[], userId: string): Promise<KnowledgeItem[]>;
  listKnowledgeItemsForSource(rawSourceId: string, userId: string): Promise<KnowledgeItem[]>;
  listKnowledgeItemsForNode(nodeId: string, userId: string): Promise<KnowledgeItem[]>;
  updateKnowledgeItem(
    id: string,
    userId: string,
    patch: Partial<Pick<KnowledgeItem, 'normalizedText' | 'summary' | 'confidence' | 'status'>>,
  ): Promise<KnowledgeItem>;

  createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode>;
  findNode(id: string, userId: string): Promise<KnowledgeNode | null>;
  findNodeByTitle(userId: string, title: string, parentId?: string | null): Promise<KnowledgeNode | null>;
  listNodes(userId: string, options?: NodeListItemOptions): Promise<KnowledgeNode[]>;
  listRootNodes(userId: string): Promise<KnowledgeNode[]>;
  listChildNodes(userId: string, parentId: string): Promise<KnowledgeNode[]>;
  updateNode(patch: UpdateNodeInput): Promise<KnowledgeNode>;
  nodePath(userId: string, nodeId: string): Promise<PathSegment[]>;
  /** Cycle-safe re-parent that writes its own VersionRecord. */
  moveNode(input: MoveNodeRecordInput): Promise<MoveNodeRecordResult>;
  nodeStats(userId: string, nodeId: string): Promise<NodeStats>;

  linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink>;
  listLinksForItem(itemId: string, userId: string): Promise<ItemNodeLink[]>;
  unlinkItemFromNodes(itemId: string, userId: string): Promise<void>;
  listLinksForNode(nodeId: string, userId: string): Promise<ItemNodeLink[]>;
  countItemsForNodes(userId: string, nodeIds: string[]): Promise<Record<string, number>>;

  createItemRelation(input: CreateLibraryRelationRecordInput): Promise<ItemRelation>;
  listItemRelations(sourceId: string, userId: string): Promise<ItemRelation[]>;
  deleteItemRelations(sourceId: string, targetId: string, userId: string): Promise<void>;

  createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge>;
  findEdge(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: EdgeRelation,
  ): Promise<KnowledgeEdge | null>;
  listEdgesForNode(userId: string, nodeId: string): Promise<KnowledgeEdge[]>;
  listEdges(userId: string): Promise<KnowledgeEdge[]>;
  deleteEdge(userId: string, fromNodeId: string, toNodeId: string, relationType: EdgeRelation): Promise<void>;

  getKnowledgeNote(userId: string, topicId: string, chapterId: string | null): Promise<KnowledgeNote | null>;
  listKnowledgeNotes(userId: string, topicId: string): Promise<KnowledgeNoteIndexEntry[]>;
  saveKnowledgeNote(input: SaveKnowledgeNoteInput): Promise<KnowledgeNote>;

  searchSimilarItems(
    userId: string,
    embedding: number[],
    options?: VectorSearchOptions,
  ): Promise<ItemVectorMatch[]>;
  searchSimilarNodes(
    userId: string,
    embedding: number[],
    options?: VectorSearchOptions,
  ): Promise<NodeVectorMatch[]>;
  searchKeyword(userId: string, query: string, options?: { limit?: number }): Promise<KeywordMatch[]>;

  createVersionRecord(input: CreateVersionRecordInput): Promise<VersionRecord>;
  listVersionRecords(userId: string, entityId?: string): Promise<VersionRecord[]>;

  createConversation(input: CreateConversationInput): Promise<Conversation>;
  findConversation(id: string, userId: string): Promise<Conversation | null>;
  listConversations(userId: string, nodeId?: string): Promise<Conversation[]>;
  addMessage(input: AddMessageInput): Promise<ConversationMessage>;
  listMessages(conversationId: string, userId: string): Promise<ConversationMessage[]>;

  storageHealth(): StorageHealth;
}
