import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { codeBlockPositionAtClick, createLivePreviewStateField, editorOffsetToSourceOffset, lineSeparatorForSource, normalizeEditorDocument, notesSearchRangesField, parseLivePreviewTokens, resolveLinkWidget, serializeEditorDocument, setNotesSearchRanges, sourceRangesToEditorRanges } from './NotesEditor';
import type { LivePreviewToken } from './NotesEditor';

describe('live preview tokenization', () => {
  it('maps raw CRLF+CJK source ranges and cursor positions to CM6 while preserving CRLF on edit', () => {
    const source = ['---', 'title: 中文', '---', '# 第一节', '命中 [[目标]]'].join('\r\n');
    const rawStart = source.indexOf('[[目标]]');
    const rawEnd = rawStart + '[[目标]]'.length;
    const lineSeparator = lineSeparatorForSource(source);
    const doc = normalizeEditorDocument(source, lineSeparator);
    const propsRef = { current: { sourcePath: 'CRLF.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({
      doc,
      extensions: [EditorState.lineSeparator.of(lineSeparator), notesSearchRangesField, field],
    });
    const [searchRange] = sourceRangesToEditorRanges(source, [{ start: rawStart, end: rawEnd }]);
    const token = initial.field(field).tokens.find((item) => item.kind === 'wiki-link')!;

    expect(lineSeparator).toBe('\r\n');
    expect(initial.doc.toString()).not.toContain('\r');
    expect(searchRange).toEqual({ start: token.start, end: token.end });
    expect(editorOffsetToSourceOffset(initial, initial.doc.toString().indexOf('目标'))).toBe(source.indexOf('目标'));

    const searched = initial.update({ effects: setNotesSearchRanges.of([searchRange!]) }).state;
    let wikiWidgetVisible = false;
    searched.field(field).decorations.between(token.start, token.end, (_from, _to, decoration) => {
      if (decoration.spec.widget) wikiWidgetVisible = true;
    });
    expect(wikiWidgetVisible).toBe(false);

    const edited = initial.update({ changes: { from: initial.doc.length, insert: '\r\n新增' } }).state;
    expect(serializeEditorDocument(edited)).toBe(`${source}\r\n新增`);
    expect(editorOffsetToSourceOffset(edited, edited.doc.toString().indexOf('新增'))).toBe(`${source}\r\n新增`.indexOf('新增'));
  });

  it('keeps LF offsets and serialization unchanged', () => {
    const source = '# 中文\n命中 [[目标]]';
    const lineSeparator = lineSeparatorForSource(source);
    const state = EditorState.create({ doc: source, extensions: [EditorState.lineSeparator.of(lineSeparator)] });
    const rawStart = source.indexOf('[[目标]]');
    const rawEnd = rawStart + '[[目标]]'.length;
    expect(lineSeparator).toBe('\n');
    expect(sourceRangesToEditorRanges(source, [{ start: rawStart, end: rawEnd }])).toEqual([{ start: rawStart, end: rawEnd }]);
    expect(editorOffsetToSourceOffset(state, rawStart)).toBe(rawStart);
    expect(serializeEditorDocument(state)).toBe(source);
  });

  it('indexes dense live-preview tokens across a 5k-line note', () => {
    const source = Array.from({ length: 5_000 }, (_, index) => `line-${index} [[Target]] #tag **bold** $x$`).join('\n');
    const tokens = parseLivePreviewTokens(source);
    expect(tokens).toHaveLength(20_000);
    expect(tokens.filter((token) => token.kind === 'wiki-link')).toHaveLength(5_000);
    expect(tokens.filter((token) => token.kind === 'tag')).toHaveLength(5_000);
    expect(tokens.filter((token) => token.kind === 'strong')).toHaveLength(5_000);
    expect(tokens.filter((token) => token.kind === 'math-inline')).toHaveLength(5_000);
  });

  it('hides only the heading prefix and keeps the whole heading as the reveal token', () => {
    const tokens = parseLivePreviewTokens('# A heading');
    expect(tokens).toContainEqual(expect.objectContaining({ kind: 'heading', start: 0, end: 11, decorationStart: 0, decorationEnd: 2, text: 'A heading' }));
  });

  it('renders math, tables, callouts, embeds, and block ids as separate widgets', () => {
    const source = [
      '$$x^2 + y^2$$',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '',
      '> [!tip] Useful',
      '> Body text',
      '',
      '![[Assets/figure.png|Diagram]]',
      '',
      'A paragraph. ^anchor-1',
    ].join('\n');
    const tokens = parseLivePreviewTokens(source);
    expect(tokens.map((token) => token.kind)).toEqual(['math-block', 'table', 'callout', 'embed', 'block-id']);
    expect(tokens.find((token) => token.kind === 'table')?.raw).toContain('| one | two |');
    expect(tokens.find((token) => token.kind === 'callout')?.raw).toContain('Useful');
    expect(tokens.find((token) => token.kind === 'embed')?.text).toBe('![[Assets/figure.png|Diagram]]');
    expect(tokens.find((token) => token.kind === 'block-id')?.text).toBe('anchor-1');
  });

  it('keeps frontmatter hidden, previews fenced code as one block, and still previews following math', () => {
    const source = [
      '---', 'title: $not math$', '---',
      '```md', '$not math$', '| not | a table |', '> [!tip] not a callout', '```',
      '$yes$',
    ].join('\n');
    const tokens = parseLivePreviewTokens(source);
    expect(tokens.map((token) => token.kind)).toEqual(['code-block', 'math-inline']);
    expect(tokens[0]).toMatchObject({ language: 'md', block: true, text: '$not math$\n| not | a table |\n> [!tip] not a callout' });
    expect(source.slice(tokens[1]!.start, tokens[1]!.end)).toBe('$yes$');
  });

  it('previews inline wiki links, tags, code, and math without swallowing overlapping syntax', () => {
    const source = 'See [[Folder/Note#Heading|this note]], `code`, #topic, and $x+1$.';
    const tokens = parseLivePreviewTokens(source);
    expect(tokens.map((token) => token.kind)).toEqual(['wiki-link', 'inline-code', 'tag', 'math-inline']);
    expect(tokens[0]?.text).toBe('this note');
    expect(tokens[2]?.text).toBe('topic');
  });

  it('keeps inline widgets inside headings while the heading prefix remains independently replaceable', () => {
    const tokens = parseLivePreviewTokens('# Heading [[Target]] #topic');
    expect(tokens.map((token) => token.kind)).toEqual(['heading', 'wiki-link', 'tag']);
    expect(tokens[0]).toMatchObject({ start: 0, end: 27, decorationStart: 0, decorationEnd: 2 });
  });

  it('recognizes HTML, horizontal rules, and multiple fenced languages as block widgets', () => {
    const source = [
      'before',
      '---',
      '<div class="safe">',
      '<script>bad()</script>',
      '</div>',
      '',
      '~~~Mermaid',
      'graph TD; A-->B',
      '~~~',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      'after',
    ].join('\n');
    const tokens = parseLivePreviewTokens(source);
    expect(tokens.map((token) => token.kind)).toEqual(['horizontal-rule', 'html-block', 'code-block', 'code-block']);
    expect(tokens.filter((token) => token.kind === 'code-block').map((token) => token.language)).toEqual(['mermaid', 'js']);
    expect(tokens.find((token) => token.kind === 'html-block')?.raw).toContain('<script>bad()</script>');
  });

  it('does not create clickable widgets for javascript Markdown links', () => {
    const tokens = parseLivePreviewTokens('[unsafe](javascript:alert(1)) and ![image](javascript:alert(1))');
    expect(tokens.some((token) => token.kind === 'markdown-link')).toBe(false);
    expect(tokens.find((token) => token.kind === 'image')).toBeDefined();
  });

  it('reveals StateField block and inline widgets under caret, selection, and search changes', () => {
    const source = [
      'intro',
      'See [[Target]]',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '<div>safe</div>',
      '',
      '---',
    ].join('\n');
    const propsRef = { current: {
      sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false,
      onOpenLink: () => undefined, isCurrent: () => true,
    } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const tokens = parseLivePreviewTokens(source);
    const wiki = tokens.find((token) => token.kind === 'wiki-link')!;
    const code = tokens.find((token) => token.kind === 'code-block')!;
    const html = tokens.find((token) => token.kind === 'html-block')!;
    const rule = tokens.find((token) => token.kind === 'horizontal-rule')!;
    const visibleWidgets = (state: EditorState) => {
      const ranges: Array<{ from: number; to: number }> = [];
      state.field(field).decorations.between(0, state.doc.length, (from, to, decoration) => {
        if (decoration.spec.widget) ranges.push({ from, to });
      });
      return ranges;
    };
    const contains = (state: EditorState, token: { start: number; end: number }) => visibleWidgets(state).some(({ from, to }) => from === token.start && to === token.end);

    expect(contains(initial, wiki)).toBe(true);
    expect(contains(initial, code)).toBe(true);
    expect(contains(initial, html)).toBe(true);
    expect(contains(initial, rule)).toBe(true);

    const caretInside = initial.update({ selection: { anchor: wiki.start + 2 } }).state;
    expect(contains(caretInside, wiki)).toBe(false);
    expect(contains(caretInside, code)).toBe(true);

    const selected = caretInside.update({ selection: { anchor: code.start + 4, head: code.end - 4 } }).state;
    expect(contains(selected, code)).toBe(false);
    expect(contains(selected, html)).toBe(true);

    const searched = initial.update({ effects: setNotesSearchRanges.of([{ start: html.start + 2, end: html.start + 5 }]) }).state;
    expect(contains(searched, html)).toBe(false);
    const cleared = searched.update({ effects: setNotesSearchRanges.of([]) }).state;
    expect(contains(cleared, html)).toBe(true);

    const ruleCaret = cleared.update({ selection: { anchor: rule.start + 1 } }).state;
    expect(contains(ruleCaret, rule)).toBe(false);
    const ruleSearch = cleared.update({ selection: { anchor: 0 }, effects: setNotesSearchRanges.of([{ start: rule.start, end: rule.end }]) }).state;
    expect(contains(ruleSearch, rule)).toBe(false);
    expect(contains(ruleSearch.update({ selection: { anchor: 0 }, effects: setNotesSearchRanges.of([]) }).state, rule)).toBe(true);
  });

  it('maps a stale code widget click to its current block, edits source, and restores the widget after leaving', () => {
    const original = ['Intro', '```ts', 'const answer = 42;', '```', 'After'].join('\n');
    const token = parseLivePreviewTokens(original).find((item) => item.kind === 'code-block')!;
    const source = `Inserted before\n${original}`;
    const currentStart = source.indexOf('```ts');
    const propsRef = { current: { sourcePath: 'Perf.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) } as unknown as HTMLElement;
    const view = {
      state: initial,
      posAtDOM: (node: Node) => { expect(node).toBe(element); return currentStart; },
    } as unknown as Parameters<typeof codeBlockPositionAtClick>[0];

    const position = codeBlockPositionAtClick(view, element, token, 85, 20)!;
    expect(position).toBeGreaterThan(currentStart + token.raw.indexOf('\n'));
    expect(source[position]).toBe('4');
    const selected = initial.update({ selection: { anchor: position } }).state;
    const visible = (state: EditorState) => {
      const currentToken = parseLivePreviewTokens(state.doc.toString()).find((item) => item.kind === 'code-block')!;
      let found = false;
      state.field(field).decorations.between(0, state.doc.length, (from, to, decoration) => {
        if (decoration.spec.widget && from === currentToken.start && to === currentToken.end) found = true;
      });
      return found;
    };
    expect(visible(selected)).toBe(false);

    const edited = selected.update({ changes: { from: position, to: position, insert: 'X' }, selection: { anchor: position + 1 } }).state;
    expect(edited.doc.toString()).toContain('const answer = X42;');
    expect(visible(edited.update({ selection: { anchor: 0 } }).state)).toBe(true);
  });

  it('reuses parsed tokens and source text for selection-only updates', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({ doc: 'See [[Target]]', extensions: [notesSearchRangesField, field] });
    const original = initial.field(field);
    const selected = initial.update({ selection: { anchor: 2 } }).state.field(field);

    expect(selected.source).toBe(original.source);
    expect(selected.tokens).toBe(original.tokens);

    const changed = initial.update({ changes: { from: 0, to: 0, insert: 'Now ' } }).state.field(field);
    expect(changed.source).toBe('Now See [[Target]]');
    expect(changed.tokens).not.toBe(original.tokens);
  });

  it('updates a single ordinary row and maps untouched rows without changing parser output', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const source = [
      'before [[First]] #one',
      'See [[Target]] #topic **bold** $x$ and [label](Target.md)',
      'after `code` #last',
    ].join('\n');
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const changedLine = initial.doc.line(2);
    const changed = initial.update({ changes: { from: changedLine.from + 1, insert: 'x' } }).state;
    const value = changed.field(field);

    expect(value.tokens).toEqual(parseLivePreviewTokens(changed.doc.toString()));
    expect(value.tokens.map((token) => token.kind)).toContain('wiki-link');
    expect(value.tokens.map((token) => token.kind)).toContain('markdown-link');
    expect(value.tokens.map((token) => token.kind)).toContain('tag');
    expect(value.tokens.map((token) => token.kind)).toContain('strong');
    expect(value.tokens.map((token) => token.kind)).toContain('math-inline');
    expect(value.tokens.map((token) => token.kind)).toContain('inline-code');
  });

  it('reparses only stable heading and code-block owners while preserving other widgets', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({
      doc: ['See [[Before]]', '## Stable heading', 'text', '```ts', 'const answer = 42', '```', 'See [[After]]'].join('\n'),
      extensions: [notesSearchRangesField, field],
    });
    const widgetFor = (state: EditorState, predicate: (token: LivePreviewToken) => boolean) => {
      const token = state.field(field).tokens.find(predicate)!;
      let widget: unknown;
      state.field(field).decorations.between(token.start, token.end, (_from, _to, decoration) => {
        if (decoration.spec.widget) widget = decoration.spec.widget;
      });
      return widget;
    };
    const beforeLink = widgetFor(initial, (token) => token.kind === 'wiki-link' && token.raw === '[[Before]]');
    const afterLink = widgetFor(initial, (token) => token.kind === 'wiki-link' && token.raw === '[[After]]');
    const codeWidget = widgetFor(initial, (token) => token.kind === 'code-block');

    const headingLine = initial.doc.line(2);
    const headingEdit = initial.update({ changes: { from: headingLine.to, insert: ' updated' } }).state;
    expect(headingEdit.field(field).tokens).toEqual(parseLivePreviewTokens(headingEdit.doc.toString()));
    expect(widgetFor(headingEdit, (token) => token.kind === 'wiki-link' && token.raw === '[[Before]]')).toBe(beforeLink);
    expect(widgetFor(headingEdit, (token) => token.kind === 'wiki-link' && token.raw === '[[After]]')).toBe(afterLink);
    expect(widgetFor(headingEdit, (token) => token.kind === 'code-block')).toBe(codeWidget);

    const codeBody = headingEdit.doc.line(5);
    const codeEdit = headingEdit.update({ changes: { from: codeBody.to, insert: '!' } }).state;
    expect(codeEdit.field(field).tokens).toEqual(parseLivePreviewTokens(codeEdit.doc.toString()));
    expect(widgetFor(codeEdit, (token) => token.kind === 'wiki-link' && token.raw === '[[Before]]')).toBe(beforeLink);
    expect(widgetFor(codeEdit, (token) => token.kind === 'wiki-link' && token.raw === '[[After]]')).toBe(afterLink);
    expect(widgetFor(codeEdit, (token) => token.kind === 'code-block')).not.toBe(codeWidget);
    expect(codeEdit.field(field).tokens.filter((token) => token.kind === 'code-block')).toHaveLength(1);
    expect(codeEdit.field(field).tokens.some((token) => token.kind === 'wiki-link' && token.raw.includes('answer'))).toBe(false);
  });

  it('keeps fence delimiter edits on the conservative full-parse path', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({ doc: 'See [[Before]]\n```ts\nconst value = 1;\n```\nSee [[After]]', extensions: [notesSearchRangesField, field] });
    const before = initial.field(field).tokens.find((token) => token.kind === 'wiki-link' && token.raw === '[[Before]]')!;
    const getWidget = (state: EditorState) => {
      let widget: unknown;
      state.field(field).decorations.between(before.start, before.end, (_from, _to, decoration) => { widget = decoration.spec.widget; });
      return widget;
    };
    const initialWidget = getWidget(initial);
    const fence = initial.doc.line(2);
    const changed = initial.update({ changes: { from: fence.from, to: fence.from + 3, insert: '~~~' } }).state;
    expect(changed.field(field).tokens).toEqual(parseLivePreviewTokens(changed.doc.toString()));
    expect(getWidget(changed)).not.toBe(initialWidget);
    expect(changed.field(field).tokens.some((token) => token.kind === 'wiki-link' && token.raw === '[[After]]')).toBe(false);
  });

  it('incrementally updates inline widgets in a row adjacent to a fenced code block', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const source = [
      'before [[First]] #one',
      'See [[Target]] #topic **bold** $x$ and [label](Target.md)',
      '```ts',
      'const value = 1;',
      '```',
      'after [[Last]]',
    ].join('\n');
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const widgetFor = (state: EditorState, predicate: (token: LivePreviewToken) => boolean) => {
      const token = state.field(field).tokens.find(predicate)!;
      let widget: unknown;
      state.field(field).decorations.between(token.start, token.end, (_from, _to, decoration) => {
        if (decoration.spec.widget) widget = decoration.spec.widget;
      });
      return widget;
    };
    const firstLink = widgetFor(initial, (token) => token.kind === 'wiki-link' && token.raw === '[[First]]');
    const codeBlock = widgetFor(initial, (token) => token.kind === 'code-block');
    const changedLine = initial.doc.line(2);
    const codeToken = initial.field(field).tokens.find((token) => token.kind === 'code-block')!;
    expect(codeToken.start).toBe(changedLine.to + 1);

    const changed = initial.update({ changes: { from: changedLine.from + 1, insert: 'x' } }).state;
    const value = changed.field(field);
    expect(value.tokens).toEqual(parseLivePreviewTokens(changed.doc.toString()));
    expect(value.tokens.map((token) => token.kind)).toEqual(expect.arrayContaining(['wiki-link', 'tag', 'strong', 'math-inline', 'markdown-link']));
    expect(widgetFor(changed, (token) => token.kind === 'wiki-link' && token.raw === '[[First]]')).toBe(firstLink);
    expect(widgetFor(changed, (token) => token.kind === 'code-block')).toBe(codeBlock);
  });

  it('keeps caret and search source reveal correct after an ordinary-row update', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const source = 'before\nSee [[Target]] #topic\nafter';
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const initialLink = initial.field(field).tokens.find((token) => token.kind === 'wiki-link')!;
    const hasLinkWidget = (state: EditorState) => {
      const link = state.field(field).tokens.find((token) => token.kind === 'wiki-link')!;
      let found = false;
      state.field(field).decorations.between(link.start, link.end, (from, to, decoration) => {
        if (decoration.spec.widget && from === link.start && to === link.end) found = true;
      });
      return found;
    };
    const searched = initial.update({ effects: setNotesSearchRanges.of([{ start: initialLink.start + 2, end: initialLink.end - 2 }]) }).state;
    expect(hasLinkWidget(searched)).toBe(false);

    const changedLine = searched.doc.line(2);
    const changed = searched.update({ changes: { from: changedLine.from, insert: 'x' } }).state;
    expect(hasLinkWidget(changed)).toBe(false);

    const cleared = changed.update({ effects: setNotesSearchRanges.of([]) }).state;
    expect(hasLinkWidget(cleared)).toBe(true);
    const link = cleared.field(field).tokens.find((token) => token.kind === 'wiki-link')!;
    const caret = cleared.update({ selection: { anchor: link.start + 3 } }).state;
    expect(hasLinkWidget(caret)).toBe(false);
  });

  it('keeps block syntax isolated and reparses edits inside fenced code, math, tables, and callouts', () => {
    const propsRef = { current: { sourcePath: 'Home.md', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const source = [
      '```md',
      '[[fake]] #tag $x$ **bold**',
      '```',
      '$$',
      '[[fake]] #tag $x$ **bold**',
      '$$',
      '| A | B |',
      '| --- | --- |',
      '| [[fake]] | #tag |',
      '> [!tip] Notice',
      '> [[fake]] #tag $x$ **bold**',
      'after [[real]] #after',
    ].join('\n');
    const initial = EditorState.create({ doc: source, extensions: [notesSearchRangesField, field] });
    const blockKinds = new Set(['code-block', 'math-block', 'table', 'callout']);
    const blocks = initial.field(field).tokens.filter((token) => blockKinds.has(token.kind));
    expect(blocks.map((token) => token.kind)).toEqual(['code-block', 'math-block', 'table', 'callout']);
    for (const block of blocks) {
      expect(initial.field(field).tokens.filter((token) => token !== block && token.start >= block.start && token.end <= block.end)).toEqual([]);
    }

    let state = initial;
    for (const block of blocks) {
      const current = state.field(field).tokens.find((token) => token.kind === block.kind)!;
      const editAt = current.start + current.raw.indexOf('[[fake]]') + 2;
      state = state.update({ changes: { from: editAt, insert: 'x' } }).state;
      expect(state.field(field).tokens).toEqual(parseLivePreviewTokens(state.doc.toString()));
      expect(state.field(field).tokens.some((token) => token.kind === 'wiki-link' && token.raw.includes('fake'))).toBe(false);
    }
    expect(state.field(field).tokens.some((token) => token.kind === 'wiki-link' && token.raw.includes('real'))).toBe(true);
  });

  it('rebuilds embeds and rendered-link containers when the vault revision changes', () => {
    const propsRef = { current: { sourcePath: 'Home.md', linkResolutionKey: 'vault:1', contextKey: 'vault', trustedHtml: false, trustMermaid: false, onOpenLink: () => undefined, isCurrent: () => true } } as any;
    const field = createLivePreviewStateField(propsRef);
    const initial = EditorState.create({ doc: '![[Asset.png]]\n\n| A | B |\n| --- | --- |\n| [[Target]] | text |', selection: { anchor: 15 }, extensions: [notesSearchRangesField, field] });
    const widgets = (state: EditorState) => {
      const values: any[] = [];
      state.field(field).decorations.between(0, state.doc.length, (_from, _to, decoration) => {
        if (decoration.spec.widget) values.push(decoration.spec.widget);
      });
      return values;
    };
    const before = widgets(initial);
    propsRef.current.linkResolutionKey = 'vault:2';
    const after = widgets(initial.update({ effects: setNotesSearchRanges.of([]) }).state);

    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(after[0]!.eq(before[0]!)).toBe(false);
    expect(after[1]!.eq(before[1]!)).toBe(false);
  });
});

describe('live preview link resolution', () => {
  function linkElement() {
    const toggle = vi.fn();
    const attributes = new Map<string, string>();
    return {
      element: {
        isConnected: true,
        dataset: {} as Record<string, string>,
        classList: { toggle },
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      } as any,
      toggle,
      attributes,
    };
  }

  it('marks missing links and clears the marker when a vault revision resolves them', async () => {
    const { element, toggle, attributes } = linkElement();
    const resolver = async (_target: string, _source: string) => ({ path: null });
    await resolveLinkWidget(element, 'Future.md', 'Home.md', '/vault-a:1', resolver, () => true);
    expect(toggle).toHaveBeenLastCalledWith('is-unresolved', true);
    expect(attributes.get('aria-label')).toBe('未解析链接：Future.md');
    expect(attributes.get('aria-busy')).toBe('false');

    await resolveLinkWidget(element, 'Future.md', 'Home.md', '/vault-a:2', async () => ({ path: 'Future.md' }), () => true);
    expect(toggle).toHaveBeenLastCalledWith('is-unresolved', false);
    expect(attributes.get('aria-label')).toBe('打开链接：Future.md');
  });

  it('ignores stale resolution replies and never queries external URLs', async () => {
    const { element, toggle, attributes } = linkElement();
    let finishOld: ((value: { path: string | null }) => void) | undefined;
    const stale = resolveLinkWidget(element, 'Missing.md', 'Home.md', 'vault:1', () => new Promise((resolve) => { finishOld = resolve; }), () => true);
    await resolveLinkWidget(element, 'Missing.md', 'Home.md', 'vault:2', async () => ({ path: 'Missing.md' }), () => true);
    finishOld?.({ path: null });
    await stale;
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenLastCalledWith('is-unresolved', false);

    const external = linkElement();
    const resolver = vi.fn(async () => ({ path: null }));
    await resolveLinkWidget(external.element, 'https://example.test', 'Home.md', 'vault:2', resolver, () => true);
    expect(resolver).not.toHaveBeenCalled();
    expect(external.attributes.has('aria-busy')).toBe(false);
  });

  it('passes the requested link kind and strips subpaths before resolving', async () => {
    const { element } = linkElement();
    const resolver = vi.fn(async () => ({ path: 'Notes/Target.md' }));
    await resolveLinkWidget(element, 'Notes/Target.md#Heading', 'Home.md', 'vault:3', resolver, () => true, 'markdown');
    expect(resolver).toHaveBeenCalledWith('Notes/Target.md', 'Home.md', 'markdown');
  });
});
