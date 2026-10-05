/**
 * P2 对等验证 (acceptance gate 「核心旧功能对等测试通过」), rendered with `renderToStaticMarkup` so it needs
 * no WebView, no jsdom and no running Core: every component here takes its state as props, so static
 * markup shows exactly what the panel would draw.
 *
 * The first half compares the desktop port against the still-live `apps/web` component for identical
 * props. That is migration scaffolding — when apps/web is deleted in P7 these cases go with it.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HealthResponse, InboxEntry, InboxResponse, NodeDetail, TreeNode } from '@noltri/schema';
import { flattenTree, initialExpandedIds, toExpandedSet } from '@noltri/shared';
import DesktopDomainRail from '../src/workbench/DomainRail';
import DesktopTreeView from '../src/workbench/KnowledgeTreeView';
import DesktopDetail from '../src/workbench/NodeDetailPanel';
import WebDomainRail from '../../web/components/DomainRail';
import WebTreeView from '../../web/components/KnowledgeTreeView';
import WebDetail from '../../web/components/NodeDetailPanel';
import InboxPanel from '../src/workbench/InboxPanel';
import EmptyState from '../src/workbench/EmptyState';
import TopBar from '../src/workbench/TopBar';
import type { WorkbenchApi } from '../src/workbench/api';
import type { InboxRowState, NodeOption } from '../src/workbench/inbox-model';

const NOW = '2026-10-01T08:00:00.000Z';

function node(id: string, title: string, itemCount: number, children: TreeNode[] = []): TreeNode {
  return {
    id,
    title,
    nodeType: 'concept',
    status: 'active',
    confidence: 0.8,
    summary: null,
    itemCount,
    childCount: children.length,
    descendantItemCount: itemCount + children.reduce((total, child) => total + child.descendantItemCount, 0),
    ...(children.length === 0 ? {} : { children }),
  };
}

const TREE: TreeNode[] = [
  node('domain-python', 'Python', 0, [
    node('topic-structures', '数据结构', 0, [node('concept-tuple', 'Tuple 元组', 4), node('concept-dict', '字典推导式', 0)]),
  ]),
  node('domain-writing', '写作方法', 2, [node('note-card', '卡片笔记', 3)]),
];

const DETAIL: NodeDetail = {
  node: {
    id: 'concept-tuple',
    userId: 'u-1',
    title: 'Tuple 元组',
    summary: '不可变序列，可哈希时可作字典键。',
    nodeType: 'concept',
    parentId: 'topic-structures',
    status: 'active',
    confidence: 0.9,
    embeddingModel: null,
    masteryLevel: 'understood',
    createdAt: NOW,
    updatedAt: NOW,
  },
  path: [
    { id: 'domain-python', title: 'Python' },
    { id: 'topic-structures', title: '数据结构' },
    { id: 'concept-tuple', title: 'Tuple 元组' },
  ],
  items: [
    {
      item: {
        id: 'item-1',
        userId: 'u-1',
        rawSourceId: 'src-1',
        normalizedText: '元组创建后不可修改。',
        summary: null,
        confidence: 0.9,
        status: 'active',
        isAiDerived: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      sources: [
        {
          rawSourceId: 'src-1',
          sourceType: 'web',
          sourcePlatform: 'macos',
          sourceApp: 'Safari',
          sourceTitle: 'Python 教程',
          sourceUrl: 'https://example.com/tuple',
          capturedAt: NOW,
        },
      ],
    },
  ],
  children: [],
  relatedNodes: [],
  stats: { itemCount: 1, sourceCount: 1, childCount: 0 },
};

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

const TARGETS: NodeOption[] = [
  { id: 'domain-python', title: 'Python', depth: 0 },
  { id: 'topic-structures', title: '数据结构', depth: 1 },
];

const NOOP = (): void => undefined;

function panelProps(overrides: Partial<ComponentProps<typeof InboxPanel>> = {}) {
  return {
    response: { entries: [entry()], counts: { pending: 1, processing: 0, done: 0, failed: 0 }, limit: 20, offset: 0 } as InboxResponse,
    loading: false,
    error: null,
    feedback: null,
    filter: 'unfinished' as const,
    targets: TARGETS,
    rows: {} as Readonly<Record<string, InboxRowState>>,
    rawTexts: {} as Readonly<Record<string, string>>,
    onFilter: NOOP,
    onLoadMore: NOOP,
    onToggleText: NOOP,
    onPickTarget: NOOP,
    onEditDraft: NOOP,
    onRetry: NOOP,
    onAssign: NOOP,
    ...overrides,
  };
}

function feedOf(...entries: InboxEntry[]): InboxResponse {
  return {
    entries,
    counts: { pending: 0, processing: 0, done: 0, failed: 0 },
    limit: 20,
    offset: 0,
  };
}

describe('desktop workbench draws the same markup as the web 工作台', () => {
  const noop = (): void => undefined;

  it('知识领域 rail: empty state and populated state', () => {
    expect(renderToStaticMarkup(<DesktopDomainRail domains={[]} activeRootId={null} onSelectDomain={noop} />)).toBe(
      renderToStaticMarkup(<WebDomainRail domains={[]} activeRootId={null} onSelectDomain={noop} />),
    );
    expect(
      renderToStaticMarkup(<DesktopDomainRail domains={TREE} activeRootId="domain-writing" onSelectDomain={noop} />),
    ).toBe(renderToStaticMarkup(<WebDomainRail domains={TREE} activeRootId="domain-writing" onSelectDomain={noop} />));
  });

  it('知识树: expanded, collapsed and selected rows', () => {
    for (const selectedId of [null, 'concept-tuple']) {
      for (const ids of [toExpandedSet(initialExpandedIds(TREE)), new Set<string>()]) {
        const flat = flattenTree(TREE, ids);
        expect(
          renderToStaticMarkup(
            <DesktopTreeView
              nodes={TREE}
              flat={flat}
              expanded={ids}
              selectedId={selectedId}
              loading={false}
              onToggle={noop}
              onSelect={noop}
            />,
          ),
        ).toBe(
          renderToStaticMarkup(
            <WebTreeView
              nodes={TREE}
              flat={flat}
              expanded={ids}
              selectedId={selectedId}
              loading={false}
              onToggle={noop}
              onSelect={noop}
            />,
          ),
        );
      }
    }
  });

  it('节点详情: placeholder and full detail', () => {
    for (const detail of [null, DETAIL]) {
      expect(
        renderToStaticMarkup(
          <DesktopDetail
            detail={detail}
            error={null}
            loading={false}
            treeNodes={TREE}
            versionRecordId={null}
            onOpenNode={noop}
            onRename={async () => undefined}
            onMove={async () => undefined}
            onOpenChat={noop}
          />,
        ),
      ).toBe(
        renderToStaticMarkup(
          <WebDetail
            detail={detail}
            error={null}
            loading={false}
            treeNodes={TREE}
            versionRecordId={null}
            onOpenNode={noop}
            onRename={async () => undefined}
            onMove={async () => undefined}
            onOpenChat={noop}
          />,
        ),
      );
    }
  });

  it('the shared tree markup still carries the V1 vocabulary', () => {
    const ids = toExpandedSet(['domain-python', 'topic-structures', 'domain-writing']);
    const html = renderToStaticMarkup(
      <DesktopTreeView
        nodes={TREE}
        flat={flattenTree(TREE, ids)}
        expanded={ids}
        selectedId="concept-tuple"
        loading={false}
        onToggle={NOOP}
        onSelect={NOOP}
      />,
    );
    expect(html).toContain('Tuple 元组');
    expect(html).toContain('知识点');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('tree-row-selected');
  });
});

describe('收件箱 panel content (V1 §8)', () => {
  it('shows the counts, the source line and the Chinese status badge', () => {
    const html = renderToStaticMarkup(<InboxPanel {...panelProps()} />);
    expect(html).toContain('收件箱');
    expect(html).toContain('待整理 1');
    expect(html).toContain('网页 · Safari · macos · 卡片笔记法');
    expect(html).toContain('2026-03-01 08:00 · 24 字');
    expect(html).toContain('用自己的话重写每张卡片。');
    expect(html).toContain('class="badge badge-warn">待整理');
  });

  it('names the failure reason and enables 重试归纳 only there', () => {
    const failed = renderToStaticMarkup(
      <InboxPanel {...panelProps({ response: feedOf(entry({ processingStatus: 'failed', errorReason: '模型调用超时' })) })} />,
    );
    expect(failed).toContain('归纳失败原因：模型调用超时');
    expect(failed).toContain('class="badge badge-danger">归纳失败');
    expect(failed).toContain('<button type="button" class="btn">重试归纳</button>');

    const pending = renderToStaticMarkup(<InboxPanel {...panelProps()} />);
    expect(pending).toContain('disabled="">重试归纳');
  });

  it('withholds 人工归档 until a target node is picked, and offers the indented tree', () => {
    const untouched = renderToStaticMarkup(<InboxPanel {...panelProps()} />);
    expect(untouched).toContain('disabled="">人工归档');
    expect(untouched).toContain('选择归档节点…');
    expect(untouched).toContain('　数据结构');

    const chosen = renderToStaticMarkup(
      <InboxPanel {...panelProps({ rows: { 'src-1': { open: false, busy: false, targetId: 'topic-structures', draft: '', error: null } } })} />,
    );
    expect(chosen).toContain('<button type="button" class="btn btn-primary">人工归档</button>');
    expect(chosen).toContain('留空则归档整段原文');
  });

  it('leaves a row being processed alone', () => {
    const html = renderToStaticMarkup(
      <InboxPanel {...panelProps({ response: feedOf(entry({ processingStatus: 'processing' })) })} />,
    );
    expect(html).toContain('正在整理中，稍后可重试或人工归档。');
    expect(html).not.toContain('人工归档</button>');
    expect(html).toContain('disabled="">重试归纳');
  });

  it('shows 正在读取原文… while the full text is being fetched, then the text itself', () => {
    const rows = { 'src-1': { open: true, busy: false, targetId: '', draft: '', error: null } };
    expect(renderToStaticMarkup(<InboxPanel {...panelProps({ rows })} />)).toContain('正在读取原文…');
    expect(renderToStaticMarkup(<InboxPanel {...panelProps({ rows, rawTexts: { 'src-1': '整段原文在这里。' } })} />)).toContain(
      '整段原文在这里。',
    );
  });

  it('lists every filter as a radio and marks the active one', () => {
    const html = renderToStaticMarkup(<InboxPanel {...panelProps()} />);
    for (const label of ['需要处理', '待整理', '整理中', '归纳失败', '已归纳', '全部']) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="radiogroup"');
  });

  it('offers 加载更多 only for the filter that still has rows', () => {
    const response: InboxResponse = {
      ...feedOf(...Array.from({ length: 2 }, () => entry({ processingStatus: 'pending' }))),
      counts: { pending: 5, processing: 0, done: 0, failed: 0 },
      limit: 2,
    };
    const html = renderToStaticMarkup(<InboxPanel {...panelProps({ response, filter: 'pending' })} />);
    expect(html).toContain('加载更多（已显示 2 条，筛选「待整理」）');
    expect(renderToStaticMarkup(<InboxPanel {...panelProps({ response, filter: 'done' })} />)).not.toContain('加载更多');
  });

  it('speaks an honest empty state per filter', () => {
    const html = renderToStaticMarkup(<InboxPanel {...panelProps({ response: feedOf() })} />);
    expect(html).toContain('没有需要处理的原文，收件箱是干净的。');
    expect(
      renderToStaticMarkup(<InboxPanel {...panelProps({ response: feedOf(), filter: 'failed' })} />),
    ).toContain('没有归纳失败的原文。');
  });

  it('keeps panel feedback and errors visible', () => {
    const html = renderToStaticMarkup(<InboxPanel {...panelProps({ error: '收件箱读取失败', feedback: '已归档：Python / 数据结构' })} />);
    expect(html).toContain('收件箱读取失败');
    expect(html).toContain('已归档：Python / 数据结构');
  });
});

describe('工作台 keeps the web-only affordances out', () => {
  it('offers no login, session badge or dev-token banner', () => {
    const html = renderToStaticMarkup(<InboxPanel {...panelProps()} />);
    const empty = renderToStaticMarkup(<EmptyState onCapture={async () => ''} aiIsOffline={false} />);
    const detail = renderToStaticMarkup(
      <DesktopDetail
        detail={DETAIL}
        error={null}
        loading={false}
        treeNodes={TREE}
        versionRecordId={null}
        onOpenNode={NOOP}
        onRename={async () => undefined}
        onMove={async () => undefined}
        onOpenChat={NOOP}
      />,
    );
    for (const markup of [html, empty, detail]) {
      expect(markup).not.toContain('登录');
      expect(markup).not.toContain('退出');
      expect(markup).not.toContain('dev-banner');
      expect(markup).not.toContain('Supabase');
    }
  });

  it('explains the offline provider only when Core really is offline', () => {
    expect(renderToStaticMarkup(<EmptyState onCapture={async () => ''} aiIsOffline />)).toContain('离线 Provider');
    expect(renderToStaticMarkup(<EmptyState onCapture={async () => ''} aiIsOffline={false} />)).not.toContain('离线 Provider');
  });

  it('lists the four capture entry points a new desktop user has', () => {
    const html = renderToStaticMarkup(<EmptyState onCapture={async () => ''} aiIsOffline={false} />);
    for (const label of ['桌面 Companion', '浏览器插件', 'MCP', '收件箱']) expect(html).toContain(label);
    expect(html).toContain('你的知识树还是空的');
  });
});

describe('顶栏连接状态说得诚实', () => {
  const api = {} as WorkbenchApi;

  function bar(health: HealthResponse | null, healthProblem: string | null): string {
    return renderToStaticMarkup(
      <TopBar
        api={api}
        health={health}
        healthProblem={healthProblem}
        domainCount={2}
        nodeCount={9}
        itemCount={17}
        onPickNode={NOOP}
      />,
    );
  }

  it('正在检测 during the first probe — a request in flight is not an outage', () => {
    const html = bar(null, null);
    expect(html).toContain('正在检测本机知识服务');
    expect(html).not.toContain('不可用');
  });

  it('本机知识服务不可用 only once the probe actually failed, with the reason', () => {
    const html = bar(null, '连接被拒绝 / connection refused');
    expect(html).toContain('本机知识服务不可用');
    expect(html).toContain('连接被拒绝 / connection refused');
  });

  it('reports the storage and model the local Core is actually running', () => {
    const html = bar(
      {
        status: 'ok',
        productId: 'noltri-knowledge-core',
        instanceId: 'instance-under-test',
        protocolVersion: '1',
        version: '0.1.0',
        storageDriver: 'sqlite',
        storage: { driver: 'sqlite', ok: true, detail: { journalMode: 'wal', rawSources: 3 } },
        aiProvider: 'offline',
        embeddingDim: 1536,
        requiresAiKey: false,
      },
      null,
    );
    expect(html).toContain('知识服务已连接');
    expect(html).toContain('2 领域');
    expect(html).toContain('9 节点');
    expect(html).toContain('17 知识点');
  });

  it('calls a degraded Core 降级 rather than 已连接', () => {
    const html = bar(
      {
        status: 'degraded',
        productId: 'noltri-knowledge-core',
        instanceId: 'instance-under-test',
        protocolVersion: '1',
        version: '0.1.0',
        storageDriver: 'sqlite',
        storage: { driver: 'sqlite', ok: false, detail: { reason: 'disk full' } },
        aiProvider: 'offline',
        embeddingDim: 1536,
        requiresAiKey: false,
      },
      null,
    );
    expect(html).toContain('知识服务降级');
    expect(html).not.toContain('已连接');
  });
});
