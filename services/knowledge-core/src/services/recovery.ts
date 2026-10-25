import { workspaceSnapshotSchema, type WorkspaceSnapshot, type WorkspaceMutationResult, type WorkspaceState, type WorkspaceSettings } from '@noltri/schema';
import { knowledgeError, nowIso } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { loadWorkspace, workspaceContent, objectRevisions, takeSnapshot, finishMutation } from './course-workspace';

export async function listSnapshots(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceSnapshot[]> {
  return (await loadWorkspace(deps, actor)).snapshots.slice().reverse().map((snapshot) => workspaceSnapshotSchema.parse(snapshot));
}
/** Include only dependencies that would become invalid in the reviewed historical state. */
function recoveryKeys(state: WorkspaceState, snapshot: WorkspaceSnapshot): Set<string> {
  const keys = new Set(snapshot.objectKeys);
  const projected = <T extends { id: string }>(current: T[], before: T[], kind: string): T[] => [
    ...current.filter(item => !keys.has(`${kind}:${item.id}`)), ...before.filter(item => keys.has(`${kind}:${item.id}`)),
  ];
  let size: number;
  do {
    size = keys.size;
    const courses = new Set(projected(state.courses, snapshot.before.courses, 'course').map(item => item.id));
    const concepts = new Set(projected(state.concepts, snapshot.before.concepts, 'concept').map(item => item.id));
    const chapters = new Map(projected(state.chapters, snapshot.before.chapters, 'chapter').map(item => [item.id, item]));
    for (const chapter of chapters.values()) {
      if (courses.has(chapter.courseId) && concepts.has(chapter.conceptId)) continue;
      const key = `chapter:${chapter.id}`;
      if (!keys.has(key)) keys.add(key);
      else {
        if (!courses.has(chapter.courseId)) keys.add(`course:${chapter.courseId}`);
        if (!concepts.has(chapter.conceptId)) keys.add(`concept:${chapter.conceptId}`);
      }
    }
    for (const entry of projected(state.entries, snapshot.before.entries, 'entry')) {
      if (courses.has(entry.courseId) && (entry.courseChapterId === null || chapters.get(entry.courseChapterId)?.courseId === entry.courseId)) continue;
      const key = `entry:${entry.id}`;
      if (!keys.has(key)) keys.add(key);
      else {
        if (!courses.has(entry.courseId)) keys.add(`course:${entry.courseId}`);
        if (entry.courseChapterId !== null) keys.add(`chapter:${entry.courseChapterId}`);
      }
    }
  } while (keys.size !== size);
  return keys;
}
export async function compareSnapshot(deps: CoreDeps, actor: ActorContext, snapshotId: string) {
  const state = await loadWorkspace(deps, actor), snapshot = state.snapshots.find(item => item.id === snapshotId);
  if (!snapshot) throw knowledgeError('not_found', 'Snapshot not found');
  const revisions = objectRevisions(state);
  return { current: workspaceContent(state), revisions, conflicts: [...recoveryKeys(state, snapshot)].filter(key => revisions[key] !== snapshot.afterRevisions[key]) };
}
export async function restoreSnapshot(deps: CoreDeps, actor: ActorContext, snapshotId: string, expectedRevisions: Record<string, number>, resolveConflicts = false): Promise<WorkspaceMutationResult> {
  const state = await loadWorkspace(deps, actor);
  const snapshot = state.snapshots.find((item) => item.id === snapshotId && item.userId === actor.userId);
  if (!snapshot) throw knowledgeError('not_found', 'Snapshot not found');
  const currentRevisions = objectRevisions(state);
  const checkedKeys = resolveConflicts ? [...new Set([...Object.keys(currentRevisions), ...Object.keys(expectedRevisions)])] : snapshot.objectKeys;
  const conflicts = checkedKeys.flatMap((key) => {
    const actual = currentRevisions[key]; const expected = expectedRevisions[key]; const saved = snapshot.afterRevisions[key];
    return expected === undefined || actual !== expected || (!resolveConflicts && actual !== saved) ? [{ objectKey: key, expected, actual, snapshotRevision: saved }] : [];
  });
  if (conflicts.length) throw knowledgeError('conflict', '快照涉及的对象已变更，尚未恢复任何内容', { conflicts, current: workspaceContent(state), snapshot: snapshot.before });
  const before = workspaceContent(state);
  const keys = resolveConflicts ? recoveryKeys(state, snapshot) : new Set(snapshot.objectKeys);
  const affectedCourses = new Set<string>();
  for (const collection of ['courses', 'concepts', 'chapters', 'entries', 'attachments'] as const) {
    const prefix = collection === 'courses' ? 'course' : collection === 'concepts' ? 'concept' : collection === 'chapters' ? 'chapter' : collection === 'attachments' ? 'attachment' : 'entry';
    const existing = state[collection] as Array<{ id: string; courseId?: string; revision?: number; documentRevision?: number }>;
    const replacements = structuredClone(snapshot.before[collection]) as typeof existing;
    const restored = existing.filter((item) => !keys.has(`${prefix}:${item.id}`));
    for (const item of existing) if (keys.has(`${prefix}:${item.id}`)) affectedCourses.add(item.courseId ?? (prefix === 'course' ? item.id : ''));
    for (const item of replacements) {
      const key = `${prefix}:${item.id}`;
      if (!keys.has(key)) continue;
      if (prefix === 'course') { item.documentRevision = (currentRevisions[key] ?? 0) + 1; Object.assign(item, { updatedAt: nowIso() }); affectedCourses.add(item.id); }
      else { item.revision = (currentRevisions[key] ?? 0) + 1; if (item.courseId) affectedCourses.add(item.courseId); }
      delete state.tombstones[key]; restored.push(item);
    }
    for (const item of existing) if (keys.has(`${prefix}:${item.id}`) && !restored.some((value) => value.id === item.id)) state.tombstones[`${prefix}:${item.id}`] = (currentRevisions[`${prefix}:${item.id}`] ?? 0) + 1;
    // Collection identity is fixed by the loop; the broad local shape only shares the revision update.
    (state[collection] as unknown[]) = restored;
  }
  const entryKeys = new Set([...keys].filter((key) => key.startsWith('entry:')).map((key) => key.slice(6)));
  state.sourceLinks = [...state.sourceLinks.filter((link) => !entryKeys.has(link.entryId)), ...structuredClone(snapshot.before.sourceLinks.filter((link) => entryKeys.has(link.entryId)))];
  const ownerKeys = [...keys].filter((key) => /^(course|chapter|entry):/.test(key));
  const belongsToRestoredOwner = (bindingKey: string): boolean => ownerKeys.some((key) => bindingKey === key || bindingKey.startsWith(`${key}:property:`));
  state.resolvedReferences = Object.fromEntries([
    ...Object.entries(state.resolvedReferences).filter(([key]) => !belongsToRestoredOwner(key)),
    ...Object.entries(snapshot.before.resolvedReferences).filter(([key]) => belongsToRestoredOwner(key)).map(([key, binding]) => {
      const owner = ownerKeys.find((ownerKey) => key === ownerKey || key.startsWith(`${ownerKey}:property:`))!;
      return [key, { ...structuredClone(binding), revision: objectRevisions(state)[owner] ?? binding.revision }];
    }),
  ]);
  for (const course of state.courses) if (affectedCourses.has(course.id) && !keys.has(`course:${course.id}`)) { course.documentRevision++; course.updatedAt = nowIso(); }
  const protection = takeSnapshot(state, before, actor, 'before-restore');
  affectedCourses.delete('');
  return finishMutation(deps, actor, state, [...affectedCourses].filter((id) => state.courses.some((course) => course.id === id)), protection);
}

export async function getWorkspaceSettings(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceSettings> {
  return (await loadWorkspace(deps, actor)).settings;
}
export async function updateWorkspaceSettings(deps: CoreDeps, actor: ActorContext, input: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  const { workspaceSettingsSchema } = await import('@noltri/schema');
  const state = await loadWorkspace(deps, actor);
  state.settings = workspaceSettingsSchema.parse({ ...state.settings, ...input });
  await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  return state.settings;
}
