import { createHash } from 'node:crypto';
import {
  compileQuery, matchQuery, parseMarkdown, resolveKnowledgeLink, isKnowledgeReference,
  type LinkContext, type LinkTarget, type LinkResolution, type MarkdownLink,
  type ParsedMarkdown, type QueryObject, type QueryHit,
} from '@noltri/note-engine';
import type { ContentLocation, WorkspaceState } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
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

async function buildIndex(deps: CoreDeps, actor: ActorContext, state: WorkspaceState, owner: IndexCoordinator): Promise<WorkspaceMetadataIndex> {
  owner.worker.setGeneration(state.revision);
  const errors: WorkspaceMetadataIndex['errors'] = [];
  const parsed = new Map<string, ParseResult>();
  await Promise.all(state.entries.map(async (entry) => {
    try { const result = await owner.worker.parse({ id: entry.id, revision: entry.revision, content: entry.markdown }); if (result) parsed.set(entry.id, result); }
    catch (error) { errors.push({ entryId: entry.id, message: error instanceof Error ? error.message : String(error) }); }
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
  const objects: WorkspaceQueryObject[] = [];
  for (const course of state.courses) objects.push({ id: `course:${course.id}`, kind: 'course', courseId: course.id, title: course.title, path: logicalPath(course.id, course.title), content: '', properties: course.properties, tags: strings(course.properties.tags), location: { kind: 'course', courseId: course.id } });
  for (const chapter of state.chapters) {
    const course = state.courses.find((course) => course.id === chapter.courseId);
    objects.push({ id: `chapter:${chapter.id}`, kind: 'chapter', courseId: chapter.courseId, title: chapter.title, path: `${logicalPath(chapter.courseId, course?.title ?? chapter.courseId)}/${chapter.title}`, content: '', properties: chapter.properties, tags: strings(chapter.properties.tags), location: { kind: 'chapter', courseId: chapter.courseId, courseChapterId: chapter.id } });
  }
  const sourceIds = [...new Set(state.sourceLinks.map((link) => link.sourceId))];
  const sources = await deps.repository.listRawSourcesByIds(sourceIds, actor.userId);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const importPaths: NonNullable<LinkContext['importPaths']> = {};
  for (const entry of state.entries) {
    const course = state.courses.find((course) => course.id === entry.courseId);
    const chapter = state.chapters.find((chapter) => chapter.id === entry.courseChapterId);
    const metadata: ParsedMarkdown = parsed.get(entry.id)?.metadata ?? { ast: { type: 'root' }, headings: [], sections: [], links: [], tags: [], blocks: [], tasks: [], footnotes: [], properties: entry.properties, aliases: [], excluded: [{ from: 0, to: entry.markdown.length }] };
    const location: ContentLocation = { kind: 'entry', courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id };
    const associated = state.sourceLinks.filter((link) => link.entryId === entry.id).flatMap((link) => { const source = sourceById.get(link.sourceId); return source ? [source] : []; });
    const filenames = associated.flatMap((source) => { const filename = source.metadata.fileName ?? source.metadata.filename ?? source.metadata.originalFilename; return typeof filename === 'string' ? [filename] : []; });
    const paths = associated.flatMap((source) => { const path = source.metadata.importPath; return typeof path === 'string' ? [path] : []; });
    if (typeof entry.properties.importPath === 'string') paths.push(entry.properties.importPath);
    for (const path of paths) (importPaths[path] ??= []).push(location);
    objects.push({ id: `entry:${entry.id}`, kind: 'entry', entryId: entry.id, courseId: entry.courseId, title: chapter?.title ?? course?.title ?? '', path: [logicalPath(entry.courseId, course?.title ?? entry.courseId), chapter?.title, ...paths].filter(Boolean).join('/'), ...(filenames.length ? { file: filenames.join('\n') } : {}), content: entry.markdown, properties: entry.properties, tags: [...new Set([...(metadata?.tags.map((tag) => tag.tag) ?? []), ...strings(entry.properties.tags)])], ...(metadata ? { metadata } : {}), location });
  }
  const links: IndexedLink[] = [];
  await Promise.all(state.entries.map(async (entry) => {
    const metadata = parsed.get(entry.id)?.metadata; if (!metadata) return;
    const sourceLocation: ContentLocation = { kind: 'entry', courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id };
    const stableTargets = new Map(owner.index?.links.filter((link) => link.entryId === entry.id && !link.field).map((link) => [`${link.reference.from}:${link.reference.target}`, link.resolution]));
    const context: LinkContext = { courseId: entry.courseId, entryId: entry.id, courseChapterId: entry.courseChapterId, importPaths, ...(typeof entry.properties.importPath === 'string' ? { sourcePath: entry.properties.importPath } : {}) };
    const resolved = await owner.worker.resolve({ id: entry.id, revision: entry.revision, generation: state.revision, metadata, context, targets, stableTargets });
    for (const reference of resolved ?? []) {
      if (!isKnowledgeReference(reference.reference.target)) continue;
      links.push({ entryId: entry.id, courseId: entry.courseId, courseChapterId: entry.courseChapterId, sourceLocation, ...reference, snippet: entry.markdown.slice(Math.max(0, reference.reference.from - 60), reference.reference.to + 80) });
    }
  }));
  for (const object of objects) for (const property of propertyLinks(object.properties ?? {})) {
    links.push({ entryId: object.entryId ?? null, courseId: object.courseId, courseChapterId: 'courseChapterId' in object.location ? object.location.courseChapterId : null, sourceLocation: object.location, ...property, resolution: resolveKnowledgeLink({ courseId: object.courseId, importPaths }, property.reference.target, targets) });
  }
  owner.worker.pruneCache(new Set([...parsed.values()].map((result) => result.hash)));
  return { revision: state.revision, objects, targets, links, errors };
}

export async function getMetadataIndex(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceMetadataIndex> {
  const state = await loadWorkspace(deps, actor); const owner = coordinator(deps, actor.userId);
  if (owner.index?.revision === state.revision) return owner.index;
  if (owner.pending?.revision === state.revision) return owner.pending.result;
  owner.latestRevision = Math.max(owner.latestRevision, state.revision);
  const result = buildIndex(deps, actor, state, owner).then(async (index) => {
    if (index.revision !== owner.latestRevision) return getMetadataIndex(deps, actor);
    owner.index = index; if (owner.pending?.revision === index.revision) owner.pending = undefined;
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
  const ast = compileQuery(query); const index = await getMetadataIndex(deps, actor);
  const fingerprint = createHash('sha256').update(query).digest('hex').slice(0, 16);
  let offset = 0;
  if (cursor) {
    const parts = cursor.split(':');
    if (parts.length !== 3 || parts[0] !== String(index.revision) || parts[1] !== fingerprint || !/^\d+$/.test(parts[2])) throw knowledgeError('conflict', 'Search changed; restart this query');
    offset = Number(parts[2]);
  }
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const hits: { id: string; location: ContentLocation; title: string; snippet: string; matches: QueryHit[] }[] = [];
  let position = offset;
  for (; position < index.objects.length; position++) {
    if (options.signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    const object = index.objects[position]; const result = matchQuery(ast, object, { signal: options.signal, budgetMs: 100 });
    if (result.matched) {
      const first = result.hits.find((hit) => hit.field === 'content'); const from = Math.max(0, (first?.from ?? 0) - 60);
      const snippet = capText(actor, (object.content ?? object.title ?? '').slice(from, from + 220));
      hits.push({ id: object.id, location: object.location, title: object.title ?? '', snippet, matches: result.hits });
      if (hits.length >= limit) { position++; break; }
    }
    if ((position + 1) % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { revision: index.revision, query, hits, ...(position < index.objects.length ? { cursor: `${index.revision}:${fingerprint}:${position}` } : {}) };
}
