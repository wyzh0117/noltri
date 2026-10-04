/**
 * 收件箱 view model. Everything here is pure so the triage rules can be tested without a DOM, a WebView
 * or a running Core — the panel below only draws what these functions decide.
 */
import type { InboxCounts, InboxEntry, InboxResponse, ProcessingStatus, SourceType, TreeNode } from '@noltri/schema';
import { findNodePath, processingStatusLabels, sourceTypeLabels, walkTree } from '@noltri/shared';

/** `unfinished` is the default view: captures that still need a person or a model. */
export type InboxFilter = 'all' | 'unfinished' | ProcessingStatus;

export interface InboxFilterOption {
  readonly key: InboxFilter;
  readonly label: string;
  /** Empty means "no status filter", which the server reads as the whole feed. */
  readonly statuses: readonly ProcessingStatus[];
}

export const inboxFilterOptions: readonly InboxFilterOption[] = [
  { key: 'unfinished', label: '需要处理', statuses: ['pending', 'processing', 'failed'] },
  { key: 'pending', label: processingStatusLabels.pending, statuses: ['pending'] },
  { key: 'processing', label: processingStatusLabels.processing, statuses: ['processing'] },
  { key: 'failed', label: processingStatusLabels.failed, statuses: ['failed'] },
  { key: 'done', label: processingStatusLabels.done, statuses: ['done'] },
  { key: 'all', label: '全部', statuses: [] },
];

export function filterOption(key: InboxFilter): InboxFilterOption {
  const found = inboxFilterOptions.find((option) => option.key === key);
  return found ?? inboxFilterOptions[0];
}

/** The `status` query the client sends: comma-separated, because the router collapses repeated keys. */
export function statusesForQuery(key: InboxFilter): string | undefined {
  const statuses = filterOption(key).statuses;
  return statuses.length === 0 ? undefined : statuses.join(',');
}

/** Existing badge tones only, so a status never needs a colour the design system does not have. */
export function statusTone(status: ProcessingStatus): 'accent' | 'warn' | 'quiet' | 'danger' {
  if (status === 'done') return 'accent';
  if (status === 'pending') return 'warn';
  if (status === 'failed') return 'danger';
  return 'quiet';
}

export function statusBadgeClass(status: ProcessingStatus): string {
  const tone = statusTone(status);
  return tone === 'quiet' ? 'badge badge-quiet' : `badge badge-${tone}`;
}

/** A capture that is already filed has nothing to re-run; `processing` is somebody else's work. */
export function canRetry(status: ProcessingStatus): boolean {
  return status === 'failed';
}

export function canAssign(status: ProcessingStatus): boolean {
  return status !== 'processing';
}

export function badgeCounts(counts: InboxCounts): readonly { status: ProcessingStatus; label: string; value: number }[] {
  const order: ProcessingStatus[] = ['pending', 'processing', 'done', 'failed'];
  return order.map((status) => ({ status, label: processingStatusLabels[status], value: counts[status] ?? 0 }));
}

export interface NodeOption {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
}

/** Every node in the tree, pre-order and indented — 收件箱 may file a capture at any depth. */
export function nodeOptions(nodes: readonly TreeNode[]): NodeOption[] {
  return walkTree(nodes).map((node) => ({
    id: node.id,
    title: node.title,
    depth: Math.max(findNodePath(nodes, node.id).length - 1, 0),
  }));
}

export function sourceLine(entry: InboxEntry): string {
  const kind: string = sourceTypeLabels[entry.sourceType as SourceType] ?? entry.sourceType;
  const parts = [kind, entry.sourceApp, entry.sourcePlatform, entry.sourceTitle].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  // `filter` keeps `kind` even when it repeats, but never lets an empty source produce a bare separator.
  return parts.join(' · ');
}

/** `2026-03-01T08:00:00.000Z` → `2026-03-01 08:00`, kept as UTC so a capture time is never ambiguous. */
export function capturedLine(capturedAt: string): string {
  const trimmed = capturedAt.trim();
  if (trimmed.length < 16) return trimmed;
  return `${trimmed.slice(0, 10)} ${trimmed.slice(11, 16)}`;
}

/**
 * Whether another page exists. `counts` are whole-library totals, so the comparison sums only the
 * statuses the active filter actually asks for — otherwise filtering to 待整理 would hide page two.
 */
export function hasMorePages(response: InboxResponse, filterKey: InboxFilter): boolean {
  const statuses = filterOption(filterKey).statuses;
  const matching = (Object.keys(response.counts) as ProcessingStatus[])
    .filter((status) => statuses.length === 0 || statuses.includes(status))
    .reduce((total, status) => total + response.counts[status], 0);
  return response.offset + response.entries.length < matching;
}

export function assignmentMessage(path: readonly string[]): string {
  return path.length === 0 ? '已归档到知识树。' : `已归档：${path.join(' / ')}`;
}

/** "Load more" keeps what the user already scrolled through and only re-reads the totals. */
export function appendPage(current: InboxResponse, next: InboxResponse): InboxResponse {
  return { entries: [...current.entries, ...next.entries], counts: next.counts, limit: next.limit, offset: next.offset };
}

export const EMPTY_ROW: InboxRowState = {
  open: false,
  busy: false,
  targetId: '',
  draft: '',
  error: null,
};

export interface InboxRowState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly targetId: string;
  /** Empty means "file the whole stored text" — the server then supplies `text`. */
  readonly draft: string;
  readonly error: string | null;
}

export function withRowPatch(row: InboxRowState | undefined, patch: Partial<InboxRowState>): InboxRowState {
  return { ...(row ?? EMPTY_ROW), ...patch };
}

/** What to send for one manual filing: an edited excerpt only when the person actually typed one. */
export function assignPayload(row: InboxRowState): { nodeId: string; text?: string } | null {
  if (row.targetId === '') return null;
  const trimmed = row.draft.trim();
  return trimmed.length === 0 ? { nodeId: row.targetId } : { nodeId: row.targetId, text: trimmed };
}

export function indentOption(depth: number): string {
  return '　'.repeat(Math.max(depth, 0));
}
