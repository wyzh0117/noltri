/**
 * 收件箱 (V1 §8, P2 桌面工作台).
 *
 * The feed is a view over the RawSource rows the capture pipeline already writes — nothing is
 * duplicated into a second table — and 人工归档 deliberately bypasses the AI stages: a fresh desktop
 * install has no model key, so a person must still be able to turn a saved capture into a knowledge
 * point (acceptance L03/R05).
 */
import {
  processingStatusSchema,
  reviewSourceRequestSchema,
  type ReviewSourceRequest,
  type ReviewSourceResponse,
  type AssignSourceRequest,
  type AssignSourceResponse,
  type InboxCounts,
  type InboxEntry,
  type InboxQuery,
  type InboxResponse,
  type ProcessingStatus,
  type RawSource,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import { capText, type ActorContext, type CoreDeps } from '../types';

/** Characters shown in the feed before the reader has to open the source. */
const PREVIEW_CHARS = 160;
const DEFAULT_PAGE = 50;

function previewOf(rawText: string, actor: ActorContext): string {
  const trimmed = rawText.trim();
  // A 160-character preview per row is still a library export at 200 rows, so the feed honours the cap.
  const capped = capText(actor, trimmed);
  return capped.length <= PREVIEW_CHARS ? capped : `${capped.slice(0, PREVIEW_CHARS)}…`;
}

function toEntry(source: RawSource, actor: ActorContext): InboxEntry {
  return {
    id: source.id,
    sourceType: source.sourceType,
    sourcePlatform: source.sourcePlatform,
    sourceApp: source.sourceApp,
    sourceTitle: source.sourceTitle,
    sourceUrl: source.sourceUrl,
    capturedAt: source.capturedAt,
    processingStatus: source.processingStatus,
    reviewStatus: source.reviewStatus,
    reviewRevision: source.reviewRevision,
    errorReason: source.errorReason === null ? null : capText(actor, source.errorReason),
    textPreview: previewOf(source.rawText, actor),
    rawTextLength: source.rawText.length,
  };
}

/**
 * `status` arrives as one comma-separated string because the router builds query objects with
 * `Object.fromEntries`, which collapses repeated keys. An unrecognised token is rejected rather than
 * ignored — silently widening the filter would show a reviewer rows they never asked for.
 */
function statusesOf(raw: string | undefined): ProcessingStatus[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const out = new Set<ProcessingStatus>();
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const parsed = processingStatusSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw knowledgeError('invalid_request', `未知的归纳状态 ${trimmed} / unknown inbox status`);
    }
    out.add(parsed.data);
  }
  return [...out];
}

export async function listInbox(deps: CoreDeps, actor: ActorContext, query: InboxQuery): Promise<InboxResponse> {
  const statuses = statusesOf(query.status);
  const limit = query.limit ?? DEFAULT_PAGE;
  const offset = query.offset ?? 0;
  const [rows, counts, reviewCounts] = await Promise.all([
    deps.repository.listInbox({ userId: actor.userId, statuses, reviewStatus: query.reviewStatus, limit, offset }),
    deps.repository.countInboxByStatus(actor.userId),
    deps.repository.countInboxByReviewStatus(actor.userId),
  ]);
  return { entries: rows.map((row) => toEntry(row, actor)), counts: counts satisfies InboxCounts, reviewCounts, limit, offset };
}

/** Owned capture projected for this actor; a missing source remains null. */
export async function readRawSource(deps: CoreDeps, actor: ActorContext, id: string): Promise<RawSource | null> {
  const source = await deps.repository.findRawSource(id, actor.userId);
  if (source === null) return null;
  const confirmation = source.reviewStatus === 'confirmed'
    ? await deps.repository.readReviewConfirmation(id, actor.userId, source.reviewRevision) : null;
  // §435: 原文 is the widest single read a client has, so the cap has to cover it too — otherwise
  // 「限制返回片段」 would hold everywhere except the one call that returns the whole document.
  return {
    ...source,
    reviewConfirmation: confirmation === null ? null : { ...confirmation, text: capText(actor, confirmation.text) },
    rawText: capText(actor, source.rawText),
    surroundingContext: source.surroundingContext === null ? null : capText(actor, source.surroundingContext),
    errorReason: source.errorReason === null ? null : capText(actor, source.errorReason),
  };
}

/**
 * File a capture under a node by hand. `isAiDerived: false` and `embeddingStatus: 'none'` are the
 * point: the row is human-authored, and a later re-embed must be able to tell it apart from a
 * model-derived one (D04 keeps the two index populations separate).
 */
export async function assignSource(
  deps: CoreDeps,
  actor: ActorContext,
  rawSourceId: string,
  request: AssignSourceRequest,
): Promise<AssignSourceResponse> {
  const source = await deps.repository.findRawSource(rawSourceId, actor.userId);
  if (source === null) {
    throw knowledgeError('not_found', `原文 ${rawSourceId} 不存在 / raw source not found`);
  }
  const node = await deps.repository.findNode(request.nodeId, actor.userId);
  if (node === null) {
    throw knowledgeError('not_found', `节点 ${request.nodeId} 不存在 / node not found`);
  }

  const normalizedText = (request.text ?? source.rawText).trim();
  if (normalizedText.length === 0) {
    throw knowledgeError('invalid_request', '归档内容不能为空 / nothing to file');
  }

  const already = await deps.repository.listKnowledgeItemsForNode(node.id, actor.userId);
  if (already.some((item) => item.rawSourceId === source.id && item.normalizedText.trim() === normalizedText)) {
    throw knowledgeError('conflict', `这条原文已归入 ${node.title} / already filed under this node`);
  }

  const item = await deps.repository.createKnowledgeItem({
    userId: actor.userId,
    rawSourceId: source.id,
    normalizedText,
    confidence: 1,
    isAiDerived: false,
    embeddingModel: null,
    embeddingStatus: 'none',
  });
  await deps.repository.linkItemToNode({
    userId: actor.userId,
    itemId: item.id,
    nodeId: node.id,
    relationType: 'primary',
    confidence: 1,
  });
  await deps.repository.updateRawSourceProcessing(source.id, actor.userId, 'done');
  await deps.repository.markRawSourceConfirmed(source.id, actor.userId, false);
  await deps.vault?.syncSource(source.id, actor.userId);

  return {
    item: {
      ...item,
      normalizedText: capText(actor, item.normalizedText),
      summary: item.summary === null ? null : capText(actor, item.summary),
    },
    path: await deps.repository.nodePath(actor.userId, node.id),
  };
}

export async function reviewSource(deps: CoreDeps, actor: ActorContext, id: string, request: ReviewSourceRequest): Promise<ReviewSourceResponse> {
  const parsed = reviewSourceRequestSchema.safeParse(request);
  if (!parsed.success) throw knowledgeError('invalid_request', 'Invalid review action', parsed.error.issues);
  const result = await deps.repository.reviewSource(id, actor.userId, parsed.data);
  if (result.item) await deps.vault?.syncSource(id, actor.userId);
  // Project stored text for this actor on both first commit and replay; keep the durable response whole.
  return result.item === undefined ? result : {
    ...result,
    item: {
      ...result.item,
      normalizedText: capText(actor, result.item.normalizedText),
      summary: result.item.summary === null ? null : capText(actor, result.item.summary),
    },
  };
}
