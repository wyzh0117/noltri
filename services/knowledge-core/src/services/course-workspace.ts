import { createHash } from 'node:crypto';
import {
  applyCourseDocumentPatchSchema, moveSourceAssignmentsSchema, courseDocumentSchema,
  workspaceMutationResultSchema, WORKSPACE_REQUEST_MAX_BYTES,
  type ApplyCourseDocumentPatchRequest, type MoveSourceAssignmentsRequest,
  type CourseDocument, type ContentEntry, type CourseChapter, type ContentBlock,
  type WorkspaceState, type WorkspaceContent, type WorkspaceMutationResult, type ContentLocation,
  type DocumentChange, type KnowledgeNode,
} from '@noltri/schema';
import { parseMarkdown, resolveKnowledgeLink, rewriteReferences, formatLinkTarget, setFrontmatterProperties, type LinkTarget, type EngineLocation } from '@noltri/note-engine';
import { createId, knowledgeError, nowIso } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';

const stableId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = <T extends { order: number; id: string }>(values: T[]): T[] => [...values].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export function workspaceContent(state: WorkspaceState): WorkspaceContent {
  return structuredClone({ courses: state.courses, concepts: state.concepts, chapters: state.chapters, entries: state.entries, sourceLinks: state.sourceLinks });
}
export function objectRevisions(state: WorkspaceState): Record<string, number> {
  return { ...state.tombstones, ...Object.fromEntries([
    ...state.courses.map((item) => [`course:${item.id}`, item.documentRevision]),
    ...state.chapters.map((item) => [`chapter:${item.id}`, item.revision]),
    ...state.entries.map((item) => [`entry:${item.id}`, item.revision]),
    ...state.concepts.map((item) => [`concept:${item.id}`, item.revision]),
  ]) };
}
function entities(content: WorkspaceContent): Map<string, unknown> {
  return new Map<string, unknown>([
    ...content.courses.map((item) => [`course:${item.id}`, item] as const),
    ...content.chapters.map((item) => [`chapter:${item.id}`, item] as const),
    ...content.entries.map((item) => [`entry:${item.id}`, { ...item, sourceLinks: content.sourceLinks.filter((link) => link.entryId === item.id) }] as const),
    ...content.concepts.map((item) => [`concept:${item.id}`, item] as const),
  ]);
}
export function changedObjectKeys(before: WorkspaceContent, after: WorkspaceContent): string[] {
  const a = entities(before); const b = entities(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))).sort();
}
export function takeSnapshot(state: WorkspaceState, before: WorkspaceContent, actor: ActorContext, reason: string, force = true): string | null {
  const keys = changedObjectKeys(before, workspaceContent(state));
  if (!keys.length) return null;
  const now = nowIso();
  const last = [...state.snapshots].reverse().find((item) => item.reason === 'edit' && item.objectKeys.some((key) => keys.includes(key)));
  if (!force && last && Date.parse(now) - Date.parse(last.createdAt) < state.settings.snapshotIntervalSeconds * 1000) return null;
  const previous = entities(before); const current = entities(workspaceContent(state));
  const revisions = objectRevisions(state);
  for (const key of keys) if (previous.has(key) && !current.has(key)) state.tombstones[key] = revisions[key] = Number((previous.get(key) as { revision?: number }).revision ?? revisions[key] ?? 0) + 1;
  const snapshotId = createId();
  state.snapshots = state.snapshots.filter((item) => Date.parse(now) - Date.parse(item.createdAt) <= state.settings.snapshotRetentionDays * 86400000);
  state.snapshots.push({ id: snapshotId, userId: actor.userId, createdAt: now, actor: actor.actor, reason, objectKeys: keys, before, afterRevisions: Object.fromEntries(keys.map((key) => [key, revisions[key] ?? 0])) });
  return snapshotId;
}
function ensureCourse(state: WorkspaceState, userId: string, node: KnowledgeNode): void {
  if (!state.courses.some((course) => course.id === node.id)) state.courses.push({ id: node.id, userId, title: node.title, documentRevision: 1, properties: {}, updatedAt: nowIso() });
}
function ensureChapter(state: WorkspaceState, userId: string, courseId: string, node: KnowledgeNode, detached: boolean): CourseChapter {
  let found = state.chapters.find((chapter) => chapter.courseId === courseId && chapter.conceptId === node.id);
  if (!found) {
    if (!state.concepts.some((concept) => concept.id === node.id)) state.concepts.push({ id: node.id, userId, title: node.title, revision: 1 });
    found = { id: stableId(userId, 'chapter', courseId, node.id), userId, courseId, conceptId: node.id, title: node.title, order: state.chapters.filter((chapter) => chapter.courseId === courseId).length, revision: 1, properties: {}, detached };
    state.chapters.push(found);
  }
  return found;
}
/** YAML is an import adapter; structured properties are the one editable record. */
export function extractEntryFrontmatter(entry: ContentEntry): void {
  const parsed = parseMarkdown(entry.markdown);
  if (!parsed.frontmatter) return;
  entry.properties = { ...entry.properties, ...parsed.properties };
  entry.markdown = entry.markdown.slice(parsed.frontmatter.to).replace(/^\r?\n/, '');
}
export function syncBlocks(entry: ContentEntry, previous: ContentBlock[] = entry.blocks): void {
  const parsed = parseMarkdown(entry.markdown).blocks.filter((block) => block.alias !== undefined);
  const used = new Set<string>();
  entry.blocks = parsed.map((block, index) => {
    const old = previous.find((value) => !used.has(value.id) && value.alias === block.alias) ?? previous.find((value, position) => position === index && !used.has(value.id));
    const id = old?.id ?? createId(); used.add(id);
    return { id, alias: block.alias!, from: block.from, to: block.to };
  });
}

/** Import only explicit identities/edges. Legacy note text never gets guessed source associations. */
export async function loadWorkspace(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceState> {
  let state = await deps.repository.getWorkspaceState(actor.userId);
  const original = JSON.stringify(state);
  const prior = workspaceContent(state);
  const alreadyMigrated = state.migration.version >= 1;
  const [nodes, edges] = await Promise.all([deps.repository.listNodes(actor.userId, { includeArchived: true }), deps.repository.listEdges(actor.userId)]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memberships = new Map<string, Set<string>>();
  for (const node of nodes) if (node.nodeType === 'topic') ensureCourse(state, actor.userId, node);
  for (const node of nodes) if (node.nodeType === 'chapter') {
    const courseIds = new Set(edges.filter((edge) => edge.fromNodeId === node.id && edge.relationType === 'part_of' && byId.get(edge.toNodeId)?.nodeType === 'topic').map((edge) => edge.toNodeId));
    if (node.parentId && byId.get(node.parentId)?.nodeType === 'topic') courseIds.add(node.parentId);
    memberships.set(node.id, courseIds);
    for (const courseId of courseIds) {
      const key = `chapter:${JSON.stringify([courseId, node.id])}`;
      if (!state.migration.mappings[key]) state.migration.mappings[key] = ensureChapter(state, actor.userId, courseId, node, false).id;
    }
  }
  for (const course of state.courses) {
    const notes = await deps.repository.listKnowledgeNotes(actor.userId, course.id);
    for (const noteIndex of notes) {
      const key = `note:${JSON.stringify([course.id, noteIndex.chapterId])}`;
      if (state.migration.mappings[key]) continue;
      const note = await deps.repository.getKnowledgeNote(actor.userId, course.id, noteIndex.chapterId);
      if (!note) continue;
      const node = note.chapterId ? byId.get(note.chapterId) : undefined;
      if (note.chapterId && !node) { state.migration.unconfirmed.push(key); continue; }
      const chapter = node ? ensureChapter(state, actor.userId, course.id, node, !memberships.get(node.id)?.has(course.id)) : null;
      const id = stableId(actor.userId, key);
      const entry: ContentEntry = { id, userId: actor.userId, courseId: course.id, courseChapterId: chapter?.id ?? null, markdown: note.content, order: state.entries.filter((item) => item.courseId === course.id).length, revision: 1, properties: parseMarkdown(note.content).properties, blocks: [] };
      extractEntryFrontmatter(entry); syncBlocks(entry); state.entries.push(entry); state.migration.mappings[key] = id;
    }
  }
  const seenItems = new Set<string>();
  for (const node of nodes) {
    for (const item of await deps.repository.listKnowledgeItemsForNode(node.id, actor.userId)) {
      if (seenItems.has(item.id) || state.migration.mappings[`item:${item.id}`]) continue;
      seenItems.add(item.id);
      const links = await deps.repository.listLinksForItem(item.id, actor.userId);
      const primary = links.find((link) => link.relationType === 'primary');
      const assigned = primary ? byId.get(primary.nodeId) : undefined;
      const courseId = assigned?.nodeType === 'topic' ? assigned.id : assigned?.nodeType === 'chapter' && memberships.get(assigned.id)?.size === 1 ? [...memberships.get(assigned.id)!][0] : undefined;
      if (!courseId) { if (!state.migration.unconfirmed.includes(`item:${item.id}`)) state.migration.unconfirmed.push(`item:${item.id}`); continue; }
      const chapter = assigned?.nodeType === 'chapter' ? state.chapters.find((value) => value.courseId === courseId && value.conceptId === assigned.id) : undefined;
      if (state.migration.mappings[`note:${JSON.stringify([courseId, assigned?.nodeType === 'chapter' ? assigned.id : null])}`] && (state.migration.version === 0 || state.migration.unconfirmed.includes(`item:${item.id}:note-overlap`))) {
        if (!state.migration.unconfirmed.includes(`item:${item.id}:note-overlap`)) state.migration.unconfirmed.push(`item:${item.id}:note-overlap`);
        continue;
      }
      const id = stableId(actor.userId, 'item', item.id);
      const entry: ContentEntry = { id, userId: actor.userId, courseId, courseChapterId: chapter?.id ?? null, markdown: item.normalizedText, order: state.entries.filter((value) => value.courseId === courseId).length, revision: 1, properties: {}, blocks: [] };
      extractEntryFrontmatter(entry); syncBlocks(entry); state.entries.push(entry); state.sourceLinks.push({ entryId: id, sourceId: item.rawSourceId, locations: [{ legacyItemId: item.id }] }); state.migration.mappings[`item:${item.id}`] = id;
    }
  }
  for (const chapter of state.chapters) if (byId.get(chapter.conceptId)?.nodeType === 'chapter') {
    const detached = !memberships.get(chapter.conceptId)?.has(chapter.courseId);
    if (chapter.detached !== detached) { chapter.detached = detached; chapter.revision++; const course = state.courses.find((item) => item.id === chapter.courseId)!; course.documentRevision++; }
  }
  if (alreadyMigrated) {
    for (const course of state.courses) {
      const previous = prior.courses.find((item) => item.id === course.id);
      if (!previous || previous.documentRevision !== course.documentRevision) continue;
      const previousBody = JSON.stringify({ chapters: prior.chapters.filter((item) => item.courseId === course.id), entries: prior.entries.filter((item) => item.courseId === course.id) });
      const nextBody = JSON.stringify({ chapters: state.chapters.filter((item) => item.courseId === course.id), entries: state.entries.filter((item) => item.courseId === course.id) });
      if (previousBody !== nextBody) { course.documentRevision++; course.updatedAt = nowIso(); }
    }
  }
  state.migration.version = 1;
  if (JSON.stringify(state) !== original) state = await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  return state;
}

export function projectCourse(state: WorkspaceState, courseId: string): Omit<CourseDocument, 'sources'> {
  const course = state.courses.find((item) => item.id === courseId);
  if (!course) throw knowledgeError('not_found', 'Course not found');
  const chapters = sorted(state.chapters.filter((chapter) => chapter.courseId === courseId));
  const entries = sorted(state.entries.filter((entry) => entry.courseId === courseId));
  let markdown = `# ${course.title}\n\n`;
  const projection: CourseDocument['projection'] = [{ kind: 'title', from: 0, to: markdown.length - 2, courseChapterId: null, entryId: null, revision: course.documentRevision }];
  const append = (entry: ContentEntry) => {
    const from = markdown.length; markdown += entry.markdown;
    projection.push({ kind: 'entry', from, to: markdown.length, courseChapterId: entry.courseChapterId, entryId: entry.id, revision: entry.revision }); markdown += '\n\n';
  };
  for (const entry of entries.filter((value) => value.courseChapterId === null)) append(entry);
  for (const chapter of chapters.filter((value) => !value.detached)) {
    const from = markdown.length; markdown += `## ${chapter.title}\n\n`;
    projection.push({ kind: 'chapter', from, to: markdown.length - 2, courseChapterId: chapter.id, entryId: null, revision: chapter.revision });
    for (const entry of entries.filter((value) => value.courseChapterId === chapter.id)) append(entry);
  }
  return { courseId, title: course.title, documentRevision: course.documentRevision, markdown, chapters, entries, properties: course.properties, sourceLinks: state.sourceLinks.filter((link) => entries.some((entry) => entry.id === link.entryId)), projection };
}
export async function documentFromState(deps: CoreDeps, actor: ActorContext, state: WorkspaceState, courseId: string): Promise<CourseDocument> {
  const projected = projectCourse(state, courseId);
  const sources = await deps.repository.listRawSourcesByIds([...new Set(projected.sourceLinks.map((link) => link.sourceId))], actor.userId);
  return courseDocumentSchema.parse({ ...projected, sources });
}
export async function getCourseDocument(deps: CoreDeps, actor: ActorContext, courseId: string): Promise<CourseDocument> {
  return documentFromState(deps, actor, await loadWorkspace(deps, actor), courseId);
}
export function validateRequestSize(request: unknown): void {
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > WORKSPACE_REQUEST_MAX_BYTES) throw knowledgeError('invalid_request', '保存内容超过 2 MiB；请拆分修改，草稿已保留', { maxBytes: WORKSPACE_REQUEST_MAX_BYTES });
}
function checkRevision(key: string, actual: number | undefined, expected: number | undefined): void {
  if (expected === undefined || actual !== expected) throw knowledgeError('conflict', '内容已变更，请保留草稿并刷新后重试', { objectKey: key, expected, actual });
}
function checkReplay(state: WorkspaceState, requestId: string, request: unknown): WorkspaceMutationResult | null {
  const found = state.requests[requestId];
  if (!found) return null;
  if (found.fingerprint !== fingerprint(request)) throw knowledgeError('conflict', 'requestId was already used with different content');
  return structuredClone(found.result);
}
function refreshIndex(deps: CoreDeps, actor: ActorContext): void {
  void import('./metadata').then(({ refreshMetadata }) => refreshMetadata(deps, actor)).catch((error: unknown) => deps.logger.warn('Workspace metadata refresh failed', { reason: error instanceof Error ? error.message : String(error) }));
}
export async function finishMutation(deps: CoreDeps, actor: ActorContext, state: WorkspaceState, courseIds: string[], snapshotId: string | null, requestId?: string, request?: unknown): Promise<WorkspaceMutationResult> {
  const documents = await Promise.all([...new Set(courseIds)].map((courseId) => documentFromState(deps, actor, state, courseId)));
  const affectedLocations: ContentLocation[] = documents.flatMap((document) => [{ kind: 'course' as const, courseId: document.courseId }, ...document.entries.map((entry) => ({ kind: 'entry' as const, courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id }))]);
  const result = workspaceMutationResultSchema.parse({ documents, affectedLocations, revisions: objectRevisions(state), snapshotId });
  if (requestId) state.requests[requestId] = { fingerprint: fingerprint(request), result };
  await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  refreshIndex(deps, actor);
  return result;
}
function mapPosition(position: number, changes: DocumentChange[], right = false): number {
  let shift = 0;
  for (const change of changes) {
    if (position < change.from || (position === change.from && !right)) break;
    if (position <= change.to) return change.from + shift + (right ? change.insert.length : 0);
    shift += change.insert.length - (change.to - change.from);
  }
  return position + shift;
}
function applyChanges(markdown: string, changes: DocumentChange[]): string {
  let end = 0;
  for (const change of changes) {
    if (change.from < end || change.to < change.from || change.to > markdown.length) throw knowledgeError('invalid_request', 'Changes must be non-overlapping UTF-16 ranges in the original document');
    if ([change.from, change.to].some((offset) => offset > 0 && offset < markdown.length && /[\uD800-\uDBFF]/.test(markdown[offset - 1]) && /[\uDC00-\uDFFF]/.test(markdown[offset]))) throw knowledgeError('invalid_request', 'Change splits a Unicode character');
    end = change.to;
  }
  for (const change of [...changes].reverse()) markdown = markdown.slice(0, change.from) + change.insert + markdown.slice(change.to);
  return markdown;
}

export async function applyCourseDocumentPatch(deps: CoreDeps, actor: ActorContext, input: ApplyCourseDocumentPatchRequest): Promise<WorkspaceMutationResult> {
  validateRequestSize(input);
  const request = applyCourseDocumentPatchSchema.parse(input);
  const state = await loadWorkspace(deps, actor);
  const replay = checkReplay(state, request.requestId, request); if (replay) return replay;
  const old = projectCourse(state, request.courseId);
  checkRevision(`course:${request.courseId}`, old.documentRevision, request.baseDocumentRevision);
  const changes = [...request.changes].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const entryId of Object.keys(request.entryRevisions)) if (!old.entries.some((entry) => entry.id === entryId)) throw knowledgeError('invalid_request', 'Entry is outside the target course');
  const touched = old.projection.filter((range) => range.kind === 'entry' && changes.some((change) => change.from <= range.to && change.to >= range.from));
  for (const range of touched) checkRevision(`entry:${range.entryId}`, range.revision, request.entryRevisions[range.entryId!]);
  for (const [entryId, expected] of Object.entries(request.entryRevisions)) {
    const entry = old.entries.find((value) => value.id === entryId);
    if (!entry) throw knowledgeError('invalid_request', 'Entry is outside the target course');
    checkRevision(`entry:${entryId}`, entry.revision, expected);
  }
  const markdown = applyChanges(old.markdown, changes);
  const parsed = parseMarkdown(markdown);
  const before = workspaceContent(state);
  const course = state.courses.find((value) => value.id === request.courseId)!;
  if (parsed.frontmatter) course.properties = { ...course.properties, ...parsed.properties };
  const title = parsed.headings.find((heading) => heading.depth === 1 && markdown.slice(parsed.frontmatter?.to ?? 0, heading.from).trim() === '');
  if (title) course.title = title.text;
  const oldHeadings = old.projection.filter((range) => range.kind === 'chapter');
  const selectedChapters = new Set<string>();
  const headings = parsed.headings.filter((heading) => heading.depth === 2);
  const sections: { from: number; to: number; chapterId: string | null }[] = [{ from: title?.to ?? parsed.frontmatter?.to ?? 0, to: headings[0]?.from ?? markdown.length, chapterId: null }];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const mapped = oldHeadings.find((range) => !selectedChapters.has(range.courseChapterId!) && mapPosition(range.from, changes) === heading.from);
    let chapter = mapped ? state.chapters.find((value) => value.id === mapped.courseChapterId) : old.chapters.find((value) => !value.detached && !selectedChapters.has(value.id) && value.title === heading.text && oldHeadings.some((range) => range.courseChapterId === value.id && changes.some((change) => change.from <= range.from && change.to >= range.to)));
    if (!chapter) {
      const conceptId = createId(); state.concepts.push({ id: conceptId, userId: actor.userId, title: heading.text, revision: 1 });
      chapter = { id: createId(), userId: actor.userId, courseId: request.courseId, conceptId, title: heading.text, order: index, revision: 1, properties: {}, detached: false };
      state.chapters.push(chapter);
    } else if (chapter.title !== heading.text || chapter.order !== index) { chapter.title = heading.text; chapter.order = index; chapter.revision++; }
    selectedChapters.add(chapter.id);
    sections.push({ from: heading.to, to: headings[index + 1]?.from ?? markdown.length, chapterId: chapter.id });
  }
  const wholeUnitsReplaced = old.projection.filter((range) => range.kind === 'entry' && changes.some((change) => change.from <= range.from && change.to >= range.to)).length > 1;
  const oldRanges = old.projection.filter((range) => range.kind === 'entry').map((range) => ({ ...range, from: mapPosition(range.from, changes), to: mapPosition(range.to, changes, true) }));
  const oldVisibleIds = new Set(oldRanges.map((range) => range.entryId));
  const used = new Set<string>();
  const replacement: ContentEntry[] = [];
  const replacementLinks: WorkspaceState['sourceLinks'] = [];
  for (const section of sections) {
    const cuts = new Set([section.from, section.to]);
    for (const range of oldRanges) for (const offset of [range.from, range.to]) if (offset > section.from && offset < section.to && (markdown[offset] === '\n' || markdown[offset - 1] === '\n')) cuts.add(offset);
    // Exact old units supply reorder boundaries even when an editor replaces a larger selection.
    for (const entry of wholeUnitsReplaced ? old.entries.filter((value) => oldVisibleIds.has(value.id) && value.markdown.length > 0) : []) {
      const offset = markdown.indexOf(entry.markdown, section.from);
      if (offset >= section.from && offset + entry.markdown.length <= section.to && (markdown.slice(section.from, offset).trim() === '' || markdown.slice(offset - 2, offset) === '\n\n') && (markdown.slice(offset + entry.markdown.length, section.to).trim() === '' || markdown.slice(offset + entry.markdown.length, offset + entry.markdown.length + 2) === '\n\n')) { cuts.add(offset); cuts.add(offset + entry.markdown.length); }
    }
    const boundaries = [...cuts].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      let from = boundaries[index]; let to = boundaries[index + 1];
      while (from < to && /[\r\n]/.test(markdown[from])) from++;
      while (to > from && /[\r\n]/.test(markdown[to - 1])) to--;
      if (from === to || markdown.slice(from, to).trim() === '') continue;
      const text = markdown.slice(from, to);
      const exact = old.entries.find((entry) => oldVisibleIds.has(entry.id) && !used.has(entry.id) && entry.markdown === text);
      const overlapping = oldRanges.filter((range) => range.from < to && range.to > from).map((range) => old.entries.find((entry) => entry.id === range.entryId)!);
      const chosen = exact ?? overlapping.find((entry) => !used.has(entry.id));
      const entry: ContentEntry = chosen ? { ...structuredClone(chosen), courseChapterId: section.chapterId, markdown: text, order: replacement.length } : { id: createId(), userId: actor.userId, courseId: request.courseId, courseChapterId: section.chapterId, markdown: text, order: replacement.length, revision: 1, properties: {}, blocks: [] };
      if (chosen && (entry.markdown !== chosen.markdown || entry.courseChapterId !== chosen.courseChapterId || entry.order !== chosen.order)) entry.revision++;
      const provenance = exact ? [exact] : overlapping;
      extractEntryFrontmatter(entry);
      syncBlocks(entry, provenance.flatMap((value) => value.blocks));
      for (const source of state.sourceLinks.filter((link) => provenance.some((value) => value.id === link.entryId))) {
        const existing = replacementLinks.find((link) => link.entryId === entry.id && link.sourceId === source.sourceId);
        if (existing) existing.locations = [...new Map([...existing.locations, ...source.locations].map((value) => [JSON.stringify(value), value])).values()];
        else replacementLinks.push({ ...structuredClone(source), entryId: entry.id });
      }
      used.add(entry.id); replacement.push(entry);
    }
  }
  state.entries = [...state.entries.filter((entry) => !oldVisibleIds.has(entry.id)), ...replacement];
  state.sourceLinks = [...state.sourceLinks.filter((link) => !oldVisibleIds.has(link.entryId)), ...replacementLinks];
  const removedChapters = old.chapters.filter((chapter) => !chapter.detached && !selectedChapters.has(chapter.id));
  state.chapters = state.chapters.filter((chapter) => !removedChapters.some((removed) => removed.id === chapter.id));
  course.documentRevision++; course.updatedAt = nowIso();
  for (const entry of old.entries) if (oldVisibleIds.has(entry.id) && !used.has(entry.id)) state.tombstones[`entry:${entry.id}`] = entry.revision + 1;
  for (const chapter of removedChapters) state.tombstones[`chapter:${chapter.id}`] = chapter.revision + 1;
  const referenceCourses = rewriteRenamedReferences(state, before);
  for (const other of state.courses) if (referenceCourses.has(other.id) && other.id !== request.courseId) { other.documentRevision++; other.updatedAt = nowIso(); }
  const deletion = changes.some((change) => change.to > change.from && change.insert.length < change.to - change.from);
  const snapshotId = takeSnapshot(state, before, actor, deletion ? 'delete' : 'edit', deletion);
  return finishMutation(deps, actor, state, [request.courseId, ...referenceCourses], snapshotId, request.requestId, request);
}

export function workspaceLinkTargets(state: WorkspaceState): LinkTarget[] {
  return state.courses.map((course) => {
    const document = projectCourse(state, course.id);
    return {
      courseId: course.id, title: course.title, path: course.id,
      aliases: [course.title, ...(Array.isArray(course.properties.aliases) ? course.properties.aliases.filter((item): item is string => typeof item === 'string') : [])],
      headings: [
        ...document.chapters.filter((chapter) => !chapter.detached).map((chapter) => ({ depth: 2, text: chapter.title, from: 0, to: 0, contentFrom: 0, contentTo: 0, path: [chapter.title], courseChapterId: chapter.id })),
        ...document.entries.flatMap((entry) => parseMarkdown(entry.markdown).headings.map((heading) => ({ ...heading, path: [...(document.chapters.find((chapter) => chapter.id === entry.courseChapterId) ? [document.chapters.find((chapter) => chapter.id === entry.courseChapterId)!.title] : []), ...heading.path], courseChapterId: entry.courseChapterId, entryId: entry.id }))),
      ],
      blocks: document.entries.flatMap((entry) => entry.blocks.map((block) => ({ ...block, type: 'paragraph', text: entry.markdown.slice(block.from, block.to), entryId: entry.id, courseChapterId: entry.courseChapterId }))),
    };
  });
}

function currentTarget(target: EngineLocation, before: WorkspaceState, after: WorkspaceState, newTargets: LinkTarget[]): EngineLocation | null {
  if (target.blockId) {
    const entry = after.entries.find((value) => value.blocks.some((block) => block.id === target.blockId));
    return entry ? { ...target, courseId: entry.courseId, courseChapterId: entry.courseChapterId, entryId: entry.id } : null;
  }
  if (target.entryId) {
    const entry = after.entries.find((value) => value.id === target.entryId);
    if (!entry) return null;
    let headingPath = target.headingPath;
    if (headingPath) {
      const oldEntry = before.entries.find((value) => value.id === target.entryId);
      const oldHeadings = parseMarkdown(oldEntry?.markdown ?? '').headings;
      const newHeadings = parseMarkdown(entry.markdown).headings;
      const index = oldHeadings.findIndex((heading) => heading.path.at(-1) === headingPath!.at(-1));
      const heading = oldHeadings.length === newHeadings.length ? newHeadings[index] : newHeadings.find((value) => value.path.at(-1) === headingPath!.at(-1));
      if (!heading) return null;
      headingPath = newTargets.find((value) => value.courseId === entry.courseId)?.headings?.find((value) => value.entryId === entry.id && value.path.at(-1) === heading.path.at(-1))?.path;
    }
    return { ...target, courseId: entry.courseId, courseChapterId: entry.courseChapterId, headingPath };
  }
  if (target.courseChapterId && !after.chapters.some((value) => value.id === target.courseChapterId)) return null;
  return target;
}

/** Rewrite only references that previously resolved to an identity which still exists. */
function rewriteRenamedReferences(state: WorkspaceState, before: WorkspaceContent): Set<string> {
  const oldState = { ...state, ...before };
  const oldTargets = workspaceLinkTargets(oldState); const newTargets = workspaceLinkTargets(state);
  const affected = new Set<string>();
  const rewrite = (markdown: string, courseId: string, entryId?: string, courseChapterId?: string | null, contextMoved = false): string => {
    const edits = parseMarkdown(markdown).links.flatMap((reference) => {
      const resolved = resolveKnowledgeLink({ courseId, entryId, courseChapterId }, reference.target, oldTargets);
      if (resolved.status !== 'resolved') return [];
      const target = currentTarget(resolved.target, oldState, state, newTargets); if (!target) return [];
      const oldCanonical = formatLinkTarget(resolved.target, oldTargets); const canonical = formatLinkTarget(target, newTargets);
      const renamedCourse = oldState.courses.find((value) => value.id === target.courseId)?.title !== state.courses.find((value) => value.id === target.courseId)?.title;
      return oldCanonical !== canonical || renamedCourse || contextMoved ? [{ reference, target: canonical }] : [];
    });
    return edits.length ? rewriteReferences(markdown, edits) : markdown;
  };
  for (const entry of state.entries) {
    const oldEntry = before.entries.find((value) => value.id === entry.id);
    const markdown = rewrite(entry.markdown, oldEntry?.courseId ?? entry.courseId, entry.id, oldEntry?.courseChapterId ?? entry.courseChapterId, oldEntry !== undefined && oldEntry.courseId !== entry.courseId);
    if (markdown !== entry.markdown) { entry.markdown = markdown; entry.revision++; syncBlocks(entry); affected.add(entry.courseId); }
  }
  for (const object of [...state.courses, ...state.chapters, ...state.entries]) {
    const courseId = 'courseId' in object ? object.courseId : object.id;
    const text = setFrontmatterProperties('', object.properties);
    const oldEntry = 'markdown' in object ? before.entries.find((value) => value.id === object.id) : undefined;
    const rewritten = rewrite(text, oldEntry?.courseId ?? courseId, 'markdown' in object ? object.id : undefined, 'conceptId' in object ? object.id : 'courseChapterId' in object ? object.courseChapterId : null, oldEntry !== undefined && oldEntry.courseId !== courseId);
    if (rewritten !== text) {
      object.properties = parseMarkdown(rewritten).properties;
      if ('revision' in object) object.revision++;
      affected.add(courseId);
    }
  }
  return affected;
}

export async function moveSourceAssignments(deps: CoreDeps, actor: ActorContext, input: MoveSourceAssignmentsRequest): Promise<WorkspaceMutationResult> {
  validateRequestSize(input);
  const request = moveSourceAssignmentsSchema.parse(input);
  const state = await loadWorkspace(deps, actor);
  const replay = checkReplay(state, request.requestId, request); if (replay) return replay;
  if (!await deps.repository.findRawSource(request.sourceId, actor.userId)) throw knowledgeError('not_found', 'Source not found');
  if (!state.courses.some((course) => course.id === request.toCourseId)) throw knowledgeError('not_found', 'Destination course not found');
  if (request.toCourseChapterId !== null && !state.chapters.some((chapter) => chapter.id === request.toCourseChapterId && chapter.courseId === request.toCourseId)) throw knowledgeError('invalid_request', 'Destination chapter belongs to another course');
  const ids = new Set(request.entryIds);
  if (ids.size !== request.entryIds.length) throw knowledgeError('invalid_request', 'Duplicate entry IDs');
  const moving = request.entryIds.map((id) => {
    const entry = state.entries.find((value) => value.id === id);
    if (!entry || !state.sourceLinks.some((link) => link.entryId === id && link.sourceId === request.sourceId)) throw knowledgeError('invalid_request', 'Selected entry is not assigned to this source');
    checkRevision(`entry:${id}`, entry.revision, request.expectedEntryRevisions[id]); return entry;
  });
  const affectedCourses = new Set([request.toCourseId, ...moving.map((entry) => entry.courseId)]);
  for (const courseId of affectedCourses) checkRevision(`course:${courseId}`, state.courses.find((course) => course.id === courseId)?.documentRevision, request.expectedDocumentRevisions[courseId]);
  const before = workspaceContent(state);
  const oldTargets = workspaceLinkTargets(state);
  const oldLocations = new Map(moving.map((entry) => [entry.id, { courseId: entry.courseId, courseChapterId: entry.courseChapterId }]));
  const usedAliases = new Set(state.entries.filter((entry) => entry.courseId === request.toCourseId && !ids.has(entry.id)).flatMap((entry) => entry.blocks.map((block) => block.alias)));
  for (const entry of moving) {
    const blockChanges: DocumentChange[] = [];
    for (const block of entry.blocks) {
      let alias = block.alias; let suffix = 2;
      while (usedAliases.has(alias)) alias = `${block.alias}-${suffix++}`;
      usedAliases.add(alias);
      if (alias !== block.alias) {
        const at = entry.markdown.lastIndexOf(`^${block.alias}`, block.to);
        if (at < block.from) throw knowledgeError('conflict', 'Block alias cannot be rewritten safely');
        blockChanges.push({ from: at + 1, to: at + 1 + block.alias.length, insert: alias }); block.alias = alias;
      }
    }
    entry.markdown = applyChanges(entry.markdown, blockChanges.sort((a, b) => a.from - b.from));
    entry.courseId = request.toCourseId; entry.courseChapterId = request.toCourseChapterId;
    entry.order = Math.max(-1, ...state.entries.filter((item) => item.courseId === request.toCourseId).map((item) => item.order)) + 1;
    entry.revision++; syncBlocks(entry);
  }
  const newTargets = workspaceLinkTargets(state);
  for (const entry of state.entries) {
    const previous = before.entries.find((value) => value.id === entry.id)!;
    const oldContext = oldLocations.get(entry.id) ?? { courseId: previous.courseId, courseChapterId: previous.courseChapterId };
    const parsed = parseMarkdown(previous.markdown);
    const rewrites = parsed.links.flatMap((reference) => {
      const resolution = resolveKnowledgeLink({ ...oldContext, entryId: entry.id }, reference.target, oldTargets);
      if (resolution.status !== 'resolved') return [];
      let target: EngineLocation = resolution.target;
      const movedTarget = target.entryId ? moving.find((value) => value.id === target.entryId) : target.blockId ? moving.find((value) => value.blocks.some((block) => block.id === target.blockId || block.alias === target.blockId)) : undefined;
      if (!ids.has(entry.id) && !movedTarget) return [];
      if (movedTarget) target = { ...target, courseId: movedTarget.courseId, courseChapterId: movedTarget.courseChapterId, entryId: movedTarget.id };
      return [{ reference, target: formatLinkTarget(target, newTargets) }];
    });
    if (!rewrites.length) continue;
    if (!ids.has(entry.id)) checkRevision(`entry:${previous.id}`, previous.revision, request.expectedEntryRevisions[previous.id]);
    if (!affectedCourses.has(previous.courseId)) {
      checkRevision(`course:${previous.courseId}`, state.courses.find((course) => course.id === previous.courseId)?.documentRevision, request.expectedDocumentRevisions[previous.courseId]);
      checkRevision(`entry:${previous.id}`, previous.revision, request.expectedEntryRevisions[previous.id]);
      affectedCourses.add(previous.courseId);
    }
    // Rewrites use original coordinates; apply alias edits after semantic references to avoid drift.
    let rewritten = rewriteReferences(previous.markdown, rewrites);
    if (ids.has(entry.id)) for (const block of entry.blocks) {
      const oldBlock = previous.blocks.find((value) => value.id === block.id);
      if (oldBlock && oldBlock.alias !== block.alias) {
        const parsedBlock = parseMarkdown(rewritten).blocks.find((value) => value.alias === oldBlock.alias);
        if (!parsedBlock) throw knowledgeError('conflict', 'Block alias reference rewrite failed');
        const at = rewritten.lastIndexOf(`^${oldBlock.alias}`, parsedBlock.to);
        rewritten = rewritten.slice(0, at + 1) + block.alias + rewritten.slice(at + 1 + oldBlock.alias.length);
      }
    }
    if (rewritten !== entry.markdown) { entry.markdown = rewritten; if (!ids.has(entry.id)) entry.revision++; syncBlocks(entry); }
  }
  const propertyCourses = rewriteRenamedReferences(state, before);
  for (const courseId of propertyCourses) {
    if (!affectedCourses.has(courseId)) checkRevision(`course:${courseId}`, state.courses.find((course) => course.id === courseId)?.documentRevision, request.expectedDocumentRevisions[courseId]);
    affectedCourses.add(courseId);
  }
  for (const entry of state.entries) {
    const previous = before.entries.find((value) => value.id === entry.id);
    if (!ids.has(entry.id) && previous && entry.revision !== previous.revision) checkRevision(`entry:${entry.id}`, previous.revision, request.expectedEntryRevisions[entry.id]);
  }
  for (const course of state.courses) if (affectedCourses.has(course.id)) { course.documentRevision++; course.updatedAt = nowIso(); }
  const snapshotId = takeSnapshot(state, before, actor, 'source-assignment-move');
  return finishMutation(deps, actor, state, [...affectedCourses], snapshotId, request.requestId, request);
}

/** Compatibility endpoints project the same authority; knowledge_notes stays migration evidence. */
export async function getLegacyCourseNote(deps: CoreDeps, actor: ActorContext, topicId: string, conceptId: string | null): Promise<{ topicId: string; chapterId: string | null; content: string; updatedAt: string | null }> {
  const state = await loadWorkspace(deps, actor);
  const course = state.courses.find((item) => item.id === topicId);
  if (!course) throw knowledgeError('not_found', 'Course not found');
  const chapter = conceptId === null ? null : state.chapters.find((item) => item.courseId === topicId && item.conceptId === conceptId);
  return { topicId, chapterId: conceptId, content: sorted(state.entries.filter((entry) => entry.courseId === topicId && entry.courseChapterId === (chapter?.id ?? null) && (conceptId === null || chapter))).map((entry) => entry.markdown).join('\n\n'), updatedAt: course.updatedAt };
}
export async function saveLegacyCourseNote(deps: CoreDeps, actor: ActorContext, topicId: string, conceptId: string | null, content: string): Promise<{ topicId: string; chapterId: string | null; content: string; updatedAt: string | null }> {
  const state = await loadWorkspace(deps, actor);
  const course = state.courses.find((item) => item.id === topicId);
  if (!course) throw knowledgeError('not_found', 'Course not found');
  let chapter = conceptId === null ? null : state.chapters.find((item) => item.courseId === topicId && item.conceptId === conceptId);
  if (conceptId !== null && !chapter) {
    const node = await deps.repository.findNode(conceptId, actor.userId);
    if (!node) throw knowledgeError('not_found', 'Chapter not found');
    chapter = ensureChapter(state, actor.userId, topicId, node, true);
  }
  const before = workspaceContent(state);
  const existing = sorted(state.entries.filter((entry) => entry.courseId === topicId && entry.courseChapterId === (chapter?.id ?? null)));
  const entry: ContentEntry = existing[0] ? { ...existing[0], markdown: content, revision: existing[0].revision + 1 } : { id: createId(), userId: actor.userId, courseId: topicId, courseChapterId: chapter?.id ?? null, markdown: content, revision: 1, order: state.entries.length, properties: {}, blocks: [] };
  extractEntryFrontmatter(entry); syncBlocks(entry);
  const removed = new Set(existing.map((item) => item.id));
  const links = state.sourceLinks.filter((link) => removed.has(link.entryId));
  state.entries = [...state.entries.filter((item) => !removed.has(item.id)), entry];
  const mergedLinks = new Map<string, WorkspaceState['sourceLinks'][number]>();
  for (const link of links) {
    const current = mergedLinks.get(link.sourceId);
    if (current) current.locations = [...new Map([...current.locations, ...link.locations].map((value) => [JSON.stringify(value), value])).values()];
    else mergedLinks.set(link.sourceId, { ...structuredClone(link), entryId: entry.id });
  }
  state.sourceLinks = [...state.sourceLinks.filter((link) => !removed.has(link.entryId)), ...mergedLinks.values()];
  course.documentRevision++; course.updatedAt = nowIso();
  for (const old of existing.slice(1)) state.tombstones[`entry:${old.id}`] = old.revision + 1;
  takeSnapshot(state, before, actor, 'legacy-note-write');
  await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  refreshIndex(deps, actor);
  return { topicId, chapterId: conceptId, content, updatedAt: course.updatedAt };
}

export async function patchWorkspaceProperties(deps: CoreDeps, actor: ActorContext, input: import('@noltri/schema').PatchWorkspacePropertiesRequest): Promise<WorkspaceMutationResult> {
  const { patchWorkspacePropertiesSchema } = await import('@noltri/schema');
  validateRequestSize(input);
  const request = patchWorkspacePropertiesSchema.parse(input);
  const state = await loadWorkspace(deps, actor);
  const replay = checkReplay(state, request.requestId, request); if (replay) return replay;
  const collection = request.owner.kind === 'course' ? state.courses : request.owner.kind === 'chapter' ? state.chapters : state.entries;
  const object = collection.find((item) => item.id === request.owner.id);
  if (!object) throw knowledgeError('not_found', 'Property owner not found');
  const actual = 'documentRevision' in object ? object.documentRevision : object.revision;
  checkRevision(`${request.owner.kind}:${object.id}`, actual, request.expectedRevision);
  for (const key of ['tags', 'aliases']) if (request.properties[key] !== undefined && (!Array.isArray(request.properties[key]) || !(request.properties[key] as unknown[]).every((value) => typeof value === 'string'))) throw knowledgeError('invalid_request', `${key} must be a list of strings`);
  const validValue = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(validValue) : typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(validValue));
  if (!validValue(request.properties)) throw knowledgeError('invalid_request', 'Properties must contain finite JSON values');
  const before = workspaceContent(state);
  object.properties = structuredClone(request.properties);
  const courseId = 'courseId' in object ? object.courseId : object.id;
  const course = state.courses.find((item) => item.id === courseId)!;
  if ('revision' in object) object.revision++;
  course.documentRevision++; course.updatedAt = nowIso();
  const snapshotId = takeSnapshot(state, before, actor, 'properties');
  return finishMutation(deps, actor, state, [courseId], snapshotId, request.requestId, request);
}
