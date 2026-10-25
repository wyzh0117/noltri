import { workspaceStateSchema, type WorkspaceState } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';

export function emptyWorkspaceState(): WorkspaceState {
  return { revision: 0, courses: [], concepts: [], chapters: [], entries: [], sourceLinks: [], snapshots: [], requests: {}, tombstones: {}, settings: { snapshotIntervalSeconds: 60, snapshotRetentionDays: 30 }, migration: { version: 0, mappings: {}, unconfirmed: [] } };
}

/** Validate the aggregate before the CAS, identically for both drivers. */
export function validateWorkspaceState(userId: string, state: WorkspaceState): WorkspaceState {
  const parsed = workspaceStateSchema.parse(state);
  const courses = new Map(parsed.courses.map((value) => [value.id, value]));
  const concepts = new Map(parsed.concepts.map((value) => [value.id, value]));
  const chapters = new Map(parsed.chapters.map((value) => [value.id, value]));
  const entries = new Map(parsed.entries.map((value) => [value.id, value]));
  for (const list of [parsed.courses, parsed.concepts, parsed.chapters, parsed.entries]) {
    if (new Set(list.map((value) => value.id)).size !== list.length || list.some((value) => value.userId !== userId)) {
      throw knowledgeError('invalid_request', 'Duplicate workspace identity or invalid owner');
    }
  }
  const memberships = new Set<string>();
  for (const chapter of chapters.values()) {
    const key = JSON.stringify([chapter.courseId, chapter.conceptId]);
    if (!courses.has(chapter.courseId) || !concepts.has(chapter.conceptId) || memberships.has(key)) throw knowledgeError('invalid_request', 'Invalid or duplicate course chapter');
    memberships.add(key);
  }
  const aliases = new Set<string>();
  const blocks = new Set<string>();
  for (const entry of entries.values()) {
    if (!courses.has(entry.courseId) || (entry.courseChapterId !== null && chapters.get(entry.courseChapterId)?.courseId !== entry.courseId)) throw knowledgeError('invalid_request', 'Entry chapter belongs to another course');
    for (const block of entry.blocks) {
      const key = JSON.stringify([entry.courseId, block.alias]);
      if (aliases.has(key) || blocks.has(block.id)) throw knowledgeError('conflict', 'Block aliases must be unique in a course and block IDs globally stable');
      if (block.to < block.from || block.to > entry.markdown.length) throw knowledgeError('invalid_request', 'Invalid block range');
      aliases.add(key); blocks.add(block.id);
    }
  }
  const sourceLinks = new Set<string>();
  for (const link of parsed.sourceLinks) {
    const key = JSON.stringify([link.entryId, link.sourceId]);
    if (!entries.has(link.entryId) || sourceLinks.has(key)) throw knowledgeError('invalid_request', 'Invalid or duplicate source association');
    sourceLinks.add(key);
  }
  for (const snapshot of parsed.snapshots) if (snapshot.userId !== userId) throw knowledgeError('invalid_request', 'Invalid snapshot owner');
  return parsed;
}

/** Legacy reads project the authority while original knowledge_notes rows stay migration evidence. */
export function workspaceKnowledgeNote(state: WorkspaceState | undefined, userId: string, topicId: string, chapterId: string | null): import('@noltri/schema').KnowledgeNote | undefined {
  if (!state || state.migration.version < 1) return undefined;
  const course = state.courses.find((item) => item.id === topicId);
  if (!course) return undefined;
  const chapter = chapterId === null ? null : state.chapters.find((item) => item.courseId === topicId && item.conceptId === chapterId);
  const entries = state.entries.filter((item) => item.courseId === topicId && item.courseChapterId === (chapter?.id ?? null) && (chapterId === null || chapter)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (!entries.length && !state.migration.mappings[`note:${JSON.stringify([topicId, chapterId])}`]) return undefined;
  return { userId, topicId, chapterId, content: entries.map((item) => item.markdown).join('\n\n'), createdAt: course.updatedAt, updatedAt: course.updatedAt };
}
