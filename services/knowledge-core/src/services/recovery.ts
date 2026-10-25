import { workspaceSnapshotSchema, type WorkspaceSnapshot, type WorkspaceMutationResult, type WorkspaceState, type WorkspaceSettings } from '@noltri/schema';
import { knowledgeError, nowIso } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { loadWorkspace, workspaceContent, objectRevisions, takeSnapshot, finishMutation } from './course-workspace';

export async function listSnapshots(deps: CoreDeps, actor: ActorContext): Promise<WorkspaceSnapshot[]> {
  return (await loadWorkspace(deps, actor)).snapshots.slice().reverse().map((snapshot) => workspaceSnapshotSchema.parse(snapshot));
}
export async function restoreSnapshot(deps: CoreDeps, actor: ActorContext, snapshotId: string, expectedRevisions: Record<string, number>): Promise<WorkspaceMutationResult> {
  const state = await loadWorkspace(deps, actor);
  const snapshot = state.snapshots.find((item) => item.id === snapshotId && item.userId === actor.userId);
  if (!snapshot) throw knowledgeError('not_found', 'Snapshot not found');
  const currentRevisions = objectRevisions(state);
  const conflicts = snapshot.objectKeys.flatMap((key) => {
    const actual = currentRevisions[key]; const expected = expectedRevisions[key]; const saved = snapshot.afterRevisions[key];
    return expected === undefined || actual !== expected || actual !== saved ? [{ objectKey: key, expected, actual, snapshotRevision: saved }] : [];
  });
  if (conflicts.length) throw knowledgeError('conflict', '快照涉及的对象已变更，尚未恢复任何内容', { conflicts, current: workspaceContent(state), snapshot: snapshot.before });
  const before = workspaceContent(state);
  const keys = new Set(snapshot.objectKeys);
  const affectedCourses = new Set<string>();
  for (const collection of ['courses', 'concepts', 'chapters', 'entries'] as const) {
    const prefix = collection === 'courses' ? 'course' : collection === 'concepts' ? 'concept' : collection === 'chapters' ? 'chapter' : 'entry';
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
