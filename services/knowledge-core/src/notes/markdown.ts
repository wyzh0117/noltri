import { isMap, isScalar, isSeq, parseDocument, type Node, type Pair, type Scalar } from 'yaml';
import type { CachedNoteMetadata, NoteLink, NotePosition } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';

const WIKILINK = /(!?)\[\[([^\]]*)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TAG = /(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu;
const FENCE = /^\s*(```+|~~~+)/;

export interface ParsedMarkdown {
  metadata: CachedNoteMetadata;
  frontmatterRange: { start: number; end: number } | null;
  codeRanges: Array<{ start: number; end: number }>;
}

function positionOf(text: string, start: number, end: number): NotePosition {
  const point = (offset: number) => {
    const prefix = text.slice(0, offset);
    const line = (prefix.match(/\n/g)?.length ?? 0) + 1;
    return { line, col: offset - (prefix.lastIndexOf('\n') + 1) + 1, offset };
  };
  return { start: point(start), end: point(end) };
}

function headingSlug(value: string): string {
  return value.toLocaleLowerCase().normalize('NFC').replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
}

function plainValue(node: Node | null | undefined): unknown {
  if (node === null || node === undefined) return undefined;
  if (isScalar(node)) return node.value;
  if (isSeq(node)) return node.items.map((item) => plainValue(item as Node));
  if (isMap(node)) return Object.fromEntries(node.items.map((pair) => [String(plainValue(pair.key as Node)), plainValue(pair.value as Node)]));
  return undefined;
}

function frontmatter(content: string): { record?: Record<string, unknown>; start: number; end: number; raw: string; rawStart: number } | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
  if (!match) return null;
  const raw = match[1] ?? '';
  const doc = parseDocument(raw, { uniqueKeys: false });
  const rawStart = (match[0]?.startsWith('---\r\n') ? 5 : 4);
  if (doc.errors.length > 0) return { start: 0, end: match[0].length, raw, rawStart };
  const value = plainValue(doc.contents as Node | null);
  return {
    ...(value !== null && typeof value === 'object' && !Array.isArray(value) ? { record: value as Record<string, unknown> } : {}),
    start: 0,
    end: match[0].length,
    raw,
    rawStart,
  };
}

function childKey(pair: Pair, parent: string): string {
  const key = plainValue(pair.key as Node);
  return parent === '' ? String(key ?? '') : `${parent}.${String(key ?? '')}`;
}

function frontmatterLinkRefs(raw: string, bodyOffset: number, text: string): Array<{ key: string; link: string; original: string; displayText?: string; position: NotePosition }> {
  const doc = parseDocument(raw, { uniqueKeys: false });
  if (doc.errors.length > 0) return [];
  const output: Array<{ key: string; link: string; original: string; position: NotePosition }> = [];
  const visit = (node: Node | null, key: string): void => {
    if (node === null) return;
    if (isMap(node)) {
      for (const pair of node.items) visit(pair.value as Node | null, childKey(pair, key));
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node, key);
      return;
    }
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const value = node.value;
    const refs = [...value.matchAll(WIKILINK)];
    if (refs.length === 0) return;
    const range = node.range;
    if (range === null || range === undefined) return;
    for (const ref of refs) {
      const original = ref[0] ?? '';
      const inner = ref[2] ?? '';
      const [target = '', alias] = inner.split('|', 2);
      const link = target.split('#', 1)[0]?.trim() ?? '';
      const found = raw.indexOf(original, range[0]);
      const start = bodyOffset + (found < 0 ? range[0] : found);
      output.push({ key, link, original, ...(alias ? { displayText: alias } : {}), position: positionOf(text, start, start + original.length) });
    }
  };
  visit(doc.contents as Node | null, '');
  return output;
}

function frontmatterTags(raw: string, bodyOffset: number, text: string): Array<{ tag: string; position: NotePosition; field: 'frontmatter' }> {
  const doc = parseDocument(raw, { uniqueKeys: false });
  if (doc.errors.length > 0) return [];
  const output: Array<{ tag: string; position: NotePosition; field: 'frontmatter' }> = [];
  const visit = (node: Node | null, key: string): void => {
    if (node === null) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        const child = childKey(pair, key);
        visit(pair.value as Node | null, child);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node, key);
      return;
    }
    if (!isScalar(node) || typeof node.value !== 'string' || key.toLocaleLowerCase() !== 'tags' || node.range === null || node.range === undefined) return;
    const tag = node.value.trim().replace(/^#/, '');
    if (tag === '') return;
    output.push({ tag: `#${tag}`, position: positionOf(text, bodyOffset + node.range[0], bodyOffset + node.range[1]), field: 'frontmatter' });
  };
  visit(doc.contents as Node | null, '');
  return output;
}

function inlineRefs(body: string, baseOffset: number, fullText: string, kind: NoteLink['kind']): NoteLink[] {
  const refs: NoteLink[] = [];
  const add = (match: RegExpExecArray, syntax: 'wiki' | 'markdown') => {
    const original = match[0] ?? '';
    const embed = (match[1] ?? '') === '!';
    const inside = syntax === 'wiki' ? match[2] ?? '' : match[3] ?? '';
    const [rawPath = '', ...subpathParts] = inside.split('#');
    const beforeAlias = rawPath.split('|');
    const link = beforeAlias[0]?.trim() ?? '';
    const displayText = syntax === 'wiki' ? beforeAlias[1] : match[2];
    refs.push({
      link: subpathParts.length > 0 ? `${link}#${subpathParts.join('#')}` : link,
      original,
      ...(displayText ? { displayText } : {}),
      position: positionOf(fullText, baseOffset + (match.index ?? 0), baseOffset + (match.index ?? 0) + original.length),
      ...(embed ? { isEmbed: true } : {}),
      kind: syntax === 'markdown' ? 'markdown' : kind,
    });
  };
  for (const match of body.matchAll(WIKILINK)) add(match as RegExpExecArray, 'wiki');
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const href = match[3] ?? '';
    if (/^(?:https?:|mailto:|data:|#)/i.test(href)) continue;
    add(match as RegExpExecArray, 'markdown');
  }
  return refs.sort((a, b) => a.position.start.offset - b.position.start.offset);
}

function maskedCodeRanges(content: string, frontmatterEnd: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: string | null = null;
  let offset = frontmatterEnd;
  for (const line of content.slice(frontmatterEnd).matchAll(/.*(?:\n|$)/g)) {
    const value = line[0] ?? '';
    if (value.length === 0) continue;
    const marker = FENCE.exec(value)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0]) fence = null;
      ranges.push({ start: offset, end: offset + value.length });
    } else if (fence !== null) ranges.push({ start: offset, end: offset + value.length });
    offset += value.length;
  }
  for (const match of content.matchAll(/`+[^`\n]+`+/g)) {
    const start = match.index ?? 0;
    if (start < frontmatterEnd || ranges.some((range) => start < range.end && start + match[0].length > range.start)) continue;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function inRanges(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const fm = frontmatter(content);
  const bodyOffset = fm?.end ?? 0;
  const body = content.slice(bodyOffset);
  const codeRanges = maskedCodeRanges(content, bodyOffset);
  const bodyLinks = inlineRefs(body, bodyOffset, content, 'wikilink').filter((link) => !inRanges(link.position.start.offset, link.position.end.offset, codeRanges));
  const frontmatterLinks = fm === null ? [] : frontmatterLinkRefs(fm.raw, fm.rawStart, content);
  const headings: Array<{ heading: string; level: number; position: NotePosition }> = [];
  const sections: Array<{ type: string; position: NotePosition; id?: string }> = [];
  const listItems: Array<{ position: NotePosition; parent: number; task?: string; id?: string }> = [];
  const blocks: Record<string, { id: string; position: NotePosition }> = {};
  const footnotes: Record<string, { id: string; position: NotePosition }> = {};
  const footnoteRefs: Array<{ id: string; position: NotePosition }> = [];
  const referenceLinks: Record<string, { link: string; original: string; position: NotePosition }> = {};
  let cursor = bodyOffset;
  for (const lineMatch of body.matchAll(/.*(?:\n|$)/g)) {
    const line = lineMatch[0] ?? '';
    if (line.length === 0) continue;
    const start = cursor;
    const end = start + line.replace(/\r?\n$/, '').length;
    if (!inRanges(start, end, codeRanges)) {
      const heading = HEADING.exec(line.trimEnd());
      if (heading !== null) {
        const value = (heading[2] ?? '').replace(/\s+#+\s*$/, '').trim();
        const position = positionOf(content, start, end);
        headings.push({ heading: value, level: heading[1]?.length ?? 1, position });
        sections.push({ type: 'heading', position });
      } else if (line.trim() !== '') {
        sections.push({ type: /^\s*[-*+]\s+/.test(line) ? 'list' : 'paragraph', position: positionOf(content, start, end) });
      }
      const listItem = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*?)(?:\s+\^([A-Za-z0-9-]+))?\s*$/.exec(line.trimEnd());
      if (listItem !== null) {
        listItems.push({
          position: positionOf(content, start, end),
          parent: (listItem[1] ?? '').length,
          ...(listItem[2] === undefined ? {} : { task: listItem[2].toLowerCase() === 'x' ? 'done' : 'todo' }),
          ...(listItem[4] === undefined ? {} : { id: listItem[4] }),
        });
      }
      const block = /\^([A-Za-z0-9-]+)\s*$/.exec(line.trimEnd());
      if (block !== null) blocks[block[1] ?? ''] = { id: block[1] ?? '', position: positionOf(content, start, end) };
      const footnote = /^\s*\[\^([^\]]+)\]:\s*/.exec(line);
      if (footnote !== null) footnotes[footnote[1] ?? ''] = { id: footnote[1] ?? '', position: positionOf(content, start, end) };
      const reference = footnote === null ? /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(line) : null;
      if (reference !== null) referenceLinks[(reference[1] ?? '').toLocaleLowerCase()] = { link: reference[2] ?? '', original: reference[0], position: positionOf(content, start, end) };
      for (const ref of line.matchAll(/\[\^([^\]]+)\]/g)) {
        const refStart = start + (ref.index ?? 0);
        if (footnote !== null && footnote[1] === ref[1]) continue;
        footnoteRefs.push({ id: ref[1] ?? '', position: positionOf(content, refStart, refStart + (ref[0]?.length ?? 0)) });
      }
    }
    cursor += line.length;
  }
  const tags: Array<{ tag: string; position: NotePosition; field?: 'content' | 'frontmatter' }> = fm === null ? [] : frontmatterTags(fm.raw, fm.rawStart, content);
  for (const match of body.matchAll(TAG)) {
    const start = bodyOffset + (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = start + (match[2]?.length ?? 0) + 1;
    if (!inRanges(start, end, codeRanges)) tags.push({ tag: `#${match[2] ?? ''}`, position: positionOf(content, start, end), field: 'content' });
  }
  const allLinks = [...bodyLinks, ...frontmatterLinks.map((link) => ({
    link: link.link,
    original: link.original,
    ...(link.displayText === undefined ? {} : { displayText: link.displayText }),
    position: link.position,
    kind: 'frontmatter' as const,
  }))];
  const metadata: CachedNoteMetadata = {
    ...(fm?.record === undefined ? {} : { frontmatter: fm.record }),
    ...(fm === null ? {} : { frontmatterPosition: positionOf(content, fm.start, fm.end) }),
    ...(frontmatterLinks.length > 0 ? { frontmatterLinks } : {}),
    ...(allLinks.length > 0 ? { links: allLinks, embeds: allLinks.filter((link) => 'isEmbed' in link && link.isEmbed) } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(headings.length > 0 ? { headings } : {}),
    ...(sections.length > 0 ? { sections } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
    ...(Object.keys(blocks).length > 0 ? { blocks } : {}),
    ...(Object.keys(footnotes).length > 0 ? { footnotes } : {}),
    ...(footnoteRefs.length > 0 ? { footnoteRefs } : {}),
    ...(Object.keys(referenceLinks).length > 0 ? { referenceLinks } : {}),
  };
  return { metadata, frontmatterRange: fm === null ? null : { start: fm.start, end: fm.end }, codeRanges };
}

export function stripHeading(value: string): string {
  return headingSlug(value);
}

export function resolveSubpath(content: string, metadata: CachedNoteMetadata, subpath: string): NotePosition | null {
  const decode = (value: string): string => {
    try { return decodeURIComponent(value); }
    catch { return value; }
  };
  const decoded = decode(subpath);
  if (decoded.startsWith('^')) {
    const id = decoded.slice(1).toLocaleLowerCase();
    const block = metadata.blocks?.[id];
    return block?.position ?? Object.values(metadata.blocks ?? {}).find((candidate) => candidate.id.toLocaleLowerCase() === id)?.position ?? null;
  }
  // Split before decoding so an encoded `#` remains part of one heading slug.
  const parts = subpath.split('#').filter(Boolean).map(decode).map(stripHeading);
  if (parts.length === 0) return null;
  const headings = metadata.headings ?? [];
  let previous = -1;
  let previousLevel = 0;
  for (const part of parts) {
    let index = -1;
    for (let cursor = previous + 1; cursor < headings.length; cursor += 1) {
      const heading = headings[cursor]!;
      if (previous >= 0 && heading.level <= previousLevel) break;
      if (stripHeading(heading.heading) === part && (previous < 0 || heading.level > previousLevel)) { index = cursor; break; }
    }
    if (index < 0) return null;
    previous = index;
    previousLevel = headings[index]?.level ?? previousLevel;
  }
  const found = headings[previous];
  return found?.position ?? null;
}

/** Rewrites only wikilink/Markdown link targets while retaining aliases and display text. */
export function rewriteLinkOccurrences(content: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let output = content;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    if (replacement.start < 0 || replacement.end > output.length || replacement.start > replacement.end) {
      throw knowledgeError('invalid_request', '链接位置已失效，拒绝写回');
    }
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

export function rewriteYamlLinks(content: string, transform: (key: string, value: string) => string): string {
  const fm = frontmatter(content);
  if (fm === null) return content;
  const doc = parseDocument(fm.raw, { uniqueKeys: false });
  if (doc.errors.length > 0) throw knowledgeError('invalid_request', 'Frontmatter YAML 无法解析；请先修复语法再重命名');
  const visit = (node: Node | null, parentKey: string): void => {
    if (node === null) return;
    if (isMap(node)) {
      for (const pair of node.items) visit(pair.value as Node | null, childKey(pair, parentKey));
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node, parentKey);
      return;
    }
    if (isScalar(node) && typeof node.value === 'string' && node.value.includes('[[') && node.value.includes(']]')) {
      node.value = transform(parentKey, node.value) as Scalar['value'];
    }
  };
  visit(doc.contents as Node | null, '');
  const serialized = doc.toString({ lineWidth: 0 }).trimEnd();
  const lineEnding = content.slice(0, fm.end).includes('\r\n') ? '\r\n' : '\n';
  return `---${lineEnding}${serialized.replace(/\r?\n/g, lineEnding)}${lineEnding}---${content.slice(fm.end)}`;
}

export function parseFrontmatterValue(content: string): Record<string, unknown> {
  return frontmatter(content)?.record ?? {};
}
