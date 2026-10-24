import YAML from 'yaml';
import type { NoteFile, VaultEntry, WriteNoteFileRequest } from '@noltri/schema';

export interface TextRange { start: number; end: number }
export interface HistoryDiffLine { kind: 'context' | 'added' | 'removed' | 'notice'; text: string }
export interface VaultLinkPathCandidates { shortest: string[]; relative: string; absolute: string }
export interface VaultDraftMetadata { baseEtag: string | null; conflict: boolean }
export interface StoredVaultDraft { content: string; metadata: VaultDraftMetadata | null }
export interface VaultContextIdentity { rootPath: string; epoch: number }

export function vaultContextMatches(identity: VaultContextIdentity, rootPath: string | null, epoch: number): boolean {
  return identity.rootPath === rootPath && identity.epoch === epoch;
}

const vaultDraftRecordPrefix = '\u0000noltri-vault-draft-v1\n';

export function encodeVaultDraftRecord(content: string, metadata: VaultDraftMetadata): string {
  return `${vaultDraftRecordPrefix}${JSON.stringify({ marker: 'noltri-vault-draft', version: 1, content, metadata })}`;
}

export function writeVaultDraftRecord(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  content: string | null,
  metadata?: VaultDraftMetadata,
): boolean {
  try {
    if (content === null) storage.removeItem(key);
    else storage.setItem(key, encodeVaultDraftRecord(content, metadata ?? { baseEtag: null, conflict: true }));
    return true;
  } catch { return false; }
}

export function decodeVaultDraftRecord(raw: string): StoredVaultDraft {
  if (!raw.startsWith(vaultDraftRecordPrefix)) return { content: raw, metadata: null };
  try {
    const parsed: unknown = JSON.parse(raw.slice(vaultDraftRecordPrefix.length));
    if (typeof parsed !== 'object' || parsed === null) return { content: raw, metadata: null };
    const record = parsed as { marker?: unknown; version?: unknown; content?: unknown; metadata?: unknown };
    if (record.marker !== 'noltri-vault-draft' || record.version !== 1 || typeof record.content !== 'string') return { content: raw, metadata: null };
    if (record.metadata === null) return { content: record.content, metadata: null };
    if (typeof record.metadata !== 'object') return { content: raw, metadata: null };
    const metadata = record.metadata as Partial<VaultDraftMetadata>;
    if ((metadata.baseEtag !== null && typeof metadata.baseEtag !== 'string') || typeof metadata.conflict !== 'boolean') return { content: raw, metadata: null };
    return { content: record.content, metadata: { baseEtag: metadata.baseEtag ?? null, conflict: metadata.conflict } };
  } catch { return { content: raw, metadata: null }; }
}

export function classifyVaultDraftRecovery(
  content: string,
  metadata: VaultDraftMetadata | null,
  current: Pick<NoteFile, 'content' | 'etag'>,
): 'discard' | 'restore' | 'conflict' {
  if (content === current.content) return 'discard';
  if (metadata === null || metadata.conflict || metadata.baseEtag === null || metadata.baseEtag !== current.etag) return 'conflict';
  return 'restore';
}

export function safeDecodeVaultFragment(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

export function vaultPathContains(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function remapVaultPath(path: string, from: string, to: string): string {
  return vaultPathContains(path, from) ? `${to}${path.slice(from.length)}` : path;
}

export function movedMarkdownHistoryPaths(entries: readonly VaultEntry[], from: string): string[] {
  const paths = entries
    .filter((entry) => entry.kind === 'file' && vaultPathContains(entry.path, from)
      && (entry.extension?.toLocaleLowerCase() === 'md' || entry.path.toLocaleLowerCase().endsWith('.md')))
    .map((entry) => entry.path);
  if (from.toLocaleLowerCase().endsWith('.md') && !paths.includes(from)) paths.push(from);
  return paths;
}

export function vaultPathContextMatches(
  rootPath: string | null,
  currentRootPath: string | null,
  targetPath: string | null,
  currentPath: string | null,
  mentionsPath: string | null,
): boolean {
  return rootPath !== null && rootPath === currentRootPath && targetPath !== null
    && targetPath === currentPath && targetPath === mentionsPath;
}

export function vaultLinkPathCandidates(targetPath: string, sourcePath: string): VaultLinkPathCandidates {
  const target = targetPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
  const sourceDirectory = sourcePath.replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean);
  const targetParts = target.split('/').filter(Boolean);
  let common = 0;
  while (common < sourceDirectory.length && common < targetParts.length && sourceDirectory[common] === targetParts[common]) common += 1;
  const relativeParts = [
    ...sourceDirectory.slice(common).map(() => '..'),
    ...targetParts.slice(common),
  ];
  const relativePath = relativeParts.join('/');
  const relative = relativePath.startsWith('../') ? relativePath : `./${relativePath}`;
  const absolute = `/${target}`;
  const shortest = [...new Set([targetParts.at(-1) ?? target, relative, absolute])]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return { shortest, relative, absolute };
}

export function normalizeTextRanges(ranges: readonly TextRange[], textLength: number): TextRange[] {
  const sorted = ranges
    .map(({ start, end }) => ({ start: Math.max(0, Math.min(textLength, start)), end: Math.max(0, Math.min(textLength, end)) }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) merged.push(range);
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function historyDiffLines(current: string, historical: string): HistoryDiffLine[] {
  const now = current.split('\n');
  const before = historical.split('\n');
  if (now.length > 10_000 || before.length > 10_000) {
    return [{ kind: 'notice', text: `文件行数过多，差异预览已限制（当前 ${now.length} 行，历史 ${before.length} 行）。` }];
  }
  let prefix = 0;
  while (prefix < now.length && prefix < before.length && now[prefix] === before[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < now.length - prefix && suffix < before.length - prefix
    && now[now.length - suffix - 1] === before[before.length - suffix - 1]) suffix += 1;

  const output: HistoryDiffLine[] = [];
  const context = 3;
  for (const text of before.slice(Math.max(0, prefix - context), prefix)) output.push({ kind: 'context', text });
  if (prefix > context) output.unshift({ kind: 'notice', text: `… ${prefix - context} 行相同内容已折叠 …` });
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = now.slice(prefix, now.length - suffix);
  const maxChangedLines = 120;
  for (const text of oldMiddle.slice(0, maxChangedLines)) output.push({ kind: 'removed', text });
  if (oldMiddle.length > maxChangedLines) output.push({ kind: 'notice', text: `… 省略 ${oldMiddle.length - maxChangedLines} 行删除 …` });
  for (const text of newMiddle.slice(0, maxChangedLines)) output.push({ kind: 'added', text });
  if (newMiddle.length > maxChangedLines) output.push({ kind: 'notice', text: `… 省略 ${newMiddle.length - maxChangedLines} 行新增 …` });
  const suffixEnd = Math.min(before.length, prefix + suffix + context);
  for (const text of before.slice(before.length - suffix, suffixEnd)) output.push({ kind: 'context', text });
  if (suffix > context) output.push({ kind: 'notice', text: `… ${suffix - context} 行相同内容已折叠 …` });
  return output.length > 0 ? output : [{ kind: 'context', text: '无差异' }];
}

export interface MarkdownBlockRange { source: string; start: number; end: number }

export interface MarkdownTokenLike {
  type?: string;
  level?: number;
  nesting?: number;
  map?: number[] | null;
}

export interface MarkdownTokenGroup<T extends MarkdownTokenLike = MarkdownTokenLike> {
  tokens: T[];
  startLine: number | null;
  endLine: number | null;
  footnotes: boolean;
}

export function groupMarkdownTokens<T extends MarkdownTokenLike>(tokens: readonly T[]): MarkdownTokenGroup<T>[] {
  const groups: MarkdownTokenGroup<T>[] = [];
  let index = 0;
  while (index < tokens.length) {
    const start = index;
    const token = tokens[index]!;
    let footnotes = false;
    if (token.type === 'footnote_block_open') {
      footnotes = true;
      index += 1;
      while (index < tokens.length && tokens[index]!.type !== 'footnote_block_close') index += 1;
      if (index < tokens.length) index += 1;
    } else if (token.level === 0 && token.nesting === 1) {
      let depth = 0;
      do {
        depth += tokens[index]!.nesting ?? 0;
        index += 1;
      } while (index < tokens.length && depth > 0);
    } else {
      index += 1;
    }

    const groupTokens = tokens.slice(start, index) as T[];
    let startLine: number | null = null;
    let endLine: number | null = null;
    for (const item of groupTokens) {
      if (item.map === undefined || item.map === null) continue;
      const from = item.map[0] ?? 0;
      const to = item.map[1] ?? from;
      startLine = startLine === null ? from : Math.min(startLine, from);
      endLine = endLine === null ? to : Math.max(endLine, to);
    }
    groups.push({
      tokens: groupTokens,
      startLine,
      endLine,
      footnotes,
    });
  }
  return groups;
}

export function markdownBlockRanges(content: string): MarkdownBlockRange[] {
  const rawLines = content.split(/\r?\n/);
  let offset = 0;
  const lines = rawLines.map((text) => {
    const start = offset;
    const end = start + text.length;
    const separator = content.slice(end, end + 2) === '\r\n' ? 2 : content[end] === '\n' ? 1 : 0;
    offset = end + separator;
    return { text, start, end };
  });
  const blocks: MarkdownBlockRange[] = [];
  let current: string[] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let fence: { marker: string; length: number } | null = null;
  let inTable = false;
  const isTableSeparator = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  for (let index = 0; index < lines.length; index += 1) {
    const row = lines[index]!;
    const line = row.text;
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker !== null) {
      const found = marker[1]!;
      if (fence === null) fence = { marker: found[0]!, length: found.length };
      else if (found[0] === fence.marker && found.length >= fence.length) fence = null;
    }
    if (fence === null && index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1]!.text)) inTable = true;
    if (fence === null && line.trim() === '' && inTable) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.text.trim() === '') next += 1;
      if (next < lines.length && lines[next]!.text.includes('|')) { current.push(line); continue; }
      inTable = false;
    }
    if (line.trim() === '' && fence === null) {
      if (inTable && current.length > 0) {
        current.push(line);
        currentEnd = row.end;
        continue;
      }
      if (current.length > 0) blocks.push({ source: content.slice(currentStart, currentEnd), start: currentStart, end: currentEnd });
      current = [];
      currentStart = -1;
      currentEnd = -1;
    } else {
      if (currentStart < 0) currentStart = row.start;
      current.push(line);
      currentEnd = row.end;
      if (inTable && !line.includes('|') && !isTableSeparator(line)) inTable = false;
    }
  }
  if (current.length > 0) blocks.push({ source: content.slice(currentStart, currentEnd), start: currentStart, end: currentEnd });
  return blocks.length > 0 ? blocks : [{ source: '', start: 0, end: 0 }];
}

export function markdownBlocks(content: string): string[] {
  return markdownBlockRanges(content).map((block) => block.source);
}

export interface MarkdownReaderTarget { sectionIndex: number; sourceLine: number }

export function markdownReaderTarget(content: string, sourceOffset: number): MarkdownReaderTarget | null {
  const frontmatter = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.exec(content);
  const bodyOffset = frontmatter?.[0].length ?? 0;
  const body = content.slice(bodyOffset);
  const offset = sourceOffset - bodyOffset;
  if (!Number.isInteger(offset) || offset < 0 || offset > body.length) return null;
  const blocks = markdownBlockRanges(body);
  const sectionIndex = blocks.findIndex((block) => offset >= block.start && offset <= block.end);
  if (sectionIndex < 0) return null;
  const section = blocks[sectionIndex]!;
  return { sectionIndex, sourceLine: body.slice(section.start, offset).split(/\r?\n/).length - 1 };
}

export function markdownSectionIndex(blocks: readonly string[], subpath: string): number {
  const target = subpath.replace(/^#/, '').trim();
  if (target.startsWith('^')) {
    const id = target.slice(1).toLocaleLowerCase();
    return blocks.findIndex((block) => new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`, 'im').test(block.toLocaleLowerCase()));
  }
  const segments = target.split('#').map(headingKey).filter(Boolean);
  if (segments.length === 0) return -1;
  const headings: Array<{ blockIndex: number; level: number; slug: string }> = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    let fence: { marker: string; length: number } | null = null;
    for (const line of blocks[blockIndex]!.split(/\r?\n/)) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker !== null) {
        const value = marker[1]!;
        if (fence === null) fence = { marker: value[0]!, length: value.length };
        else if (value[0] === fence.marker && value.length >= fence.length) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match !== null) headings.push({ blockIndex, level: match[1]!.length, slug: headingKey(match[2]!) });
    }
  }
  let cursor = -1;
  let previousLevel = 0;
  for (const segment of segments) {
    let found = -1;
    for (let index = cursor + 1; index < headings.length; index += 1) {
      const heading = headings[index]!;
      if (cursor >= 0 && heading.level <= previousLevel) break;
      if (heading.slug === segment && (cursor < 0 || heading.level > previousLevel)) { found = index; break; }
    }
    if (found < 0) return -1;
    cursor = found;
    previousLevel = headings[found]!.level;
  }
  return headings[cursor]?.blockIndex ?? -1;
}

export function rangeIntersectsToken(token: TextRange, range: TextRange, caretIsBoundary = true): boolean {
  if (range.start === range.end) return caretIsBoundary
    ? range.start >= token.start && range.start <= token.end
    : range.start >= token.start && range.start < token.end;
  return range.start < token.end && range.end > token.start;
}

export function shouldRevealSource(token: TextRange, selections: readonly TextRange[], searches: readonly TextRange[]): boolean {
  return selections.some((range) => rangeIntersectsToken(token, range)) || searches.some((range) => rangeIntersectsToken(token, range));
}

export function fuzzyMatchRanges(query: string, target: string): TextRange[] {
  const queryChars = Array.from(query.toLocaleLowerCase());
  const targetChars = Array.from(target);
  const offsets: number[] = [];
  let offset = 0;
  for (const char of targetChars) { offsets.push(offset); offset += char.length; }
  offsets.push(offset);
  const matches: TextRange[] = [];
  let cursor = 0;
  for (const queryChar of queryChars) {
    let found = cursor;
    while (found < targetChars.length && targetChars[found]!.toLocaleLowerCase() !== queryChar) found += 1;
    if (found >= targetChars.length) return [];
    matches.push({ start: offsets[found]!, end: offsets[found + 1]! });
    cursor = found + 1;
  }
  return matches;
}

export function parseWikiLink(raw: string): { embed: boolean; target: string; alias: string } | null {
  const match = raw.match(/^(!?)\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]$/);
  if (match === null) return null;
  const target = match[2]!.trim();
  return { embed: match[1] === '!', target, alias: match[3]?.trim() || target.split('#')[0]?.split('/').at(-1) || target };
}

export function extractSubpath(content: string, subpath: string): string | null {
  const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
  const target = subpath.replace(/^#/, '').trim();
  if (target === '') return body;
  const lines = body.split(/\r?\n/);
  if (target.startsWith('^')) {
    const id = target.slice(1).toLocaleLowerCase();
    const line = lines.findIndex((candidate) => new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`, 'i').test(candidate));
    if (line < 0) return null;
    let start = line;
    let end = line + 1;
    while (start > 0 && lines[start - 1]!.trim() !== '') start -= 1;
    while (end < lines.length && lines[end]!.trim() !== '') end += 1;
    const block = lines.slice(start, end).join('\n').replace(new RegExp(`\\s+\\^${escapeRegExp(id)}\\s*$`, 'i'), '');
    return block;
  }
  const headings = lines.map((line, index) => {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match === null ? null : { index, level: match[1]!.length, slug: headingKey(match[2]!) };
  }).filter((heading): heading is { index: number; level: number; slug: string } => heading !== null);
  const segments = target.split('#').map(headingKey).filter(Boolean);
  let selected: { index: number; level: number } | null = null;
  let cursor = -1;
  for (const segment of segments) {
    const found = headings.find((heading) => heading.index > cursor && (selected === null || heading.level > selected.level) && heading.slug === segment);
    if (found === undefined) return null;
    selected = found;
    cursor = found.index;
  }
  if (selected === null) return null;
  const end = headings.find((heading) => heading.index > selected!.index && heading.level <= selected!.level)?.index ?? lines.length;
  return lines.slice(selected.index, end).join('\n');
}

function headingKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function safeNoteHref(value: string): string | null {
  const href = value.trim();
  if (/^(?:javascript|data|vbscript|file):/i.test(href)) return null;
  return href;
}

export function replaceMentionAt(content: string, start: number, end: number, expected: string, targetPath: string): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) return null;
  const actual = content.slice(start, end).normalize('NFC').toLocaleLowerCase();
  if (actual !== expected.normalize('NFC').toLocaleLowerCase()) return null;
  return `${content.slice(0, start)}[[${targetPath}]]${content.slice(end)}`;
}

export function setFrontmatterProperty(content: string, key: string, value: unknown): string {
  const match = content.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/);
  const document = YAML.parseDocument(match?.[2] ?? '', { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(`YAML 属性格式有误：${document.errors[0]?.message ?? '无法解析'}`);
  if (value === undefined) document.delete(key);
  else document.set(key, value);
  const lineSeparator = match?.[1]?.match(/\r\n|\r|\n/)?.[0] ?? content.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const yaml = document.toString().replace(/\r\n|\r|\n/g, lineSeparator).replace(/\s+$/, '');
  return match === null
    ? `---${lineSeparator}${yaml}${lineSeparator}---${lineSeparator}${lineSeparator}${content}`
    : `${match[1]}${yaml}${match[3]}${content.slice(match[0].length)}`;
}

export async function saveWithEtag(
  save: (request: WriteNoteFileRequest) => Promise<NoteFile>,
  request: WriteNoteFileRequest,
): Promise<{ kind: 'saved'; file: NoteFile } | { kind: 'conflict' }> {
  try { return { kind: 'saved', file: await save(request) }; }
  catch (error) { return (error as { status?: number })?.status === 409 ? { kind: 'conflict' } : Promise.reject(error); }
}

export async function saveLatestNoteWithEtag(
  save: (request: WriteNoteFileRequest) => Promise<NoteFile>,
  path: string,
  getCurrent: () => NoteFile | null,
  getContent: () => string,
): Promise<{ kind: 'saved'; file: NoteFile } | { kind: 'unchanged'; file: NoteFile } | { kind: 'conflict' } | { kind: 'missing' }> {
  const current = getCurrent();
  if (current === null || current.path !== path) return { kind: 'missing' };
  const content = getContent();
  if (content === current.content) return { kind: 'unchanged', file: current };
  return saveWithEtag(save, { path, content, expectedEtag: current.etag });
}

export async function drainNoteFlush(
  read: () => { valid: boolean; content: string; saved: string; pending: number },
  waitForPending: () => Promise<void>,
  saveOnce: () => Promise<boolean>,
): Promise<boolean> {
  while (true) {
    const state = read();
    if (!state.valid) return false;
    if (state.content === state.saved && state.pending === 0) return true;
    if (state.pending > 0) { await waitForPending(); continue; }
    if (!(await saveOnce())) return false;
  }
}

export function createVaultDraftWriteQueue(
  write: (root: string, path: string, content: string | null, metadata?: VaultDraftMetadata) => unknown,
  delayMs = 750,
  onWriteError?: (root: string, path: string, metadata?: VaultDraftMetadata) => void,
): {
  schedule(root: string, path: string, content: string, metadata?: VaultDraftMetadata): void;
  flush(root: string, path: string, content: string, metadata?: VaultDraftMetadata): void;
  clear(root: string, path: string): boolean;
  flushPending(): void;
} {
  let pending: { root: string; path: string; content: string; metadata?: VaultDraftMetadata; timer: ReturnType<typeof setTimeout> } | null = null;
  const writeSafely = (root: string, path: string, content: string | null, metadata?: VaultDraftMetadata): boolean => {
    let success = true;
    try { success = write(root, path, content, metadata) !== false; }
    catch { success = false; }
    if (!success) onWriteError?.(root, path, metadata);
    return success;
  };
  const flushPending = (): void => {
    if (pending === null) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    writeSafely(current.root, current.path, current.content, current.metadata);
  };
  return {
    schedule(root, path, content, metadata) {
      if (pending?.root === root && pending.path === path) {
        pending.content = content;
        pending.metadata = metadata;
        return;
      }
      flushPending();
      const current = { root, path, content, metadata, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      pending = current;
      current.timer = setTimeout(() => {
        if (pending !== current) return;
        pending = null;
        writeSafely(root, path, current.content, current.metadata);
      }, delayMs);
    },
    flush(root, path, content, metadata) {
      if (pending?.root === root && pending.path === path) {
        clearTimeout(pending.timer);
        pending = null;
      }
      writeSafely(root, path, content, metadata);
    },
    clear(root, path) {
      if (pending?.root === root && pending.path === path) {
        clearTimeout(pending.timer);
        pending = null;
      }
      return writeSafely(root, path, null);
    },
    flushPending,
  };
}

export function classifyNoteChange(
  pendingWrites: number,
  current: NoteFile | null,
  fresh: NoteFile,
  localContent: string,
): 'defer' | 'ignore' | 'reload' | 'conflict' {
  if (pendingWrites > 0) return 'defer';
  if (current?.path !== fresh.path || current.etag === fresh.etag) return 'ignore';
  return localContent === current.content ? 'reload' : 'conflict';
}
