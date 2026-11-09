import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeRightPanel } from './KnowledgeRightPanel';
import type { KnowledgeRightPanelProps } from './KnowledgeRightPanel';

const allDisciplineNodes = [{ id: 'topic-python', title: 'Python', nodeType: 'topic' as const, parentId: null, summary: null }];

function panelMarkup(patch: Partial<KnowledgeRightPanelProps> = {}): string {
  const props: KnowledgeRightPanelProps = {
    scope: null,
    nodes: [],
    edges: [],
    projectionNodes: allDisciplineNodes,
    projectionEdges: [],
    scopeIdentity: 'all',
    contextNodeId: 'topic-python',
    selectedNodeId: null,
    mode: 'mini',
    onModeChange: vi.fn(),
    view: 'subject',
    onViewChange: vi.fn(),
    subjectScope: 'local',
    onSubjectScopeChange: vi.fn(),
    advancedScope: 'all',
    onAdvancedScopeChange: vi.fn(),
    evaluateQuery: async () => new Set(),
    onNodeOpen: vi.fn(),
    toolPanels: { outline: 'Outline slot', backlinks: 'Backlinks slot', outgoing: 'Outgoing slot', tags: 'Tags slot', properties: 'Properties slot' },
    interpretationPanel: 'Interpretation slot',
    ...patch,
  };
  return renderToStaticMarkup(<KnowledgeRightPanel {...props} />);
}

function wholeDisciplineOption(markup: string): string {
  return markup.match(/<option[^>]*value="whole-discipline"[^>]*>/)?.[0] ?? '';
}

describe('knowledge right panel', () => {
  it('renders the ordered relation tools, defaults to properties, and keeps interpretation separate', () => {
    const markup = panelMarkup();

    const order = ['大纲', '反向链接', '出链', '标签', '来源与属性'].map((label) => markup.indexOf(`>${label}</button>`));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(markup).toContain('aria-label="正文工具"');
    expect(markup).toMatch(/id="[^"]+-tool-properties" aria-selected="true" aria-controls="[^"]+-tool-panel"/);
    expect(markup).toContain('Properties slot');
    expect(markup).toMatch(/aria-selected="false"[^>]*>解读<\/button>/);
    expect(markup).not.toContain('class="workbench-graph-mode"');
    expect(markup).toContain('aria-label="学科语义图谱"');
    expect(markup).toContain('学科图谱需要先选择一个学科、方向或主题。');
    expect(markup).toContain('当前范围没有符合条件的节点');
    expect(markup).not.toContain('Python');
  });

  it('uses the all-discipline projection only for explicit advanced all scope', () => {
    const focus = panelMarkup({ view: 'advanced', advancedScope: 'focus' });
    expect(focus).toContain('当前范围需要先选择一个学科、方向或主题');
    expect(focus).toContain('当前范围没有符合条件的节点');
    expect(focus).not.toContain('Python');

    const all = panelMarkup({ view: 'advanced', advancedScope: 'all' });
    expect(all).not.toContain('当前范围需要先选择一个学科、方向或主题');
    expect(all).not.toContain('当前范围没有符合条件的节点');
  });

  it('allows entering whole-discipline scope only on a first-level page', () => {
    const topic = panelMarkup({
      scope: { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' },
      canEnterWholeDiscipline: false,
    });
    const discipline = panelMarkup({
      scope: { kind: 'discipline', disciplineId: 'd1' },
      canEnterWholeDiscipline: true,
    });
    const activeWholeTopic = panelMarkup({
      scope: { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' },
      subjectScope: 'whole-discipline',
      canEnterWholeDiscipline: false,
    });

    expect(wholeDisciplineOption(topic)).toContain('disabled=""');
    expect(wholeDisciplineOption(discipline)).not.toContain('disabled');
    expect(wholeDisciplineOption(activeWholeTopic)).not.toContain('disabled');
  });

  it('restores the right-side tools when the graph returns to mini mode', () => {
    const expanded = panelMarkup({
      scope: { kind: 'discipline', disciplineId: 'd1' },
      subjectScope: 'whole-discipline',
      canEnterWholeDiscipline: true,
      mode: 'expanded',
    });
    const collapsed = panelMarkup({
      scope: { kind: 'topic', disciplineId: 'd1', anchorTopicId: 't1' },
      subjectScope: 'local',
      mode: 'mini',
    });

    expect(expanded).not.toContain('aria-label="正文辅助工具"');
    expect(collapsed).toContain('aria-label="正文辅助工具"');
  });
});
