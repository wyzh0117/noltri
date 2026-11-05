import MarkdownIt from 'markdown-it';
import markdownKatex from 'markdown-it-katex';

export interface NoteMindmapNode {
  id: string;
  title: string;
  level: number;
  sourceOffset: number;
  body: string;
  children: NoteMindmapNode[];
}

export interface NoteMindmapDocument {
  leadBody: string;
  roots: NoteMindmapNode[];
  isEmpty: boolean;
}

interface SourceLine {
  text: string;
  start: number;
  fullEnd: number;
}

interface MutableMindmapNode extends Omit<NoteMindmapNode, 'body' | 'children'> {
  bodyParts: string[];
  children: MutableMindmapNode[];
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1;
    let fullEnd = end;
    if (source[end] === '\r' && source[end + 1] === '\n') fullEnd += 2;
    else if (end < source.length) fullEnd += 1;
    lines.push({ text: source.slice(start, end), start, fullEnd });
    start = fullEnd;
  }
  return lines;
}

function frontmatterEndLine(lines: readonly SourceLine[]): number {
  if (lines[0]?.text !== '---') return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.text === '---' || lines[index]?.text === '...') return index + 1;
  }
  return 0;
}

function bodyText(parts: readonly string[]): string {
  return parts.join('').trim();
}

const markdownParser = new MarkdownIt({ html: false, breaks: false, linkify: false, typographer: false })
  .use(markdownKatex as any, { throwOnError: false, trust: false });

/** Build an ephemeral hierarchy from the current Markdown buffer; this never mutates or persists the source. */
export function buildNoteMindmap(source: string, path = ''): NoteMindmapDocument {
  const lines = sourceLines(source);
  const frontmatterEnd = frontmatterEndLine(lines);
  const markdownOffset = frontmatterEnd === 0 ? 0 : (lines[frontmatterEnd - 1]?.fullEnd ?? source.length);
  const markdownSource = source.slice(markdownOffset);
  const markdownLines = sourceLines(markdownSource);
  const tokens = markdownParser.parse(markdownSource, {});
  const headings: Array<{ title: string; level: number; sourceOffset: number; startLine: number; endLine: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type !== 'heading_open' || token.map === null) continue;
    const inline = tokens[index + 1];
    if (inline?.type !== 'inline') continue;
    headings.push({
      title: inline.content,
      level: Number(token.tag.slice(1)),
      sourceOffset: markdownOffset + (markdownLines[token.map[0] ?? -1]?.start ?? markdownSource.length),
      startLine: token.map[0] ?? 0,
      endLine: token.map[1] ?? 0,
    });
  }
  const roots: MutableMindmapNode[] = [];
  const stack: MutableMindmapNode[] = [];
  const leadParts: string[] = [];

  const appendBody = (startLine: number, endLine: number): void => {
    const start = markdownLines[startLine]?.start ?? markdownSource.length;
    const end = markdownLines[endLine]?.start ?? markdownSource.length;
    const body = markdownSource.slice(start, end);
    const target = stack.at(-1);
    if (body !== '') (target?.bodyParts ?? leadParts).push(body);
  };

  let cursorLine = 0;
  for (const heading of headings) {
    appendBody(cursorLine, heading.startLine);
    while (stack.at(-1) !== undefined && stack.at(-1)!.level >= heading.level) stack.pop();
    const node: MutableMindmapNode = {
      id: `${encodeURIComponent(path)}:${heading.sourceOffset}`,
      title: heading.title,
      level: heading.level,
      sourceOffset: heading.sourceOffset,
      bodyParts: [],
      children: [],
    };
    const parent = stack.at(-1);
    (parent?.children ?? roots).push(node);
    stack.push(node);
    cursorLine = heading.endLine;
  }
  appendBody(cursorLine, markdownLines.length);

  const freeze = (node: MutableMindmapNode): NoteMindmapNode => ({
    id: node.id,
    title: node.title,
    level: node.level,
    sourceOffset: node.sourceOffset,
    body: bodyText(node.bodyParts),
    children: node.children.map(freeze),
  });
  const leadBody = bodyText(leadParts);
  const frozenRoots = roots.map(freeze);
  return { leadBody, roots: frozenRoots, isEmpty: leadBody === '' && frozenRoots.length === 0 };
}
