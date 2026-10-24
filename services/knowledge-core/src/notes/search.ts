import type { CachedNoteMetadata } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';

export interface SearchFile {
  path: string;
  title: string;
  content: string;
  metadata: CachedNoteMetadata;
}
export interface SearchHit {
  path: string;
  title: string;
  score: number;
  matches: Array<{ start: number; end: number; field: 'content' | 'path' | 'frontmatter' }>;
  snippet: string;
  titleMatches: Array<{ start: number; end: number }>;
  snippetMatches: Array<{ start: number; end: number }>;
  matchedTags: string[];
}

type Token = { kind: 'term' | 'or' | 'not' | 'left' | 'right'; value: string };
type Expr = { kind: 'term'; value: string } | { kind: 'not'; child: Expr } | { kind: 'and' | 'or'; children: Expr[] };

function tokenizeQuery(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i] ?? '')) { i += 1; continue; }
    const char = query[i];
    if (char === '(' || char === ')') { tokens.push({ kind: char === '(' ? 'left' : 'right', value: char }); i += 1; continue; }
    if (char === '|') { tokens.push({ kind: 'or', value: char }); i += 1; continue; }
    if (char === '-') { tokens.push({ kind: 'not', value: char }); i += 1; continue; }
    if (char === '"' || char === '[' || char === '/') {
      const close = char === '"' ? '"' : char === '[' ? ']' : '/';
      let j = i + 1;
      let escaped = false;
      while (j < query.length) {
        const current = query[j];
        if (!escaped && current === close) break;
        if (!escaped && current === '\\') escaped = true;
        else escaped = false;
        j += 1;
      }
      if (j === query.length) throw knowledgeError('invalid_request', `搜索查询中缺少 ${close}`);
      let value = query.slice(i, j + 1);
      if (char === '/' && /^[gimyusd]*$/.test(query.slice(j + 1).match(/^[a-z]*/i)?.[0] ?? '')) {
        const flags = query.slice(j + 1).match(/^[a-z]*/i)?.[0] ?? '';
        value += flags;
        j += flags.length;
      }
      tokens.push({ kind: 'term', value });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < query.length && !/\s|[()|]/.test(query[j] ?? '')) j += 1;
    const value = query.slice(i, j);
    const upper = value.toLocaleUpperCase();
    tokens.push({ kind: upper === 'OR' ? 'or' : upper === 'NOT' ? 'not' : 'term', value });
    i = j;
  }
  return tokens;
}

function parseQuery(tokens: Token[]): Expr {
  let cursor = 0;
  const parseAtom = (): Expr => {
    const token = tokens[cursor];
    if (token?.kind === 'not') { cursor += 1; return { kind: 'not', child: parseAtom() }; }
    if (token?.kind === 'left') {
      cursor += 1;
      const nested = parseOr();
      if (tokens[cursor]?.kind !== 'right') throw knowledgeError('invalid_request', '搜索查询括号不匹配');
      cursor += 1;
      return nested;
    }
    if (token?.kind !== 'term') throw knowledgeError('invalid_request', '搜索查询缺少词项');
    cursor += 1;
    return { kind: 'term', value: token.value };
  };
  const parseAnd = (): Expr => {
    const children: Expr[] = [];
    while (cursor < tokens.length && tokens[cursor]?.kind !== 'or' && tokens[cursor]?.kind !== 'right') children.push(parseAtom());
    if (children.length === 0) throw knowledgeError('invalid_request', '搜索查询 OR 两侧都需要词项');
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  };
  const parseOr = (): Expr => {
    const children = [parseAnd()];
    while (tokens[cursor]?.kind === 'or') { cursor += 1; children.push(parseAnd()); }
    return children.length === 1 ? children[0]! : { kind: 'or', children };
  };
  if (tokens.length === 0) return { kind: 'term', value: 'TRUE' };
  const tree = parseOr();
  if (cursor !== tokens.length) throw knowledgeError('invalid_request', '搜索查询括号不匹配');
  return tree;
}

function frontmatterValue(metadata: CachedNoteMetadata, key: string): unknown {
  let value: unknown = metadata.frontmatter;
  for (const part of key.split('.')) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}

function allOccurrences(text: string, needle: string, caseSensitive = false, field: 'content' | 'path' | 'frontmatter' = 'content'): Array<{ start: number; end: number; field: 'content' | 'path' | 'frontmatter' }> {
  if (needle === '') return [];
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const query = caseSensitive ? needle : needle.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number; field: 'content' | 'path' | 'frontmatter' }> = [];
  let offset = 0;
  while (offset <= source.length - query.length) {
    const found = source.indexOf(query, offset);
    if (found < 0) break;
    matches.push({ start: found, end: found + query.length, field });
    offset = found + Math.max(query.length, 1);
  }
  return matches;
}

interface Evaluation { matched: boolean; positions: Array<{ start: number; end: number; field: 'content' | 'path' | 'frontmatter' }>; score: number; tags?: string[] }
const EXCLUSIVE = new Set(['path', 'file', 'content', 'line', 'block', 'section', 'task', 'task-todo', 'task-done']);
const REGEX_CACHE_TTL_MS = 60_000;
const REGEX_CACHE_LIMIT = 256;
const regexCache = new Map<string, { matcher: RegExp; expiresAt: number }>();

function cachedRegex(source: string, flags: string): RegExp {
  const normalizedFlags = flags.includes('g') ? flags : `${flags}g`;
  const key = `${source}\u0000${normalizedFlags}`;
  const now = Date.now();
  const cached = regexCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    regexCache.delete(key);
    regexCache.set(key, { ...cached, expiresAt: now + REGEX_CACHE_TTL_MS });
    return cached.matcher;
  }
  if (cached !== undefined) regexCache.delete(key);
  let matcher: RegExp;
  try { matcher = new RegExp(source, normalizedFlags); }
  catch { throw knowledgeError('invalid_request', '搜索正则表达式无效'); }
  regexCache.set(key, { matcher, expiresAt: now + REGEX_CACHE_TTL_MS });
  while (regexCache.size > REGEX_CACHE_LIMIT) regexCache.delete(regexCache.keys().next().value as string);
  return matcher;
}

function compileQuery(query: string): { expression: Expr; caseSensitive: boolean } {
  const modifiers = [...query.matchAll(/(?:^|\s)(match-case|ignore-case):(?=\s|$)/gi)];
  let caseSensitive = false;
  for (const modifier of modifiers) caseSensitive = modifier[1]?.toLocaleLowerCase() === 'match-case';
  const expression = parseQuery(tokenizeQuery(query.replace(/(?:^|\s)(?:match-case|ignore-case):(?=\s|$)/gi, ' ')));
  return { expression, caseSensitive };
}

function evalTerm(raw: string, file: SearchFile, defaultCaseSensitive: boolean): Evaluation {
  if (/^\/.*\/[a-z]*$/i.test(raw)) {
    const last = raw.lastIndexOf('/');
    const matcher = cachedRegex(raw.slice(1, last), raw.slice(last + 1));
    matcher.lastIndex = 0;
    const positions: Evaluation['positions'] = [];
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(file.content)) !== null) {
      positions.push({ start: match.index, end: match.index + match[0].length, field: 'content' });
      if (match[0] === '') {
        const next = file.content.codePointAt(matcher.lastIndex);
        matcher.lastIndex += matcher.unicode && next !== undefined && next > 0xffff ? 2 : 1;
      }
    }
    return { matched: positions.length > 0, positions, score: positions.length };
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const clause = raw.slice(1, -1);
    const match = /^([^:<>!=]+)(>=|<=|!=|=|>|<|:)(.*)$/.exec(clause);
    if (!match) throw knowledgeError('invalid_request', `属性查询格式无效：${raw}`);
    const [, key = '', op = ':', expected = ''] = match;
    const actual = frontmatterValue(file.metadata, key.trim());
    const actualText = Array.isArray(actual) ? actual.join(' ') : actual === null || actual === undefined ? '' : String(actual);
    const leftNumber = Number(actualText); const rightNumber = Number(expected);
    const left = defaultCaseSensitive ? actualText : actualText.toLocaleLowerCase();
    const right = defaultCaseSensitive ? expected : expected.toLocaleLowerCase();
    const matched = op === ':' ? left.includes(right)
      : op === '=' ? left === right
        : op === '!=' ? left !== right
          : Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
            ? op === '>' ? leftNumber > rightNumber : op === '<' ? leftNumber < rightNumber : op === '>=' ? leftNumber >= rightNumber : leftNumber <= rightNumber
            : false;
    const frontmatter = file.metadata.frontmatterPosition;
    const yaml = frontmatter === undefined ? '' : file.content.slice(frontmatter.start.offset, frontmatter.end.offset);
    const positions = matched && expected !== ''
      ? allOccurrences(yaml, expected, true, 'frontmatter').map((position) => ({ ...position, start: position.start + frontmatter!.start.offset, end: position.end + frontmatter!.start.offset }))
      : [];
    return { matched, positions, score: matched ? 1 : 0 };
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const positions = allOccurrences(file.content, raw.slice(1, -1));
    return { matched: positions.length > 0, positions, score: positions.length * 2 };
  }
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const operator = raw.slice(0, colon).toLocaleLowerCase();
    const arg = raw.slice(colon + 1);
    if (['match-case', 'ignore-case'].includes(operator)) return { matched: true, positions: [], score: 0 };
    if (EXCLUSIVE.has(operator) && (arg.trim() === '' || /^(?:path|file|content|line|block|section|task|task-todo|task-done):/i.test(arg))) {
      throw knowledgeError('invalid_request', `${operator}: 不可嵌套其他独占搜索运算符`);
    }
    const ci = operator === 'match-case' ? false : operator === 'ignore-case' ? true : !defaultCaseSensitive;
    const includes = (value: string) => (ci ? value.toLocaleLowerCase() : value).includes(ci ? arg.toLocaleLowerCase() : arg);
    if (operator === 'path') return { matched: includes(file.path), positions: allOccurrences(file.path, arg, !ci, 'path'), score: includes(file.path) ? 1 : 0 };
    if (operator === 'file') {
      const name = file.path.split('/').at(-1) ?? file.path;
      return { matched: includes(name), positions: allOccurrences(file.path, arg, !ci, 'path'), score: includes(name) ? 2 : 0 };
    }
    if (operator === 'content') {
      const positions = allOccurrences(file.content, arg, !ci);
      return { matched: positions.length > 0, positions, score: positions.length };
    }
    if (operator === 'tag') {
      const normalize = (value: string) => ci ? value.toLocaleLowerCase() : value;
      const target = normalize(arg.replace(/^#/, ''));
      const matchedTags = (file.metadata.tags ?? []).filter((tag) => normalize(tag.tag.replace(/^#/, '')).match(new RegExp(`^${escapeRegex(target)}(?:$|/)`)) !== null);
      const matched = matchedTags.length > 0;
      const positions = matchedTags
        .map((tag) => ({ start: tag.position.start.offset, end: tag.position.end.offset, field: tag.field ?? 'content' }));
      return { matched, positions, score: matched ? 1 : 0, tags: matchedTags.map((tag) => tag.tag) };
    }
    if (operator === 'line') {
      const positions: Evaluation['positions'] = [];
      let start = 0;
      for (const line of file.content.split(/\n/)) {
        if (includes(line)) positions.push({ start, end: start + line.length, field: 'content' });
        start += line.length + 1;
      }
      return { matched: positions.length > 0, positions, score: positions.length };
    }
    if (operator === 'block' || operator === 'section') {
      const candidates = operator === 'block'
        ? Object.values(file.metadata.blocks ?? {}).map((block) => file.content.slice(block.position.start.offset, block.position.end.offset))
        : (file.metadata.headings ?? []).map((heading) => file.content.slice(heading.position.start.offset));
      const matched = candidates.some((value) => includes(value));
      return { matched, positions: [], score: matched ? 1 : 0 };
    }
    if (operator === 'task' || operator === 'task-todo' || operator === 'task-done') {
      const lines = file.content.split(/\n/);
      const positions: Evaluation['positions'] = [];
      let offset = 0;
      for (const line of lines) {
        const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
        if (task !== null && (operator === 'task' || operator === 'task-todo' && task[1]?.toLowerCase() === ' ' || operator === 'task-done' && task[1]?.toLowerCase() === 'x') && includes(task[2] ?? '')) {
          positions.push({ start: offset, end: offset + line.length, field: 'content' });
        }
        offset += line.length + 1;
      }
      return { matched: positions.length > 0, positions, score: positions.length };
    }
    throw knowledgeError('invalid_request', `不支持的搜索运算符：${operator}`);
  }
  if (raw.toLocaleUpperCase() === 'TRUE') return { matched: true, positions: [], score: 0 };
  if (raw.toLocaleUpperCase() === 'FALSE') return { matched: false, positions: [], score: 0 };
  if (raw.toLocaleUpperCase() === 'EMPTY') return { matched: file.content.trim() === '', positions: [], score: 1 };
  const positions = allOccurrences(file.content, raw, defaultCaseSensitive);
  const pathPositions = allOccurrences(file.path, raw, defaultCaseSensitive, 'path');
  const left = defaultCaseSensitive ? file.path : file.path.toLocaleLowerCase();
  const right = defaultCaseSensitive ? raw : raw.toLocaleLowerCase();
  const pathMatch = left.includes(right);
  return { matched: positions.length > 0 || pathMatch, positions: [...positions, ...pathPositions], score: positions.length * 2 + (pathMatch ? 1 : 0) };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function evaluate(expr: Expr, file: SearchFile, caseSensitive: boolean): Evaluation {
  if (expr.kind === 'term') return evalTerm(expr.value, file, caseSensitive);
  if (expr.kind === 'not') { const child = evaluate(expr.child, file, caseSensitive); return { matched: !child.matched, positions: [], score: 0 }; }
  const values = expr.children.map((child) => evaluate(child, file, caseSensitive));
  if (expr.kind === 'and') {
    const matched = values.every((value) => value.matched);
    return { matched, positions: matched ? values.flatMap((value) => value.positions) : [], score: matched ? values.reduce((sum, value) => sum + value.score, 0) : 0, tags: matched ? values.flatMap((value) => value.tags ?? []) : [] };
  }
  const matched = values.filter((value) => value.matched);
  return { matched: matched.length > 0, positions: matched.flatMap((value) => value.positions), score: matched.reduce((sum, value) => sum + value.score, 0), tags: matched.flatMap((value) => value.tags ?? []) };
}

export function searchNotes(query: string, files: SearchFile[], limit = 1000): SearchHit[] {
  const { expression, caseSensitive } = compileQuery(query);
  const hits: SearchHit[] = [];
  for (const file of files) {
    const result = evaluate(expression, file, caseSensitive);
    if (!result.matched) continue;
    const positions = result.positions.slice(0, 20);
    const firstSourcePosition = positions.find((position) => position.field !== 'path')?.start ?? 0;
    const rawSnippetStart = Math.max(0, firstSourcePosition - 70);
    const rawSnippet = file.content.slice(rawSnippetStart, Math.min(file.content.length, firstSourcePosition + 150));
    const leadingTrim = rawSnippet.length - rawSnippet.trimStart().length;
    const snippet = rawSnippet.trim();
    const snippetStart = rawSnippetStart + leadingTrim;
    const snippetEnd = snippetStart + snippet.length;
    const snippetMatches = positions.flatMap((position) => {
      if (position.field === 'path' || position.end <= snippetStart || position.start >= snippetEnd) return [];
      return [{ start: Math.max(position.start, snippetStart) - snippetStart, end: Math.min(position.end, snippetEnd) - snippetStart }];
    });
    const titleResult = evaluate(expression, { path: file.title, title: file.title, content: file.title, metadata: {} }, caseSensitive);
    const titleMatches = [...new Map(titleResult.positions.slice(0, 20).flatMap(({ start, end }) => start < file.title.length && end > 0
      ? [{ start: Math.max(start, 0), end: Math.min(end, file.title.length) }]
      : []).map((range) => [`${range.start}:${range.end}`, range])).values()];
    hits.push({ path: file.path, title: file.title, score: result.score, matches: positions, snippet, titleMatches, snippetMatches, matchedTags: [...new Set(result.tags ?? [])] });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Evaluate the full expression independently against each tag node. */
export function matchingTagNodes(query: string, tags: Iterable<string>): string[] {
  const { expression, caseSensitive } = compileQuery(query);
  return [...new Set(tags)].filter((tag) => evaluate(expression, {
    path: tag,
    title: tag,
    content: tag,
    metadata: { tags: [{ tag, position: { start: { line: 1, col: 1, offset: 0 }, end: { line: 1, col: tag.length + 1, offset: tag.length } }, field: 'content' }] },
  }, caseSensitive).matched).sort((a, b) => a.localeCompare(b));
}

function fuzzyTokenRanges(value: string): Array<{ text: string; start: number; end: number }> {
  const chars = Array.from(value);
  const ranges: Array<{ text: string; start: number; end: number }> = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    ranges.push({ text: chars.slice(start, end).join('').toLocaleLowerCase(), start, end });
    start = -1;
  };
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index] ?? '';
    const previous = chars[index - 1] ?? '';
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(current);
    if (cjk || /[\p{P}\p{Z}\s]/u.test(current)) {
      flush(index);
      if (cjk) ranges.push({ text: current.toLocaleLowerCase(), start: index, end: index + 1 });
      continue;
    }
    if (start >= 0 && /[a-z0-9]/.test(previous) && /[A-Z]/.test(current)) flush(index);
    if (start < 0) start = index;
  }
  flush(chars.length);
  return ranges;
}

function scoreFuzzyPositions(queryLength: number, targetChars: string[], positions: number[]): number {
  let runs = 0;
  let penalty = 0;
  let first = -1;
  let previous = -2;
  const original = targetChars;
  for (const found of positions) {
    if (first < 0) first = found;
    if (found !== previous + 1) {
      runs += 1;
      const before = original[found - 1] ?? '';
      const current = original[found] ?? '';
      if (found > 0 && (/[a-z0-9]/.test(before) && /[A-Z]/.test(current) || /[\p{P}\s]/u.test(before))) penalty += 1;
    }
    previous = found;
  }
  const span = previous - first + 1;
  return -(runs - 1) - penalty / 10 - (span - queryLength) / 100 - first / 1000 - targetChars.length / 10000;
}

/** Token-first fuzzy matching, falling back to character subsequences when no whole-token path fits. */
export function fuzzyScore(query: string, target: string): number | null {
  const queryTokens = fuzzyTokenRanges(query);
  if (queryTokens.length === 0) return 0;
  const targetChars = Array.from(target);
  const targetTokens = fuzzyTokenRanges(target);
  const tokenPositions: number[] = [];
  let tokenCursor = 0;
  let tokenMatch = true;
  for (const queryToken of queryTokens) {
    const found = targetTokens.findIndex((candidate, index) => index >= tokenCursor && candidate.text.startsWith(queryToken.text));
    if (found < 0) { tokenMatch = false; break; }
    const candidate = targetTokens[found]!;
    const length = Array.from(queryToken.text).length;
    for (let offset = 0; offset < length; offset += 1) tokenPositions.push(candidate.start + offset);
    tokenCursor = found + 1;
  }
  const queryLength = queryTokens.reduce((sum, token) => sum + Array.from(token.text).length, 0);
  if (tokenMatch) return scoreFuzzyPositions(queryLength, targetChars, tokenPositions);

  const queryChars = queryTokens.flatMap((token) => Array.from(token.text));
  const targetLower = targetChars.map((char) => char.toLocaleLowerCase());
  let cursor = 0;
  const fuzzyPositions: number[] = [];
  for (const char of queryChars) {
    let found = -1;
    for (let index = cursor; index < targetLower.length; index += 1) {
      if (targetLower[index] === char) { found = index; break; }
    }
    if (found < 0) return null;
    fuzzyPositions.push(found);
    cursor = found + 1;
  }
  return scoreFuzzyPositions(queryLength, targetChars, fuzzyPositions);
}
