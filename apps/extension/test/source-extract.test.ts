import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SOURCE_TITLE_LENGTH,
  SURROUNDING_CONTEXT_JOINER,
  SURROUNDING_CONTEXT_TOTAL_MAX,
  SURROUNDING_CONTEXT_WINDOW,
  buildSource,
  deriveSurroundingContext,
  domainLabel,
  offsetOfPosition,
  platformFromHostname,
  productPlatform,
  readSelectionIntent,
  readImageAltText,
  readPageCollectionContext,
  textOfContentTree,
  type ContentTree,
  type SurroundingContextInput,
} from '../src/source/extract';

afterEach(() => vi.unstubAllGlobals());

const SELECTION = '归纳知识点按钮';
const BEFORE = 'A'.repeat(1_000);
const AFTER = 'B'.repeat(1_000);
const PAGE_TEXT = `${BEFORE}${SELECTION}${AFTER}`;

function text(content: string): ContentTree {
  return { nodeName: '#text', text: content };
}

function element(nodeName: string, children: readonly ContentTree[], id?: string): ContentTree {
  return { nodeName, children, ...(id === undefined ? {} : { id }) };
}

describe('surrounding context window (§10.4)', () => {
  it('stays within the documented per-side window and combined budget', () => {
    const context = deriveSurroundingContext({ parentText: PAGE_TEXT, start: BEFORE.length, end: BEFORE.length + SELECTION.length });
    expect(context.length).toBeLessThanOrEqual(SURROUNDING_CONTEXT_TOTAL_MAX + SURROUNDING_CONTEXT_JOINER.length);
    const sides = context.split(SURROUNDING_CONTEXT_JOINER);
    for (const side of sides) expect(side.length).toBeLessThanOrEqual(SURROUNDING_CONTEXT_WINDOW);
  });

  it('keeps text on both sides of the selection', () => {
    const context = deriveSurroundingContext({ parentText: PAGE_TEXT, start: BEFORE.length, end: BEFORE.length + SELECTION.length });
    const [before, after] = context.split(SURROUNDING_CONTEXT_JOINER);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(before?.endsWith('A')).toBe(true);
    expect(after?.startsWith('B')).toBe(true);
  });

  it('never repeats the selected text into the context field', () => {
    const context = deriveSurroundingContext({ parentText: PAGE_TEXT, start: BEFORE.length, end: BEFORE.length + SELECTION.length });
    expect(context.includes(SELECTION)).toBe(false);
  });

  it('honours a custom window and budget', () => {
    const context = deriveSurroundingContext({ parentText: PAGE_TEXT, start: BEFORE.length, end: BEFORE.length + SELECTION.length, windowSize: 400, totalMax: 900 });
    expect(context.length).toBeLessThanOrEqual(900 + SURROUNDING_CONTEXT_JOINER.length);
    expect(context.split(SURROUNDING_CONTEXT_JOINER)[0]?.length).toBe(400);
  });

  it('spends the whole budget on the one side that exists', () => {
    const context = deriveSurroundingContext({ parentText: PAGE_TEXT, start: BEFORE.length, end: PAGE_TEXT.length });
    expect(context).toBe('A'.repeat(SURROUNDING_CONTEXT_WINDOW));
  });

  it('clamps nonsense offsets instead of throwing', () => {
    expect(deriveSurroundingContext({ parentText: '知识就是知识', start: -10, end: 999 })).toBe('');
    expect(deriveSurroundingContext({ parentText: '', start: 0, end: 0 })).toBe('');
  });
});

describe('content extraction ignores page machinery, not pages', () => {
  const tree = element('DIV', [
    text('前段内容'),
    element('SCRIPT', [text('var tracking = true')]),
    element('STYLE', [text('body { color: red }')]),
    element('NOSCRIPT', [text('no script fallback')]),
    text('选中的知识内容'),
    element('P', [text('后段'), text('内容')]),
    element('DIV', [text('插件自己的界面文字')], 'noltri-pill-host'),
  ]);

  it('drops script, style, noscript and own UI text', () => {
    expect(textOfContentTree(tree)).toBe('前段内容选中的知识内容后段内容');
  });

  it('maps positions inside the flattened text, skipping the excluded subtrees', () => {
    const flattened = textOfContentTree(tree);
    const start = offsetOfPosition(tree, { path: [4], offset: 0 });
    const end = offsetOfPosition(tree, { path: [4], offset: '选中的知识内容'.length });
    expect(start).toBe(4);
    expect(flattened.slice(start ?? -1, end ?? -1)).toBe('选中的知识内容');
    expect(offsetOfPosition(tree, { path: [5, 1], offset: 0 })).toBe(13);
    expect(flattened.slice(11, 13)).toBe('后段');
  });

  it('refuses to map a position that lives in excluded text or outside the tree', () => {
    expect(offsetOfPosition(tree, { path: [1, 0], offset: 4 })).toBeNull();
    expect(offsetOfPosition(tree, { path: [6, 0], offset: 0 })).toBeNull();
    expect(offsetOfPosition(tree, { path: [9], offset: 0 })).toBeNull();
  });
});

describe('platform labelling is hostname-only', () => {
  it('names the known chat products and falls back to the bare domain', () => {
    expect(platformFromHostname('www.chatgpt.com')).toBe('ChatGPT');
    expect(platformFromHostname('claude.ai')).toBe('Claude');
    expect(platformFromHostname('gemini.google.com')).toBe('Gemini');
    expect(platformFromHostname('www.perplexity.ai')).toBe('Perplexity');
    expect(platformFromHostname('news.ycombinator.com')).toBe('news.ycombinator.com');
    expect(platformFromHostname('docs.example.com')).toBe('docs.example.com');
    expect(platformFromHostname('')).toBe('网页');
    expect(productPlatform('chatgpt.com')).toBe('ChatGPT');
    expect(productPlatform('example.com')).toBeUndefined();
    expect(domainLabel('WWW.Example.com.')).toBe('example.com');
  });

  it('builds a web source from url and title only', () => {
    const source = buildSource({ href: 'https://chatgpt.com/c/0198abc', title: '  我的对话  ' });
    expect(source).toEqual({ type: 'web', platform: 'ChatGPT', appName: 'ChatGPT', title: '我的对话', url: 'https://chatgpt.com/c/0198abc' });
  });

  it('derives a title when the page has none, and caps it at the contract length', () => {
    const long = '知'.repeat(900);
    expect(buildSource({ href: 'https://blog.example.org/post', title: '' }).title).toBeUndefined();
    const titled = buildSource({ href: 'https://blog.example.org/post', title: long });
    expect((titled.title ?? '').length).toBeLessThanOrEqual(MAX_SOURCE_TITLE_LENGTH);
  });

  it('tolerates non-http locations such as chrome://newtab', () => {
    expect(buildSource({ href: 'chrome://newtab', title: '新标签页' })).toEqual({ type: 'web', title: '新标签页' });
    expect(buildSource({ href: 'not a url', title: '' })).toEqual({ type: 'web' });
  });

  it('tags the popup paste fallback as a manual source', () => {
    expect(buildSource({ href: '', title: '', type: 'manual' })).toEqual({ type: 'manual', appName: '知序 Noltri 扩展' });
  });
});

describe('page and image metadata collection', () => {
  it('reads declared descriptions and an HTTPS Open Graph image without reading page text', () => {
    const metadata = new Map([
      ['meta[name="description"]', { content: 'A short page description that explains the topic.' }],
      ['meta[property="og:image"]', { content: '/images/cover.png' }],
    ]);
    vi.stubGlobal('document', {
      title: 'Page title',
      querySelector: (selector: string) => metadata.get(selector) ?? null,
    });
    vi.stubGlobal('location', { href: 'https://docs.example.com/topic' });

    expect(readPageCollectionContext()).toEqual({
      title: 'Page title',
      description: 'A short page description that explains the topic.',
      previewImageUrl: 'https://docs.example.com/images/cover.png',
    });
  });

  it('ignores insecure image metadata and reads alt text only for the clicked image', () => {
    const metadata = new Map([
      ['meta[property="og:image"]', { content: 'http://cdn.example.com/cover.png' }],
    ]);
    vi.stubGlobal('document', {
      title: 'Image page',
      querySelector: (selector: string) => metadata.get(selector) ?? null,
      images: [
        { currentSrc: 'https://cdn.example.com/first.png', src: 'https://cdn.example.com/first.png', alt: 'first selected image', title: '' },
        { currentSrc: 'https://cdn.example.com/second.png', src: 'https://cdn.example.com/second.png', alt: 'second selected image', title: '' },
      ],
    });
    vi.stubGlobal('location', { href: 'https://docs.example.com/topic' });

    expect(readPageCollectionContext()).toEqual({ title: 'Image page' });
    expect(readImageAltText('https://cdn.example.com/second.png')).toBe('second selected image');
    expect(readImageAltText('file:///tmp/private.png')).toBeUndefined();
  });
});

describe('the extractor is handed plain data, never a Document', () => {
  const FORBIDDEN_KEYS = ['body', 'head', 'documentElement', 'innerHTML', 'outerHTML', 'innerText', 'querySelector', 'getElementById', 'getElementsByTagName'];

  function hostile<T extends object>(value: T): T {
    return new Proxy(value, {
      get(target, key) {
        if (typeof key === 'string' && FORBIDDEN_KEYS.includes(key)) {
          throw new Error(`the extractor reached for page-wide member "${key}"`);
        }
        return Reflect.get(target, key);
      },
    });
  }

  it('reads only the parent text and the two offsets', () => {
    const input: SurroundingContextInput = hostile({ parentText: PAGE_TEXT, start: BEFORE.length, end: BEFORE.length + SELECTION.length });
    expect(() => deriveSurroundingContext(input)).not.toThrow();
    expect(deriveSurroundingContext(input).length).toBeGreaterThan(0);
  });

  it('reads only href, title and type when building the source', () => {
    const input = hostile({ href: 'https://blog.example.org/post', title: '一篇文章', type: 'web' as const });
    expect(() => buildSource(input)).not.toThrow();
    expect(buildSource(input).platform).toBe('blog.example.org');
  });

  it('exposes one page-reading entry point that takes only an optional forced string', () => {
    expect(typeof readSelectionIntent).toBe('function');
    expect(readSelectionIntent.length).toBe(1);
  });
});
