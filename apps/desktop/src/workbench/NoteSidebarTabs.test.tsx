import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteSidebarTabs } from './NoteSidebarTabs';

describe('reading sidebar sections', () => {
  it('groups existing note tools under relationships and keeps interpretation explicit', () => {
    const onSelect = vi.fn();
    const markup = renderToStaticMarkup(<NoteSidebarTabs panel="properties" onSelect={onSelect} />);
    expect(markup).toContain('aria-label="阅读侧栏分区"');
    expect(markup).toContain('aria-pressed="true">关系</button>');
    expect(markup).toContain('aria-pressed="false">解读</button>');
    for (const label of ['大纲', '标签', '属性', '反链', '提及', '历史']) expect(markup).toContain(label);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects interpretation without presenting relation controls as active', () => {
    const markup = renderToStaticMarkup(<NoteSidebarTabs panel="interpretation" onSelect={() => undefined} />);
    expect(markup).toContain('aria-pressed="true">解读</button>');
    expect(markup).not.toContain('aria-label="关系工具"');
  });
});


it('offers graph relationships only when a graph slot exists', () => {
  const withGraph = renderToStaticMarkup(<NoteSidebarTabs panel="graph" hasGraph onSelect={() => undefined} />);
  expect(withGraph).toContain('aria-pressed="true">图谱</button>');
  const withoutGraph = renderToStaticMarkup(<NoteSidebarTabs panel="outline" onSelect={() => undefined} />);
  expect(withoutGraph).not.toContain('>图谱</button>');
});
