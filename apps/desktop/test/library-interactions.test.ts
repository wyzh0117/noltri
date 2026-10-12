import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '@noltri/schema';
import { isWithinPath, parseSubjectPath, toggleComparedItems } from '../src/workbench/WorkbenchApp';

function paper(id: string, title: string, content: string, url: string): LibraryItem {
  return {
    id,
    content,
    summary: null,
    kind: 'paper_excerpt',
    source: { type: 'manual', title, url, platform: null, appName: null, capturedAt: '2026-10-12T00:00:00Z', citation: null, page: null, author: null, doi: null },
    previewImageUrl: null,
    subjectPath: ['经济学', '因果推断'],
    researchPoint: null,
    tags: [],
    aiStatus: 'ready',
    createdAt: '2026-10-12T00:00:00Z',
    archived: false,
  };
}

describe('library navigation and comparison', () => {
  it('keeps an empty category unfiltered and matches selected subject paths by ancestry', () => {
    expect(isWithinPath(['经济学', '金融'], [])).toBe(true);
    expect(isWithinPath(['经济学', '金融'], ['经济学'])).toBe(true);
    expect(isWithinPath(['经济学', '金融'], ['管理学'])).toBe(false);
  });

  it('keeps full selected papers when search or category changes the visible results', () => {
    const first = paper('first', '第一篇论文', '第一段原文', 'https://example.com/first');
    const second = paper('second', '第二篇论文', '第二段原文', 'https://example.com/second');
    const third = paper('third', '第三篇论文', '第三段原文', 'https://example.com/third');
    const selectedBeforeFilter = toggleComparedItems([], first);
    const selectedAfterFilter = toggleComparedItems(selectedBeforeFilter, second);

    expect(selectedAfterFilter).toHaveLength(2);
    expect(selectedAfterFilter.map(({ source, content }) => [source.title, content, source.url])).toEqual([
      ['第一篇论文', '第一段原文', 'https://example.com/first'],
      ['第二篇论文', '第二段原文', 'https://example.com/second'],
    ]);
    expect(toggleComparedItems(selectedAfterFilter, first)).toEqual([second]);
    expect(toggleComparedItems(selectedAfterFilter, third)).toBe(selectedAfterFilter);
  });

  it('turns a typed slash path into clean hierarchy segments', () => {
    expect(parseSubjectPath(' 社会科学 / / 经济学 / 因果推断 / ')).toEqual(['社会科学', '经济学', '因果推断']);
    expect(parseSubjectPath(' /   / ')).toEqual([]);
  });
});
