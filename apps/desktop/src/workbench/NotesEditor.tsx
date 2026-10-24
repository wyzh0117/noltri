import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import DOMPurify from 'dompurify';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import markdownKatex from 'markdown-it-katex';
import { extractSubpath, parseWikiLink, rangeIntersectsToken, safeNoteHref } from './notes-model';
import type { TextRange } from './notes-model';
import 'katex/dist/katex.min.css';

export interface NotesEditorProps {
  value: string;
  mode: 'live' | 'source';
  readOnly?: boolean;
  searchRanges?: readonly TextRange[];
  sourcePath?: string;
  trustedHtml?: boolean;
  trustMermaid?: boolean;
  linkResolutionKey?: string | number;
  onTrustMermaid?: () => void;
  onChange: (value: string) => void;
  onOpenLink: (target: string, sourcePath?: string, kind?: LinkKind) => void;
  onResolveLink?: (target: string, sourcePath: string, kind?: LinkKind) => Promise<{ path: string | null }>;
  onLoadNote?: (path: string) => Promise<{ content: string }>;
  onLoadAsset?: (path: string) => Promise<{ mimeType: string; dataUrl: string }>;
  onHoverLink?: (target: string, anchor: DOMRect, sourcePath?: string, kind?: LinkKind) => void;
  onLeaveLink?: () => void;
  onCursorChange?: (offset: number) => void;
}

export type LinkKind = 'wikilink' | 'markdown';

export type LivePreviewKind = 'heading' | 'inline-code' | 'wiki-link' | 'embed' | 'markdown-link' | 'image' | 'strong' | 'emphasis' | 'tag' | 'math-inline' | 'math-block' | 'table' | 'callout' | 'block-id' | 'code-block' | 'html-block' | 'horizontal-rule';

export function lineSeparatorForSource(source: string, fallback = '\n'): string {
  const separators = source.match(/\r\n|\r|\n/g) ?? [];
  if (separators.length === 0) return fallback;
  const first = separators[0]!;
  return separators.every((separator) => separator === first) ? first : '\n';
}

export function normalizeEditorDocument(source: string, lineSeparator: string): string {
  // ponytail: mixed-EOL files canonicalize to LF; preserving per-line separators needs a source map.
  return source.replace(/\r\n|\r|\n/g, lineSeparator);
}

export function sourceOffsetToEditorOffset(source: string, sourceOffset: number): number {
  const bounded = Math.max(0, Math.min(source.length, Math.trunc(sourceOffset)));
  return source.slice(0, bounded).replace(/\r\n/g, '\n').length;
}

export function sourceRangesToEditorRanges(source: string, ranges: readonly TextRange[]): TextRange[] {
  return ranges.map(({ start, end }) => ({
    start: sourceOffsetToEditorOffset(source, start),
    end: sourceOffsetToEditorOffset(source, end),
  }));
}

export function editorOffsetToSourceOffset(state: EditorState, editorOffset: number): number {
  const bounded = Math.max(0, Math.min(state.doc.length, Math.trunc(editorOffset)));
  const line = state.doc.lineAt(bounded);
  return bounded + (line.number - 1) * (state.lineBreak.length - 1);
}

export function serializeEditorDocument(state: EditorState): string {
  return state.sliceDoc();
}

export interface LivePreviewToken extends TextRange {
  kind: LivePreviewKind;
  raw: string;
  text: string;
  block?: boolean;
  language?: string;
  decorationStart?: number;
  decorationEnd?: number;
}

export const setNotesSearchRanges = StateEffect.define<readonly TextRange[]>();
export const notesSearchRangesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setNotesSearchRanges)) continue;
      const ranges: Range<Decoration>[] = effect.value
        .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= transaction.newDoc.length)
        .map((range) => Decoration.mark({ class: 'cm-search-hit' }).range(range.start, range.end));
      value = Decoration.set(ranges, true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const markdownRenderer = createMarkdownRenderer();
const refreshWidgets = StateEffect.define<void>();

function createMarkdownRenderer() {
  const md = new MarkdownIt({ html: false, breaks: false, linkify: false, typographer: false });
  md.use(markdownKatex as any, { throwOnError: false, trust: false });
  const escape = md.utils.escapeHtml;
  (md as any).inline.ruler.before('link', 'noltri_wikilink', (state: any, silent: boolean) => {
    const start = state.pos as number;
    const source = state.src as string;
    const embed = source.startsWith('![[', start);
    const open = embed ? start + 1 : start;
    if (!source.startsWith('[[', open)) return false;
    const close = source.indexOf(']]', open + 2);
    if (close < 0) return false;
    if (silent) return true;
    const raw = source.slice(open + 2, close);
    const [target = '', ...alias] = raw.split('|');
    const token = state.push(embed ? 'noltri_embed' : 'noltri_wikilink', embed ? 'div' : 'a', 0);
    token.meta = { target: target.trim(), label: alias.join('|').trim() || target.split('#')[0]?.split('/').at(-1) || target.trim() };
    token.content = token.meta.label;
    state.pos = close + 2;
    return true;
  });
  (md as any).renderer.rules.noltri_wikilink = (tokens: any[], index: number) => {
    const { target, label } = tokens[index]!.meta as { target: string; label: string };
    return `<a href="#" role="button" data-note-link="${escape(target)}" data-note-link-kind="wikilink">${escape(label)}</a>`;
  };
  (md as any).renderer.rules.noltri_embed = (tokens: any[], index: number) => {
    const { target, label } = tokens[index]!.meta as { target: string; label: string };
    return `<div class="cm-live-embed" data-note-embed="${escape(target)}">${escape(label)}</div>`;
  };
  (md as any).renderer.rules.image = (tokens: any[], index: number) => {
    const token = tokens[index]!;
    const source = token.attrGet('src') ?? '';
    if (safeNoteHref(source) === null || /^https?:/i.test(source)) return `<span class="cm-live-image-blocked">${escape(token.content || '已阻止外部图片')}</span>`;
    return `<span class="cm-live-image" data-note-image="${escape(source)}" data-note-image-kind="markdown" data-note-alt="${escape(token.content || '')}">${escape(token.content || source)}</span>`;
  };
  const originalLinkOpen = (md as any).renderer.rules.link_open;
  (md as any).renderer.rules.link_open = (tokens: any[], index: number, options: unknown, env: unknown, renderer: any) => {
    const target = tokens[index]!.attrGet('href') ?? '';
    if (safeNoteHref(target) === null) return '';
    tokens[index]!.attrSet('href', '#');
    tokens[index]!.attrSet('role', 'button');
    tokens[index]!.attrSet('data-note-link', target);
    tokens[index]!.attrSet('data-note-link-kind', 'markdown');
    return originalLinkOpen?.(tokens, index, options, env, renderer) ?? renderer.renderToken(tokens, index, options);
  };
  (md as any).core.ruler.after('inline', 'noltri_blockid', (state: any) => {
    for (let i = 0; i < state.tokens.length - 1; i += 1) {
      const block = state.tokens[i];
      const inline = state.tokens[i + 1];
      if (block.type !== 'paragraph_open' || inline.type !== 'inline') continue;
      const match = inline.content.match(/\s+\^([\p{L}\p{N}_-]+)\s*$/u);
      if (!match) continue;
      block.attrSet('data-block-id', match[1]);
      inline.content = inline.content.slice(0, match.index).trimEnd();
    }
  });
  return md;
}

function frontmatterEnd(source: string): number {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return 0;
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
  return match?.[0].length ?? 0;
}

function parseLivePreviewTokens(source: string): LivePreviewToken[] {
  const tokens: LivePreviewToken[] = [];
  const blocked: TextRange[] = [];
  const fmEnd = frontmatterEnd(source);
  if (fmEnd > 0) blocked.push({ start: 0, end: fmEnd });
  const lines = source.matchAll(/.*(?:\n|$)/g);
  const rows: Array<{ text: string; start: number; end: number; fullEnd: number }> = [];
  let offset = 0;
  for (const match of lines) {
    const full = match[0] ?? '';
    if (full === '') continue;
    const text = full.replace(/\r?\n$/, '');
    rows.push({ text, start: offset, end: offset + text.length, fullEnd: offset + full.length });
    offset += full.length;
  }
  const isBlocked = (range: TextRange) => blocked.some((item) => range.start < item.end && range.end > item.start);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.start < fmEnd || isBlocked({ start: row.start, end: Math.max(row.end, row.start + 1) })) continue;
    const htmlStart = /^\s*(?:<!--|<!doctype\b|<\?|<!\[CDATA\[|<\/?[a-z][\w:-]*(?:\s|\/?>))/iu.test(row.text);
    if (!htmlStart) continue;
    let endRow = i + 1;
    while (endRow < rows.length && rows[endRow]!.text.trim() !== '') endRow += 1;
    const end = rows[endRow - 1]!.fullEnd;
    tokens.push({ kind: 'html-block', start: row.start, end, raw: source.slice(row.start, end), text: source.slice(row.start, end), block: true });
    blocked.push({ start: row.start, end });
    i = endRow - 1;
  }
  const codeTokens: LivePreviewToken[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const opener = row.text.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (!opener || row.start < fmEnd || isBlocked({ start: row.start, end: Math.max(row.end, row.start + 1) })) continue;
    const marker = opener[1]!;
    let closeIndex = i + 1;
    for (; closeIndex < rows.length; closeIndex += 1) {
      const close = rows[closeIndex]!.text.match(/^\s*(`{3,}|~{3,})\s*$/u)?.[1];
      if (close && close[0] === marker[0] && close.length >= marker.length) break;
    }
    const closed = closeIndex < rows.length;
    const end = closed ? rows[closeIndex]!.fullEnd : source.length;
    const bodyEnd = closed ? rows[closeIndex]!.start : source.length;
    const rawLanguage = opener[2]!.trim().split(/\s+/)[0] ?? '';
    const language = /^[\w+-]{1,40}$/u.test(rawLanguage) ? rawLanguage.toLocaleLowerCase() : undefined;
    const text = source.slice(row.fullEnd, bodyEnd).replace(/\r?\n$/u, '');
    if (end > row.start) {
      codeTokens.push({ kind: 'code-block', start: row.start, end, raw: source.slice(row.start, end), text, language, block: true });
      blocked.push({ start: row.start, end });
    }
    i = closed ? closeIndex : rows.length;
  }
  tokens.push(...codeTokens);
  const add = (token: LivePreviewToken) => { if (token.end > token.start && !isBlocked(token)) tokens.push(token); };
  const inlineRangesByRow = new Map<number, TextRange[]>();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (isBlocked({ start: row.start, end: Math.max(row.end, row.start + 1) })) continue;
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/u.test(row.text)) {
      const end = row.fullEnd;
      add({ kind: 'horizontal-rule', start: row.start, end, raw: source.slice(row.start, end), text: '', block: true });
      blocked.push({ start: row.start, end });
      continue;
    }
    const callout = row.text.match(/^\s*>\s*\[!([\w-]+)\]([+-])?\s*(.*)$/u);
    if (callout) {
      let endRow = i + 1;
      while (endRow < rows.length && /^\s*>/.test(rows[endRow]!.text)) endRow += 1;
      const end = rows[endRow - 1]!.fullEnd;
      add({ kind: 'callout', start: row.start, end, raw: source.slice(row.start, end), text: source.slice(row.start, end), block: true });
      blocked.push({ start: row.start, end });
      i = endRow - 1;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(row.text)) {
      let endRow = i + 1;
      while (endRow < rows.length && !/^\s*\$\$\s*$/.test(rows[endRow]!.text)) endRow += 1;
      if (endRow < rows.length) {
        const end = rows[endRow]!.fullEnd;
        add({ kind: 'math-block', start: row.start, end, raw: source.slice(row.start, end), text: rows.slice(i + 1, endRow).map((item) => item.text).join('\n'), block: true });
        blocked.push({ start: row.start, end });
        i = endRow;
        continue;
      }
    }
    const singleLineMath = row.text.match(/^\s*\$\$(.+?)\$\$\s*$/u);
    if (singleLineMath) {
      add({ kind: 'math-block', start: row.start, end: row.end, raw: row.text, text: singleLineMath[1]!, block: true });
      blocked.push({ start: row.start, end: row.end });
      continue;
    }
    if (row.text.includes('|') && i + 1 < rows.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(rows[i + 1]!.text)) {
      let endRow = i + 2;
      while (endRow < rows.length && rows[endRow]!.text.includes('|') && rows[endRow]!.text.trim() !== '') endRow += 1;
      const end = rows[endRow - 1]!.fullEnd;
      add({ kind: 'table', start: row.start, end, raw: source.slice(row.start, end), text: source.slice(row.start, end), block: true });
      blocked.push({ start: row.start, end });
      i = endRow - 1;
      continue;
    }
    const embed = row.text.match(/^\s*(!\[\[[^\]]+\]\])\s*$/u);
    if (embed) {
      add({ kind: 'embed', start: row.start, end: row.end, raw: embed[1]!, text: embed[1]!, block: true });
      blocked.push({ start: row.start, end: row.end });
      continue;
    }
    const heading = row.text.match(/^\s*(#{1,6}\s+)/u);
    if (heading) {
      const token = { kind: 'heading' as const, start: row.start, end: row.end, decorationStart: row.start, decorationEnd: row.start + heading[0].length, raw: row.text, text: row.text.slice(heading[0].length) };
      add(token);
      const ranges = inlineRangesByRow.get(row.start) ?? [];
      ranges.push({ start: token.start, end: token.decorationEnd! });
      inlineRangesByRow.set(row.start, ranges);
    }
    const blockId = row.text.match(/\s+\^([\p{L}\p{N}_-]+)\s*$/u);
    if (blockId) {
      const start = row.start + (blockId.index ?? 0) + blockId[0].lastIndexOf('^');
      const token = { kind: 'block-id' as const, start, end: row.end, raw: source.slice(start, row.end), text: blockId[1]! };
      add(token);
      const ranges = inlineRangesByRow.get(row.start) ?? [];
      ranges.push(token);
      inlineRangesByRow.set(row.start, ranges);
    }
  }

  for (const row of rows) {
    if (row.end <= fmEnd || isBlocked({ start: row.start, end: Math.max(row.end, row.start + 1) })) continue;
    const inlineRanges = inlineRangesByRow.get(row.start) ?? [];
    const heading = row.text.match(/^\s*#{1,6}\s+/u);
    const contentStart = heading ? row.start + heading[0].length : row.start;
    const line = source.slice(contentStart, row.end);
    const patterns: Array<{ kind: LivePreviewKind; regex: RegExp; group?: number }> = [
      { kind: 'inline-code', regex: /(`+)([^`\n]+?)\1/g, group: 2 },
      { kind: 'image', regex: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, group: 1 },
      { kind: 'wiki-link', regex: /(?<!!)\[\[[^\]]+\]\]/g },
      { kind: 'embed', regex: /!\[\[[^\]]+\]\]/g },
      { kind: 'markdown-link', regex: /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, group: 1 },
      { kind: 'strong', regex: /(\*\*|__)(?=\S)(.+?\S?)\1/g, group: 2 },
      { kind: 'emphasis', regex: /(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)|(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/g, group: 1 },
      { kind: 'math-inline', regex: /(?<!\$)\$(?!\s)([^$\n]+?)\$(?!\$)/g, group: 1 },
      { kind: 'tag', regex: /(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu, group: 2 },
    ];
    for (const { kind, regex, group } of patterns) {
      for (const match of line.matchAll(regex)) {
        const localStart = match.index ?? 0;
        const raw = match[0] ?? '';
        const start = contentStart + localStart;
        const end = start + raw.length;
        if (inlineRanges.some((range) => start < range.end && end > range.start)) continue;
        let text = group === undefined ? raw : match[group] ?? raw;
        if (kind === 'wiki-link' || kind === 'embed') {
          const parsed = parseWikiLink(raw);
          if (!parsed) continue;
          text = parsed.alias;
        } else if (kind === 'markdown-link') {
          const target = match[2]?.trim() ?? '';
          if (safeNoteHref(target) === null) continue;
          text = match[1] ?? raw;
      } else if (kind === 'image') {
          text = match[1] ?? '';
      } else if (kind === 'emphasis') {
        text = match[1] ?? match[2] ?? raw;
        }
        const token = { kind, start, end, raw, text };
        add(token);
        inlineRanges.push(token);
      }
    }
  }

  return tokens.sort((a, b) => a.start - b.start || b.end - a.end);
}

interface WidgetProps {
  token: LivePreviewToken;
  sourcePath: string;
  linkResolutionKey: string | number;
  contextKey: string | number;
  canResolveLinks: boolean;
  trustedHtml: boolean;
  trustMermaid: boolean;
  onTrustMermaid?: () => void;
  onOpenLink: NotesEditorProps['onOpenLink'];
  onResolveLink: NotesEditorProps['onResolveLink'];
  onLoadNote: NotesEditorProps['onLoadNote'];
  onLoadAsset: NotesEditorProps['onLoadAsset'];
  onHoverLink: NotesEditorProps['onHoverLink'];
  onLeaveLink: NotesEditorProps['onLeaveLink'];
  isCurrent: () => boolean;
  isResolutionCurrent: () => boolean;
}

class LivePreviewWidget extends WidgetType {
  constructor(private readonly props: WidgetProps) { super(); }
  override eq(other: LivePreviewWidget): boolean {
    if (this.props.sourcePath !== other.props.sourcePath || this.props.contextKey !== other.props.contextKey
      || this.props.token.kind !== other.props.token.kind || this.props.token.raw !== other.props.token.raw) return false;
    if ((this.props.token.kind === 'wiki-link' || this.props.token.kind === 'markdown-link'
      || this.props.token.kind === 'embed' || this.props.token.kind === 'image'
      || this.props.token.kind === 'table' || this.props.token.kind === 'callout' || this.props.token.kind === 'html-block')
      && this.props.linkResolutionKey !== other.props.linkResolutionKey) return false;
    if (this.props.token.kind === 'html-block' && this.props.trustedHtml !== other.props.trustedHtml) return false;
    return this.props.token.kind !== 'code-block' || this.props.token.language !== 'mermaid'
      || this.props.trustMermaid === other.props.trustMermaid;
  }
  override ignoreEvent(): boolean { return true; }
  override toDOM(view: EditorView): HTMLElement {
    const { token } = this.props;
    const doc = view.dom.ownerDocument;
    const element = doc.createElement(token.block ? 'div' : 'span');
    element.className = `cm-live-${token.kind}`;
    if (token.kind === 'heading') {
      element.textContent = token.text;
      const level = token.raw.match(/^\s*(#{1,6})/)?.[1]?.length ?? 1;
      element.classList.add(`cm-live-heading-${level}`);
    } else if (token.kind === 'inline-code') {
      element.textContent = token.text;
      element.setAttribute('role', 'code');
    } else if (token.kind === 'wiki-link' || token.kind === 'markdown-link') {
      const linkKind: LinkKind = token.kind === 'wiki-link' ? 'wikilink' : 'markdown';
      const target = token.kind === 'wiki-link' ? parseWikiLink(token.raw)?.target ?? token.raw : token.raw.match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1] ?? token.raw;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cm-note-link';
      button.textContent = token.text;
      button.title = target;
      button.setAttribute('aria-label', `打开链接：${target}`);
      if (this.props.canResolveLinks && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target.trim())) {
        resolveLinkWidget(button, target, this.props.sourcePath, this.props.linkResolutionKey, this.props.onResolveLink, this.props.isResolutionCurrent, linkKind);
      }
      button.addEventListener('click', (event) => { event.preventDefault(); this.props.onOpenLink(target, this.props.sourcePath, linkKind); });
      button.addEventListener('pointerenter', () => this.props.onHoverLink?.(target, button.getBoundingClientRect(), this.props.sourcePath, linkKind));
      button.addEventListener('pointerleave', () => this.props.onLeaveLink?.());
      element.append(button);
    } else if (token.kind === 'tag') {
      element.textContent = `#${token.text}`;
      element.setAttribute('aria-label', `标签 ${token.text}`);
    } else if (token.kind === 'strong' || token.kind === 'emphasis') {
      const child = doc.createElement(token.kind === 'strong' ? 'strong' : 'em');
      child.textContent = token.text;
      element.append(child);
    } else if (token.kind === 'math-inline' || token.kind === 'math-block') {
      try { katex.render(token.text, element, { displayMode: token.kind === 'math-block', throwOnError: false, trust: false }); }
      catch { element.textContent = token.text; }
    } else if (token.kind === 'block-id') {
      element.textContent = `¶ ${token.text}`;
      element.setAttribute('aria-label', `段落块 ID ${token.text}`);
    } else if (token.kind === 'image') {
      const alt = token.text;
      const target = token.raw.match(/^!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)$/)?.[1] ?? '';
      element.setAttribute('aria-label', `图片：${alt || target}`);
      if (safeNoteHref(target) === null || /^https?:/i.test(target)) {
        element.textContent = '图片预览已阻止';
      } else {
        this.loadAsset(element, target, alt, this.props.sourcePath, 'markdown');
      }
    } else if (token.kind === 'embed') {
      const parsed = parseWikiLink(token.raw);
      if (parsed) {
        element.setAttribute('aria-label', `嵌入：${parsed.alias}`);
        this.loadEmbed(element, parsed.target, new Set([this.props.sourcePath]), 0);
      }
    } else if (token.kind === 'callout') {
      this.renderCallout(element, token.raw);
    } else if (token.kind === 'table') {
      this.appendMarkdown(element, token.raw, this.props.sourcePath);
    } else if (token.kind === 'code-block') {
      this.renderCodeBlock(element, token);
      element.addEventListener('click', (event) => {
        const mouseEvent = event as MouseEvent;
        const target = event.target;
        if (target instanceof Element && target.closest('button, a, input, select, textarea')) return;
        const position = codeBlockPositionAtClick(view, element, token, mouseEvent.clientX, mouseEvent.clientY);
        if (position === null) return;
        event.preventDefault();
        view.focus();
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      });
    } else if (token.kind === 'html-block') {
      this.renderHtmlBlock(element, token.raw);
    } else if (token.kind === 'horizontal-rule') {
      const rule = doc.createElement('hr');
      rule.setAttribute('role', 'separator');
      element.append(rule);
    }
    return element;
  }
  private renderCodeBlock(element: HTMLElement, token: LivePreviewToken): void {
    const doc = element.ownerDocument;
    if (token.language === 'mermaid') {
      if (this.props.trustMermaid) {
        void renderTrustedMermaid(element, token.text, this.props.isCurrent);
        return;
      }
      const notice = doc.createElement('div');
      notice.className = 'cm-live-security-notice';
      notice.setAttribute('role', 'note');
      notice.textContent = 'Mermaid 预览已关闭';
      const code = this.codeElement(doc, token);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cm-note-link';
      button.textContent = this.props.onTrustMermaid ? '信任此 Vault 并渲染 Mermaid' : '请在阅读视图中管理 Mermaid 信任';
      button.disabled = !this.props.onTrustMermaid;
      if (this.props.onTrustMermaid) button.addEventListener('click', () => this.props.onTrustMermaid?.());
      notice.append(button);
      element.append(notice, code);
      return;
    }
    element.append(this.codeElement(doc, token));
  }
  private codeElement(doc: Document, token: LivePreviewToken): HTMLElement {
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    if (token.language) code.classList.add(`language-${token.language}`);
    code.textContent = token.text;
    pre.append(code);
    return pre;
  }
  private renderHtmlBlock(element: HTMLElement, raw: string): void {
    if (!this.props.trustedHtml) {
      const notice = element.ownerDocument.createElement('strong');
      notice.className = 'cm-live-security-notice';
      notice.setAttribute('role', 'note');
      notice.textContent = 'HTML 预览已关闭';
      const pre = element.ownerDocument.createElement('pre');
      const code = element.ownerDocument.createElement('code');
      code.textContent = raw;
      pre.append(code);
      element.append(notice, pre);
      return;
    }
    const fragment = DOMPurify.sanitize(raw, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
    }) as DocumentFragment;
    for (const image of fragment.querySelectorAll<HTMLImageElement>('img[src]')) {
      const target = image.getAttribute('src')?.trim() ?? '';
      image.removeAttribute('src');
      if (target !== '' && safeNoteHref(target) !== null && !/^https?:/i.test(target)) {
        image.dataset.noteImage = target;
        image.dataset.noteAlt = image.alt;
      } else {
        image.classList.add('cm-live-image-blocked');
      }
    }
    element.append(fragment);
    for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', (event) => event.preventDefault());
    }
    this.hydrate(element, this.props.sourcePath, new Set([this.props.sourcePath]), 1);
  }
  private async resolve(target: string, from: string, kind: LinkKind): Promise<string | null> {
    const path = target.split('#', 1)[0]?.trim() ?? '';
    if (path === '') return from;
    return (await this.props.onResolveLink?.(path, from, kind))?.path ?? null;
  }
  private appendMarkdown(container: HTMLElement, source: string, sourcePath: string): void {
    const html = markdownRenderer.render(source, { sourcePath });
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
    container.append(fragment);
    this.hydrate(container, sourcePath, new Set([sourcePath]), 1);
  }
  private hydrate(container: HTMLElement, sourcePath: string, visited: Set<string>, depth: number): void {
    for (const link of container.querySelectorAll<HTMLElement>('[data-note-link]')) {
      const target = link.dataset.noteLink;
      if (!target) continue;
      const kind: LinkKind = link.dataset.noteLinkKind === 'wikilink' ? 'wikilink' : 'markdown';
      if (this.props.canResolveLinks) {
        resolveLinkWidget(link, target, sourcePath, this.props.linkResolutionKey, this.props.onResolveLink, this.props.isResolutionCurrent, kind);
      }
      link.addEventListener('click', (event) => { event.preventDefault(); this.props.onOpenLink(target, sourcePath, kind); });
      link.addEventListener('pointerenter', () => this.props.onHoverLink?.(target, link.getBoundingClientRect(), sourcePath, kind));
      link.addEventListener('pointerleave', () => this.props.onLeaveLink?.());
    }
    for (const image of container.querySelectorAll<HTMLElement>('[data-note-image]')) {
      const target = image.dataset.noteImage ?? '';
      const alt = image.dataset.noteAlt ?? '';
      if (safeNoteHref(target) === null || /^https?:/i.test(target)) { image.textContent = '已阻止外部图片'; continue; }
      void this.loadAsset(image, target, alt, sourcePath, image.dataset.noteImageKind === 'wikilink' ? 'wikilink' : 'markdown');
    }
    for (const embed of container.querySelectorAll<HTMLElement>('[data-note-embed]')) {
      const target = embed.dataset.noteEmbed;
      if (target && depth < 3) void this.loadEmbed(embed, target, visited, depth, sourcePath);
    }
  }
  private async loadAsset(element: HTMLElement, target: string, alt: string, from = this.props.sourcePath, kind: LinkKind = 'markdown'): Promise<void> {
    const resolved = await this.resolve(target, from, kind).catch(() => null);
    if (!resolved || !this.props.onLoadAsset || !element.isConnected || !this.props.isCurrent()) return;
    const asset = await this.props.onLoadAsset(resolved).catch(() => null);
    if (!asset || !element.isConnected || !this.props.isCurrent()) return;
    const doc = element.ownerDocument;
    if (asset.mimeType.startsWith('image/') && asset.mimeType !== 'image/svg+xml') {
      const image = doc.createElement('img');
      image.alt = alt;
      image.loading = 'lazy';
      image.src = asset.dataUrl;
      element.replaceChildren(image);
    } else if (asset.mimeType.startsWith('audio/')) {
      const audio = doc.createElement('audio');
      audio.controls = true;
      audio.src = asset.dataUrl;
      element.replaceChildren(audio);
    } else if (asset.mimeType.startsWith('video/')) {
      const video = doc.createElement('video');
      video.controls = true;
      video.src = asset.dataUrl;
      element.replaceChildren(video);
    } else {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cm-note-link';
      button.textContent = `打开附件：${resolved.split('/').at(-1) ?? resolved}`;
      button.addEventListener('click', () => this.props.onOpenLink(resolved, from, kind));
      element.replaceChildren(button);
    }
  }
  private async loadEmbed(element: HTMLElement, target: string, visited: Set<string>, depth: number, from = this.props.sourcePath): Promise<void> {
    if (!element.isConnected || !this.props.isCurrent()) return;
    const rawPath = target.split('#', 1)[0]?.trim() ?? '';
    const resolved = await this.resolve(target, from, 'wikilink').catch(() => null);
    if (!element.isConnected || !this.props.isCurrent()) return;
    if (!resolved || visited.has(resolved)) { if (element.isConnected) element.textContent = resolved ? '嵌入循环已停止' : '未找到嵌入目标'; return; }
    if (/\.(?:png|jpe?g|gif|webp|avif|bmp|mp3|wav|ogg|mp4|webm)$/i.test(resolved)) {
      await this.loadAsset(element, rawPath, '', from, 'wikilink');
      return;
    }
    if (!this.props.onLoadNote) { element.textContent = `嵌入：${resolved}`; return; }
    const note = await this.props.onLoadNote(resolved).catch(() => null);
    if (!note || !element.isConnected || !this.props.isCurrent()) { if (element.isConnected && this.props.isCurrent()) element.textContent = '无法载入嵌入笔记'; return; }
    const subpath = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    const selected = subpath ? extractSubpath(note.content, subpath) : note.content;
    const content = selected ?? note.content;
    element.classList.add('cm-live-embed-loaded');
    element.replaceChildren();
    const html = markdownRenderer.render(content, { sourcePath: resolved });
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
    element.append(fragment);
    const nextVisited = new Set(visited); nextVisited.add(resolved);
    this.hydrate(element, resolved, nextVisited, depth + 1);
  }
  private renderCallout(element: HTMLElement, raw: string): void {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const first = lines[0]?.match(/^\s*>\s*\[!([\w-]+)\]([+-])?\s*(.*)$/u);
    const type = first?.[1] ?? 'note';
    element.setAttribute('role', 'note');
    element.setAttribute('aria-label', `${type} callout`);
    element.dataset.callout = type.toLocaleLowerCase();
    const title = element.ownerDocument.createElement('strong');
    title.textContent = first?.[3] || type;
    element.append(title);
    this.appendMarkdown(element, lines.slice(1).map((line) => line.replace(/^\s*>\s?/, '')).join('\n'), this.props.sourcePath);
  }
}

export function codeBlockPositionAtClick(
  view: Pick<EditorView, 'posAtDOM' | 'state'>,
  element: HTMLElement,
  token: Pick<LivePreviewToken, 'raw' | 'text'>,
  clientX: number,
  clientY: number,
): number | null {
  let from: number;
  try { from = view.posAtDOM(element); }
  catch { return null; }
  const to = from + token.raw.length;
  if (from < 0 || to > view.state.doc.length || view.state.doc.sliceString(from, to) !== token.raw) return null;

  const bodyStart = token.raw.indexOf('\n') + 1;
  const lines = token.text.split('\n');
  const rect = element.getBoundingClientRect();
  const yRatio = Math.max(0, Math.min(0.999999, (clientY - rect.top) / Math.max(1, rect.height)));
  const lineIndex = Math.min(lines.length - 1, Math.floor(yRatio * lines.length));
  const lineText = lines[lineIndex] ?? '';
  const xRatio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const column = Math.round(lineText.length * xRatio);
  const bodyOffset = lines.slice(0, lineIndex).reduce((length, line) => length + line.length + 1, 0);
  return Math.max(from + 1, Math.min(to - 1, from + bodyStart + bodyOffset + column));
}

type LinkResolutionElement = Pick<HTMLButtonElement, 'isConnected' | 'dataset' | 'classList' | 'setAttribute'>;

export function resolveLinkWidget(
  element: LinkResolutionElement,
  target: string,
  sourcePath: string,
  resolutionKey: string | number,
  resolve: NotesEditorProps['onResolveLink'],
  isCurrent: () => boolean,
  kind: LinkKind = 'wikilink',
): Promise<void> {
  if (!resolve || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target.trim())) return Promise.resolve();
  const marker = `${resolutionKey}\u0000${sourcePath}\u0000${target}`;
  element.dataset.linkResolutionKey = marker;
  element.setAttribute('aria-busy', 'true');
  const apply = (resolved: boolean): void => {
    if (!element.isConnected || !isCurrent() || element.dataset.linkResolutionKey !== marker) return;
    element.classList.toggle('is-unresolved', !resolved);
    element.setAttribute('aria-busy', 'false');
    element.setAttribute('aria-label', `${resolved ? '打开链接' : '未解析链接'}：${target}`);
  };
  const targetPath = target.split('#', 1)[0]?.trim() || sourcePath;
  return resolve(targetPath, sourcePath, kind).then(({ path }) => apply(path !== null)).catch(() => apply(false));
}

type DecorationSet = ReturnType<typeof Decoration.set>;

let mermaidWidgetSequence = 0;

async function renderTrustedMermaid(element: HTMLElement, source: string, isCurrent: () => boolean): Promise<void> {
  try {
    const { default: mermaid } = await import('mermaid');
    if (!element.isConnected || !isCurrent()) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
    const { svg } = await mermaid.render(`noltri-live-mermaid-${++mermaidWidgetSequence}`, source);
    if (!element.isConnected || !isCurrent()) return;
    const fragment = DOMPurify.sanitize(svg, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject'],
      FORBID_ATTR: ['style'],
    }) as DocumentFragment;
    element.replaceChildren(fragment);
  } catch {
    if (!element.isConnected || !isCurrent()) return;
    const code = element.ownerDocument.createElement('pre');
    code.textContent = source;
    element.replaceChildren(code);
  }
}

interface LiveDecorationValue {
  decorations: DecorationSet;
  atomic: DecorationSet;
  tokens: LivePreviewToken[];
  source: string;
}

function mergeRevealRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function isRevealed(token: TextRange, ranges: readonly TextRange[]): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end < token.start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range !== undefined && rangeIntersectsToken(token, range);
}

function buildDecorations(state: EditorState, propsRef: { current: Omit<WidgetProps, 'token'> | null }, source = state.doc.toString(), tokens = parseLivePreviewTokens(source), visibleRange?: TextRange): LiveDecorationValue {
  const selection = state.selection.ranges.map((range) => ({ start: range.from, end: range.to }));
  const searches = state.field(notesSearchRangesField, false) ?? Decoration.none;
  const revealRanges: TextRange[] = [...selection];
  searches.between(visibleRange?.start ?? 0, visibleRange?.end ?? state.doc.length, (from, to, value) => { if (value.spec.class === 'cm-search-hit') revealRanges.push({ start: from, end: to }); });
  const mergedRevealRanges = mergeRevealRanges(revealRanges);
  const widgets: Range<Decoration>[] = [];
  const props = propsRef.current;
  if (props === null) return { decorations: Decoration.none, atomic: Decoration.none, tokens, source };
  const atomic: Range<Decoration>[] = [];
  for (const token of tokens) {
    if (isRevealed(token, mergedRevealRanges)) continue;
    if (token.kind === 'heading') {
      if (token.decorationEnd !== undefined && token.decorationEnd > token.decorationStart!) {
        widgets.push(Decoration.replace({}).range(token.decorationStart!, token.decorationEnd));
      }
      const level = token.raw.match(/^\s*(#{1,6})/)?.[1]?.length ?? 1;
      const start = token.decorationEnd ?? token.start;
      if (start < token.end) widgets.push(Decoration.mark({ class: `cm-live-heading-${level}` }).range(start, token.end));
      continue;
    }
    const widget = new LivePreviewWidget({ ...props, token });
    const deco = Decoration.replace({ widget, block: token.block ?? false });
    widgets.push(deco.range(token.start, token.end));
    if (token.kind === 'embed' || token.kind === 'image') atomic.push(deco.range(token.start, token.end));
  }
  return { decorations: Decoration.set(widgets, true), atomic: Decoration.set(atomic, true), tokens, source };
}

function headingPrefix(text: string): string | null {
  return text.match(/^\s*#{1,6}\s+/u)?.[0] ?? null;
}

function hasOtherStructuralSyntax(text: string): boolean {
  return /^\s*(?:`{3,}|~{3,})/u.test(text)
    || /^\s*(?:<!--|<!doctype\b|<\?|<!\[CDATA\[|<\/?[a-z][\w:-]*(?:\s|\/?>))/iu.test(text)
    || /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/u.test(text)
    || /^\s*>\s*\[!/u.test(text)
    || /\$\$/u.test(text)
    || text.includes('|')
    || /^\s*!\[\[[^\]]+\]\]\s*$/u.test(text)
    || /\s+\^[\p{L}\p{N}_-]+\s*$/u.test(text);
}

function isStructuralRow(text: string): boolean {
  return headingPrefix(text) !== null || hasOtherStructuralSyntax(text);
}

function addRanges(set: DecorationSet, from: number, to: number): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  set.between(from, to, (rangeFrom, rangeTo, value) => { ranges.push(value.range(rangeFrom, rangeTo)); });
  return ranges;
}

function updateOneLine(value: LiveDecorationValue, transaction: Transaction, propsRef: { current: Omit<WidgetProps, 'token'> | null }): LiveDecorationValue | null {
  // ponytail: only stable heading bodies, code bodies and ordinary single rows are incremental; structural/multi-row edits rescan the note.
  const fallback = (): null => null;
  let changed: { fromA: number; toA: number; fromB: number; toB: number } | null = null;
  let changedCount = 0;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    changedCount += 1;
    changed = { fromA, toA, fromB, toB };
  });
  if (changedCount !== 1 || changed === null) return fallback();

  const { fromA, toA, fromB, toB } = changed;
  const oldDoc = transaction.startState.doc;
  const newDoc = transaction.newDoc;
  const oldLine = oldDoc.lineAt(fromA);
  const oldEndLine = oldDoc.lineAt(toA);
  const newLine = newDoc.lineAt(fromB);
  const newEndLine = newDoc.lineAt(toB);
  if (oldLine.number !== oldEndLine.number || newLine.number !== newEndLine.number || oldLine.from === 0) return fallback();

  const oldLineEnd = oldLine.number < oldDoc.lines ? oldDoc.line(oldLine.number + 1).from : oldLine.to;
  const newLineEnd = newLine.number < newDoc.lines ? newDoc.line(newLine.number + 1).from : newLine.to;
  const oldText = oldDoc.sliceString(oldLine.from, oldLine.to);
  const newText = newDoc.sliceString(newLine.from, newLine.to);
  if (oldLine.from < frontmatterEnd(value.source)) return fallback();

  const blockOwner = value.tokens.find((token) => token.block && token.start < oldLineEnd && token.end > oldLine.from);
  let oldRange: TextRange = { start: oldLine.from, end: oldLineEnd };
  let range: TextRange = { start: newLine.from, end: newLineEnd };
  let localTokens: LivePreviewToken[];

  if (blockOwner !== undefined) {
    if (blockOwner.kind !== 'code-block') return fallback();
    const openerLine = oldDoc.lineAt(blockOwner.start);
    const lastBlockLine = oldDoc.lineAt(Math.max(blockOwner.start, blockOwner.end - 1));
    const opener = openerLine.text.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    const closer = lastBlockLine.text.match(/^\s*(`{3,}|~{3,})\s*$/u)?.[1];
    if (!opener || oldLine.number <= openerLine.number) return fallback();
    const closed = lastBlockLine.number > openerLine.number && closer !== undefined
      && closer[0] === opener[0] && closer.length >= opener.length;
    if ((closed && oldLine.number >= lastBlockLine.number)
      || /^\s*(`{3,}|~{3,})\s*$/u.test(newText)) return fallback();

    const mappedStart = transaction.changes.mapPos(blockOwner.start, -1);
    const mappedEnd = transaction.changes.mapPos(blockOwner.end, 1);
    const blockSource = newDoc.sliceString(mappedStart, mappedEnd);
    const parsedBlock = parseLivePreviewTokens(blockSource);
    if (parsedBlock.length !== 1 || parsedBlock[0]?.kind !== 'code-block'
      || parsedBlock[0].end !== blockSource.length || parsedBlock[0].language !== blockOwner.language) return fallback();
    oldRange = { start: blockOwner.start, end: blockOwner.end };
    range = { start: mappedStart, end: mappedEnd };
    localTokens = parsedBlock.map((token) => ({
      ...token,
      start: token.start + mappedStart,
      end: token.end + mappedStart,
      decorationStart: token.decorationStart === undefined ? undefined : token.decorationStart + mappedStart,
      decorationEnd: token.decorationEnd === undefined ? undefined : token.decorationEnd + mappedStart,
    }));
  } else {
    const oldHeadingPrefix = headingPrefix(oldText);
    const stableHeading = oldHeadingPrefix !== null && oldHeadingPrefix === headingPrefix(newText);
    if ((stableHeading
      ? hasOtherStructuralSyntax(oldText) || hasOtherStructuralSyntax(newText)
      : isStructuralRow(oldText) || isStructuralRow(newText))) return fallback();
    const lineSource = newDoc.sliceString(newLine.from, newLineEnd);
    localTokens = parseLivePreviewTokens(lineSource).map((token) => ({
      ...token,
      start: token.start + newLine.from,
      end: token.end + newLine.from,
      decorationStart: token.decorationStart === undefined ? undefined : token.decorationStart + newLine.from,
      decorationEnd: token.decorationEnd === undefined ? undefined : token.decorationEnd + newLine.from,
    }));
  }

  const before: LivePreviewToken[] = [];
  const after: LivePreviewToken[] = [];
  for (const token of value.tokens) {
    if (token.start < oldRange.end && token.end > oldRange.start) {
      if (blockOwner !== undefined && token !== blockOwner) return fallback();
      continue;
    }
    const mapped: LivePreviewToken = {
      ...token,
      start: transaction.changes.mapPos(token.start, 1),
      end: transaction.changes.mapPos(token.end, -1),
      decorationStart: token.decorationStart === undefined ? undefined : transaction.changes.mapPos(token.decorationStart, 1),
      decorationEnd: token.decorationEnd === undefined ? undefined : transaction.changes.mapPos(token.decorationEnd, -1),
    };
    if (mapped.end <= range.start) before.push(mapped);
    else after.push(mapped);
  }
  const source = newDoc.toString();
  const tokens = [...before, ...localTokens, ...after];
  const lineValue = buildDecorations(transaction.state, propsRef, source, localTokens, range);
  const decorations = value.decorations.map(transaction.changes).update({
    filter: (from, to) => !(from < range.end && to > range.start),
    filterFrom: range.start,
    filterTo: range.end,
    add: addRanges(lineValue.decorations, range.start, range.end),
  });
  const atomic = value.atomic.map(transaction.changes).update({
    filter: (from, to) => !(from < range.end && to > range.start),
    filterFrom: range.start,
    filterTo: range.end,
    add: addRanges(lineValue.atomic, range.start, range.end),
  });
  return {
    source,
    tokens,
    decorations,
    atomic,
  };
}

export function createLivePreviewStateField(propsRef: { current: Omit<WidgetProps, 'token'> | null }): StateField<LiveDecorationValue> {
  return StateField.define<LiveDecorationValue>({
    create(state) { return buildDecorations(state, propsRef); },
    update(value, transaction) {
      if (transaction.docChanged) {
        const partial = updateOneLine(value, transaction, propsRef);
        if (partial !== null) return partial;
        const source = transaction.newDoc.toString();
        const tokens = parseLivePreviewTokens(source);
        return buildDecorations(transaction.state, propsRef, source, tokens);
      }
      const rebuild = transaction.docChanged || transaction.selection !== undefined || transaction.effects.some((effect) => effect.is(refreshWidgets) || effect.is(setNotesSearchRanges));
      if (!rebuild) return value;
      const source = value.source;
      return buildDecorations(transaction.state, propsRef, source, value.tokens);
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ],
  });
}

function createLiveExtensions(enabled: boolean, field: StateField<LiveDecorationValue>): Extension {
  return enabled ? field : [];
}

function contextKeyForResolution(key: string | number): string | number {
  if (typeof key !== 'string') return key;
  return key.replace(/:\d+$/u, '');
}

export function NotesEditor({
  value, mode, readOnly = false, searchRanges = [], sourcePath = '', trustedHtml = false, trustMermaid = false, linkResolutionKey = '', onTrustMermaid, onChange, onOpenLink, onResolveLink, onLoadNote, onLoadAsset,
  onHoverLink, onLeaveLink, onCursorChange,
}: NotesEditorProps): ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastKnownValueRef = useRef(value);
  const lineSeparatorRef = useRef(lineSeparatorForSource(value));
  const sourcePathRef = useRef(sourcePath);
  const lineSeparatorCompartment = useRef(new Compartment()).current;
  const callbacksRef = useRef({ onChange, onOpenLink, onResolveLink, onLoadNote, onLoadAsset, onHoverLink, onLeaveLink, onCursorChange, onTrustMermaid, sourcePath, readOnly, linkResolutionKey });
  callbacksRef.current = { onChange, onOpenLink, onResolveLink, onLoadNote, onLoadAsset, onHoverLink, onLeaveLink, onCursorChange, onTrustMermaid, sourcePath, readOnly, linkResolutionKey };
  const widgetPropsRef = useRef<Omit<WidgetProps, 'token'> | null>(null);
  const livePreviewFieldRef = useRef<StateField<LiveDecorationValue> | null>(null);
  if (livePreviewFieldRef.current === null) livePreviewFieldRef.current = createLivePreviewStateField(widgetPropsRef);
  const livePreviewField = livePreviewFieldRef.current;
  widgetPropsRef.current = {
    sourcePath,
    trustedHtml,
    trustMermaid,
    onTrustMermaid: callbacksRef.current.onTrustMermaid === undefined ? undefined : () => callbacksRef.current.onTrustMermaid?.(),
    onOpenLink: (target, from, kind) => callbacksRef.current.onOpenLink(target, from, kind),
    onResolveLink: (target, from, kind) => callbacksRef.current.onResolveLink?.(target, from, kind) ?? Promise.resolve({ path: null }),
    canResolveLinks: callbacksRef.current.onResolveLink !== undefined,
    linkResolutionKey,
    contextKey: contextKeyForResolution(linkResolutionKey),
    onLoadNote: (path) => callbacksRef.current.onLoadNote?.(path) ?? Promise.resolve({ content: '' }),
    onLoadAsset: (path) => callbacksRef.current.onLoadAsset?.(path) ?? Promise.resolve({ mimeType: 'application/octet-stream', dataUrl: '' }),
    onHoverLink: (target, anchor, from, kind) => callbacksRef.current.onHoverLink?.(target, anchor, from, kind),
    onLeaveLink: () => callbacksRef.current.onLeaveLink?.(),
    isCurrent: () => callbacksRef.current.sourcePath === sourcePath && contextKeyForResolution(callbacksRef.current.linkResolutionKey) === contextKeyForResolution(linkResolutionKey),
    isResolutionCurrent: () => callbacksRef.current.sourcePath === sourcePath && callbacksRef.current.linkResolutionKey === linkResolutionKey,
  };
  const liveCompartment = useRef(new Compartment()).current;
  const readOnlyCompartment = useRef(new Compartment()).current;
  const liveModeRef = useRef(mode);

  useEffect(() => {
    if (!mountRef.current) return undefined;
    const state = EditorState.create({
      doc: normalizeEditorDocument(value, lineSeparatorRef.current),
      extensions: [
        lineSeparatorCompartment.of(EditorState.lineSeparator.of(lineSeparatorRef.current)),
        markdown(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), notesSearchRangesField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const source = serializeEditorDocument(update.state);
            lastKnownValueRef.current = source;
            if (!callbacksRef.current.readOnly) callbacksRef.current.onChange(source);
          }
          if (update.docChanged || update.selectionSet) callbacksRef.current.onCursorChange?.(editorOffsetToSourceOffset(update.state, update.state.selection.main.head));
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 笔记编辑器', spellcheck: 'false' }),
        EditorView.theme({
          '&': { height: '100%', minHeight: '0', backgroundColor: 'transparent', color: 'var(--ink)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.75' },
          '.cm-content': { padding: '20px clamp(16px, 3vw, 44px) 48px', caretColor: 'var(--green)', minHeight: '100%', fontSize: '13px' },
          '.cm-line': { padding: '0' },
          '.cm-focused': { outline: 'none' },
          '.cm-search-hit': { backgroundColor: 'color-mix(in srgb, #efd27a 56%, transparent)', borderRadius: '2px' },
          '.cm-note-link': { border: '0', padding: '0', background: 'transparent', color: 'var(--green)', font: 'inherit', textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, var(--green) 40%, transparent)', textUnderlineOffset: '3px', cursor: 'pointer' },
          '.cm-note-link.is-unresolved': { color: 'var(--danger, #b42318)', textDecorationStyle: 'dotted' },
          '.cm-live-heading-1': { fontSize: '1.8em', fontWeight: '600' },
          '.cm-live-heading-2': { fontSize: '1.5em', fontWeight: '600' },
          '.cm-live-heading-3': { fontSize: '1.25em', fontWeight: '600' },
          '.cm-live-inline-code': { padding: '0 .24em', borderRadius: '4px', backgroundColor: 'var(--green-pale)', fontFamily: 'ui-monospace, monospace' },
          '.cm-live-table': { display: 'block', overflowX: 'auto', margin: '8px 0' },
          '.cm-live-table table': { borderCollapse: 'collapse' },
          '.cm-live-table th, .cm-live-table td': { border: '1px solid var(--line)', padding: '4px 7px' },
          '.cm-live-code-block': { display: 'block', margin: '8px 0', padding: '10px 12px', overflowX: 'auto', backgroundColor: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: '5px' },
          '.cm-live-code-block pre': { margin: '0', whiteSpace: 'pre', fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '12px' },
          '.cm-live-code-block svg': { maxWidth: '100%', height: 'auto' },
          '.cm-live-html-block': { display: 'block', margin: '8px 0' },
          '.cm-live-security-notice': { display: 'block', marginBottom: '6px', color: 'var(--muted)', fontSize: '12px' },
          '.cm-live-horizontal-rule hr': { margin: '0', border: '0', borderTop: '1px solid var(--line)' },
          '.cm-live-callout': { display: 'block', margin: '8px 0', padding: '8px 12px', borderLeft: '3px solid var(--green)', backgroundColor: 'var(--canvas)', borderRadius: '4px' },
          '.cm-live-callout > strong': { display: 'block', marginBottom: '4px', color: 'var(--green-dark)' },
          '.cm-live-math-block': { display: 'block', padding: '7px 0', overflowX: 'auto' },
          '.cm-live-image img': { maxWidth: '100%', maxHeight: '440px', objectFit: 'contain' },
          '.cm-live-embed': { display: 'block', margin: '7px 0', padding: '8px 11px', backgroundColor: 'var(--canvas)', borderLeft: '2px solid var(--green)', borderRadius: '4px' },
          '.cm-live-block-id': { color: 'var(--muted)', fontSize: '.75em' },
          '.cm-live-math-inline': { display: 'inline-block', verticalAlign: 'middle' },
        }, { dark: false }),
        liveCompartment.of(createLiveExtensions(mode === 'live', livePreviewField)),
        readOnlyCompartment.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
        ]),
      ],
    });
    const view = new EditorView({ state, parent: mountRef.current });
    viewRef.current = view;
    view.dispatch({ effects: setNotesSearchRanges.of(sourceRangesToEditorRanges(value, searchRanges)) });
    return () => { viewRef.current = null; view.destroy(); };
  // The editor instance is deliberately stable; prop changes flow through the effects below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const sourceChanged = sourcePathRef.current !== sourcePath;
    const valueChanged = lastKnownValueRef.current !== value;
    if (!view || (!sourceChanged && !valueChanged)) return;

    const nextSeparator = lineSeparatorForSource(value, sourceChanged ? '\n' : lineSeparatorRef.current);
    sourcePathRef.current = sourcePath;
    if (nextSeparator !== lineSeparatorRef.current) {
      lineSeparatorRef.current = nextSeparator;
      view.dispatch({ effects: lineSeparatorCompartment.reconfigure(EditorState.lineSeparator.of(nextSeparator)) });
    }
    const normalized = normalizeEditorDocument(value, nextSeparator);
    if (view.state.sliceDoc() !== normalized) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalized } });
    lastKnownValueRef.current = value;
  }, [value, sourcePath, lineSeparatorCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setNotesSearchRanges.of(sourceRangesToEditorRanges(valueRef.current, searchRanges)) });
  }, [searchRanges]);

  useEffect(() => {
    if (liveModeRef.current === mode) return;
    liveModeRef.current = mode;
    viewRef.current?.dispatch({ effects: liveCompartment.reconfigure(createLiveExtensions(mode === 'live', livePreviewField)) });
  }, [mode, liveCompartment, livePreviewField]);

  useEffect(() => {
    if (mode === 'live') viewRef.current?.dispatch({ effects: refreshWidgets.of(undefined) });
  }, [mode, sourcePath, trustedHtml, trustMermaid, linkResolutionKey]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
    ]) });
  }, [readOnly, readOnlyCompartment]);

  return <div className="vault-live-editor" ref={mountRef} data-mode={mode} />;
}

export { parseLivePreviewTokens };
