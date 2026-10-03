import { truncate } from '@noltri/shared';
import type { CaptureResult } from '@noltri/schema';
import type { CaptureOutcome } from '../api/client';

export const TOAST_AUTO_HIDE_MS = 5_000;
export const TOAST_SUCCESS_HEADLINE = '✓ 已收纳';
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

export function buildToastContent(result: CaptureResult): ToastContent {
  if (result.processingStatus === 'failed') {
    return {
      headline: TOAST_INCOMPLETE_HEADLINE,
      tone: 'warning',
      lines: [safeReasonLine(result.errorReason) ?? '原始内容已保存，稍后可在 App 中查看归类结果'].filter((line) => line.length > 0),
    };
  }
  if (result.items.length === 0) {
    return { headline: TOAST_SUCCESS_HEADLINE, tone: 'success', lines: ['知识树整理中，稍后可在 App 查看'] };
  }
  const shown = result.items.slice(0, MAX_TOAST_ITEMS);
  const lines = shown.flatMap((item, index) => {
    const pathLines = renderNodePathLines(item.nodePath);
    const block = pathLines.length > 0 ? pathLines : [truncate(item.text, MAX_REASON_LENGTH)];
    return index === 0 ? block : ['', ...block];
  });
  if (result.items.length > MAX_TOAST_ITEMS) lines.push(`…共归纳 ${result.items.length} 条知识点`);
  return { headline: TOAST_SUCCESS_HEADLINE, tone: 'success', lines };
}

export function toastContentFromOutcome(outcome: CaptureOutcome): ToastContent {
  if (!outcome.ok) return { headline: outcome.message, tone: 'error', lines: [] };
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
