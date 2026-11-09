import type { GraphEdge, GraphNode, GraphNoteIndexEntry, GraphScope, SearchHit, TreeNode } from '@noltri/schema';
import type { NoteIdentity } from './note-drafts';

export type WorkbenchContent =
  | { kind: 'library' }
  | { kind: 'cards'; scope: GraphScope; selectedNodeId: string }
  | { kind: 'file'; path: string }
  | { kind: 'topic'; topicId: string }
  | { kind: 'chapter'; topicId: string; chapterId: string };

export interface TreeSelection {
  path: TreeNode[];
  scope: GraphScope;
  content: WorkbenchContent;
}

export type WorkbenchTreeNode = Omit<TreeNode, 'children'> & {
  readonly referenceScope?: GraphScope;
  readonly children?: WorkbenchTreeNode[];
};

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

/** Add a display-only path to an existing topic when its current Graph scope confirms another valid parent. */
export function addTopicPathReference(
  nodes: readonly TreeNode[],
  scope: GraphScope | null,
  topicId: string,
  edges: readonly GraphEdge[],
): WorkbenchTreeNode[] {
  if (scope?.kind !== 'subdiscipline'
    || !edges.some((edge) => edge.relationType === 'part_of' && edge.fromNodeId === topicId && edge.toNodeId === scope.subdisciplineId)) {
    return nodes as WorkbenchTreeNode[];
  }
  const path = findTreePath(nodes, topicId);
  if (path === null) return nodes as WorkbenchTreeNode[];
  const topic = path.at(-1);
  if (topic === undefined || path.some((node) => node.id === scope.subdisciplineId)) return nodes as WorkbenchTreeNode[];

  const { children: _children, ...topicReference } = topic;
  const appendReference = (branches: readonly TreeNode[]): WorkbenchTreeNode[] => branches.map((node) => {
    const children = node.children === undefined ? [] : appendReference(node.children);
    if (node.id === scope.subdisciplineId) {
      return {
        ...node,
        children: [...children, { ...topicReference, referenceScope: scope }],
      };
    }
    return node.children === undefined ? node : { ...node, children };
  });
  return appendReference(nodes);
}

export function contextualTopicPath(
  nodes: readonly TreeNode[],
  topicId: string,
  referenceScopeId?: string | null,
): string[] {
  const topicPath = findTreePath(nodes, topicId);
  if (topicPath === null) return [];
  const referencePath = referenceScopeId === undefined || referenceScopeId === null ? null : findTreePath(nodes, referenceScopeId);
  if (referencePath === null || topicPath.some((node) => node.id === referenceScopeId)) return topicPath.map((node) => node.title);
  return [...referencePath.map((node) => node.title), topicPath.at(-1)!.title];
}

export function contextualChapterPath(
  nodes: readonly TreeNode[],
  topicId: string,
  chapterTitle: string,
  referenceScopeId?: string | null,
): string[] {
  return [...contextualTopicPath(nodes, topicId, referenceScopeId), chapterTitle];
}

export function contextualChapterSelectionId(nodes: readonly TreeNode[], topicId: string, chapterId: string, referenceScopeId?: string | null): string {
  if (referenceScopeId !== undefined && referenceScopeId !== null) return topicId;
  const canonicalTopicId = findTreePath(nodes, chapterId)?.slice().reverse().find((node) => node.nodeType === 'topic')?.id;
  return canonicalTopicId === topicId ? chapterId : topicId;
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
    const scope: GraphScope = selected.nodeType === 'topic'
      ? { kind: 'topic', disciplineId, anchorTopicId: id }
      : { kind: 'subdiscipline', disciplineId, subdisciplineId: id };
    return { path, scope, content: { kind: 'cards', scope, selectedNodeId: id } };
  }

  if (selected.nodeType === 'domain') {
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

/** Resolve the local Graph focus for the currently open knowledge object. */
export function graphScopeForContent(
  content: WorkbenchContent,
  currentScope: GraphScope | null,
  nodes: readonly TreeNode[],
): GraphScope | null {
  if (content.kind === 'cards') return content.scope;
  if (content.kind !== 'topic' && content.kind !== 'chapter') return null;
  const disciplineId = currentScope?.disciplineId
    ?? findTreePath(nodes, content.topicId)?.find((node) => node.nodeType === 'discipline')?.id;
  return disciplineId === undefined
    ? null
    : { kind: 'topic', disciplineId, anchorTopicId: content.topicId };
}

/** Keep the deepest visible direction as context while the selected note keeps its stable topic ID. */
export function graphContextScopeForTopic(nodes: readonly TreeNode[], topicId: string): GraphScope | null {
  const path = findTreePath(nodes, topicId);
  const disciplineId = path?.find((node) => node.nodeType === 'discipline')?.id;
  if (path === null || disciplineId === undefined) return null;
  const direction = [...path.slice(1)].reverse().find((node) => node.nodeType === 'subdiscipline' || node.nodeType === 'domain');
  return direction === undefined
    ? { kind: 'topic', disciplineId, anchorTopicId: topicId }
    : { kind: 'subdiscipline', disciplineId, subdisciplineId: direction.id };
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

export function graphPanelScopeIdentity(
  scope: GraphScope | null,
  view: 'subject' | 'advanced',
  subjectScope: 'local' | 'whole-discipline',
  localFocusScope: GraphScope | null,
  advancedScope: 'focus' | 'discipline' | 'all',
): string {
  if (view === 'advanced') return `advanced:${scope === null ? 'vault:all' : graphScopeIdentity(scope)}:${advancedScope}`;
  if (scope === null) return 'subject:vault:all';
  return subjectScope === 'whole-discipline'
    ? `subject:whole:${graphScopeIdentity(scope)}`
    : `subject:local:${graphScopeIdentity(scope)}:${localFocusScope === null ? 'none' : graphScopeIdentity(localFocusScope)}`;
}

export function contentIdentity(content: WorkbenchContent): string {
  switch (content.kind) {
    case 'library': return 'library';
    case 'cards': return `cards:${graphScopeIdentity(content.scope)}`;
    case 'file': return `file:${JSON.stringify(content.path)}`;
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
