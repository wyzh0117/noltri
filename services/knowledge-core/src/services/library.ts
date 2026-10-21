import type {
  CreateLibraryItemInput,
  ItemRelation,
  LibraryItem,
  LibraryItemsQuery,
  LibraryMetadata,
  PatchLibraryItemInput,
  RawSource,
} from '@noltri/schema';
import { captureSourceUrlSchema, libraryMetadataSchema, previewImageUrlSchema } from '@noltri/schema';
import { buildCaptureRequest } from '@noltri/api-client';
import type { CreateNodeRecordInput, KnowledgeRepository, ListInboxInput } from '@noltri/storage';
import { knowledgeError, nowIso } from '@noltri/shared';
import type { KnowledgeCore } from '../core';
import type { ActorContext } from '../types';
import { nodeTypeForPath } from '../node-taxonomy';

const PAGE_SCAN_SIZE = 200;

function metadataFor(source: RawSource): LibraryMetadata {
  const value = source.metadata.library;
  const input = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : value;
  if (input !== null && typeof input === 'object' && 'previewImageUrl' in input) {
    const preview = input.previewImageUrl;
    if (typeof preview === 'string' && !previewImageUrlSchema.safeParse(preview).success) {
      input.previewImageUrl = null;
    }
  }
  const parsed = libraryMetadataSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

function safeSourceUrl(value: string | null): string | null {
  if (value === null) return null;
  const parsed = captureSourceUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isArchived(source: RawSource): boolean {
  return metadataFor(source).archivedAt != null;
}

function sourceTypeForActor(actor: string): 'extension' | 'desktop' | 'mcp' | 'web_app' {
  if (actor === 'extension' || actor === 'mcp' || actor === 'web_app') return actor;
  return 'desktop';
}

async function subjectPathFor(
  repository: KnowledgeRepository,
  source: RawSource,
  userId: string,
  metadata: LibraryMetadata,
): Promise<string[]> {
  if (metadata.subjectPath && metadata.subjectPath.length > 0) return metadata.subjectPath;
  const points = await repository.listKnowledgeItemsForSource(source.id, userId);
  for (const point of points) {
    const links = await repository.listLinksForItem(point.id, userId);
    const primary = links[0];
    if (primary) return (await repository.nodePath(userId, primary.nodeId)).map((segment) => segment.title);
  }
  return [];
}

async function toLibraryItem(
  repository: KnowledgeRepository,
  source: RawSource,
  userId: string,
): Promise<LibraryItem> {
  const metadata = metadataFor(source);
  const points = await repository.listKnowledgeItemsForSource(source.id, userId);
  const summary = points.find((item) => item.summary)?.summary ?? null;
  return {
    id: source.id,
    content: source.rawText,
    summary,
    kind: metadata.kind ?? (source.sourceUrl !== null && source.sourceType === 'web' ? 'web_page' : 'knowledge'),
    source: {
      type: source.sourceType,
      title: source.sourceTitle,
      url: safeSourceUrl(source.sourceUrl),
      platform: source.sourcePlatform,
      appName: source.sourceApp,
      capturedAt: source.capturedAt,
      citation: metadata.citation ?? null,
      page: metadata.page ?? null,
      author: metadata.author ?? null,
      doi: metadata.doi ?? null,
    },
    previewImageUrl: typeof metadata.previewImageUrl === 'string' && previewImageUrlSchema.safeParse(metadata.previewImageUrl).success
      ? metadata.previewImageUrl
      : null,
    subjectPath: await subjectPathFor(repository, source, userId, metadata),
    researchPoint: metadata.researchPoint ?? null,
    tags: metadata.tags ?? [],
    aiStatus: source.processingStatus === 'done' ? 'ready' : source.processingStatus,
    createdAt: source.createdAt,
    archived: metadata.archivedAt != null,
  };
}

function searchText(item: LibraryItem): string {
  return [
    item.id,
    item.content,
    item.summary,
    item.kind,
    item.source.type,
    item.source.title,
    item.source.url,
    item.source.platform,
    item.source.appName,
    item.source.capturedAt,
    item.source.citation,
    item.source.page,
    item.source.author,
    item.source.doi,
    item.previewImageUrl,
    ...item.subjectPath,
    item.researchPoint,
    ...item.tags,
    item.aiStatus,
    item.createdAt,
  ].filter((value): value is string => typeof value === 'string').join('\n').toLocaleLowerCase();
}

async function belongsToNode(
  repository: KnowledgeRepository,
  source: RawSource,
  userId: string,
  nodeId: string,
): Promise<boolean> {
  const points = await repository.listKnowledgeItemsForSource(source.id, userId);
  for (const point of points) {
    const links = await repository.listLinksForItem(point.id, userId);
    for (const link of links) {
      const path = await repository.nodePath(userId, link.nodeId);
      if (path.some((segment) => segment.id === nodeId)) return true;
    }
  }
  for (const link of metadataFor(source).archivedLinks ?? []) {
    const path = await repository.nodePath(userId, link.nodeId);
    if (path.some((segment) => segment.id === nodeId)) return true;
  }
  return false;
}

export async function listLibraryItems(
  core: KnowledgeCore,
  actor: ActorContext,
  query: LibraryItemsQuery,
): Promise<{ items: LibraryItem[]; limit: number; offset: number }> {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const needed = offset + limit;
  const needle = query.query?.trim().toLocaleLowerCase() || undefined;
  const matched: { source: RawSource; item?: LibraryItem }[] = [];
  let scanOffset = 0;

  while (matched.length < needed) {
    const input: ListInboxInput = { userId: actor.userId, limit: PAGE_SCAN_SIZE, offset: scanOffset };
    const page = await core.deps.repository.listInbox(input);
    for (const source of page) {
      const archived = isArchived(source);
      if (query.state === 'archive' ? !archived : archived && (query.state !== undefined || !query.includeArchived)) continue;
      const sourceKind = metadataFor(source).kind
        ?? (source.sourceUrl !== null && source.sourceType === 'web' ? 'web_page' : 'knowledge');
      if (query.kind && sourceKind !== query.kind) continue;
      if (query.state === 'organize' && source.processingStatus === 'done') continue;
      if (query.nodeId && !(await belongsToNode(core.deps.repository, source, actor.userId, query.nodeId))) continue;
      let item: LibraryItem | undefined;
      if (needle !== undefined) {
        // ponytail: full scan keeps the existing schema and repository API; add indexed search only if collection size makes this slow.
        item = await toLibraryItem(core.deps.repository, source, actor.userId);
        if (!searchText(item).includes(needle)) continue;
      }
      matched.push({ source, ...(item === undefined ? {} : { item }) });
      if (matched.length >= needed) break;
    }
    if (page.length < PAGE_SCAN_SIZE) break;
    scanOffset += page.length;
  }

  const selected = matched.slice(offset, offset + limit);
  const items = await Promise.all(selected.map(({ source, item }) => item ?? toLibraryItem(core.deps.repository, source, actor.userId)));
  return { items, limit, offset };
}

export async function readLibraryItem(core: KnowledgeCore, actor: ActorContext, id: string): Promise<LibraryItem> {
  const source = await core.deps.repository.findRawSource(id, actor.userId);
  if (!source || isArchived(source)) throw knowledgeError('not_found', `收集条目 ${id} 不存在`);
  return toLibraryItem(core.deps.repository, source, actor.userId);
}

export async function createLibraryItem(
  core: KnowledgeCore,
  actor: ActorContext,
  input: CreateLibraryItemInput,
): Promise<{ item: LibraryItem }> {
  const request = buildCaptureRequest({
    text: input.content,
    source: {
      type: input.source.type,
      ...(input.source.title === undefined ? {} : { title: input.source.title }),
      ...(input.source.url === undefined ? {} : { url: input.source.url }),
      ...(input.source.platform === undefined ? {} : { platform: input.source.platform }),
      ...(input.source.appName === undefined ? {} : { appName: input.source.appName }),
    },
    library: {
      kind: input.kind,
      ...(input.subjectPath === undefined ? {} : { subjectPath: input.subjectPath }),
      ...(input.researchPoint === undefined ? {} : { researchPoint: input.researchPoint }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.previewImageUrl === undefined ? {} : { previewImageUrl: input.previewImageUrl }),
      ...(input.source.citation === undefined ? {} : { citation: input.source.citation }),
      ...(input.source.page === undefined ? {} : { page: input.source.page }),
      ...(input.source.author === undefined ? {} : { author: input.source.author }),
      ...(input.source.doi === undefined ? {} : { doi: input.source.doi }),
    },
    client: sourceTypeForActor(actor.actor),
    ...(input.source.capturedAt === undefined ? {} : { capturedAt: input.source.capturedAt }),
  });
  const result = await core.capture(request, actor);
  if (result.duplicate) {
    const existing = await core.deps.repository.findRawSource(result.rawSourceId, actor.userId);
    if (existing) {
      const library = { ...metadataFor(existing), ...request.library };
      await core.deps.repository.updateRawSource(existing.id, actor.userId, {
        metadata: { ...existing.metadata, library },
      });
    }
  }
  if (input.subjectPath && input.subjectPath.length > 0) {
    await setSubjectPath(core.deps.repository, result.rawSourceId, actor, input.subjectPath);
  }
  return { item: await readLibraryItem(core, actor, result.rawSourceId) };
}

export async function patchLibraryItem(
  core: KnowledgeCore,
  actor: ActorContext,
  id: string,
  patch: PatchLibraryItemInput,
): Promise<{ item: LibraryItem }> {
  const repository = core.deps.repository;
  const existing = await repository.findRawSource(id, actor.userId);
  if (!existing || isArchived(existing)) throw knowledgeError('not_found', `收集条目 ${id} 不存在`);

  const oldMetadata = metadataFor(existing);
  const nextMetadata: LibraryMetadata = {
    ...oldMetadata,
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.subjectPath === undefined ? {} : { subjectPath: patch.subjectPath }),
    ...(patch.researchPoint === undefined ? {} : { researchPoint: patch.researchPoint }),
    ...(patch.tags === undefined ? {} : { tags: patch.tags }),
    ...(patch.previewImageUrl === undefined ? {} : { previewImageUrl: patch.previewImageUrl }),
    ...(patch.source?.citation === undefined ? {} : { citation: patch.source.citation }),
    ...(patch.source?.page === undefined ? {} : { page: patch.source.page }),
    ...(patch.source?.author === undefined ? {} : { author: patch.source.author }),
    ...(patch.source?.doi === undefined ? {} : { doi: patch.source.doi }),
  };
  const sourcePatch: Parameters<typeof repository.updateRawSource>[2] = {
    ...(patch.content === undefined ? {} : { rawText: patch.content }),
    ...(patch.source?.type === undefined ? {} : { sourceType: patch.source.type }),
    ...(patch.source?.platform === undefined ? {} : { sourcePlatform: patch.source.platform ?? null }),
    ...(patch.source?.appName === undefined ? {} : { sourceApp: patch.source.appName ?? null }),
    ...(patch.source?.title === undefined ? {} : { sourceTitle: patch.source.title ?? null }),
    ...(patch.source?.url === undefined ? {} : { sourceUrl: patch.source.url ?? null }),
    ...(patch.source?.capturedAt === undefined ? {} : { capturedAt: patch.source.capturedAt }),
    metadata: { ...existing.metadata, library: nextMetadata },
  };
  await repository.updateRawSource(id, actor.userId, sourcePatch);
  if (patch.content !== undefined && patch.content !== existing.rawText) {
    await repository.updateRawSourceProcessing(id, actor.userId, 'pending');
    const points = await repository.listKnowledgeItemsForSource(id, actor.userId);
    for (const point of points) {
      if (!point.isAiDerived) await repository.updateKnowledgeItem(point.id, actor.userId, { normalizedText: patch.content });
    }
  }
  if (patch.subjectPath !== undefined) await setSubjectPath(repository, id, actor, patch.subjectPath);
  return { item: await readLibraryItem(core, actor, id) };
}

async function setSubjectPath(
  repository: KnowledgeRepository,
  sourceId: string,
  actor: ActorContext,
  titles: readonly string[],
): Promise<void> {
  const points = await repository.listKnowledgeItemsForSource(sourceId, actor.userId);
  if (titles.length === 0) {
    for (const point of points) await repository.unlinkItemFromNodes(point.id, actor.userId);
    await repository.updateRawSourceProcessing(sourceId, actor.userId, 'pending');
    return;
  }

  let parentId: string | null = null;
  let targetId = '';
  for (const [index, title] of titles.entries()) {
    let node = await repository.findNodeByTitle(actor.userId, title, parentId);
    if (!node) {
      const input: CreateNodeRecordInput = {
        userId: actor.userId,
        title,
        nodeType: nodeTypeForPath(index, titles.length),
        parentId,
        confidence: null,
        embeddingModel: null,
        embeddingStatus: 'none',
      };
      node = await repository.createNode(input);
      if (parentId !== null) {
        await repository.createEdge({
          userId: actor.userId,
          fromNodeId: node.id,
          toNodeId: parentId,
          relationType: 'part_of',
          confidence: 1,
          source: 'manual_library_path',
        });
      }
      await repository.createVersionRecord({
        userId: actor.userId,
        entityType: 'knowledge_node',
        entityId: node.id,
        operation: 'create',
        before: {},
        after: { title: node.title, parentId: node.parentId, nodeType: node.nodeType },
        actor: actor.actor,
      });
    }
    targetId = node.id;
    parentId = node.id;
  }

  const source = await repository.findRawSource(sourceId, actor.userId);
  if (!source) throw knowledgeError('not_found', `收集条目 ${sourceId} 不存在`);
  const pointsToLink =
    points.length > 0
      ? points
      : [
          await repository.createKnowledgeItem({
            userId: actor.userId,
            rawSourceId: sourceId,
            normalizedText: source.rawText,
            confidence: 1,
            isAiDerived: false,
          }),
        ];
  for (const point of pointsToLink) {
    await repository.unlinkItemFromNodes(point.id, actor.userId);
    await repository.linkItemToNode({
      userId: actor.userId,
      itemId: point.id,
      nodeId: targetId,
      relationType: 'primary',
      confidence: 1,
    });
  }
  await repository.updateRawSourceProcessing(sourceId, actor.userId, titles.length === 0 ? 'pending' : 'done');
}

export async function archiveLibraryItem(core: KnowledgeCore, actor: ActorContext, id: string): Promise<{ item: LibraryItem }> {
  const repository = core.deps.repository;
  const source = await repository.findRawSource(id, actor.userId);
  if (!source) throw knowledgeError('not_found', `收集条目 ${id} 不存在`);
  if (isArchived(source)) return { item: await toLibraryItem(repository, source, actor.userId) };
  const metadata = metadataFor(source);
  const points = await repository.listKnowledgeItemsForSource(id, actor.userId);
  const archivedLinks = [];
  for (const point of points) {
    for (const link of await repository.listLinksForItem(point.id, actor.userId)) {
      archivedLinks.push({
        itemId: link.itemId,
        nodeId: link.nodeId,
        relationType: link.relationType,
        confidence: link.confidence,
      });
    }
  }
  const subjectPath = await subjectPathFor(repository, source, actor.userId, metadata);
  const updated = await repository.updateRawSource(id, actor.userId, {
    metadata: { ...source.metadata, library: { ...metadata, subjectPath, archivedLinks, archivedAt: nowIso() } },
  });
  for (const point of points) await repository.unlinkItemFromNodes(point.id, actor.userId);
  return { item: await toLibraryItem(core.deps.repository, updated, actor.userId) };
}

export async function restoreLibraryItem(core: KnowledgeCore, actor: ActorContext, id: string): Promise<{ item: LibraryItem }> {
  const source = await core.deps.repository.findRawSource(id, actor.userId);
  if (!source) throw knowledgeError('not_found', `收集条目 ${id} 不存在`);
  const repository = core.deps.repository;
  const metadata = metadataFor(source);
  const updated = await repository.updateRawSource(id, actor.userId, {
    metadata: { ...source.metadata, library: { ...metadata, archivedAt: null, archivedLinks: [] } },
  });
  for (const link of metadata.archivedLinks ?? []) {
    const item = await repository.findKnowledgeItem(link.itemId, actor.userId);
    const node = await repository.findNode(link.nodeId, actor.userId);
    if (item?.rawSourceId !== id || !node || node.status === 'archived') continue;
    await repository.linkItemToNode({
      userId: actor.userId,
      itemId: item.id,
      nodeId: node.id,
      relationType: link.relationType,
      confidence: link.confidence,
    });
  }
  return { item: await toLibraryItem(core.deps.repository, updated, actor.userId) };
}

async function requireActiveSource(core: KnowledgeCore, actor: ActorContext, id: string): Promise<RawSource> {
  const source = await core.deps.repository.findRawSource(id, actor.userId);
  if (!source || isArchived(source)) throw knowledgeError('not_found', `收集条目 ${id} 不存在`);
  return source;
}

export async function listLibraryRelations(
  core: KnowledgeCore,
  actor: ActorContext,
  id: string,
): Promise<{ relations: ItemRelation[] }> {
  await requireActiveSource(core, actor, id);
  const relations = await core.deps.repository.listItemRelations(id, actor.userId);
  const visible: ItemRelation[] = [];
  for (const relation of relations) {
    const target = await core.deps.repository.findRawSource(relation.targetId, actor.userId);
    if (target && !isArchived(target)) visible.push(relation);
  }
  return { relations: visible };
}

export async function createLibraryRelation(
  core: KnowledgeCore,
  actor: ActorContext,
  id: string,
  targetId: string,
  relation: ItemRelation['relation'],
): Promise<{ relation: ItemRelation }> {
  await requireActiveSource(core, actor, id);
  if (id === targetId) throw knowledgeError('invalid_request', '条目不能关联自身');
  await requireActiveSource(core, actor, targetId);
  return {
    relation: await core.deps.repository.createItemRelation({ userId: actor.userId, fromSourceId: id, targetId, relation }),
  };
}

export async function deleteLibraryRelation(
  core: KnowledgeCore,
  actor: ActorContext,
  id: string,
  targetId: string,
): Promise<void> {
  await requireActiveSource(core, actor, id);
  await requireActiveSource(core, actor, targetId);
  await core.deps.repository.deleteItemRelations(id, targetId, actor.userId);
}
