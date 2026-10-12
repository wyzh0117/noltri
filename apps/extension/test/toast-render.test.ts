import { describe, expect, it } from 'vitest';
import type { CaptureResult, CaptureResultItem } from '@noltri/schema';
import {
  MAX_TOAST_ITEMS,
  TOAST_DUPLICATE_HEADLINE,
  TOAST_INCOMPLETE_HEADLINE,
  TOAST_PROCESSING_HEADLINE,
  TOAST_QUEUED_HEADLINE,
  TOAST_REVIEW_HEADLINE,
  TOAST_SAVED_HEADLINE,
  TOAST_STORED_HEADLINE,
  buildToastContent,
  renderNodePathLines,
  safeReasonLine,
  toastContentFromOutcome,
} from '../src/overlay/toast-content';
import { OFFLINE_MESSAGE } from '../src/api/client';
import type { CaptureStage } from '@noltri/schema';

function result(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    rawSourceId: 'rs-1',
    requestId: 'req-toast-test-000001',
    stage: 'completed',
    duplicate: false,
    items: [
      {
        knowledgeItemId: 'ki-1',
        text: '元组是不可变序列',
        nodeId: 'n-3',
        nodePath: ['编程', 'Python', '数据结构'],
        action: 'created',
        confidence: 0.91,
        confidenceTier: 'high',
      },
    ],
    processingStatus: 'done',
    ...overrides,
  };
}

describe('nodePath renders as the §10.5 tree', () => {
  it('indents a three-level path exactly like the design document', () => {
    expect(renderNodePathLines(['Python', '数据结构', 'Tuple'])).toEqual(['Python', '└── 数据结构', '    └── Tuple']);
  });

  it('handles the shallow cases without inventing branches', () => {
    expect(renderNodePathLines(['Python'])).toEqual(['Python']);
    expect(renderNodePathLines(['Python', 'Tuple'])).toEqual(['Python', '└── Tuple']);
    expect(renderNodePathLines([])).toEqual([]);
  });

  it('shows the full path for a captured item', () => {
    const content = buildToastContent(result());
    expect(content.headline).toBe(TOAST_STORED_HEADLINE);
    expect(content.tone).toBe('success');
    expect(content.lines).toEqual(['编程', '└── Python', '    └── 数据结构']);
  });

  it('lists several items and stops overflowing the page', () => {
    const many = result({
      items: Array.from({ length: 5 }, (_unused, index): CaptureResultItem => ({
        knowledgeItemId: `ki-${index}`,
        text: `知识点 ${index}`,
        nodeId: `n-${index}`,
        nodePath: ['编程', `分组 ${index}`],
        action: 'attached',
        confidence: 0.6,
        confidenceTier: 'medium',
      })),
    });
    const content = buildToastContent(many);
    const pathLines = content.lines.filter((line) => line.startsWith('编程'));
    expect(pathLines).toHaveLength(MAX_TOAST_ITEMS);
    expect(content.lines[content.lines.length - 1]).toBe('…共归纳 5 条知识点');
  });

  it('falls back to the item text when a path is missing', () => {
    const content = buildToastContent(result({ items: [{ ...result().items[0], nodePath: [] }] }));
    expect(content.lines).toEqual(['元组是不可变序列']);
  });
});

describe('failed and unreachable outcomes', () => {
  it('says the knowledge is saved when the AI pass failed', () => {
    const content = buildToastContent(result({ processingStatus: 'failed', errorReason: 'AI 服务超时，稍后可重新归纳' }));
    expect(content.headline).toBe(TOAST_INCOMPLETE_HEADLINE);
    expect(content.tone).toBe('warning');
    expect(content.lines).toEqual(['AI 服务超时，稍后可重新归纳']);
  });

  it('never renders a raw error stack', () => {
    const stack = 'TypeError: Cannot read properties of undefined\n    at classify (core.js:12:3)';
    const content = buildToastContent(result({ processingStatus: 'failed', errorReason: stack }));
    expect(content.lines.join('\n')).not.toMatch(/at |TypeError|core\.js/);
    expect(content.lines).toEqual(['原始内容已保存，稍后可在 App 中查看归类结果']);
    expect(safeReasonLine('    at Object.<anonymous> (/app/index.js:1:1)')).toBeUndefined();
    expect(safeReasonLine(undefined)).toBeUndefined();
  });

  it('tells the user the tree is still being organised while processing', () => {
    const content = buildToastContent(result({ processingStatus: 'pending', items: [] }));
    expect(content.headline).toBe(TOAST_STORED_HEADLINE);
    expect(content.lines).toEqual(['知识树整理中，稍后可在 App 查看']);
  });

  it('renders the offline message without a tree', () => {
    const content = toastContentFromOutcome({ ok: false, message: OFFLINE_MESSAGE, retryable: true, coreUnreachable: true });
    expect(content).toEqual({ headline: OFFLINE_MESSAGE, tone: 'error', lines: [] });
  });

  it('promises a queue only when the extension really kept one', () => {
    const queued = toastContentFromOutcome({ ok: false, message: OFFLINE_MESSAGE, retryable: true, coreUnreachable: true, queued: true });
    expect(queued.headline).toBe(TOAST_QUEUED_HEADLINE);
    expect(queued.tone).toBe('warning');
    expect(queued.lines.join('')).toContain('自动发送');
    const dropped = toastContentFromOutcome({ ok: false, message: OFFLINE_MESSAGE, retryable: false, coreUnreachable: false, queued: false });
    expect(dropped.headline).toBe(OFFLINE_MESSAGE);
    expect(dropped.tone).toBe('error');
  });
});

describe('the toast follows stage, not item counts', () => {
  const stages: readonly (readonly [CaptureStage, string])[] = [
    ['saved', TOAST_SAVED_HEADLINE],
    ['processing', TOAST_PROCESSING_HEADLINE],
    ['completed', TOAST_STORED_HEADLINE],
    ['needs_review', TOAST_REVIEW_HEADLINE],
  ];

  it.each(stages)('says the §7.4 stage %s for an acked capture', (stage, headline) => {
    const content = buildToastContent(result({ stage, items: [] }));
    expect(content.headline).toBe(headline);
    // A replayed capture answers with no items at all; that is not a failure and must not read like one.
    expect(content.lines.length).toBeGreaterThan(0);
  });

  it('keeps the tree lines for a completed capture and warns on the one to review', () => {
    expect(buildToastContent(result({ stage: 'completed' })).lines).toEqual(['编程', '└── Python', '    └── 数据结构']);
    expect(buildToastContent(result({ stage: 'needs_review' })).tone).toBe('warning');
    expect(buildToastContent(result({ stage: 'saved' })).tone).toBe('success');
  });

  it('names a replay as already stored instead of claiming a new capture', () => {
    const content = buildToastContent(result({ duplicate: true, stage: 'completed', items: [] }));
    expect(content.headline).toBe(TOAST_DUPLICATE_HEADLINE);
    expect(content.lines).toEqual([TOAST_STORED_HEADLINE]);
  });

  it('shows 需要复核 even when the model filed something, because confidence is the point', () => {
    const content = buildToastContent(result({ stage: 'needs_review' }));
    expect(content.headline).toContain('复核');
    expect(content.tone).toBe('warning');
  });
});
