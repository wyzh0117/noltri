import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LibraryItem } from '@noltri/schema';
import ModelSettings, { createFetchModelsInput, hasProviderIdConflict } from '../src/workbench/ModelSettings';
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
  it('allows using a saved provider while rejecting a duplicate id on creation', () => {
    const savedProviders = [{ id: 'openai' }];
    expect(hasProviderIdConflict('openai', savedProviders, false)).toBe(false);
    expect(hasProviderIdConflict('openai', savedProviders, true)).toBe(true);
    expect(hasProviderIdConflict('anthropic', savedProviders, true)).toBe(false);
  });

  it('uses a saved key for existing providers unless the draft explicitly clears it', () => {
    const draft = { id: 'openai', name: 'OpenAI', protocol: 'openai-responses' as const, baseUrl: 'https://api.openai.com/v1', models: [], apiKey: '' };
    expect(createFetchModelsInput(draft, false)).toEqual({ providerId: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
    expect(createFetchModelsInput({ ...draft, apiKey: 'typed-key', clearApiKey: true }, false)).toEqual({ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
  });

  it('renders provider management and the current model without exposing credentials', () => {
    const html = renderToStaticMarkup(createElement(ModelSettings, {
      settings: {
        apiBaseUrl: '', apiToken: '', mcpEndpoint: '', runtimeStatus: 'managed',
        providers: [{ id: 'openai', name: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', hasApiKey: true, models: [{ id: 'gpt-model', name: 'GPT Model', contextWindow: null, maxTokens: null, input: { text: true, image: false } }] }],
        activeProviderId: 'openai', activeModelId: 'gpt-model',
      },
      outsideTauri: false, welcome: true, onSaved: () => {}, onDone: () => {},
    }));
    expect(html).toContain('先连接你的 AI 模型');
    expect(html).toContain('Provider 管理');
    expect(html).toContain('OpenAI');
    expect(html).toContain('当前模型');
    expect(html).toContain('API Key 已保存');
    expect(html).toContain('添加 Provider');
    expect(html).not.toContain('test-only');
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
