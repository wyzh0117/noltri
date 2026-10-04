import type {
  Conversation,
  ConversationMessage,
  CreateRawSourceInput,
  ItemNodeLink,
  JsonValue,
  KnowledgeEdge,
  KnowledgeItem,
  KnowledgeNode,
  RawSource,
  UpdateNodeInput,
  VersionRecord,
} from '@noltri/schema';
import { cosineSimilarity, createId, knowledgeError, nowIso, tokenize, uniqueTokens } from '@noltri/shared';
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

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

const titleKey = (title: string) => title.trim().toLowerCase();

export class InMemoryRepository implements KnowledgeRepository {
  readonly driver: StorageDriverName = 'memory';

  private readonly rawSources = new Map<string, RawSource>();
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly itemEmbeddings = new Map<string, number[]>();
  private readonly nodes = new Map<string, KnowledgeNode>();
  private readonly nodeEmbeddings = new Map<string, number[]>();
  private readonly links = new Map<string, ItemNodeLink>();
  private readonly edges = new Map<string, KnowledgeEdge>();
  private readonly versions = new Map<string, VersionRecord>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ConversationMessage>();

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
      metadata: input.metadata ?? {},
      processingStatus: 'pending',
      errorReason: null,
      createdAt: nowIso(),
    };
    this.rawSources.set(record.id, record);
    return clone(record);
  }

  async updateRawSourceProcessing(
    id: string,
    userId: string,
    status: RawSource['processingStatus'],
    errorReason: string | null = null,
  ): Promise<RawSource> {
    const existing = this.rawSources.get(id);
    if (!existing || existing.userId !== userId) throw knowledgeError('not_found', `RawSource ${id} not found`);
    const updated: RawSource = { ...existing, processingStatus: status, errorReason };
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

  async createKnowledgeItem(input: CreateKnowledgeItemRecordInput): Promise<KnowledgeItem> {
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

  async createNode(input: CreateNodeRecordInput): Promise<KnowledgeNode> {
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

  async linkItemToNode(input: LinkItemInput): Promise<ItemNodeLink> {
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

  async createEdge(input: CreateEdgeInput): Promise<KnowledgeEdge> {
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

  async createVersionRecord(input: CreateVersionRecordInput): Promise<VersionRecord> {
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
