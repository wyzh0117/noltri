/**
 * Pure view model for the knowledge tree: flattening, expand/collapse, keyboard navigation,
 * node-detail derivation and move-target computation. No React and no DOM, so the tree behaviour is
 * unit-testable and stays the single source of truth for the UI.
 */

import type { NodeDetail, NodeSourceSummary, TreeNode, TreeResponse } from '@noltri/schema';
import { relationLabel } from './labels';

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter';

export interface FlatNode {
  id: string;
  title: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  itemCount: number;
  childCount: number;
  descendantItemCount: number;
  /** Ids from the root down to this node (inclusive). */
  trail: string[];
}

export function toExpandedSet(ids: Iterable<string>): Set<string> {
  return new Set(ids);
}

/** Roots and their direct children start open so a returning user immediately sees structure. */
export function initialExpandedIds(nodes: readonly TreeNode[], depth = 1): string[] {
  const ids: string[] = [];
  const visit = (list: readonly TreeNode[], level: number): void => {
    for (const node of list) {
      const children = node.children ?? [];
      if (children.length > 0 && level <= depth) {
        ids.push(node.id);
        visit(children, level + 1);
      }
    }
  };
  visit(nodes, 0);
  return ids;
}

export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function withExpanded(expanded: ReadonlySet<string>, id: string, open: boolean): Set<string> {
  const next = new Set(expanded);
  if (open) next.add(id);
  else next.delete(id);
  return next;
}

export function flattenTree(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  parentId: string | null = null,
  trail: readonly string[] = [],
): FlatNode[] {
  const out: FlatNode[] = [];
  for (const node of nodes) {
    const children = node.children ?? [];
    const isOpen = expanded.has(node.id);
    out.push({
      id: node.id,
      title: node.title,
      depth: trail.length,
      parentId,
      hasChildren: children.length > 0,
      expanded: isOpen,
      itemCount: node.itemCount,
      childCount: node.childCount,
      descendantItemCount: node.descendantItemCount,
      trail: [...trail, node.id],
    });
    if (children.length > 0 && isOpen) {
      out.push(...flattenTree(children, expanded, node.id, [...trail, node.id]));
    }
  }
  return out;
}

/** Every node id, regardless of collapse state — used for counts and move targets. */
export function walkTree(nodes: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...walkTree(node.children ?? []));
  }
  return out;
}

export function findNodePath(nodes: readonly TreeNode[], id: string): TreeNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const nested = findNodePath(node.children ?? [], id);
    if (nested.length > 0) return [node, ...nested];
  }
  return [];
}

export function subtreeIds(node: TreeNode): string[] {
  return walkTree([node]).map((entry) => entry.id);
}

/** Own items plus every item below, so a collapsed subtree still reports its real weight. */
export function subtreeItemCount(node: TreeNode): number {
  return (node.itemCount ?? 0) + sumItems(node.children ?? []);
}

function sumItems(nodes: readonly TreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += subtreeItemCount(node);
  return total;
}

export interface TreeSummary {
  nodeCount: number;
  itemCount: number;
  domainCount: number;
}

export function summarizeTree(nodes: readonly TreeNode[]): TreeSummary {
  const all = walkTree(nodes);
  return {
    nodeCount: all.length,
    itemCount: all.reduce((total, node) => total + node.itemCount, 0),
    domainCount: nodes.length,
  };
}

export function isEmptyTree(response: Pick<TreeResponse, 'nodes'>): boolean {
  return response.nodes.length === 0;
}

/** Left rail "知识领域" is exactly the root nodes — no invented navigation entries. */
export function domainRoots(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes];
}

export interface NavigationResult {
  selectedId: string | null;
  expanded: Set<string>;
}

export function navigateKeyboard(
  flat: readonly FlatNode[],
  currentId: string | null,
  key: ArrowKey,
  expanded: ReadonlySet<string>,
): NavigationResult {
  if (flat.length === 0) return { selectedId: currentId, expanded: new Set(expanded) };
  const index = flat.findIndex((entry) => entry.id === currentId);

  if (key === 'Enter') {
    const first = flat[0];
    return { selectedId: currentId ?? first?.id ?? null, expanded: new Set(expanded) };
  }
  if (key === 'ArrowDown') {
    const next = flat[Math.min(index + 1, flat.length - 1)] ?? flat[0];
    return { selectedId: next?.id ?? null, expanded: new Set(expanded) };
  }
  if (key === 'ArrowUp') {
    const previous = flat[Math.max(index - 1, 0)] ?? flat[0];
    return { selectedId: previous?.id ?? null, expanded: new Set(expanded) };
  }

  const current = index >= 0 ? flat[index] : flat[0];
  if (!current) return { selectedId: currentId, expanded: new Set(expanded) };

  if (key === 'ArrowRight') {
    if (!current.hasChildren) return { selectedId: current.id, expanded: new Set(expanded) };
    if (!current.expanded) return { selectedId: current.id, expanded: withExpanded(expanded, current.id, true) };
    const child = flat[index + 1];
    return { selectedId: child ? child.id : current.id, expanded: new Set(expanded) };
  }

  // ArrowLeft: collapse the open node first, then step up to its parent.
  if (current.hasChildren && current.expanded) {
    return { selectedId: current.id, expanded: withExpanded(expanded, current.id, false) };
  }
  const parentIndex = flat.findIndex((entry) => entry.id === current.parentId);
  const parent = parentIndex >= 0 ? flat[parentIndex] : undefined;
  if (parent) return { selectedId: parent.id, expanded: withExpanded(expanded, parent.id, false) };
  return { selectedId: current.id, expanded: new Set(expanded) };
}

/**
 * Valid parents for a move: every node outside the moving subtree, plus "作为知识领域" (parentId null).
 * Excluding the subtree is what prevents the cycle the core also rejects.
 */
export interface MoveTargetOption {
  id: string | null;
  title: string;
  depth: number;
  disabled: boolean;
}

export function moveTargetOptions(
  nodes: readonly TreeNode[],
  movingId: string,
  currentParentId: string | null,
): MoveTargetOption[] {
  const movingPath = findNodePath(nodes, movingId);
  const blocked = new Set(movingPath.length > 0 ? subtreeIds(movingPath[movingPath.length - 1] as TreeNode) : []);
  const options: MoveTargetOption[] = [
    { id: null, title: '作为知识领域（顶级）', depth: 0, disabled: currentParentId === null },
  ];
  for (const node of walkTree(nodes)) {
    if (blocked.has(node.id)) continue;
    const path = findNodePath(nodes, node.id);
    options.push({
      id: node.id,
      title: node.title,
      depth: Math.max(path.length - 1, 0),
      disabled: node.id === currentParentId,
    });
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Node detail view model                                                      */
/* -------------------------------------------------------------------------- */

export interface DetailSourceRef {
  rawSourceId: string;
  label: string;
  url: string | null;
  capturedAt: string;
}

export interface DetailItemView {
  id: string;
  text: string;
  confidence: number;
  isAiDerived: boolean;
  sources: DetailSourceRef[];
}

export interface DetailRelatedView {
  id: string;
  title: string;
  relationType: string;
  relationLabel: string;
  confidence: number | null;
}

export interface DetailViewModel {
  id: string;
  title: string;
  summary: string;
  hasSummary: boolean;
  itemCount: number;
  sourceCount: number;
  childCount: number;
  status: string;
  breadcrumb: { id: string; title: string }[];
  breadcrumbText: string;
  children: { id: string; title: string }[];
  related: DetailRelatedView[];
  items: DetailItemView[];
  /** A node with zero items is a legitimate, renderable node — never a blank panel. */
  hasItems: boolean;
}

export function sourceLabel(source: NodeSourceSummary): string {
  const title = source.sourceTitle?.trim();
  if (title) return title;
  const platform = source.sourcePlatform ?? source.sourceApp;
  if (platform) return `${platform} 来源`;
  return '未命名来源';
}

export function toDetailSource(source: NodeSourceSummary): DetailSourceRef {
  return {
    rawSourceId: source.rawSourceId,
    label: sourceLabel(source),
    url: source.sourceUrl,
    capturedAt: source.capturedAt,
  };
}

export function deriveDetail(detail: NodeDetail): DetailViewModel {
  const items: DetailItemView[] = detail.items.map((entry) => ({
    id: entry.item.id,
    text: entry.item.normalizedText,
    confidence: entry.item.confidence,
    isAiDerived: entry.item.isAiDerived,
    sources: entry.sources.map(toDetailSource),
  }));
  const breadcrumb = detail.path;
  return {
    id: detail.node.id,
    title: detail.node.title,
    summary: detail.node.summary ?? '',
    hasSummary: (detail.node.summary ?? '').trim().length > 0,
    itemCount: detail.stats.itemCount,
    sourceCount: detail.stats.sourceCount,
    childCount: detail.stats.childCount,
    status: detail.node.status,
    breadcrumb,
    breadcrumbText: breadcrumb.map((segment) => segment.title).join(' / '),
    children: detail.children.map((node) => ({ id: node.id, title: node.title })),
    related: detail.relatedNodes.map((entry) => ({
      id: entry.node.id,
      title: entry.node.title,
      relationType: entry.relationType,
      relationLabel: relationLabel(entry.relationType),
      confidence: entry.confidence,
    })),
    items,
    hasItems: items.length > 0,
  };
}

/** Distinct sources behind a node's items — the sanity check behind 来源数. */
export function countDistinctSources(detail: NodeDetail): number {
  const ids = new Set<string>();
  for (const entry of detail.items) {
    for (const source of entry.sources) ids.add(source.rawSourceId);
  }
  return ids.size;
}

export interface TreeNodeStats {
  nodes: number;
  items: number;
}

export function treeStats(response: TreeResponse): TreeNodeStats {
  const summary = summarizeTree(response.nodes);
  return {
    nodes: response.totalNodes > 0 ? response.totalNodes : summary.nodeCount,
    items: summary.itemCount,
  };
}
