/**
 * 收件箱 triage rules, tested as pure functions (V1 §8 / P2). These decide what a reviewer can actually
 * do with a capture — which statuses a filter asks the server for, whether a row may be re-run, and
 * whether "load more" would silently hide page two — so they must hold without a WebView or a Core.
 */
import { describe, expect, it } from 'vitest';
import { processingStatusSchema, treeNodeSchema, type InboxCounts, type InboxEntry, type InboxResponse } from '@noltri/schema';
import {
  EMPTY_ROW,
  appendPage,
  assignPayload,
  assignmentMessage,
  badgeCounts,
  canAssign,
  canRetry,
  capturedLine,
  filterOption,
  hasMorePages,
  indentOption,
  inboxFilterOptions,
  nodeOptions,
  sourceLine,
  statusBadgeClass,
  statusTone,
  statusesForQuery,
  withRowPatch,
  type InboxFilter,
  type InboxRowState,
} from '../src/workbench/inbox-model';

const STATUSES = ['pending', 'processing', 'done', 'failed'] as const;

function tree(id: string, title: string, children: readonly unknown[] = []) {
  return {
    id,
    title,
    nodeType: 'concept',
    status: 'active',
    confidence: 0.8,
    summary: null,
    itemCount: 1,
    childCount: children.length,
    descendantItemCount: children.length + 1,
    ...(children.length === 0 ? {} : { children }),
  };
}

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'src-1',
    sourceType: 'web',
    sourcePlatform: 'macos',
    sourceApp: 'Safari',
    sourceTitle: '卡片笔记法',
    sourceUrl: 'https://example.com/zettelkasten',
    capturedAt: '2026-03-01T08:00:00.000Z',
    processingStatus: 'pending',
    errorReason: null,
    textPreview: '用自己的话重写每张卡片。',
    rawTextLength: 24,
    ...overrides,
  };
}

function response(overrides: Partial<InboxResponse> = {}): InboxResponse {
  const counts: InboxCounts = { pending: 5, processing: 1, done: 20, failed: 2 };
  return { entries: [entry()], counts, limit: 20, offset: 0, ...overrides };
}

describe('inbox filter options', () => {
  it('lists 需要处理 first and 全部 last', () => {
    expect(inboxFilterOptions[0].key).toBe('unfinished');
    expect(inboxFilterOptions[0].label).toBe('需要处理');
    expect(inboxFilterOptions.at(-1)?.key).toBe('all');
    expect(inboxFilterOptions.at(-1)?.statuses).toEqual([]);
  });

  it('labels every option in Chinese and keeps the keys unique', () => {
    const keys = inboxFilterOptions.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const option of inboxFilterOptions) expect(option.label).not.toContain('_');
  });

  it('falls back to the first option for an unknown filter', () => {
    expect(filterOption('not-a-filter' as InboxFilter).key).toBe('unfinished');
  });
});

describe('inbox status queries', () => {
  it('sends nothing for 全部 and a comma-joined list otherwise', () => {
    expect(statusesForQuery('all')).toBeUndefined();
    expect(statusesForQuery('unfinished')).toBe('pending,processing,failed');
    expect(statusesForQuery('done')).toBe('done');
  });

  it('only ever emits tokens the server accepts, inside the query length limit', () => {
    for (const option of inboxFilterOptions) {
      const query = statusesForQuery(option.key);
      if (query === undefined) continue;
      expect(query.length).toBeLessThanOrEqual(80);
      for (const token of query.split(',')) expect(processingStatusSchema.safeParse(token).success).toBe(true);
    }
  });

  it('never asks for 已归纳 under 需要处理', () => {
    expect(statusesForQuery('unfinished')?.split(',')).not.toContain('done');
  });
});

describe('inbox status presentation', () => {
  it('maps each status to exactly one tone', () => {
    expect(statusTone('done')).toBe('accent');
    expect(statusTone('pending')).toBe('warn');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('processing')).toBe('quiet');
  });

  it('uses only badge classes the desktop stylesheet defines', () => {
    expect(statusBadgeClass('failed')).toBe('badge badge-danger');
    expect(statusBadgeClass('processing')).toBe('badge badge-quiet');
    expect(statusBadgeClass('pending')).toBe('badge badge-warn');
    expect(statusBadgeClass('done')).toBe('badge badge-accent');
  });

  it('orders the count badges and zero-fills a status the server omitted', () => {
    const counts = badgeCounts({ pending: 2, done: 7 } as InboxCounts);
    expect(counts.map((row) => [row.status, row.value])).toEqual([
      ['pending', 2],
      ['processing', 0],
      ['done', 7],
      ['failed', 0],
    ]);
    expect(counts.map((row) => row.label)).toEqual(['待整理', '整理中', '已归纳', '归纳失败']);
  });
});

describe('inbox row capabilities', () => {
  it('only offers 重试归纳 for a failed capture', () => {
    expect(canRetry('failed')).toBe(true);
    for (const status of STATUSES.filter((value) => value !== 'failed')) expect(canRetry(status)).toBe(false);
  });

  it('blocks 人工归档 only while another worker holds the row', () => {
    expect(canAssign('processing')).toBe(false);
    for (const status of STATUSES.filter((value) => value !== 'processing')) expect(canAssign(status)).toBe(true);
  });

  it('keeps a row with no state closed and idle', () => {
    expect(withRowPatch(undefined, { open: true })).toEqual({ ...EMPTY_ROW, open: true });
  });

  it('patches without dropping the untouched fields', () => {
    const row: InboxRowState = { open: true, busy: true, targetId: 'n-2', draft: '摘录', error: '归档失败' };
    expect(withRowPatch(row, { busy: false })).toEqual({ ...row, busy: false });
  });
});

describe('inbox manual filing payload', () => {
  it('sends nothing until a target node is chosen', () => {
    expect(assignPayload(EMPTY_ROW)).toBeNull();
  });

  it('omits text when the draft is empty so the server files the stored original', () => {
    expect(assignPayload({ ...EMPTY_ROW, targetId: 'n-1', draft: '   ' })).toEqual({ nodeId: 'n-1' });
  });

  it('trims an edited excerpt instead of sending the whitespace', () => {
    expect(assignPayload({ ...EMPTY_ROW, targetId: 'n-1', draft: ' 只保留这一句。 ' })).toEqual({
      nodeId: 'n-1',
      text: '只保留这一句。',
    });
  });

  it('describes where the capture went', () => {
    expect(assignmentMessage(['Python', '数据结构', 'Tuple 元组'])).toBe('已归档：Python / 数据结构 / Tuple 元组');
    expect(assignmentMessage([])).toBe('已归档到知识树。');
  });
});

describe('inbox paging', () => {
  it('counts only the statuses the active filter asked for', () => {
    // 待整理 is fully on screen; a large 已归纳 total must not keep the button alive under that filter.
    const loaded = response({ entries: Array.from({ length: 5 }, () => entry({ processingStatus: 'pending' })), limit: 20, offset: 0 });
    expect(hasMorePages(loaded, 'pending')).toBe(false);
    expect(hasMorePages(loaded, 'all')).toBe(true);
    expect(hasMorePages(loaded, 'unfinished')).toBe(true);
  });

  it('offers 加载更多 while rows of the filter remain', () => {
    const partial = response({ entries: [entry(), entry()], limit: 2, offset: 0 });
    expect(hasMorePages(partial, 'pending')).toBe(true);
    expect(hasMorePages(partial, 'unfinished')).toBe(true);
  });

  it('resumes from the offset the server reported', () => {
    const secondPage = response({ entries: [entry()], limit: 4, offset: 4 });
    // 5 pending exist and rows 0..4 are already read, so page two closed the gap.
    expect(hasMorePages(secondPage, 'pending')).toBe(false);
  });

  it('appends the next page and adopts its totals and offset', () => {
    const first = response({ entries: [entry({ id: 'a' })], offset: 0, limit: 20 });
    const second = response({ entries: [entry({ id: 'b' })], offset: 1, limit: 20, counts: { pending: 2, processing: 0, done: 0, failed: 0 } });
    const merged = appendPage(first, second);
    expect(merged.entries.map((row) => row.id)).toEqual(['a', 'b']);
    expect(merged.offset).toBe(1);
    expect(merged.counts.pending).toBe(2);
  });
});

describe('inbox source line', () => {
  it('translates the source type and joins the parts the capture actually carried', () => {
    expect(sourceLine(entry())).toBe('网页 · Safari · macos · 卡片笔记法');
  });

  it('drops empty and missing parts instead of leaving bare separators', () => {
    expect(sourceLine(entry({ sourceApp: null, sourceTitle: null, sourcePlatform: null }))).toBe('网页');
    expect(sourceLine(entry({ sourceApp: '   ', sourceUrl: null }))).toBe('网页 · macos · 卡片笔记法');
  });

  it('shows an unknown source type verbatim rather than blanking it out', () => {
    expect(sourceLine(entry({ sourceType: 'clipboard' as InboxEntry['sourceType'], sourcePlatform: null, sourceTitle: null, sourceApp: null }))).toBe('clipboard');
  });

  it('renders a capture time as UTC date and hour:minute', () => {
    expect(capturedLine('2026-03-01T08:00:00.000Z')).toBe('2026-03-01 08:00');
    expect(capturedLine('2026-03-01')).toBe('2026-03-01');
  });
});

describe('inbox archive targets', () => {
  it('lists every node pre-order with its depth so the select can indent', () => {
    const nodes = [
      tree('domain-python', 'Python', [tree('topic-structures', '数据结构', [tree('concept-tuple', 'Tuple 元组')])]),
      tree('domain-writing', '写作方法'),
    ];
    const options = nodeOptions(nodes.map((node) => treeNodeSchema.parse(node)));
    expect(options.map((option) => `${String(option.depth)}:${option.title}`)).toEqual([
      '0:Python',
      '1:数据结构',
      '2:Tuple 元组',
      '0:写作方法',
    ]);
  });

  it('indents with full-width spaces and never with a negative repeat', () => {
    expect(indentOption(2)).toBe('　　');
    expect(indentOption(0)).toBe('');
    expect(indentOption(-3)).toBe('');
  });
});
