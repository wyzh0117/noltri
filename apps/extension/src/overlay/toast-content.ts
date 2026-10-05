import { truncate } from '@noltri/shared';
import type { CaptureResult, CaptureResultItem, CaptureStage } from '@noltri/schema';
import type { CaptureOutcome } from '../api/client';

export const TOAST_AUTO_HIDE_MS = 5_000;
/** Only ever shown from a Core ack: the page may not claim the text is stored before the reply says so. */
export const TOAST_STORED_HEADLINE = '✓ 已存入 Noltri';
export const TOAST_SAVED_HEADLINE = '已落盘，等待归纳';
export const TOAST_PROCESSING_HEADLINE = '已存入 Noltri，正在归纳';
export const TOAST_REVIEW_HEADLINE = '已存入 Noltri，需要你复核';
export const TOAST_DUPLICATE_HEADLINE = '这条已经在 Noltri 里，没有重复写入';
export const TOAST_QUEUED_HEADLINE = '仅保存在扩展待发送队列';
export const TOAST_INCOMPLETE_HEADLINE = '已保存，AI 处理未完成';
export const TREE_BRANCH = '└── ';
export const TREE_INDENT = '    ';
export const MAX_TOAST_ITEMS = 3;
const MAX_REASON_LENGTH = 60;

export type ToastTone = 'success' | 'warning' | 'error';

export interface ToastContent {
  readonly headline: string;
  readonly tone: ToastTone;
  readonly lines: readonly string[];
}

/** V1 §10.5 shape: the root is plain, each deeper level is indented one branch further. */
export function renderNodePathLines(nodePath: readonly string[]): string[] {
  return nodePath.map((segment, index) =>
    index === 0 ? segment : `${TREE_INDENT.repeat(index - 1)}${TREE_BRANCH}${segment}`,
  );
}

function itemLines(items: readonly CaptureResultItem[]): string[] {
  const shown = items.slice(0, MAX_TOAST_ITEMS);
  const lines = shown.flatMap((item, index) => {
    const pathLines = renderNodePathLines(item.nodePath);
    const block = pathLines.length > 0 ? pathLines : [truncate(item.text, MAX_REASON_LENGTH)];
    return index === 0 ? block : ['', ...block];
  });
  if (items.length > MAX_TOAST_ITEMS) lines.push(`…共归纳 ${items.length} 条知识点`);
  return lines;
}

const HEADLINE_BY_STAGE: Readonly<Record<CaptureStage, string>> = {
  saved: TOAST_SAVED_HEADLINE,
  processing: TOAST_PROCESSING_HEADLINE,
  completed: TOAST_STORED_HEADLINE,
  needs_review: TOAST_REVIEW_HEADLINE,
  failed: TOAST_INCOMPLETE_HEADLINE,
};

/**
 * The copy follows `stage`, never `items.length`. A replay answers with no items on purpose (the Core
 * does not persist which action it took), so counting items would render a successful resend as a
 * failure and a 需要复核 as an empty success.
 */
export function buildToastContent(result: CaptureResult): ToastContent {
  if (result.processingStatus === 'failed') {
    return {
      headline: TOAST_INCOMPLETE_HEADLINE,
      tone: 'warning',
      lines: [safeReasonLine(result.errorReason) ?? '原始内容已保存，稍后可在 App 中查看归类结果'].filter((line) => line.length > 0),
    };
  }
  if (result.duplicate) {
    return { headline: TOAST_DUPLICATE_HEADLINE, tone: 'success', lines: [HEADLINE_BY_STAGE[result.stage]] };
  }
  const lines = itemLines(result.items);
  if (result.stage === 'saved' || result.stage === 'processing') {
    return { headline: HEADLINE_BY_STAGE[result.stage], tone: 'success', lines: ['原文已保存，归纳结果稍后可在 App 查看'] };
  }
  if (result.stage === 'needs_review') {
    return { headline: TOAST_REVIEW_HEADLINE, tone: 'warning', lines: lines.length > 0 ? lines : ['归类把握不高，请在 App 的收件箱里确认'] };
  }
  return {
    headline: TOAST_STORED_HEADLINE,
    tone: 'success',
    lines: lines.length > 0 ? lines : ['知识树整理中，稍后可在 App 查看'],
  };
}

export function toastContentFromOutcome(outcome: CaptureOutcome): ToastContent {
  if (!outcome.ok) {
    if (outcome.queued === true) {
      return {
        headline: TOAST_QUEUED_HEADLINE,
        tone: 'warning',
        lines: ['等待 Noltri 连接后自动发送', '在知序弹窗里可以立即发送或清空'],
      };
    }
    return { headline: outcome.message, tone: 'error', lines: [] };
  }
  return buildToastContent(outcome.result);
}

/**
 * Core's `errorReason` can carry provider internals. The page must never render a stack, so only a
 * single short human line survives and anything that looks technical is dropped.
 */
export function safeReasonLine(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const firstLine = reason.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return undefined;
  if (/(^|\s)at\s+\S|Error:|Traceback|\{.*\}|\(.*:\d+:\d+\)/.test(firstLine)) return undefined;
  return truncate(firstLine, MAX_REASON_LENGTH);
}
