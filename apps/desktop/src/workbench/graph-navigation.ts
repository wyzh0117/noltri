import type { GraphNode, GraphNoteIndexEntry, GraphScope, SearchHit, TreeNode } from '@noltri/schema';
import type { NoteIdentity } from './note-drafts';

export type WorkbenchContent =
  | { kind: 'library' }
  | { kind: 'cards'; scope: GraphScope; selectedNodeId: string }
  | { kind: 'topic'; topicId: string }
  | { kind: 'chapter'; topicId: string; chapterId: string };

export interface TreeSelection {
  path: TreeNode[];
  scope: GraphScope;
  content: WorkbenchContent;
}

/** Monotonic token shared by all user-initiated content navigation. */
export class NavigationIntentClock {
  private value = 0;

  begin(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(intent: number): boolean {
    return intent === this.value;
  }
}

/** Ignore late async navigation results before they can mutate the workbench. */
export async function commitLatestNavigation<T>(
  clock: NavigationIntentClock,
  intent: number,
  result: Promise<T>,
  commit: (value: T) => void | Promise<void>,
): Promise<boolean> {
  let value: T;
  try {
    value = await result;
  } catch (error) {
    if (!clock.isCurrent(intent)) return false;
    throw error;
  }
  if (!clock.isCurrent(intent)) return false;
  await commit(value);
  return clock.isCurrent(intent);
}

export function shouldReuseActiveNote(
  activeIdentity: NoteIdentity | null,
  targetIdentity: NoteIdentity,
  forceReload = false,
): boolean {
  return !forceReload
    && activeIdentity !== null
    && activeIdentity.topicId === targetIdentity.topicId
    && activeIdentity.chapterId === targetIdentity.chapterId;
}

export function findTreePath(nodes: readonly TreeNode[], id: string, parents: TreeNode[] = []): TreeNode[] | null {
  for (const node of nodes) {
    const path = [...parents, node];
    if (node.id === id) return path;
    const nested = findTreePath(node.children ?? [], id, path);
    if (nested !== null) return nested;
  }
  return null;
}

export function graphChapterTitle(
  topicId: string,
  chapterId: string,
  graphNodes: readonly GraphNode[],
  tree: readonly TreeNode[],
  notes: readonly GraphNoteIndexEntry[],
): string {
  const indexedTitle = notes.find((entry) => entry.topicId === topicId && entry.chapterId === chapterId)?.chapterTitle;
  const treeNode = findTreePath(tree, chapterId)?.at(-1);
  return graphNodes.find((node) => node.id === chapterId && node.nodeType === 'chapter')?.title
    ?? (indexedTitle?.trim() ? indexedTitle : null)
    ?? (treeNode?.nodeType === 'chapter' ? treeNode.title : null)
    ?? '章节正文';
}

/** null means the per-topic relationship index has not confirmed this note yet. */
export function graphChapterAttachment(
  notes: readonly GraphNoteIndexEntry[],
  topicId: string,
  chapterId: string,
): 'attached' | 'detached' | null {
  const entry = notes.find((candidate) => candidate.topicId === topicId && candidate.chapterId === chapterId);
  return entry === undefined ? null : entry.attached ? 'attached' : 'detached';
}

export function selectionForTreeNode(nodes: readonly TreeNode[], id: string): TreeSelection | null {
  const path = findTreePath(nodes, id);
  if (path === null || path.length === 0) return null;
  const disciplineId = path[0]!.id;
  const selected = path.at(-1)!;

  if (selected.nodeType === 'chapter') {
    const topic = [...path].reverse().find((node) => node.nodeType === 'topic');
    if (topic === undefined) return null;
    return {
      path,
      scope: { kind: 'topic', disciplineId, anchorTopicId: topic.id },
      content: { kind: 'chapter', topicId: topic.id, chapterId: selected.id },
    };
  }

  if (path.length === 1) {
    return { path, scope: { kind: 'discipline', disciplineId }, content: { kind: 'cards', scope: { kind: 'discipline', disciplineId }, selectedNodeId: id } };
  }
  if (path.length === 2) {
    const scope: GraphScope = { kind: 'subdiscipline', disciplineId, subdisciplineId: id };
    return { path, scope, content: { kind: 'cards', scope, selectedNodeId: id } };
  }

  const topic = selected.nodeType === 'topic'
    ? selected
    : [...path].reverse().find((node) => node.nodeType === 'topic');
  if (topic === undefined) return null;
  const scope: GraphScope = { kind: 'topic', disciplineId, anchorTopicId: topic.id };
  return { path, scope, content: { kind: 'topic', topicId: topic.id } };
}

export function disciplineScopesForTopics(nodes: readonly TreeNode[], topicIds: readonly string[]): GraphScope[] {
  const disciplineIds = new Set<string>();
  for (const topicId of topicIds) {
    const discipline = findTreePath(nodes, topicId)?.[0];
    if (discipline?.nodeType === 'discipline') disciplineIds.add(discipline.id);
  }
  return [...disciplineIds].map((disciplineId) => ({ kind: 'discipline', disciplineId }));
}

export function graphScopeIdentity(scope: GraphScope): string {
  switch (scope.kind) {
    case 'discipline': return `discipline:${scope.disciplineId}`;
    case 'subdiscipline': return `subdiscipline:${scope.disciplineId}:${scope.subdisciplineId}`;
    case 'topic': return `topic:${scope.disciplineId}:${scope.anchorTopicId}`;
  }
}

export function contentIdentity(content: WorkbenchContent): string {
  switch (content.kind) {
    case 'library': return 'library';
    case 'cards': return `cards:${graphScopeIdentity(content.scope)}`;
    case 'topic': return `note:${JSON.stringify([content.topicId, null])}`;
    case 'chapter': return `note:${JSON.stringify([content.topicId, content.chapterId])}`;
  }
}

/** Search the already scope-filtered GraphSelection, including nodes omitted from the rendered window. */
export function searchGraphNodes(nodes: readonly GraphNode[], query: string, limit = 50): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [];
  return nodes
    .filter((node) => [node.id, node.title, node.summary ?? ''].some((value) => value.toLocaleLowerCase().includes(needle)))
    .slice(0, limit)
    .map((node) => ({
      itemId: null,
      nodeId: node.id,
      title: node.title,
      text: node.summary ?? '',
      score: 1,
      matchedBy: 'keyword',
      source: null,
    }));
}
