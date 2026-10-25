import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { MarkdownNode, ParsedMarkdown, Span, MarkdownLink } from './types';

export const PARSER_VERSION = 'noltri-mdast-1';
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);
const span = (node: MarkdownNode): Span => ({ from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 });
const textOf = (node: MarkdownNode): string => node.value ?? (node.children ?? []).map(textOf).join('');
export const normalizeIdentity = (text: string): string => text.normalize('NFC').replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und');
export const normalizeHeading = (text: string): string => normalizeIdentity(text).replace(/[\p{P}\p{S}]/gu, '').trim();

function wikiLinks(text: string, offset: number, kind: MarkdownLink['kind'], propertyPath?: (string | number)[]): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of text.matchAll(/(!?)\[\[([^\]\n]*)\]\]/g)) {
    const body = match[2];
    const pipe = body.indexOf('|');
    const target = pipe < 0 ? body : body.slice(0, pipe);
    const from = offset + match.index;
    links.push({ kind, raw: match[0], target, from, to: from + match[0].length,
      targetFrom: from + match[1].length + 2, targetTo: from + match[1].length + 2 + target.length,
      embed: match[1] === '!', ...(pipe >= 0 ? { label: body.slice(pipe + 1) } : {}),
      ...(propertyPath ? { propertyPath } : {}),
    });
  }
  return links;
}

/** CommonMark/GFM owns syntax and positions; extensions only inspect eligible AST text/scalars. */
export function parseMarkdown(content: string, options: { tolerateInvalidFrontmatter?: boolean } = {}): ParsedMarkdown {
  const ast = parser.parse(content) as MarkdownNode;
  const result: ParsedMarkdown = { ast, headings: [], sections: [], links: [], tags: [], blocks: [], tasks: [], footnotes: [], properties: {}, aliases: [], excluded: [] };
  const definitions = new Map<string, MarkdownNode>();
  const collect = (node: MarkdownNode) => { if (node.type === 'definition' && node.identifier) definitions.set(normalizeIdentity(node.identifier), node); (node.children ?? []).forEach(collect); };
  collect(ast);
  const blocked = new Set(['code', 'inlineCode', 'html', 'yaml']);
  const blockTypes = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'code', 'table', 'thematicBreak']);
  const walk = (node: MarkdownNode): void => {
    const range = span(node);
    if (blockTypes.has(node.type)) {
      const raw = content.slice(range.from, range.to);
      const id = node.type !== 'code' ? /(?:^|\s)\^([\p{L}\p{N}_-]+)\s*$/u.exec(raw) : null;
      result.blocks.push({ ...range, type: node.type, text: textOf(node), ...(id ? { id: id[1], alias: id[1] } : {}) });
    }
    if (node.type === 'heading') result.headings.push({ ...range, depth: node.depth!, text: textOf(node).replace(/\s+\^[\p{L}\p{N}_-]+\s*$/u, ''), path: [], contentFrom: range.to, contentTo: content.length });
    if (node.type === 'listItem' && typeof node.checked === 'boolean') result.tasks.push({ ...range, checked: node.checked, text: textOf(node) });
    if (node.type === 'footnoteDefinition' || node.type === 'footnoteReference') result.footnotes.push({ ...range, id: node.identifier ?? '', definition: node.type === 'footnoteDefinition' });
    if (node.type === 'yaml') {
      const raw = content.slice(range.from, range.to);
      const opening = /^(?:\uFEFF)?---[^\S\n]*\r?\n/.exec(raw);
      const closing = /\r?\n(?:---|\.\.\.)[^\S\n]*$/.exec(raw);
      if (!opening || !closing) throw new Error('Invalid YAML frontmatter fences');
      const valueFrom = range.from + opening[0].length;
      const valueTo = range.from + closing.index + (/^\r\n/.test(closing[0]) ? 2 : 1);
      result.frontmatter = { ...range, valueFrom, valueTo };
      try {
      const doc = parseDocument(content.slice(valueFrom, valueTo), { keepSourceTokens: true });
      if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors[0].message}`);
      const value: unknown = doc.toJS({ maxAliasCount: 100 });
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Frontmatter must be a mapping');
      result.properties = (value ?? {}) as Record<string, unknown>;
      const scalars = (item: unknown, path: (string | number)[]): void => {
        if (isMap(item)) for (const pair of item.items) scalars(pair.value, [...path, String(isScalar(pair.key) ? pair.key.value : pair.key)]);
        else if (isSeq(item)) item.items.forEach((child, index) => scalars(child, [...path, index]));
        else if (isScalar(item) && item.range && typeof item.value === 'string') {
          const from = valueFrom + item.range[0];
          result.links.push(...wikiLinks(content.slice(from, valueFrom + item.range[1]), from, 'property', path));
          if (path[0] === 'tags') {
            for (const tag of item.value.split(/[,\s]+/u).filter(Boolean)) result.tags.push({ from, to: valueFrom + item.range[1], tag: tag.replace(/^#/, ''), property: true });
          }
        }
      };
      scalars(doc.contents, []);
      const aliases = result.properties['aliases'] ?? result.properties['alias'];
      result.aliases = typeof aliases === 'string' ? [aliases] : Array.isArray(aliases) ? aliases.filter((x): x is string => typeof x === 'string') : [];
      } catch (error) {
        if (!options.tolerateInvalidFrontmatter) throw error;
        result.frontmatterError = error instanceof Error ? error.message : String(error);
        result.properties = {}; result.aliases = [];
      }
    }
    if (blocked.has(node.type)) { result.excluded.push(range); return; }
    if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference' || node.type === 'imageReference') {
      const definition = node.identifier ? definitions.get(normalizeIdentity(node.identifier)) : undefined;
      const target = node.url ?? definition?.url;
      if (target !== undefined) {
        const sourceRange = definition ? span(definition) : range;
        const raw = content.slice(sourceRange.from, sourceRange.to);
        const position = definition ? raw.indexOf(']:') + 2 : raw.indexOf('](') + 2;
        const tail = raw.slice(position).trimStart();
        const targetFrom = sourceRange.from + position + (raw.slice(position).length - tail.length) + (tail.startsWith('<') ? 1 : 0);
        // The AST URL is decoded; raw syntax bounds remain authoritative for replacement.
        let end = 0, depth = 0, escaped = false;
        for (; end < tail.length; end++) {
          const char = tail[end];
          if (!escaped && (tail.startsWith('<') ? char === '>' : /\s/u.test(char) || (char === ')' && depth === 0))) break;
          if (!escaped && char === '(') depth++;
          if (!escaped && char === ')') depth--;
          escaped = !escaped && char === '\\';
        }
        const sourceTarget = tail.startsWith('<') ? tail.slice(1, end) : tail.slice(0, end);
        result.links.push({ ...range, kind: definition ? 'reference' : 'markdown', raw: content.slice(range.from, range.to), target,
          targetFrom, targetTo: targetFrom + sourceTarget.length, embed: node.type.startsWith('image'), label: textOf(node) });
      }
      result.excluded.push(range); return;
    }
    if (node.type === 'definition') { result.excluded.push(range); return; }
    if (node.type === 'text') {
      const raw = content.slice(range.from, range.to);
      const links = wikiLinks(raw, range.from, 'wiki');
      result.links.push(...links); result.excluded.push(...links.map(({ from, to }) => ({ from, to })));
      for (const tag of raw.matchAll(/(^|[^\p{L}\p{N}_/])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu)) {
        if (/^\d+$/u.test(tag[2])) continue;
        const from = range.from + tag.index + tag[1].length;
        if (!links.some((link) => from >= link.from && from < link.to)) result.tags.push({ from, to: from + tag[2].length + 1, tag: tag[2], property: false });
      }
    }
    (node.children ?? []).forEach(walk);
  };
  walk(ast);
  result.blocks = result.blocks.filter((block) => !block.alias || !result.blocks.some((outer) => outer !== block && outer.alias === block.alias && outer.to === block.to && outer.from < block.from));
  for (let index = 0; index < result.headings.length; index++) {
    const heading = result.headings[index];
    const ancestors = result.headings.slice(0, index).filter((candidate, prior, list) => candidate.depth < heading.depth && !list.slice(prior + 1).some((next) => next.depth <= candidate.depth));
    heading.path = [...ancestors.map((x) => x.text), heading.text];
    heading.contentTo = result.headings.slice(index + 1).find((next) => next.depth <= heading.depth)?.from ?? content.length;
  }
  result.sections = result.headings;
  result.links.sort((a, b) => a.from - b.from || a.to - b.to);
  result.excluded.sort((a, b) => a.from - b.from || a.to - b.to);
  return result;
}

/** Only plain text outside references, code and properties can become a new link. */
export function findUnlinkedMentions(content: string, names: readonly string[], metadata = parseMarkdown(content)): (Span & { name: string })[] {
  const result: (Span & { name: string })[] = [];
  const seen = new Set<string>();
  const segments = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(content)];
  let normalized = ''; const starts: number[] = []; const ends: number[] = [];
  for (const segment of segments) for (const character of segment.segment.normalize('NFC').replace(/\u00a0/g, ' ').toLocaleLowerCase('und')) {
    normalized += character; for (let i = 0; i < character.length; i++) { starts.push(segment.index); ends.push(segment.index + segment.segment.length); }
  }
  for (const name of names) {
    const needle = normalizeIdentity(name); if (!needle) continue;
    let offset = 0;
    while ((offset = normalized.indexOf(needle, offset)) >= 0) {
      const from = starts[offset], to = ends[offset + needle.length - 1];
      const before = content.slice(0, from).at(-1) ?? '', after = content.slice(to, to + 1);
      const word = /[\p{Script=Latin}\p{N}_]/u;
      const boundary = !(word.test(needle[0]) && word.test(before)) && !(word.test(needle.at(-1)!) && word.test(after));
      const key = `${from}:${to}`;
      if (boundary && !seen.has(key) && !metadata.excluded.some((span) => from < span.to && to > span.from)) { result.push({ from, to, name }); seen.add(key); }
      offset += Math.max(needle.length, 1);
    }
  }
  const ordered = result.sort((a, b) => a.from - b.from || b.to - a.to);
  return ordered.filter((match, index) => !ordered.slice(0, index).some((previous) => match.from < previous.to && match.to > previous.from));
}

/** Merge exact YAML keys, preserving unmentioned keys and the Markdown body byte-for-byte. */
export function setFrontmatterProperties(content: string, properties: Record<string, unknown>): string {
  const metadata = parseMarkdown(content);
  if (!metadata.frontmatter) return Object.keys(properties).length ? `---\n${stringify(properties)}---\n${content}` : content;
  const { valueFrom, valueTo } = metadata.frontmatter;
  const doc = parseDocument(content.slice(valueFrom, valueTo), { keepSourceTokens: true });
  for (const [key, value] of Object.entries(properties)) { if (value === undefined) doc.delete(key); else doc.set(key, value); }
  return content.slice(0, valueFrom) + doc.toString() + content.slice(valueTo);
}
