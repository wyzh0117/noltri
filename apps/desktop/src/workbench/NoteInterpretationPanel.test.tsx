import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteInterpretationPanel } from './NoteInterpretationPanel';

const api = { interpretNote: async () => ({ text: 'synthetic result' }) };

function renderPanel(content: string): string {
  return renderToStaticMarkup(createElement(NoteInterpretationPanel, {
    api,
    content,
    path: 'Inbox/Example.md',
    onReturnToSource: () => undefined,
  }));
}

describe('note interpretation panel', () => {
  it('offers explicit translation and explanation actions, discloses the send, and keeps the source view separate', () => {
    const source = 'A tuple is immutable.\n\n| Kind | Mutable |\n| --- | --- |\n| tuple | no |\n\n```ts\nconst x = 1;\n```\n\n$$x^2$$\n\n![diagram](assets/graph.png)';
    const markup = renderPanel(source);

    expect(markup).toContain('翻译为简体中文');
    expect(markup).toContain('通俗解释');
    expect(markup).toContain('点击后会把当前笔记正文发送给已配置的模型');
    expect(markup).toContain('原文不会被修改');
    expect(markup).toContain('aria-label="笔记解读"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain('synthetic result');
    expect(markup).not.toContain('原文快照</summary>');
  });

  it('disables both actions for empty source text', () => {
    const markup = renderPanel('  \n  ');

    expect((markup.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(markup).toContain('当前笔记没有正文');
  });

  it('disables actions when the source exceeds the Core input limit', () => {
    const markup = renderPanel('x'.repeat(20_001));

    expect((markup.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(markup).toContain('原文超过 20,000 字符上限');
  });
});


describe('note interpretation source bounds', () => {
  it('accepts exactly 20,000 characters without disabling either action', () => {
    const markup = renderPanel('x'.repeat(20_000));

    expect((markup.match(/disabled=""/g) ?? [])).toHaveLength(1);
    expect(markup).not.toContain('原文超过 20,000 字符上限');
  });
});
