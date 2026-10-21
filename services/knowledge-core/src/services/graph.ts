import type {
  ChapterResponse,
  ChapterTarget,
  CreateChapterRequest,
  GraphEdge,
  GraphDiagnostic,
  GraphNode,
  GraphNote,
  GraphNoteIndex,
  GraphScope,
  GraphSelection,
  KnowledgeEdge,
  KnowledgeNode,
  ResolveChapterRequest,
  SaveGraphNoteRequest,
} from '@noltri/schema';
import { isKnowledgeError, knowledgeError } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { taxonomyNodeType } from '../node-taxonomy';

function graphNode(node: KnowledgeNode): GraphNode {
  if (node.nodeType !== 'topic' && node.nodeType !== 'chapter') {
    throw knowledgeError('invalid_request', `节点 ${node.id} 不是主题或章节`);
  }
  return { id: node.id, title: node.title, nodeType: node.nodeType, parentId: node.parentId, summary: node.summary };
}

function graphEdge(edge: KnowledgeEdge, implicit = false): GraphEdge {
  return {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    relationType: 'part_of',
    source: edge.source,
    ...(implicit ? { implicit: true } : {}),
  };
}

function edgeKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}\u0000${toNodeId}`;
}

function disciplineFor(nodeId: string, nodesById: Map<string, KnowledgeNode>): string | null {
  const seen = new Set<string>();
  let current: KnowledgeNode | undefined = nodesById.get(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    if (taxonomyNodeType(current, nodesById) === 'discipline') return current.id;
    seen.add(current.id);
    current = current.parentId === null ? undefined : nodesById.get(current.parentId);
  }
  return null;
}

function chapterDisciplineAnchors(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const anchors = new Map<string, string>();
  for (const node of nodes) {
    if (node.nodeType !== 'chapter') continue;
    const disciplineId = disciplineFor(node.id, byId);
    if (disciplineId !== null) anchors.set(node.id, disciplineId);
  }
  // Prefer memberships written by the chapter API over older/imported conflicting rows. This keeps
  // a detached chapter anchored to its actual topic when stale cross-discipline edges also exist.
  const memberships = edges
    .filter((edge) => edge.relationType === 'part_of')
    .sort((first, second) => {
      const rank = (edge: KnowledgeEdge) => edge.source === 'topic_chapter' ? 0 : 1;
      return rank(first) - rank(second) || first.id.localeCompare(second.id);
    });
  for (const edge of memberships) {
    const chapter = byId.get(edge.fromNodeId);
    const topic = byId.get(edge.toNodeId);
    if (chapter?.nodeType !== 'chapter' || topic?.nodeType !== 'topic') continue;
    if (edge.source === 'tree_structure' && chapter.parentId !== topic.id) continue;
    if (anchors.has(chapter.id)) continue;
    const disciplineId = disciplineFor(topic.id, byId);
    if (disciplineId !== null) anchors.set(chapter.id, disciplineId);
  }
  return anchors;
}

function partOfEdges(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  diagnostics: GraphDiagnostic[] = [],
  knownNodes: KnowledgeNode[] = nodes,
): GraphEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const knownIds = new Set(knownNodes.map((node) => node.id));
  const chapterAnchors = chapterDisciplineAnchors(nodes, edges);
  const relationships: GraphEdge[] = [];
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (ids.has(edge.id)) diagnostics.push({ entityId: edge.id, reason: 'duplicate-id' });
    ids.add(edge.id);
    if (edge.fromNodeId === edge.toNodeId) {
      diagnostics.push({ entityId: edge.id, reason: 'self-loop' });
      continue;
    }
    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    if (from === undefined || to === undefined) {
      if (knownIds.has(edge.fromNodeId) && knownIds.has(edge.toNodeId)) continue;
      diagnostics.push({ entityId: edge.id, reason: 'missing-endpoint' });
      continue;
    }
    if (edge.relationType !== 'part_of') continue;
    if (from.nodeType === 'chapter' && to.nodeType === 'topic') {
      const fromDiscipline = chapterAnchors.get(from.id) ?? disciplineFor(from.id, byId);
      const toDiscipline = disciplineFor(to.id, byId);
      if (fromDiscipline !== null && toDiscipline !== null && fromDiscipline !== toDiscipline) {
        diagnostics.push({ entityId: edge.id, reason: 'cross-discipline' });
        continue;
      }
    }
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}\u0000${edge.relationType}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    if (edge.source === 'tree_structure' && from.parentId !== to.id) continue;
    relationships.push(graphEdge(edge));
  }
  const existing = new Set(relationships.map((edge) => edgeKey(edge.fromNodeId, edge.toNodeId)));
  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId) || existing.has(edgeKey(node.id, node.parentId))) continue;
    // Parent links are persisted taxonomy relationships too; keep older rows visible if their edge is absent.
    relationships.push({
      id: `parent:${encodeURIComponent(node.id)}:${encodeURIComponent(node.parentId)}`,
      fromNodeId: node.id,
      toNodeId: node.parentId,
      relationType: 'part_of',
      source: 'parent_id',
      implicit: true,
    });
  }
  return relationships;
}

function parentMap(nodes: KnowledgeNode[], edges: GraphEdge[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId !== null) parents.set(node.id, [node.parentId]);
  }
  for (const edge of edges) {
    const bucket = parents.get(edge.fromNodeId) ?? [];
    if (!bucket.includes(edge.toNodeId)) bucket.push(edge.toNodeId);
    parents.set(edge.fromNodeId, bucket);
  }
  return parents;
}

function belongsTo(nodeId: string, ancestorId: string, parents: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    if (id === ancestorId) return true;
    seen.add(id);
    pending.push(...(parents.get(id) ?? []));
  }
  return false;
}

function noteView(topicId: string, chapterId: string | null, note: Awaited<ReturnType<CoreDeps['repository']['getKnowledgeNote']>>): GraphNote {
  return { topicId, chapterId, content: note?.content ?? '', updatedAt: note?.updatedAt ?? null };
}

export async function selectGraph(
  deps: CoreDeps,
  actor: ActorContext,
  scope: GraphScope,
): Promise<GraphSelection> {
  const knownNodes = await deps.repository.listNodes(actor.userId, { includeArchived: true });
  const nodes = knownNodes.filter((node) => node.status !== 'archived');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const storedEdges = await deps.repository.listEdges(actor.userId);
  const diagnostics: GraphDiagnostic[] = [];
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) diagnostics.push({ entityId: node.id, reason: 'duplicate-id' });
    nodeIds.add(node.id);
  }
  const taxonomyEdges = partOfEdges(nodes, storedEdges, diagnostics, knownNodes);
  const parents = parentMap(nodes, taxonomyEdges);

  const discipline = byId.get(scope.disciplineId);
  if (discipline === undefined || taxonomyNodeType(discipline, byId) !== 'discipline') {
    throw knowledgeError('not_found', `学科 ${scope.disciplineId} 不存在`);
  }

  let scopeRootId = scope.disciplineId;
  if (scope.kind === 'subdiscipline') {
    const subdiscipline = byId.get(scope.subdisciplineId);
    if (
      subdiscipline === undefined ||
      taxonomyNodeType(subdiscipline, byId) !== 'subdiscipline' ||
      !belongsTo(subdiscipline.id, discipline.id, parents) ||
      subdiscipline.id === discipline.id
    ) {
      throw knowledgeError('not_found', `二级学科 ${scope.subdisciplineId} 不属于 ${scope.disciplineId}`);
    }
    scopeRootId = subdiscipline.id;
  }

  const allTopics = nodes.filter((node) => node.nodeType === 'topic');
  let topicIds: Set<string>;
  let chapterIds: Set<string>;
  if (scope.kind === 'topic') {
    const anchor = byId.get(scope.anchorTopicId);
    if (anchor === undefined || anchor.nodeType !== 'topic' || !belongsTo(anchor.id, discipline.id, parents)) {
      throw knowledgeError('not_found', `主题 ${scope.anchorTopicId} 不属于 ${scope.disciplineId}`);
    }
    const anchorChapters = new Set(
      taxonomyEdges
        .filter((edge) => edge.fromNodeId !== edge.toNodeId && edge.toNodeId === anchor.id && byId.get(edge.fromNodeId)?.nodeType === 'chapter')
        .map((edge) => edge.fromNodeId),
    );
    topicIds = new Set([anchor.id]);
    chapterIds = anchorChapters;
    for (const edge of taxonomyEdges) {
      if (
        anchorChapters.has(edge.fromNodeId) &&
        byId.get(edge.toNodeId)?.nodeType === 'topic' &&
        belongsTo(edge.toNodeId, discipline.id, parents)
      ) topicIds.add(edge.toNodeId);
    }
  } else {
    topicIds = new Set(allTopics.filter((node) => belongsTo(node.id, scopeRootId, parents)).map((node) => node.id));
    chapterIds = new Set(
      taxonomyEdges
        .filter((edge) => topicIds.has(edge.toNodeId) && byId.get(edge.fromNodeId)?.nodeType === 'chapter')
        .map((edge) => edge.fromNodeId),
    );
  }

  const selectedNodes = nodes
    .filter((node) => (node.nodeType === 'topic' && topicIds.has(node.id)) || (node.nodeType === 'chapter' && chapterIds.has(node.id)))
    .sort((first, second) => first.title.localeCompare(second.title, 'zh-Hans-CN') || first.id.localeCompare(second.id))
    .map(graphNode);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = taxonomyEdges
    .filter((edge) => selectedIds.has(edge.fromNodeId) && selectedIds.has(edge.toNodeId))
    .filter((edge) => byId.get(edge.fromNodeId)?.nodeType === 'chapter' && byId.get(edge.toNodeId)?.nodeType === 'topic')
    .sort((first, second) => first.fromNodeId.localeCompare(second.fromNodeId) || first.toNodeId.localeCompare(second.toNodeId));
  return { scope, nodes: selectedNodes, edges: selectedEdges, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
}

export async function resolveChapter(
  deps: CoreDeps,
  actor: ActorContext,
  request: ResolveChapterRequest,
): Promise<ChapterTarget> {
  let graph: GraphSelection;
  try {
    graph = await selectGraph(deps, actor, request.scope);
  } catch (error) {
    if (isKnowledgeError(error) && error.code === 'not_found') return { kind: 'unavailable' };
    throw error;
  }
  const candidates = [...new Set(graph.edges
    .filter((edge) => edge.fromNodeId === request.chapterId)
    .map((edge) => edge.toNodeId))].sort();
  if (candidates.length === 0) return { kind: 'unavailable' };
  if (request.activeTopicId && candidates.includes(request.activeTopicId)) {
    return { kind: 'resolved', topicId: request.activeTopicId, chapterId: request.chapterId };
  }
  if (candidates.length === 1) return { kind: 'resolved', topicId: candidates[0]!, chapterId: request.chapterId };
  return { kind: 'choose-topic', chapterId: request.chapterId, topicIds: candidates };
}

export async function getGraphNote(
  deps: CoreDeps,
  actor: ActorContext,
  topicId: string,
  chapterId: string | null,
): Promise<GraphNote> {
  const topic = await deps.repository.findNode(topicId, actor.userId);
  if (topic === null || topic.nodeType !== 'topic') throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  if (chapterId !== null) {
    const chapter = await deps.repository.findNode(chapterId, actor.userId);
    if (chapter === null || chapter.nodeType !== 'chapter') throw knowledgeError('not_found', `章节 ${chapterId} 不存在`);
  }
  return noteView(topicId, chapterId, await deps.repository.getKnowledgeNote(actor.userId, topicId, chapterId));
}

export async function listGraphNotes(
  deps: CoreDeps,
  actor: ActorContext,
  topicId: string,
): Promise<GraphNoteIndex> {
  const topic = await deps.repository.findNode(topicId, actor.userId);
  if (topic === null || topic.nodeType !== 'topic') throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  const [notes, nodes, storedEdges] = await Promise.all([
    deps.repository.listKnowledgeNotes(actor.userId, topicId),
    deps.repository.listNodes(actor.userId, { includeArchived: true }),
    deps.repository.listEdges(actor.userId),
  ]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const relationships = partOfEdges(nodes, storedEdges);
  const attached = new Set(
    relationships
      .filter((edge) => edge.toNodeId === topicId && byId.get(edge.fromNodeId)?.nodeType === 'chapter')
      .map((edge) => edge.fromNodeId),
  );
  return {
    notes: notes.map((note) => {
      const chapter = note.chapterId === null ? null : byId.get(note.chapterId) ?? null;
      return {
        ...note,
        chapterTitle: chapter?.title ?? null,
        attached: note.chapterId === null || (chapter !== null && chapter.status !== 'archived' && attached.has(chapter.id)),
      };
    }),
  };
}

export async function saveGraphNote(
  deps: CoreDeps,
  actor: ActorContext,
  topicId: string,
  request: SaveGraphNoteRequest,
): Promise<GraphNote> {
  const topic = await deps.repository.findNode(topicId, actor.userId);
  if (topic === null || topic.nodeType !== 'topic' || topic.status === 'archived') {
    throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  }
  if (request.chapterId !== null) {
    const chapter = await deps.repository.findNode(request.chapterId, actor.userId);
    if (chapter === null || chapter.nodeType !== 'chapter' || chapter.status === 'archived') {
      throw knowledgeError('not_found', `章节 ${request.chapterId} 不存在`);
    }
  }
  const saved = await deps.repository.saveKnowledgeNote({
    userId: actor.userId,
    topicId,
    chapterId: request.chapterId,
    content: request.content,
  });
  return noteView(topicId, request.chapterId, saved);
}

export async function createChapter(
  deps: CoreDeps,
  actor: ActorContext,
  topicId: string,
  request: CreateChapterRequest,
): Promise<ChapterResponse> {
  const topic = await deps.repository.findNode(topicId, actor.userId);
  if (topic === null || topic.nodeType !== 'topic' || topic.status === 'archived') {
    throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  }
  const chapter = await deps.repository.createNode({
    userId: actor.userId,
    title: request.title,
    nodeType: 'chapter',
    parentId: topic.id,
  });
  const edge = await deps.repository.createEdge({
    userId: actor.userId,
    fromNodeId: chapter.id,
    toNodeId: topic.id,
    relationType: 'part_of',
    confidence: 1,
    source: 'tree_structure',
  });
  await deps.repository.createVersionRecord({
    userId: actor.userId,
    entityType: 'knowledge_node',
    entityId: chapter.id,
    operation: 'create',
    before: {},
    after: { title: chapter.title, nodeType: chapter.nodeType, parentId: chapter.parentId },
    actor: actor.actor,
  });
  return { chapter: graphNode(chapter), edge: graphEdge(edge) };
}

export async function connectChapter(
  deps: CoreDeps,
  actor: ActorContext,
  chapterId: string,
  topicId: string,
): Promise<ChapterResponse> {
  const [chapter, topic] = await Promise.all([
    deps.repository.findNode(chapterId, actor.userId),
    deps.repository.findNode(topicId, actor.userId),
  ]);
  if (chapter === null || chapter.nodeType !== 'chapter' || chapter.status === 'archived') {
    throw knowledgeError('not_found', `章节 ${chapterId} 不存在`);
  }
  if (topic === null || topic.nodeType !== 'topic' || topic.status === 'archived') {
    throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  }
  if (chapterId === topicId) throw knowledgeError('invalid_request', '章节不能归属于自身');
  const nodes = await deps.repository.listNodes(actor.userId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = await deps.repository.listEdges(actor.userId);
  const chapterDiscipline = chapterDisciplineAnchors(nodes, edges).get(chapterId) ?? disciplineFor(chapterId, byId);
  const topicDiscipline = disciplineFor(topicId, byId);
  if (chapterDiscipline !== null && topicDiscipline !== null && chapterDiscipline !== topicDiscipline) {
    throw knowledgeError('invalid_request', '章节与主题不能跨一级学科建立归属');
  }
  const existing = await deps.repository.findEdge(actor.userId, chapterId, topicId, 'part_of');
  if (existing) return { chapter: graphNode(chapter), edge: graphEdge(existing) };
  if (chapter.parentId === null) {
    await deps.repository.moveNode({ userId: actor.userId, nodeId: chapter.id, targetParentId: topic.id, actor: actor.actor });
  }
  const edge = await deps.repository.createEdge({
    userId: actor.userId,
    fromNodeId: chapter.id,
    toNodeId: topic.id,
    relationType: 'part_of',
    confidence: 1,
    source: 'topic_chapter',
  });
  return { chapter: graphNode((await deps.repository.findNode(chapterId, actor.userId)) ?? chapter), edge: graphEdge(edge) };
}

export async function disconnectChapter(
  deps: CoreDeps,
  actor: ActorContext,
  chapterId: string,
  topicId: string,
): Promise<void> {
  const [chapter, topic] = await Promise.all([
    deps.repository.findNode(chapterId, actor.userId),
    deps.repository.findNode(topicId, actor.userId),
  ]);
  if (chapter === null || chapter.nodeType !== 'chapter') throw knowledgeError('not_found', `章节 ${chapterId} 不存在`);
  if (topic === null || topic.nodeType !== 'topic') throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
  if (chapter.parentId === topicId) {
    await deps.repository.moveNode({ userId: actor.userId, nodeId: chapterId, targetParentId: null, actor: actor.actor });
  }
  await deps.repository.deleteEdge(actor.userId, chapterId, topicId, 'part_of');
}
