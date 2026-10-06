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
  KnowledgeNode,
  NodeStatus,
  ProcessingStatus,
  RawSource,
  UpdateNodeInput,
  VersionedEntity,
  VersionRecord,
  StructureOperation,
  JsonValue,
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
export interface CreateKnowledgeItemRecordInput extends CreateKnowledgeItemInput {
  embedding?: number[];
  embeddingModel?: string | null;
  embeddingStatus?: EmbeddingStatus;
}

export interface CreateNodeRecordInput extends CreateNodeInput {
  embedding?: number[];
  embeddingModel?: string | null;
  embeddingStatus?: EmbeddingStatus;
}

export interface LinkItemInput {
  userId: string;
  itemId: string;
  nodeId: string;
  relationType: ItemLinkRelation;
  confidence: number;
}

export interface CreateEdgeInput {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: EdgeRelation;
  confidence?: number | null;
  source: string;
}

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
  limit?: number;
  offset?: number;
}

export interface NodeStats {
  itemCount: number;
  sourceCount: number;
  childCount: number;
}

/**
 * The single seam between business logic and persistence.
 * Local-first ships another implementation of this interface without touching
 * Knowledge Core — see PROJECT_MASTER §7.2.
 */
export interface KnowledgeRepository {
  readonly driver: StorageDriverName;

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
  updateRawSourceProcessing(
    id: string,
    userId: string,
    status: ProcessingStatus,
    errorReason?: string | null,
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
  listLinksForNode(nodeId: string, userId: string): Promise<ItemNodeLink[]>;
  countItemsForNodes(userId: string, nodeIds: string[]): Promise<Record<string, number>>;

  createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge>;
  findEdge(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: EdgeRelation,
  ): Promise<KnowledgeEdge | null>;
  listEdgesForNode(userId: string, nodeId: string): Promise<KnowledgeEdge[]>;

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
