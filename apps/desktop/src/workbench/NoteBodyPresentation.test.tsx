import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { NoteBodyPresentation } from './NoteBodyPresentation';

function renderPresentation(content: string): string {
  return renderToStaticMarkup(createElement(NoteBodyPresentation, {
    content,
    path: 'Notes/Example.md',
    textView: createElement('textarea', { 'aria-label': 'note source', defaultValue: content }),
    onLocate: () => undefined,
    children: ({ toggleButton, viewport }) => createElement('main', null, toggleButton, viewport),
  }));
}

describe('note body presentation', () => {
  it('keeps a native keyboard button and mounted, accessible text and mindmap layers', () => {
    const markup = renderPresentation('# Root\nBody\n## Child\nDetail');

    expect(markup).toContain('aria-label="切换为思维导图视图"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('data-testid="body-view-toggle"');
    expect(markup).toContain('data-view-layer="text"');
    expect(markup).toContain('data-view-layer="mindmap"');
    expect(markup).toContain('inert=""');
    expect(markup).toContain('Example 标题层级思维导图');
    expect(markup).toContain('定位到正文：Child');
    expect(markup).toContain('正文');
  });

  it('renders a helpful empty state instead of an empty graph canvas', () => {
    const markup = renderPresentation('');

    expect(markup).toContain('这篇笔记还没有正文或标题。');
    expect(markup).not.toContain('vault-mindmap-node');
  });

  it('declares interruptible motion and removes transitions for reduced-motion users', () => {
    const css = readFileSync(new URL('./mindmap-view.css', import.meta.url), 'utf8');

    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition:\s*none/su);
    expect(css).toMatch(/transition:\s*opacity 180ms ease, transform 180ms ease/su);
  });
});
