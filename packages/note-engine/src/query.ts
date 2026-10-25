import { RE2JS } from 're2js';
import { parseMarkdown } from './metadata';
import type { ParsedMarkdown, Span } from './types';

export type QueryOperator = 'match-case' | 'ignore-case' | 'path' | 'file' | 'content' | 'line' | 'block' | 'section' | 'task' | 'task-todo' | 'task-done' | 'tag';
export type SearchQuery =
  | { type: 'constant'; value: boolean }
  | { type: 'term'; value: string; regex?: boolean; flags?: string }
  | { type: 'and'; children: SearchQuery[] }
  | { type: 'or'; children: SearchQuery[] }
  | { type: 'not'; child: SearchQuery }
  | { type: 'scope'; operator: QueryOperator; child: SearchQuery }
  | { type: 'property'; key: string; comparison?: ':' | '=' | '!=' | '<' | '>' | '<=' | '>='; value?: string };
export interface QueryObject {
  id: string; courseId?: string; kind?: string; title?: string; path?: string; file?: string;
  content?: string; tags?: string[]; properties?: Record<string, unknown>; metadata?: ParsedMarkdown;
  /** Optional conservative superset; absence may reject a tag, presence never establishes a hit. */
  tagText?: string;
}
export interface QueryHit extends Span { field: string }
export interface QueryMatch { matched: boolean; hits: QueryHit[] }
export class QueryError extends Error { override name = 'QueryError'; }
interface Token { type: 'word' | 'quote' | 'regex' | 'property' | '(' | ')' | ':' | '-'; value: string; flags?: string }
const operators = new Set<QueryOperator>(['match-case','ignore-case','path','file','content','line','block','section','task','task-todo','task-done','tag']);
const exclusive = new Set(['path','file','content','line','block','section','task','task-todo','task-done']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (/\s/u.test(character)) { index++; continue; }
    if ('():-'.includes(character)) { tokens.push({ type: character as Token['type'], value: character }); index++; continue; }
    if (character === '[') {
      const start = ++index; let quote = ''; let escaped = false;
      while (index < input.length) { const char = input[index]; if (!escaped && char === ']' && !quote) break; if (!escaped && (char === '"' || char === "'")) quote = quote === char ? '' : quote || char; escaped = !escaped && char === '\\'; index++; }
      if (input[index] !== ']') throw new QueryError('Unclosed property query');
      tokens.push({ type: 'property', value: input.slice(start, index++) }); continue;
    }
    if (character === '"' || character === "'" || character === '/') {
      const quote = character; const start = ++index; let value = ''; let escaped = false; let inClass = false;
      while (index < input.length) {
        const char = input[index];
        if (!escaped && char === quote && !inClass) break;
        if (quote === '/' && !escaped) { if (char === '[') inClass = true; if (char === ']') inClass = false; }
        if (quote !== '/' && escaped && (char === quote || char === '\\')) value = value.slice(0, -1);
        value += char; escaped = !escaped && char === '\\'; index++;
      }
      if (input[index] !== quote) throw new QueryError(`Unclosed ${quote === '/' ? 'regular expression' : 'phrase'} at ${start}`);
      index++; let flags = '';
      if (quote === '/') while (/[a-z]/i.test(input[index] ?? '') && index < input.length) flags += input[index++];
      if (/[^imsu]/.test(flags)) throw new QueryError('Unsupported regular expression flags (use i, m, s, u)');
      tokens.push({ type: quote === '/' ? 'regex' : 'quote', value, flags }); continue;
    }
    const start = index;
    while (index < input.length && !/[\s():\[\]]/u.test(input[index])) index++;
    if (start === index) throw new QueryError(`Unexpected character at ${index}`);
    tokens.push({ type: 'word', value: input.slice(start, index) });
  }
  return tokens;
}

const unquote = (value: string): string => (/^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value).trim();
const regexCache = new Map<string, RE2JS>();
function compileRegex(pattern: string, flags = '', sensitive = false): RE2JS {
  if (pattern.length > 512) throw new QueryError('Regular expression exceeds 512 characters');
  const key = `${sensitive}:${flags}:${pattern}`; const cached = regexCache.get(key); if (cached) return cached;
  try {
    const result = RE2JS.compile(pattern, ((!sensitive || flags.includes('i')) ? RE2JS.CASE_INSENSITIVE : 0) | (flags.includes('m') ? RE2JS.MULTILINE : 0) | (flags.includes('s') ? RE2JS.DOTALL : 0));
    if (regexCache.size >= 100) regexCache.delete(regexCache.keys().next().value!);
    regexCache.set(key, result); return result;
  } catch (error) { throw new QueryError(`Unsupported or invalid RE2 regular expression: ${error instanceof Error ? error.message : String(error)}`); }
}

/** OR has lower precedence than implicit AND; exclusive scopes may be siblings, never nested. */
export function compileQuery(input: string): SearchQuery {
  if (input.length > 2000) throw new QueryError('Query exceeds 2000 characters');
  const tokens = tokenize(input); let index = 0;
  const unary = (outer?: string, depth = 0): SearchQuery => {
    if (depth > 64) throw new QueryError('Query nesting exceeds 64 levels');
    const token = tokens[index++]; if (!token) throw new QueryError('Missing query operand');
    if (token.type === '-' || (token.type === 'word' && token.value === 'NOT')) return { type: 'not', child: unary(outer, depth + 1) };
    if (token.type === '(') { const child = or(outer, depth + 1); if (tokens[index++]?.type !== ')') throw new QueryError('Unclosed query group'); return child; }
    if (token.type === 'property') {
      const match = /^\s*(.*?)(:|>=|<=|!=|=|>|<)(.*)$/s.exec(token.value);
      if (!match) { const key = unquote(token.value); if (!key) throw new QueryError('Empty property name'); return { type: 'property', key }; }
      const key = unquote(match[1]); if (!key) throw new QueryError('Empty property name');
      let comparison = match[2] as ':' | '=' | '!=' | '<' | '>' | '<=' | '>='; let value = match[3].trim();
      if (comparison === ':') { const compare = /^(>=|<=|!=|=|>|<)(.*)$/s.exec(value); if (compare) { comparison = compare[1] as typeof comparison; value = compare[2]; } }
      return { type: 'property', key, comparison, value: unquote(value) };
    }
    if (token.type === 'word' && tokens[index]?.type === ':') {
      index++; if (!operators.has(token.value as QueryOperator)) throw new QueryError(`Unknown search operator: ${token.value}`);
      if (outer && exclusive.has(token.value)) throw new QueryError(`Exclusive search scopes cannot nest: ${outer}:${token.value}:`);
      return { type: 'scope', operator: token.value as QueryOperator, child: unary(exclusive.has(token.value) ? token.value : outer, depth + 1) };
    }
    if (token.type === 'word' && (token.value === 'TRUE' || token.value === 'FALSE')) return { type: 'constant', value: token.value === 'TRUE' };
    if (!['word','quote','regex'].includes(token.type)) throw new QueryError(`Unexpected query token: ${token.value}`);
    if (token.type === 'regex') compileRegex(token.value, token.flags);
    return { type: 'term', value: token.value === 'EMPTY' && token.type === 'word' ? '' : token.value, ...(token.type === 'regex' ? { regex: true, flags: token.flags } : {}) };
  };
  const and = (outer?: string, depth = 0): SearchQuery => {
    const children: SearchQuery[] = [];
    while (index < tokens.length && tokens[index].type !== ')' && !(tokens[index].type === 'word' && tokens[index].value === 'OR')) children.push(unary(outer, depth));
    if (!children.length) throw new QueryError('Missing query operand');
    return children.length === 1 ? children[0] : { type: 'and', children };
  };
  const or = (outer?: string, depth = 0): SearchQuery => {
    const children = [and(outer, depth)];
    while (tokens[index]?.type === 'word' && tokens[index].value === 'OR') { index++; children.push(and(outer, depth)); }
    return children.length === 1 ? children[0] : { type: 'or', children };
  };
  if (!tokens.length) return { type: 'constant', value: true };
  const query = or(); if (index < tokens.length) throw new QueryError('Unexpected closing group'); return query;
}

interface Field { name: string; text: string; offset?: number }
export function matchQuery(query: SearchQuery, object: QueryObject, options: { signal?: AbortSignal; budgetMs?: number } = {}): QueryMatch {
  const deadline = performance.now() + (options.budgetMs ?? 100);
  const check = () => { if (options.signal?.aborted) throw new DOMException('Query cancelled', 'AbortError'); if (performance.now() > deadline) throw new QueryError('Query execution budget exceeded'); };
  const fields: Field[] = [{ name: 'title', text: object.title ?? '' }, { name: 'content', text: object.content ?? '' }];
  let metadata: ParsedMarkdown | undefined;
  const meta = () => metadata ??= object.metadata ?? parseMarkdown(object.content ?? '');
  const cost = (node: SearchQuery): number => node.type === 'scope' ? (['tag','block','section','task','task-todo','task-done'].includes(node.operator) ? 2 : cost(node.child)) : node.type === 'not' ? cost(node.child) : node.type === 'and' || node.type === 'or' ? Math.max(...node.children.map(cost)) : 0;
  // A structural span is a subset of raw content: absence can reject it, presence cannot prove it.
  const possibleInContent = (node: SearchQuery, content: string, sensitive: boolean): boolean | undefined => {
    if (node.type === 'constant') return node.value;
    if (node.type === 'property') return evaluate(node, sensitive).matched;
    if (node.type === 'term') {
      if (!node.value || node.regex) return undefined;
      const found = (sensitive ? content : content.toLocaleLowerCase()).includes(sensitive ? node.value : node.value.toLocaleLowerCase());
      return found ? undefined : false;
    }
    if (node.type === 'not') { const result = possibleInContent(node.child, content, sensitive); return result === undefined ? undefined : !result; }
    if (node.type === 'and' || node.type === 'or') {
      const children = node.children.map((child) => possibleInContent(child, content, sensitive));
      return node.type === 'and' ? children.includes(false) ? false : children.every((result) => result === true) ? true : undefined : children.includes(true) ? true : children.every((result) => result === false) ? false : undefined;
    }
    if (node.operator === 'match-case' || node.operator === 'ignore-case') return possibleInContent(node.child, content, node.operator === 'match-case');
    return undefined;
  };
  const evaluate = (node: SearchQuery, sensitive = false, scoped?: Field[]): QueryMatch => {
    check();
    if (node.type === 'constant') return { matched: node.value, hits: [] };
    if (node.type === 'not') return { matched: !evaluate(node.child, sensitive, scoped).matched, hits: [] };
    if (node.type === 'and' || node.type === 'or') {
      let matched = node.type === 'and'; const hits: QueryHit[] = [];
      const children = node.type === 'and' ? [...node.children].sort((a, b) => cost(a) - cost(b)) : node.children;
      for (const child of children) {
        const result = evaluate(child, sensitive, scoped);
        if (node.type === 'and' && !result.matched) return { matched: false, hits: [] };
        if (result.matched) { matched = true; hits.push(...result.hits); }
      }
      return { matched, hits: matched ? hits : [] };
    }
    if (node.type === 'property') {
      const key = Object.keys(object.properties ?? {}).find((key) => sensitive ? key === node.key : key.toLocaleLowerCase() === node.key.toLocaleLowerCase());
      if (!key) return { matched: false, hits: [] };
      const values = Array.isArray(object.properties![key]) ? object.properties![key] as unknown[] : [object.properties![key]];
      const value = node.value ?? '';
      const matched = !node.comparison || values.some((raw) => {
        const text = String(raw ?? ''); const a = sensitive ? text : text.toLocaleLowerCase(); const b = sensitive ? value : value.toLocaleLowerCase();
        if (node.comparison === ':') return a.includes(b);
        if (node.comparison === '=') return a === b;
        if (node.comparison === '!=') return a !== b;
        const left = text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : a;
        const right = value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : b;
        return node.comparison === '>' ? left > right : node.comparison === '>=' ? left >= right : node.comparison === '<' ? left < right : left <= right;
      });
      return { matched, hits: matched ? [{ field: `property:${key}`, from: 0, to: String(values[0] ?? '').length }] : [] };
    }
    if (node.type === 'scope') {
      const op = node.operator;
      if (op === 'match-case' || op === 'ignore-case') return evaluate(node.child, op === 'match-case', scoped);
      if (op === 'path' || op === 'file') return evaluate(node.child, sensitive, [{ name: op, text: object[op] ?? '' }]);
      if (op === 'tag') {
        const child = node.child;
        const candidate = child.type === 'term' && !child.regex ? { ...child, value: child.value.replace(/^#/, '') } : child;
        if (object.tagText !== undefined && possibleInContent(candidate, object.tagText, sensitive) === false) return { matched: false, hits: [] };
        if (child.type === 'term' && !child.regex) {
          const wanted = (sensitive ? child.value : child.value.toLocaleLowerCase()).replace(/^#/, '');
          const tags = (object.tags ?? []).filter((tag) => { const value = sensitive ? tag : tag.toLocaleLowerCase(); return value === wanted || value.startsWith(`${wanted}/`); });
          return { matched: tags.length > 0, hits: tags.map((tag) => ({ field: 'tag', from: 0, to: tag.length })) };
        }
        return evaluate(child, sensitive, (object.tags ?? []).map((text) => ({ name: 'tag', text })));
      }
      const content = object.content ?? '';
      if (op === 'content') return evaluate(node.child, sensitive, [{ name: 'content', text: content }]);
      if (possibleInContent(node.child, content, sensitive) === false) return { matched: false, hits: [] };
      let parts: Span[];
      if (op === 'line') { let from = 0; parts = content.split('\n').map((line) => { const part = { from, to: from + line.length }; from += line.length + 1; return part; }); }
      else if (op === 'block') parts = meta().blocks;
      else if (op === 'section') parts = meta().sections.map((section) => ({ from: section.from, to: section.contentTo }));
      else parts = meta().tasks.filter((task) => op === 'task' || (op === 'task-done' ? task.checked : !task.checked));
      const hits: QueryHit[] = []; let matched = false;
      for (const part of parts) { const result = evaluate(node.child, sensitive, [{ name: 'content', text: content.slice(part.from, part.to), offset: part.from }]); if (result.matched) { matched = true; hits.push(...result.hits); } }
      return { matched, hits };
    }
    const hits: QueryHit[] = []; let matched = false;
    for (const field of scoped ?? fields) {
      check();
      if (node.value === '') { if (!field.text) matched = true; continue; }
      if (node.regex) {
        const expression = compileRegex(node.value, node.flags, sensitive);
        for (const match of expression.matchAll(field.text)) { matched = true; hits.push({ field: field.name, from: (field.offset ?? 0) + match.index!, to: (field.offset ?? 0) + match.index! + match[0].length }); if (hits.length >= 1000) break; check(); }
      } else {
        const haystack = sensitive ? field.text : field.text.toLocaleLowerCase(); const needle = sensitive ? node.value : node.value.toLocaleLowerCase();
        let from = 0;
        while ((from = haystack.indexOf(needle, from)) >= 0) { matched = true; hits.push({ field: field.name, from: (field.offset ?? 0) + from, to: (field.offset ?? 0) + from + needle.length }); from += Math.max(1, needle.length); if (hits.length >= 1000) break; }
      }
    }
    return { matched, hits };
  };
  const result = evaluate(query);
  return { matched: result.matched, hits: [...new Map(result.hits.map((hit) => [`${hit.field}:${hit.from}:${hit.to}`, hit])).values()] };
}

/** Project only after the complete AST matched an individual object, preserving AND ownership. */
export function matchingCourseIds(query: SearchQuery, objects: readonly QueryObject[]): Set<string> {
  return new Set(objects.filter((object) => object.courseId && matchQuery(query, object).matched).map((object) => object.courseId!));
}
