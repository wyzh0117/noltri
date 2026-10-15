import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LibraryItem } from '@noltri/schema';
import ModelSettings from '../src/workbench/ModelSettings';
import { describeError } from '../src/workbench/api';
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
  it('renders the model welcome screen with a selected profile and masked API key', () => {
    const modelProfiles = ['flash', 'pro'].map((id) => ({
      id, name: id, provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com',
      apiKey: 'test-only', model: id === 'flash' ? 'deepseek-flash' : 'deepseek-v4-pro',
    }));
    const html = renderToStaticMarkup(createElement(ModelSettings, {
      settings: { apiBaseUrl: '', apiToken: '', mcpEndpoint: '', modelProfiles, activeModelId: 'pro', runtimeStatus: 'managed' },
      outsideTauri: false, welcome: true, onSaved: () => {}, onDone: () => {},
    }));
    expect(html).toContain('先连接你的 AI 模型');
    expect(html).toContain('<option value="pro" selected="">pro · deepseek-v4-pro</option>');
    expect(html).toContain('type="password"');
    for (const label of ['API Key', '添加模型', '保存并启用', '进入知识库']) expect(html).toContain(label);
  });

  it('preserves native command error messages', () => {
    expect(describeError('请选择当前使用的模型。')).toBe('请选择当前使用的模型。');
    expect(describeError(new Error('网络不可用'))).toBe('网络不可用');
    expect(describeError('  ')).toBe('发生未知错误。');
  });

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
