import { createHash } from 'node:crypto';
import {
  compileQuery, matchQuery, parseMarkdown, resolveKnowledgeLink, isKnowledgeReference, rebaseReferenceRanges,
  type LinkContext, type LinkTarget, type LinkResolution, type MarkdownLink,
  type ParsedMarkdown, type QueryObject, type QueryHit,
} from '@noltri/note-engine';
import type { ContentLocation, WorkspaceState, RawSource, KnowledgeNode, ContentEntry } from '@noltri/schema';
import { knowledgeError, isKnowledgeError } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { capText } from '../types';
import { loadWorkspace } from './course-workspace';
import { MarkdownParseThread, MetadataWorker, type ParseResult } from '../workers/metadata-worker';

export interface WorkspaceQueryObject extends QueryObject { location: ContentLocation; courseId: string; entryId?: string }
export interface IndexedLink {
  entryId: string | null; courseId: string; courseChapterId: string | null; sourceLocation: ContentLocation;
  reference: MarkdownLink; resolution: LinkResolution; snippet: string; field?: string;
}
export interface WorkspaceMetadataIndex {
  revision: number; objects: WorkspaceQueryObject[]; targets: LinkTarget[]; links: IndexedLink[];
  errors: { entryId: string; message: string }[];
}
interface IndexCoordinator {
  worker: MetadataWorker; thread: MarkdownParseThread; latestRevision: number;
  pending?: { revision: number; result: Promise<WorkspaceMetadataIndex> }; index?: WorkspaceMetadataIndex;
  listeners: Set<(event: { revision: number; entryIds: string[] }) => void>;
}
const repositories = new WeakMap<object, Map<string, IndexCoordinator>>();
function coordinator(deps: CoreDeps, userId: string): IndexCoordinator {
  let users = repositories.get(deps.repository); if (!users) { users = new Map(); repositories.set(deps.repository, users); }
  let value = users.get(userId);
  if (!value) { const thread = new MarkdownParseThread(); value = { thread, worker: new MetadataWorker(thread.parse), latestRevision: -1, listeners: new Set() }; users.set(userId, value); }
  return value;
}
const strings = (value: unknown): string[] => typeof value === 'string' ? value.split(/[,\s]+/u).filter(Boolean) : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
function propertyLinks(properties: Record<string, unknown>): { reference: MarkdownLink; field: string; snippet: string }[] {
  const results: { reference: MarkdownLink; field: string; snippet: string }[] = [];
  const visit = (value: unknown, path: (string | number)[]) => {
    if (typeof value === 'string' && value.includes('[[')) {
      for (const reference of parseMarkdown(value).links) results.push({ reference: { ...reference, kind: 'property', propertyPath: path }, field: `property:${path.join('.')}`, snippet: value });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  };
  visit(properties, []); return results;
}

/** Both full indexing and progressive cold search use exactly these independently owned objects. */
function* queryObjects(state: WorkspaceState, nodes: KnowledgeNode[], sources: RawSource[], metadataFor: (entry: ContentEntry) => ParsedMarkdown): Generator<WorkspaceQueryObject> {
  const courseById = new Map(state.courses.map((course) => [course.id, course]));
  const chapterById = new Map(state.chapters.map((chapter) => [chapter.id, chapter]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const sourcesByEntry = new Map<string, RawSource[]>();
  for (const link of state.sourceLinks) { const source = sourceById.get(link.sourceId); if (source) { const list = sourcesByEntry.get(link.entryId) ?? []; list.push(source); sourcesByEntry.set(link.entryId, list); } }
  const pathOf = (courseId: string) => {
    const parts = [courseById.get(courseId)?.title ?? courseId]; const seen = new Set<string>([courseId]); let parentId = nodeById.get(courseId)?.parentId;
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = nodeById.get(parentId); if (!parent) break; parts.unshift(parent.title); parentId = parent.parentId; }
    return parts.join('/');
  };
  for (const course of state.courses) yield { id: `course:${course.id}`, kind: 'course', courseId: course.id, title: course.title, path: pathOf(course.id), content: '', properties: course.properties, tags: strings(course.properties.tags), location: { kind: 'course', courseId: course.id } };
  for (const chapter of state.chapters) yield { id: `chapter:${chapter.id}`, kind: 'chapter', courseId: chapter.courseId, title: chapter.title, path: `${pathOf(chapter.courseId)}/${chapter.title}`, content: '', properties: chapter.properties, tags: strings(chapter.properties.tags), location: { kind: 'chapter', courseId: chapter.courseId, courseChapterId: chapter.id } };
  for (const entry of state.entries) {
    const chapter = chapterById.get(entry.courseChapterId ?? ''); const metadata = metadataFor(entry);
    const associated = sourcesByEntry.get(entry.id) ?? [];
    const filenames = associated.flatMap((source) => { const filename = source.metadata.fileName ?? source.metadata.filename ?? source.metadata.originalFilename; return typeof filename === 'string' ? [filename] : []; });
    const paths = associated.flatMap((source) => { const path = source.metadata.importPath; return typeof path === 'string' ? [path] : []; });
    if (typeof entry.properties.importPath === 'string') paths.push(entry.properties.importPath);
    for (const record of Object.values(state.imports)) if (record.entryIds.includes(entry.id)) { paths.push(record.path); if (!filenames.includes(record.path.split('/').at(-1)!)) filenames.push(record.path.split('/').at(-1)!); }
    yield { id: `entry:${entry.id}`, kind: 'entry', entryId: entry.id, courseId: entry.courseId, title: chapter?.title ?? courseById.get(entry.courseId)?.title ?? '', path: [pathOf(entry.courseId), chapter?.title, ...paths].filter(Boolean).join('/'), ...(filenames.length ? { file: filenames.join('\n') } : {}), content: entry.markdown, properties: entry.properties, tags: [...new Set([...metadata.tags.map((tag) => tag.tag), ...strings(entry.properties.tags)])], metadata, location: { kind: 'entry', courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id } };
  }
}

async function buildIndex(deps: CoreDeps, actor: ActorContext, state: WorkspaceState, owner: IndexCoordinator): Promise<WorkspaceMetadataIndex> {
  owner.worker.setGeneration(state.revision);
  const errors: WorkspaceMetadataIndex['errors'] = [];
  const parsed = new Map<string, ParseResult>();
  await Promise.all(state.entries.map(async (entry) => {
    try { const result = await owner.worker.parse({ id: entry.id, revision: entry.revision, content: entry.markdown }); if (result) parsed.set(entry.id, result); }
    catch (error) {
      errors.push({ entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
      try {
        const metadata = parseMarkdown(entry.markdown, { tolerateInvalidFrontmatter: true });
        parsed.set(entry.id, { id: entry.id, revision: entry.revision, hash: createHash('sha256').update(entry.markdown).digest('hex'), cacheKey: 'invalid-frontmatter', metadata });
      } catch { /* The error above remains visible; another entry must still finish indexing. */ }
    }
  }));
  const nodes = await deps.repository.listNodes(actor.userId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const logicalPath = (courseId: string, title: string) => {
    const parts = [title]; const seen = new Set<string>([courseId]); let parentId = byId.get(courseId)?.parentId;
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = byId.get(parentId); if (!parent) break; parts.unshift(parent.title); parentId = parent.parentId; }
    return parts.join('/');
  };
  const targets: LinkTarget[] = state.courses.map((course) => ({
    courseId: course.id, title: course.title, path: logicalPath(course.id, course.title), aliases: typeof (course.properties.aliases ?? course.properties.alias) === 'string' ? [String(course.properties.aliases ?? course.properties.alias)] : strings(course.properties.aliases ?? course.properties.alias),
    headings: [
      ...state.chapters.filter((chapter) => chapter.courseId === course.id).map((chapter) => ({ depth: 2, text: chapter.title, from: 0, to: 0, contentFrom: 0, contentTo: 0, path: [chapter.title], courseChapterId: chapter.id })),
      ...state.entries.filter((entry) => entry.courseId === course.id).flatMap((entry) => (parsed.get(entry.id)?.metadata.headings ?? []).map((heading) => ({ ...heading, path: [...(state.chapters.find((chapter) => chapter.id === entry.courseChapterId) ? [state.chapters.find((chapter) => chapter.id === entry.courseChapterId)!.title] : []), ...heading.path], entryId: entry.id, courseChapterId: entry.courseChapterId }))),
    ],
    blocks: state.entries.filter((entry) => entry.courseId === course.id).flatMap((entry) => entry.blocks.map((block) => ({ ...block, type: 'paragraph', text: entry.markdown.slice(block.from, block.to), entryId: entry.id, courseChapterId: entry.courseChapterId }))),
  }));
  const sourceIds = [...new Set(state.sourceLinks.map((link) => link.sourceId))];
  const sources = await deps.repository.listRawSourcesByIds(sourceIds, actor.userId);
  const importPaths: NonNullable<LinkContext['importPaths']> = {};
  for (const imported of Object.values(state.imports)) {
    const courseIds = new Set(imported.entryIds.flatMap((id) => { const entry = state.entries.find((entry) => entry.id === id); return entry ? [entry.courseId] : []; }));
    if (!courseIds.size && state.courses.some((course) => course.id === imported.courseId)) courseIds.add(imported.courseId);
    importPaths[imported.path] = [...courseIds].map((courseId) => ({ kind: 'course', courseId }));
  }
  for (const entry of state.entries) if (typeof entry.properties.importPath === 'string' && !importPaths[entry.properties.importPath]) importPaths[entry.properties.importPath] = [{ kind: 'course', courseId: entry.courseId }];
  const objects = [...queryObjects(state, nodes, sources, (entry) => parsed.get(entry.id)?.metadata ?? parseMarkdown(entry.markdown, { tolerateInvalidFrontmatter: true }))];
  const links: IndexedLink[] = [];
  const nextBindings: WorkspaceState['resolvedReferences'] = {};
  await Promise.all(state.entries.map(async (entry) => {
    const metadata = parsed.get(entry.id)?.metadata;
    const ownerKey = `entry:${entry.id}`;
    const previous = state.resolvedReferences[ownerKey];
    if (!metadata) { if (previous) nextBindings[ownerKey] = previous; return; }
    const sourceLocation: ContentLocation = { kind: 'entry', courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id };
    const retained = previous ? rebaseReferenceRanges(previous.content, entry.markdown, previous.references) : [];
    const stableTargets = new Map(retained.map((reference) => [`${reference.from}:${reference.targetText}`, { status: 'resolved', target: reference.target } as LinkResolution]));
    const importedPath = Object.values(state.imports).find((record) => record.entryIds.includes(entry.id))?.path;
    const sourcePath = typeof entry.properties.importPath === 'string' ? entry.properties.importPath : importedPath;
    const context: LinkContext = { courseId: entry.courseId, entryId: entry.id, courseChapterId: entry.courseChapterId, importPaths, ...(sourcePath ? { sourcePath } : {}) };
    const resolved = await owner.worker.resolve({ id: entry.id, revision: entry.revision, generation: state.revision, metadata, context, targets, stableTargets });
    const references: WorkspaceState['resolvedReferences'][string]['references'] = [];
    for (const reference of resolved ?? []) {
      if (!isKnowledgeReference(reference.reference.target)) continue;
      links.push({ entryId: entry.id, courseId: entry.courseId, courseChapterId: entry.courseChapterId, sourceLocation, ...reference, snippet: entry.markdown.slice(Math.max(0, reference.reference.from - 60), reference.reference.to + 80) });
      const target = reference.resolution.status === 'resolved' ? reference.resolution.target : retained.find((old) => old.from === reference.reference.from && old.raw === reference.reference.raw)?.target;
      if (target) references.push({ from: reference.reference.from, to: reference.reference.to, raw: reference.reference.raw, targetText: reference.reference.target, target: target as ContentLocation });
    }
    if (references.length) nextBindings[ownerKey] = { content: entry.markdown, revision: entry.revision, references };
  }));
  for (const object of objects) for (const property of propertyLinks(object.properties ?? {})) {
    const key = `${object.id}:property:${JSON.stringify(property.reference.propertyPath)}`;
    const previous = state.resolvedReferences[key];
    const retained = previous ? rebaseReferenceRanges(previous.content, property.snippet, previous.references) : [];
    const stable = retained.find((reference) => reference.from === property.reference.from && reference.raw === property.reference.raw)?.target;
    const resolution = resolveKnowledgeLink({ courseId: object.courseId, importPaths, ...(stable ? { stableTarget: stable as LinkContext['stableTarget'] } : {}) }, property.reference.target, targets);
    links.push({ entryId: object.entryId ?? null, courseId: object.courseId, courseChapterId: 'courseChapterId' in object.location ? object.location.courseChapterId : null, sourceLocation: object.location, ...property, resolution });
    const target = resolution.status === 'resolved' ? resolution.target : stable;
    if (target) {
      const binding = nextBindings[key] ??= { content: property.snippet, revision: state.revision, references: [] };
      binding.references.push({ from: property.reference.from, to: property.reference.to, raw: property.reference.raw, targetText: property.reference.target, field: property.field, target: target as ContentLocation });
    }
  }
  owner.worker.pruneCache(new Set([...parsed.values()].map((result) => result.hash)));
  let revision = state.revision;
  // A changed binding ledger is persisted once; unchanged reads never advance the aggregate revision.
  for (const [key, binding] of Object.entries(nextBindings)) if (state.resolvedReferences[key]?.content === binding.content && JSON.stringify(state.resolvedReferences[key].references) === JSON.stringify(binding.references)) binding.revision = state.resolvedReferences[key].revision;
  if (JSON.stringify(state.resolvedReferences) !== JSON.stringify(nextBindings)) {
    state.resolvedReferences = nextBindings;
    const saved = await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
    revision = saved.revision; owner.latestRevision = Math.max(owner.latestRevision, revision);
  }
  return { revision, objects, targets, links, errors };
}

export async function getMetadataIndex(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceMetadataIndex> {
  const state = await loadWorkspace(deps, actor); const owner = coordinator(deps, actor.userId);
  if (owner.index?.revision === state.revision) return owner.index;
  if (owner.pending?.revision === state.revision) return owner.pending.result;
  owner.latestRevision = Math.max(owner.latestRevision, state.revision);
  const result = buildIndex(deps, actor, state, owner).catch((error) => {
    if (isKnowledgeError(error) && error.code === 'conflict') return getMetadataIndex(deps, actor);
    throw error;
  }).then(async (index) => {
    if (index.revision !== owner.latestRevision) return getMetadataIndex(deps, actor);
    owner.index = index; if (owner.pending?.revision === state.revision) owner.pending = undefined;
    for (const listener of owner.listeners) { try { listener({ revision: index.revision, entryIds: state.entries.map((entry) => entry.id) }); } catch (error) { deps.logger.warn('Metadata subscription failed', { error: String(error) }); } }
    return index;
  });
  owner.pending = { revision: state.revision, result }; return result;
}
export function subscribeMetadata(deps: CoreDeps, userId: string, listener: (event: { revision: number; entryIds: string[] }) => void): () => void {
  const owner = coordinator(deps, userId); owner.listeners.add(listener); return () => { owner.listeners.delete(listener); };
}
/** Mutations enqueue authoritative reindexing; subscriptions only fire after both stages converge. */
export async function refreshMetadata(deps: CoreDeps, actor: ActorContext): Promise<void> { await getMetadataIndex(deps, actor); }
export async function rebuildMetadata(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceMetadataIndex> { const owner = coordinator(deps, actor.userId); owner.worker.clearCache(); owner.index = undefined; owner.pending = undefined; return getMetadataIndex(deps, actor); }
export async function closeMetadata(deps: CoreDeps, userId: string): Promise<void> { const users = repositories.get(deps.repository); const owner = users?.get(userId); users?.delete(userId); await owner?.thread.close(); }

export async function resolveWorkspaceLink(deps: CoreDeps, actor: ActorContext, context: LinkContext, rawLink: string): Promise<LinkResolution> {
  const index = await getMetadataIndex(deps, actor);
  if (!index.targets.some((target) => target.courseId === context.courseId)) throw knowledgeError('not_found', 'Course context not found');
  if (context.entryId) {
    const references = index.links.filter((link) => link.entryId === context.entryId && !link.field && (link.reference.target === rawLink || link.reference.raw === rawLink) && (context.referenceFrom === undefined || link.reference.from === context.referenceFrom));
    if (references.length && references.every((link) => JSON.stringify(link.resolution) === JSON.stringify(references[0].resolution))) return references[0].resolution;
  }
  return resolveKnowledgeLink(context, rawLink, index.targets);
}
export async function getBacklinks(deps: CoreDeps, actor: ActorContext, target: ContentLocation): Promise<{ revision: number; target: ContentLocation; references: IndexedLink[]; count: number }> {
  const index = await getMetadataIndex(deps, actor);
  const references = index.links.filter((link) => {
    if (link.resolution.status !== 'resolved') return false;
    const location = link.resolution.target;
    if (!('courseId' in target) || location.courseId !== target.courseId) return false;
    if (target.kind === 'course') return true;
    if (target.kind === 'chapter') return location.courseChapterId === target.courseChapterId;
    if (target.kind === 'entry') return location.entryId === target.entryId && (!target.blockId || target.blockId === location.blockId);
    return false;
  }).map((link) => ({ ...link, snippet: capText(actor, link.snippet) }));
  return { revision: index.revision, target, references, count: references.length };
}

export async function searchKnowledge(deps: CoreDeps, actor: ActorContext, query: string, cursor?: string, options: { signal?: AbortSignal; limit?: number } = {}): Promise<{ revision: number; query: string; hits: { id: string; location: ContentLocation; title: string; snippet: string; matches: QueryHit[] }[]; cursor?: string }> {
  const ast = compileQuery(query); const state = await loadWorkspace(deps, actor);
  const ready = coordinator(deps, actor.userId).index;
  let objects: Iterable<WorkspaceQueryObject>;
  if (ready?.revision === state.revision) objects = ready.objects;
  else {
    const [nodes, sources] = await Promise.all([deps.repository.listNodes(actor.userId), deps.repository.listRawSourcesByIds([...new Set(state.sourceLinks.map((link) => link.sourceId))], actor.userId)]);
    objects = queryObjects(state, nodes, sources, (entry) => parseMarkdown(entry.markdown, { tolerateInvalidFrontmatter: true }));
  }
  const revision = state.revision;
  const total = state.courses.length + state.chapters.length + state.entries.length;
  const fingerprint = createHash('sha256').update(query).digest('hex').slice(0, 16);
  let offset = 0;
  if (cursor) {
    const parts = cursor.split(':');
    if (parts.length !== 3 || parts[0] !== String(revision) || parts[1] !== fingerprint || !/^\d+$/.test(parts[2])) throw knowledgeError('conflict', 'Search changed; restart this query');
    offset = Number(parts[2]);
  }
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const hits: { id: string; location: ContentLocation; title: string; snippet: string; matches: QueryHit[] }[] = [];
  let position = 0;
  for (const object of objects) {
    if (position++ < offset) continue;
    if (options.signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    const result = matchQuery(ast, object, { signal: options.signal, budgetMs: 100 });
    if (result.matched) {
      const first = result.hits.find((hit) => hit.field === 'content'); const from = Math.max(0, (first?.from ?? 0) - 60);
      const snippet = capText(actor, (object.content ?? object.title ?? '').slice(from, from + 220));
      hits.push({ id: object.id, location: object.location, title: object.title ?? '', snippet, matches: result.hits });
      if (hits.length >= limit) break;
    }
    if ((position + 1) % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { revision, query, hits, ...(position < total ? { cursor: `${revision}:${fingerprint}:${position}` } : {}) };
}
