import { createHash, randomUUID } from 'node:crypto';
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import { link, mkdir, open, readFile, readdir, realpath, rename as renameFile, rm, rmdir, stat, lstat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, parseDocument, stringify as stringifyYaml } from 'yaml';
import type {
  CachedNoteMetadata,
  RenameVaultBlockResponse,
  NoteBacklinksResponse,
  VaultDeletePreview,
  NoteFile,
  NoteHistoryResponse,
  NoteLinksResponse,
  NoteMentionResponse,
  NoteSearchResponse,
  VaultChangesResponse,
  VaultEntry,
  VaultGraph,
  VaultSnapshot,
  VaultSettings,
  VaultPropertyTypes,
  NotePosition,
  VaultAsset,
  VaultDiagnostics,
  NoteLink,
  KnowledgeItem,
  KnowledgeNode,
  RawSource,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { KnowledgeRepository } from '@noltri/storage';
import { basenameWithoutExtension, extensionOf, isMarkdownPath, normalizeVaultPath, normalizeVaultPathComponent, pathKey, titleOf } from './path';
import { parseFrontmatterValue, parseMarkdown, resolveSubpath, rewriteLinkOccurrences, rewriteYamlLinks } from './markdown';
import { MetadataParserWorker } from './parser';
import { fuzzyScore, matchingTagNodes, searchNotes } from './search';

interface CachedFile {
  path: string;
  mtime: number;
  size: number;
  etag: string;
  content: string;
  metadata: CachedNoteMetadata;
  codeRanges: Array<{ start: number; end: number }>;
  frontmatterRange: { start: number; end: number } | null;
}
interface SavedVersion { id: string; path: string; rootPath: string; createdAt: string; etag: string; content: string; encoding?: 'base64' }
interface DirectoryFile { path: string; bytes: Buffer; etag: string }
interface DirectoryTree { etag: string; files: DirectoryFile[] }
interface LegacyMap { [key: string]: string }
interface VaultOptions {
  rootPath: string;
  dataDir: string;
  repository: KnowledgeRepository;
  userId: string;
}
interface VaultWatchEvent {
  relativeDirectory: string;
  eventType: string;
  fileName: string | Buffer | null;
}

export interface SemanticNoteFile {
  path: string;
  frontmatter: Record<string, unknown>;
  title: string;
  summary: string | null;
  links: string[];
}

const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;
const HISTORY_THROTTLE_MS = 60_000;
const HASH_CACHE_TTL_MS = 600_000;
const CHANGE_LIMIT = 2000;
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '.obsidian', '.noltri']);
const GRAPH_NOTE_SYSTEM_PROPERTIES = new Set(['id', 'noteType', 'topicId', 'chapterId', 'title']);
const idKey = (topicId: string, chapterId: string | null) => `${topicId}\u0000${chapterId ?? ''}`;
const userGraphNoteProperties = (frontmatter: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !GRAPH_NOTE_SYSTEM_PROPERTIES.has(key)));
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'not_found'].includes((error as NodeJS.ErrnoException).code ?? '');
const positionIn = (content: string, start: number, end: number): NotePosition => {
  const point = (offset: number) => {
    const prefix = content.slice(0, offset);
    return { line: (prefix.match(/\n/g)?.length ?? 0) + 1, col: offset - prefix.lastIndexOf('\n'), offset };
  };
  return { start: point(start), end: point(end) };
};
const isHistoryId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const markdownBody = (content: string): string => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)\r?\n?/, '');
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const libraryMapKey = (kind: 'source' | 'item', id: string): string => `library:${kind}\u0000${id}`;
const parseHistoryVersion = (value: unknown, fileName: string, rootPath: string): SavedVersion | null => {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Partial<SavedVersion>;
  if (!isHistoryId(record.id) || fileName !== `${record.id}.json` || typeof record.path !== 'string' || record.rootPath !== rootPath) return null;
  let canonicalPath: string;
  try { canonicalPath = normalizeVaultPath(record.path); }
  catch { return null; }
  if (record.path !== canonicalPath || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
  try { if (new Date(record.createdAt).toISOString() !== record.createdAt) return null; }
  catch { return null; }
  if (typeof record.etag !== 'string' || !/^[a-f0-9]{64}$/.test(record.etag) || typeof record.content !== 'string') return null;
  if (record.encoding === 'base64') {
    const bytes = Buffer.from(record.content, 'base64');
    if (bytes.toString('base64') !== record.content || sha256(bytes) !== record.etag) return null;
  } else if (record.encoding === undefined) {
    if (sha256(record.content) !== record.etag) return null;
  } else return null;
  return record as SavedVersion;
};

/**
 * The local filesystem is the note store. The maps below are disposable indexes; every write reaches
 * disk first and updates the same cache consumed by notes, backlinks, search, and Graph.
 */
export class VaultService {
  private rootPath: string;
  private newLinkFormat: VaultSettings['newLinkFormat'] = 'shortest';
  private propertyTypes: VaultPropertyTypes = {};
  private propertyTypesConfig: Record<string, unknown> = {};
  private propertyTypesMalformed = false;
  private readonly settingsByRoot = new Map<string, VaultSettings['newLinkFormat']>();
  private readonly configuredRoot: string;
  private readonly dataDir: string;
  private readonly historyDir: string;
  private readonly hashCacheDir: string;
  private readonly settingsFile: string;
  private legacyMapFile = '';
  private readonly repository: KnowledgeRepository;
  private readonly userId: string;
  private ready = false;
  private initializing: Promise<void> | null = null;
  private entries: VaultEntry[] = [];
  private cache = new Map<string, CachedFile>();
  private libraryPathByKey = new Map<string, string>();
  private semanticNotePathByKey = new Map<string, string>();
  private physicalPaths = new Map<string, string>();
  private metadataByHash = new Map<string, ReturnType<typeof parseMarkdown>>();
  private resolvedLinks: Record<string, Record<string, number>> = {};
  private unresolvedLinks: Record<string, Record<string, number>> = {};
  private linksBySource = new Map<string, Array<{ target: string | null; linkpath: string; position: NotePosition; original: string; kind: string; embed: boolean }>>();
  private revision = 0;
  private readonly changes: Array<{ revision: number; kind: 'changed' | 'resolved' | 'deleted'; path: string }> = [];
  private readonly historyIndex = new Map<string, SavedVersion[]>();
  private historyIndexLoaded = false;
  private watchers = new Map<string, FSWatcher>();
  private watcherGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshQueue: Promise<void> = Promise.resolve();
  private pendingWatchEvents: VaultWatchEvent[] = [];
  private legacyMap: LegacyMap = {};
  private migratingLibrary = false;
  private parser: MetadataParserWorker | null = null;
  private readonly hashLastUsed = new Map<string, number>();
  private readonly failedFiles = new Map<string, { path: string; error: string; at: string }>();
  private cacheLoaded = false;
  private cachePersisted = false;
  private indexing = false;
  private closed = false;
  private lastIndexedAt: string | null = null;
  private hashGcTimer: ReturnType<typeof setInterval> | null = null;
  // ponytail: one in-process queue keeps competing Vault mutations atomic; split per-path only if throughput later requires it.
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: VaultOptions) {
    this.configuredRoot = path.resolve(options.rootPath);
    this.rootPath = this.configuredRoot;
    this.dataDir = path.resolve(options.dataDir);
    this.historyDir = path.join(this.dataDir, 'vault-history');
    this.hashCacheDir = path.join(this.dataDir, 'vault-cache');
    this.settingsFile = path.join(this.dataDir, 'vault-settings.json');
    this.repository = options.repository;
    this.userId = options.userId;
  }

  private serializeMutation<T>(operation: () => Promise<T>, expectedRoot: string | null = this.rootPath): Promise<T> {
    const run = async (): Promise<T> => {
      if (expectedRoot !== null && expectedRoot !== this.rootPath) {
        throw knowledgeError('conflict', 'Vault 已切换，请刷新后重试操作');
      }
      return await operation();
    };
    const result = this.mutationQueue.then(run);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async mutationRootForCall(requestRoot?: string): Promise<string> {
    const rootAtCall = this.ready ? this.rootPath : undefined;
    await this.ensureReady();
    return requestRoot ?? rootAtCall ?? this.rootPath;
  }

  /** Captures the Vault identity before an HTTP body is read, so a delayed old-root request stays stale. */
  async captureRootForMutation(): Promise<string> {
    await this.ensureReady();
    return this.rootPath;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.initializing !== null) return await this.initializing;
    this.initializing = this.initializeOnce();
    try { await this.initializing; }
    finally { this.initializing = null; }
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.historyDir, { recursive: true });
    try {
      const settings = JSON.parse(await readFile(this.settingsFile, 'utf8')) as { rootPath?: unknown; newLinkFormat?: unknown; vaults?: unknown };
      if (typeof settings.rootPath === 'string' && settings.rootPath.length > 0) this.rootPath = path.resolve(settings.rootPath);
      if (settings.vaults !== null && typeof settings.vaults === 'object' && !Array.isArray(settings.vaults)) {
        for (const [rootHash, format] of Object.entries(settings.vaults)) {
          if (format === 'absolute' || format === 'relative' || format === 'shortest') this.settingsByRoot.set(rootHash, format);
        }
      }
      if (settings.newLinkFormat === 'absolute' || settings.newLinkFormat === 'relative' || settings.newLinkFormat === 'shortest') {
        this.newLinkFormat = settings.newLinkFormat;
      }
    } catch { /* the configured default is used when there is no saved Vault */ }
    await mkdir(this.rootPath, { recursive: true });
    this.rootPath = await realpath(this.rootPath);
    const savedFormat = this.settingsByRoot.get(sha256(this.rootPath));
    if (savedFormat !== undefined) this.newLinkFormat = savedFormat;
    else if (this.settingsByRoot.size > 0) this.newLinkFormat = 'shortest';
    this.settingsByRoot.set(sha256(this.rootPath), this.newLinkFormat);
    await this.loadPropertyTypes();
    this.legacyMapFile = this.mapFileFor(this.rootPath);
    await this.loadLegacyMap();
    await this.loadHashCache(this.rootPath);
    this.parser = new MetadataParserWorker(import.meta.url);
    this.hashGcTimer = setInterval(() => { void this.collectHashCache().catch(() => undefined); }, 60_000);
    await this.refresh(true);
    await this.migrateLegacyNotes();
    await this.migrateLegacyLibrary();
    await this.refresh(true);
    this.attachWatchers();
    this.ready = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcherGeneration += 1;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingWatchEvents = [];
    if (this.hashGcTimer !== null) clearInterval(this.hashGcTimer);
    await this.mutationQueue.catch(() => undefined);
    await this.refreshQueue.catch(() => undefined);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.parser !== null) await this.parser.close();
  }

  private mapFileFor(root: string): string {
    return path.join(this.dataDir, 'vault-index', `${sha256(root)}.json`);
  }

  private hashCacheFileFor(root: string): string {
    return path.join(this.hashCacheDir, `${sha256(root)}.json`);
  }

  private async loadHashCache(root: string): Promise<void> {
    this.metadataByHash.clear();
    this.hashLastUsed.clear();
    this.cacheLoaded = false;
    this.cachePersisted = false;
    try {
      const value = JSON.parse(await readFile(this.hashCacheFileFor(root), 'utf8')) as {
        version?: unknown; rootPath?: unknown; entries?: unknown;
      };
      if (value.version !== 1 || value.rootPath !== root || !Array.isArray(value.entries)) return;
      for (const item of value.entries) {
        if (item === null || typeof item !== 'object') continue;
        const entry = item as { hash?: unknown; lastUsed?: unknown; parsed?: unknown };
        if (typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.lastUsed !== 'number' || entry.parsed === null || typeof entry.parsed !== 'object') continue;
        const parsed = entry.parsed as ReturnType<typeof parseMarkdown>;
        if (parsed.metadata === null || typeof parsed.metadata !== 'object' || !Array.isArray(parsed.codeRanges)) continue;
        this.metadataByHash.set(entry.hash, parsed);
        this.hashLastUsed.set(entry.hash, entry.lastUsed);
      }
      this.cacheLoaded = true;
    } catch { /* missing or corrupt disposable cache is rebuilt from Markdown */ }
  }

  private async persistHashCache(): Promise<void> {
    const now = Date.now();
    const entries = [...this.metadataByHash].map(([hash, parsed]) => ({ hash, lastUsed: this.hashLastUsed.get(hash) ?? now, parsed }));
    await this.atomicWrite(this.hashCacheFileFor(this.rootPath), JSON.stringify({ version: 1, rootPath: this.rootPath, entries }));
    this.cachePersisted = true;
  }

  private async collectHashCache(): Promise<void> {
    const cutoff = Date.now() - HASH_CACHE_TTL_MS;
    let removed = false;
    for (const [hash, usedAt] of this.hashLastUsed) {
      if (usedAt >= cutoff) continue;
      this.hashLastUsed.delete(hash);
      this.metadataByHash.delete(hash);
      removed = true;
    }
    if (removed && this.ready) await this.persistHashCache();
  }

  private async loadLegacyMap(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.legacyMapFile, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.entries(parsed).every(([key, value]) => key.includes('\u0000') && typeof value === 'string' && normalizeVaultPath(value) === value)) {
        throw new Error('legacy map has an invalid shape');
      }
      this.legacyMap = parsed as LegacyMap;
    } catch (error) {
      if (missing(error)) { this.legacyMap = {}; return; }
      throw knowledgeError('internal_error', `旧笔记映射无法读取；已停止自动迁移以避免重复导入：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveLegacyMap(): Promise<void> {
    await this.atomicWrite(this.legacyMapFile, JSON.stringify(this.legacyMap, null, 2));
  }

  private async migrateLegacyNotes(): Promise<void> {
    const nodes = await this.repository.listNodes(this.userId, { includeArchived: true });
    const topics = nodes.filter((node) => node.nodeType === 'topic');
    const chapters = new Map(nodes.filter((node) => node.nodeType === 'chapter').map((node) => [node.id, node]));
    const memberships = (await this.repository.listEdges(this.userId))
      .filter((edge) => edge.relationType === 'part_of' && chapters.has(edge.fromNodeId))
      .map((edge) => ({ topicId: edge.toNodeId, chapterId: edge.fromNodeId }));
    let mapChanged = false;

    for (const topic of topics) {
      const indexes = await this.repository.listKnowledgeNotes(this.userId, topic.id);
      const contentByKey = new Map<string, string>();
      for (const index of indexes) {
        const note = await this.repository.getKnowledgeNote(this.userId, index.topicId, index.chapterId);
        if (note !== null) contentByKey.set(idKey(index.topicId, index.chapterId), note.content);
      }
      const targets = [
        { chapterId: null, title: topic.title },
        ...memberships.filter((entry) => entry.topicId === topic.id).map((entry) => ({ chapterId: entry.chapterId, title: chapters.get(entry.chapterId)?.title ?? entry.chapterId })),
        ...indexes.flatMap((entry) => entry.chapterId === null ? [] : [{ chapterId: entry.chapterId, title: chapters.get(entry.chapterId)?.title ?? entry.chapterId }]),
      ];
      const uniqueTargets = new Map(targets.map((target) => [idKey(topic.id, target.chapterId), target]));
      for (const [key, target] of uniqueTargets) {
        if (this.legacyMap[key] !== undefined) continue;
        const indexedPath = this.semanticNotePathByKey.get(key);
        if (indexedPath !== undefined) {
          this.legacyMap[key] = indexedPath;
          mapChanged = true;
          continue;
        }
        const base = this.defaultLegacyPath(topic.id, target.chapterId);
        let candidate = base;
        for (let collision = 1; await this.pathExists(candidate); collision += 1) {
          const ext = path.posix.extname(base);
          candidate = `${base.slice(0, -ext.length)}-${String(collision)}${ext}`;
        }
        const body = contentByKey.get(key) ?? `# ${target.title}\n`;
        const noteType = target.chapterId === null ? 'topic' : 'chapter';
        const frontmatter = {
          id: target.chapterId ?? topic.id,
          noteType,
          topicId: topic.id,
          chapterId: target.chapterId,
          title: target.title,
        };
        await this.writeFileInternal(candidate, this.documentWithFrontmatter(body, frontmatter), undefined, false);
        this.legacyMap[key] = candidate;
        this.semanticNotePathByKey.set(key, candidate);
        mapChanged = true;
      }
    }

    // Existing legacy maps can point at notes written before frontmatter support. Add IDs in place,
    // retaining their Markdown body and every user-authored field.
    for (const topic of topics) {
      const indexes = await this.repository.listKnowledgeNotes(this.userId, topic.id);
      const chapterIds = new Set([
        ...memberships.filter((entry) => entry.topicId === topic.id).map((entry) => entry.chapterId),
        ...indexes.map((entry) => entry.chapterId).filter((id): id is string => id !== null),
      ]);
      for (const chapterId of [null, ...chapterIds]) {
        const key = idKey(topic.id, chapterId);
        let notePath = this.legacyMap[key];
        if (notePath === undefined) continue;
        try {
          const current = await this.getFileInternal(notePath);
          const noteType = chapterId === null ? 'topic' : 'chapter';
          const title = chapterId === null ? topic.title : chapters.get(chapterId)?.title ?? chapterId;
          const next = this.documentWithFrontmatter(current.content, {
            id: chapterId ?? topic.id, noteType, topicId: topic.id, chapterId, title,
          });
          if (next !== current.content) await this.writeFileInternal(notePath, next, current.etag, false);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    }
    if (mapChanged) await this.saveLegacyMap();
  }

  private documentWithFrontmatter(content: string, updates: Record<string, unknown>, replace = false): string {
    const parsed = parseFrontmatterValue(content);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
    if (match !== null && parseDocument(match[1] ?? '', { uniqueKeys: false }).errors.length > 0) {
      throw knowledgeError('invalid_request', 'Frontmatter YAML 无法解析；已停止更新元数据以保留原文');
    }
    const merged = replace ? updates : { ...parsed, ...updates };
    const serialized = stringifyYaml(merged, { lineWidth: 0 }).trimEnd();
    if (match !== null) return `---\n${serialized}\n---${content.slice(match[0].length)}`;
    return `---\n${serialized}\n---\n${content}`;
  }

  private async pathForLibraryDocument(kind: 'source' | 'item', id: string): Promise<string | null> {
    const key = libraryMapKey(kind, id);
    const indexed = this.libraryPathByKey.get(key);
    if (indexed !== undefined) {
      if (this.legacyMap[key] !== indexed) {
        this.legacyMap[key] = indexed;
        if (!this.migratingLibrary) await this.saveLegacyMap();
      }
      return indexed;
    }
    const mapped = this.legacyMap[key];
    if (mapped !== undefined) return await this.pathExists(mapped) ? mapped : null;
    const base = this.defaultLibraryPath(kind, id);
    let candidate = base;
    for (let collision = 1; await this.pathExists(candidate); collision += 1) {
      const suffix = `-${sha256(id).slice(0, 8)}${collision === 1 ? '' : `-${String(collision)}`}`;
      const ext = path.posix.extname(base);
      candidate = `${base.slice(0, -ext.length)}${suffix}${ext}`;
    }
    return candidate;
  }

  private async writeLibraryDocument(
    kind: 'source' | 'item',
    id: string,
    frontmatter: Record<string, unknown>,
    initialBody: string,
  ): Promise<string | null> {
    const key = libraryMapKey(kind, id);
    const notePath = await this.pathForLibraryDocument(kind, id);
    if (notePath === null) return null; // persisted mapping is a deletion tombstone
    const current = await this.getFileInternal(notePath).catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    if (current === null) {
      await this.writeFileInternal(notePath, this.documentWithFrontmatter(initialBody, frontmatter), undefined, false);
    } else {
      const next = this.documentWithFrontmatter(current.content, frontmatter);
      if (next !== current.content) await this.writeFileInternal(notePath, next, current.etag, false);
    }
    this.legacyMap[key] = notePath;
    this.libraryPathByKey.set(key, notePath);
    return notePath;
  }

  private async topicAndChapterIds(items: readonly KnowledgeItem[], userId: string): Promise<{ topicIds: string[]; chapterIds: string[] }> {
    if (items.length === 0) return { topicIds: [], chapterIds: [] };
    const nodes = await this.repository.listNodes(userId, { includeArchived: true });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const topics = new Set<string>();
    const chapters = new Set<string>();
    for (const item of items) {
      for (const link of await this.repository.listLinksForItem(item.id, userId)) {
        for (const segment of await this.repository.nodePath(userId, link.nodeId)) {
          const node = byId.get(segment.id);
          if (node?.nodeType === 'topic') topics.add(node.id);
          if (node?.nodeType === 'chapter') chapters.add(node.id);
        }
      }
    }
    return { topicIds: [...topics].sort(), chapterIds: [...chapters].sort() };
  }

  private async syncSourceDocuments(source: RawSource, userId: string): Promise<string[]> {
    const items = await this.repository.listKnowledgeItemsForSource(source.id, userId);
    const notePaths: string[] = [];
    const library = source.metadata.library !== null && typeof source.metadata.library === 'object' && !Array.isArray(source.metadata.library)
      ? source.metadata.library as Record<string, unknown>
      : {};
    const ids = await this.topicAndChapterIds(items, userId);
    const sourceFrontmatter = {
      id: source.id,
      noteType: 'source',
      sourceIds: [source.id],
      itemIds: items.map((item) => item.id),
      topicIds: ids.topicIds,
      chapterIds: ids.chapterIds,
      topicId: ids.topicIds[0] ?? null,
      chapterId: ids.chapterIds[0] ?? null,
      sourceType: source.sourceType,
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourcePlatform: source.sourcePlatform,
      sourceApp: source.sourceApp,
      capturedAt: source.capturedAt,
      citation: library.citation ?? null,
      page: library.page ?? null,
      author: library.author ?? null,
      doi: library.doi ?? null,
      sourceMetadata: source.metadata,
      surroundingContext: source.surroundingContext,
      processingStatus: source.processingStatus,
      errorReason: source.errorReason,
      createdAt: source.createdAt,
      requestId: source.requestId,
      clientId: source.clientId,
      archived: typeof library.archivedAt === 'string' && library.archivedAt.length > 0,
      aiStatus: source.processingStatus,
    };
    const sourcePath = await this.writeLibraryDocument('source', source.id, sourceFrontmatter, source.rawText);
    if (sourcePath !== null) notePaths.push(sourcePath);

    for (const item of items) {
      const itemIds = await this.topicAndChapterIds([item], userId);
      const itemPath = await this.writeLibraryDocument('item', item.id, {
        id: item.id,
        noteType: 'item',
        itemIds: [item.id],
        sourceIds: [source.id],
        topicIds: itemIds.topicIds,
        chapterIds: itemIds.chapterIds,
        topicId: itemIds.topicIds[0] ?? null,
        chapterId: itemIds.chapterIds[0] ?? null,
        title: source.sourceTitle ?? item.id,
        sourceType: source.sourceType,
        sourceTitle: source.sourceTitle,
        sourceUrl: source.sourceUrl,
        sourcePlatform: source.sourcePlatform,
        sourceApp: source.sourceApp,
        capturedAt: source.capturedAt,
        citation: library.citation ?? null,
        page: library.page ?? null,
        author: library.author ?? null,
        doi: library.doi ?? null,
        summary: item.summary,
        confidence: item.confidence,
        itemStatus: item.status,
        isAiDerived: item.isAiDerived,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        archived: typeof library.archivedAt === 'string' && library.archivedAt.length > 0,
        aiStatus: source.processingStatus,
      }, item.normalizedText);
      if (itemPath !== null) notePaths.push(itemPath);
    }
    return notePaths;
  }

  private async migrateLegacyLibrary(): Promise<void> {
    this.migratingLibrary = true;
    try {
      let offset = 0;
      const limit = 200;
      while (true) {
        const sources = await this.repository.listInbox({ userId: this.userId, limit, offset });
        // ponytail: bounded writes keep per-file fsync durability without serializing 1k-note migration.
        for (let index = 0; index < sources.length; index += 24) {
          await Promise.all(sources.slice(index, index + 24).map((source) => this.syncSourceDocuments(source, this.userId)));
        }
        offset += sources.length;
        if (sources.length < limit) break;
      }
    } finally {
      this.migratingLibrary = false;
    }
    await this.saveLegacyMap();
  }

  async syncSource(rawSourceId: string, userId = this.userId): Promise<void> {
    await this.ensureReady();
    const expectedRoot = this.rootPath;
    await this.serializeMutation(async () => {
      const source = await this.repository.findRawSource(rawSourceId, userId);
      if (source === null) return;
      const notePaths = await this.syncSourceDocuments(source, userId);
      await this.saveLegacyMap();
      await this.refreshKnownPaths(notePaths);
    }, expectedRoot);
  }

  async sourceBody(rawSourceId: string): Promise<string | null> {
    await this.ensureReady();
    const notePath = await this.pathForLibraryDocument('source', rawSourceId);
    if (notePath === null) return null;
    const file = this.cache.get(notePath);
    return file === undefined ? null : markdownBody(file.content);
  }

  /** An explicit library edit updates its source note and human-authored item projections. */
  async replaceLibraryContent(rawSourceId: string, body: string, userId = this.userId): Promise<void> {
    await this.ensureReady();
    const expectedRoot = this.rootPath;
    await this.serializeMutation(async () => {
      const source = await this.repository.findRawSource(rawSourceId, userId);
      if (source === null) return;
      const items = await this.repository.listKnowledgeItemsForSource(rawSourceId, userId);
      const writes: Array<{ kind: 'source' | 'item'; id: string }> = [
        { kind: 'source', id: rawSourceId },
        ...items.filter((item) => !item.isAiDerived).map((item) => ({ kind: 'item' as const, id: item.id })),
      ];
      const notePaths: string[] = [];
      for (const entry of writes) {
        const notePath = await this.pathForLibraryDocument(entry.kind, entry.id);
        if (notePath === null) continue;
        const current = await this.getFileInternal(notePath).catch((error) => {
          if (missing(error)) return null;
          throw error;
        });
        if (current === null) continue;
        const prefix = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)\r?\n?/.exec(current.content)?.[0] ?? '';
        const next = `${prefix}${body}`;
        if (next !== current.content) {
          await this.writeFileInternal(notePath, next, current.etag, false);
          notePaths.push(notePath);
        }
      }
      await this.refreshKnownPaths(notePaths);
    }, expectedRoot);
  }

  async semanticFileIndex(): Promise<SemanticNoteFile[]> {
    await this.ensureReady();
    return [...this.cache.values()].map((file) => {
      const frontmatter = file.metadata.frontmatter ?? {};
      const firstHeading = file.metadata.headings?.[0]?.heading;
      const title = typeof frontmatter.title === 'string' ? frontmatter.title : firstHeading ?? basenameWithoutExtension(file.path);
      return {
        path: file.path,
        frontmatter,
        title,
        summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : null,
        links: Object.keys(this.resolvedLinks[file.path] ?? {}),
      };
    });
  }

  private async syncSqlProjection(filePath: string): Promise<void> {
    const file = this.cache.get(filePath);
    const frontmatter = file?.metadata.frontmatter;
    if (file === undefined || frontmatter?.noteType !== 'item' || typeof frontmatter.id !== 'string') return;
    const item = await this.repository.findKnowledgeItem(frontmatter.id, this.userId);
    if (item === null) return;
    const body = markdownBody(file.content);
    const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary : null;
    if (item.normalizedText !== body || item.summary !== summary) {
      await this.repository.updateKnowledgeItem(item.id, this.userId, { normalizedText: body, summary });
    }
    await this.syncItemLinksFromFrontmatter(item, frontmatter);
  }

  private async syncItemLinksFromFrontmatter(item: KnowledgeItem, frontmatter: Record<string, unknown>): Promise<void> {
    const hasRelations = ['topicId', 'topicIds', 'chapterId', 'chapterIds'].some((key) => key in frontmatter);
    if (!hasRelations) return;
    const topicIds = [...new Set([
      ...(typeof frontmatter.topicId === 'string' ? [frontmatter.topicId] : []),
      ...stringArray(frontmatter.topicIds),
    ])];
    const chapterIds = [...new Set([
      ...(typeof frontmatter.chapterId === 'string' ? [frontmatter.chapterId] : []),
      ...stringArray(frontmatter.chapterIds),
    ])];
    const desiredIds = new Set(chapterIds);
    for (const topicId of topicIds) {
      let coveredByChapter = false;
      for (const chapterId of chapterIds) {
        const chapterPath = await this.repository.nodePath(this.userId, chapterId);
        if (chapterPath.some((segment) => segment.id === topicId)) { coveredByChapter = true; break; }
      }
      if (!coveredByChapter) desiredIds.add(topicId);
    }
    const desired: Array<{ id: string; node: KnowledgeNode }> = [];
    for (const id of desiredIds) {
      const node = await this.repository.findNode(id, this.userId);
      const expectedType = chapterIds.includes(id) ? 'chapter' : 'topic';
      if (node === null || node.nodeType !== expectedType || node.status === 'archived') return;
      desired.push({ id, node });
    }
    const existing = await this.repository.listLinksForItem(item.id, this.userId);
    if (desired.length === 0 && existing.length > 0) {
      for (const link of existing) {
        const node = await this.repository.findNode(link.nodeId, this.userId);
        if (node?.nodeType !== 'topic' && node?.nodeType !== 'chapter') return;
      }
    }
    const existingIds = new Set(existing.map((link) => link.nodeId));
    if (existingIds.size === desired.length && desired.every(({ id }) => existingIds.has(id))) return;
    await this.repository.unlinkItemFromNodes(item.id, this.userId);
    const fallback = existing[0];
    for (const { id } of desired) {
      const prior = existing.find((link) => link.nodeId === id) ?? fallback;
      await this.repository.linkItemToNode({
        userId: this.userId,
        itemId: item.id,
        nodeId: id,
        relationType: prior?.relationType ?? 'primary',
        confidence: prior?.confidence ?? item.confidence,
      });
    }
  }

  private defaultLegacyPath(topicId: string, chapterId: string | null): string {
    const topic = encodeURIComponent(topicId);
    const chapter = chapterId === null ? 'topic' : encodeURIComponent(chapterId);
    return `_legacy/${topic}/${chapter}.md`;
  }

  private defaultLibraryPath(kind: 'source' | 'item', id: string): string {
    return `_library/${kind === 'source' ? 'Sources' : 'Items'}/${encodeURIComponent(id)}.md`;
  }

  private async pathExists(relative: string): Promise<boolean> {
    try { await this.safePath(relative, false); return true; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }

  private async safePath(relativeInput: string, allowMissing = true, physicalPaths = this.physicalPaths): Promise<string> {
    const relative = normalizeVaultPath(relativeInput);
    if (relative === '') throw knowledgeError('invalid_request', 'Vault 文件路径不能为空');
    const absolute = path.resolve(this.rootPath, ...relative.split('/'));
    if (absolute !== this.rootPath && !absolute.startsWith(`${this.rootPath}${path.sep}`)) {
      throw knowledgeError('invalid_request', 'Vault 路径不能越出根目录');
    }
    let cursor = this.rootPath;
    let prefix = '';
    const parts = relative.split('/');
    for (const part of parts) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      cursor = physicalPaths.get(prefix) ?? path.join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw knowledgeError('invalid_request', 'Vault 不跟随符号链接');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
      }
    }
    return cursor;
  }

  private async ensureParent(relative: string): Promise<string> {
    await this.assertPathSpelling(relative);
    const parts = relative.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) throw knowledgeError('invalid_request', '文件路径无效');
    let cursor = this.rootPath;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      cursor = this.physicalPaths.get(prefix) ?? path.join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || !info.isDirectory()) throw knowledgeError('invalid_request', 'Vault 目录不安全');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(cursor); }
        catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        }
        const created = await lstat(cursor);
        if (created.isSymbolicLink() || !created.isDirectory()) throw knowledgeError('invalid_request', 'Vault 目录不安全');
      }
    }
    return path.join(cursor, fileName);
  }

  private async atomicWrite(absolute: string, content: string | Buffer, replaceExisting = true): Promise<void> {
    const parent = path.dirname(absolute);
    await mkdir(parent, { recursive: true });
    const temp = path.join(parent, `.noltri-tmp-${randomUUID()}`);
    const handle = await open(temp, 'wx', 0o600);
    let handleClosed = false;
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handleClosed = true;
      if (replaceExisting) await renameFile(temp, absolute);
      else {
        try { await link(temp, absolute); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw knowledgeError('conflict', `目标文件已存在：${absolute}`);
          throw error;
        }
      }
    } finally {
      if (!handleClosed) await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async movePathNoReplace(source: string, target: string, expectedSourceEtag?: string): Promise<void> {
    const sourceInfo = await lstat(source);
    if (sourceInfo.isFile()) {
      const staging = path.join(path.dirname(source), `.noltri-tmp-${randomUUID()}`);
      try { await renameFile(source, staging); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw knowledgeError('conflict', '源文件在重命名期间被外部删除');
        throw error;
      }
      const sourceIsPresent = async (): Promise<boolean> => {
        try { await lstat(source); return true; }
        catch (error) { if (missing(error)) return false; throw error; }
      };
      const restoreSourceIfMissing = async (): Promise<boolean> => {
        try {
          await link(staging, source);
          await unlink(staging);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          return false;
        }
      };
      if (expectedSourceEtag !== undefined && sha256(await readFile(staging)) !== expectedSourceEtag) {
        const restored = await restoreSourceIfMissing();
        throw knowledgeError('conflict', restored ? '源文件在重命名期间被外部修改' : `源文件已变化且无法覆盖新版本；保留副本：${staging}`);
      }
      if (await sourceIsPresent()) {
        throw knowledgeError('conflict', `源文件在重命名期间被外部重新创建；保留副本：${staging}`);
      }
      try { await link(staging, target); }
      catch (error) {
        const restored = await restoreSourceIfMissing();
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw knowledgeError('conflict', restored ? `目标路径已存在：${target}` : `目标路径已存在：${target}；源文件副本保留于 ${staging}`);
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw knowledgeError('invalid_request', '无法安全跨文件系统移动路径');
        throw error;
      }
      if (await sourceIsPresent()) {
        const stagedInfo = await lstat(staging).catch(() => null);
        const targetInfo = await lstat(target).catch(() => null);
        if (stagedInfo !== null && targetInfo?.dev === stagedInfo.dev && targetInfo.ino === stagedInfo.ino) await unlink(target).catch(() => undefined);
        await restoreSourceIfMissing();
        throw knowledgeError('conflict', `源文件在重命名期间被外部重新创建；保留副本：${staging}`);
      }
      await unlink(staging);
      return;
    }
    if (!sourceInfo.isDirectory()) throw knowledgeError('invalid_request', '只能移动普通文件或文件夹');

    // Reserve the absent destination exclusively, then atomically replace only our empty directory.
    try { await mkdir(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw knowledgeError('conflict', `目标路径已存在：${target}`);
      throw error;
    }
    const reservation = await lstat(target);
    try { await renameFile(source, target); }
    catch (error) {
      const current = await lstat(target).catch(() => null);
      if (current?.isDirectory() && current.dev === reservation.dev && current.ino === reservation.ino) {
        await rmdir(target).catch(() => undefined);
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') throw knowledgeError('conflict', `目标路径已存在：${target}`);
      if (code === 'EXDEV') throw knowledgeError('invalid_request', '无法安全跨文件系统移动路径');
      throw error;
    }
  }

  private async scanDirectory(directory: string, relative: string, folders: VaultEntry[], files: VaultEntry[], physicalPaths = this.physicalPaths): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (child.name.startsWith('.noltri-tmp-') || child.name.startsWith('.noltri-trash-') || child.isSymbolicLink()) continue;
      const childName = normalizeVaultPathComponent(child.name);
      const childPath = relative === '' ? childName : `${relative}/${childName}`;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(child.name)) continue;
        const info = await stat(absolute);
        physicalPaths.set(childPath, absolute);
        folders.push({ path: childPath, name: child.name, kind: 'folder', mtime: info.mtimeMs, ctime: info.ctimeMs });
        await this.scanDirectory(absolute, childPath, folders, files, physicalPaths);
      } else if (child.isFile()) {
        const info = await stat(absolute);
        physicalPaths.set(childPath, absolute);
        files.push({ path: childPath, name: child.name, kind: 'file', extension: extensionOf(child.name), mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size });
      }
    }
  }

  private async refresh(force: boolean, watchEvents?: VaultWatchEvent[]): Promise<void> {
    this.refreshQueue = this.refreshQueue.catch(() => undefined).then(() => this.refreshOnce(force, watchEvents));
    return await this.refreshQueue;
  }

  private async refreshKnownPaths(paths: readonly string[]): Promise<void> {
    const uniquePaths = [...new Set(paths.map((filePath) => normalizeVaultPath(filePath)))];
    if (uniquePaths.length === 0) return;
    if (uniquePaths.length > 512) return await this.refresh(true);
    const events = uniquePaths.map((filePath) => {
      const parent = path.posix.dirname(filePath);
      return {
        relativeDirectory: parent === '.' ? '' : parent,
        eventType: 'change',
        fileName: path.posix.basename(filePath),
      };
    });
    await this.refresh(true, events);
  }

  private async refreshWatchEvents(events: VaultWatchEvent[]): Promise<boolean> {
    if (events.length === 0) return false;
    // ponytail: batches above 512 events use a full scan; bulk-import indexing can become incremental later.
    if (events.length > 512) return false;
    const entriesByKey = new Map(this.entries.map((entry) => [pathKey(entry.path), entry]));
    const changes = new Map<string, { path: string; oldEntry: VaultEntry | null; entry: VaultEntry | null; absolute: string | null }>();
    const reconciledParents = new Set<string>();
    const reconcileParent = async (relativeDirectory: string, absoluteDirectory: string): Promise<boolean> => {
      const parentKey = pathKey(relativeDirectory);
      if (reconciledParents.has(parentKey)) return true;
      let children: import('node:fs').Dirent[];
      try { children = await readdir(absoluteDirectory, { withFileTypes: true }); }
      catch { return false; }
      const oldChildren = this.entries.filter((entry) => {
        const directory = path.posix.dirname(entry.path);
        return pathKey(directory === '.' ? '' : directory) === parentKey;
      });
      const diskKeys = new Set<string>();
      const seenNames = new Map<string, string>();
      for (const child of children) {
        if (child.name.startsWith('.noltri-tmp-') || child.name.startsWith('.noltri-trash-') || child.isSymbolicLink()) continue;
        if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name)) continue;
        let name: string;
        try { name = normalizeVaultPathComponent(child.name); }
        catch { return false; }
        const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
        const key = pathKey(relativePath);
        const previousName = seenNames.get(key);
        if (previousName !== undefined && previousName !== child.name) {
          throw knowledgeError('conflict', `Vault 存在大小写或 Unicode 路径冲突：${previousName} / ${child.name}`);
        }
        seenNames.set(key, child.name);
        const oldEntry = entriesByKey.get(key) ?? null;
        if (oldEntry !== null && oldEntry.path !== relativePath) return false;
        const absolute = path.join(absoluteDirectory, child.name);
        if (child.isDirectory()) {
          if (oldEntry?.kind !== 'folder') return false;
          let info;
          try { info = await lstat(absolute); }
          catch { return false; }
          if (!info.isDirectory() || oldEntry.mtime !== info.mtimeMs || oldEntry.ctime !== info.ctimeMs) return false;
          diskKeys.add(key);
          continue;
        }
        if (!child.isFile() || oldEntry?.kind === 'folder') return false;
        let info;
        try { info = await lstat(absolute); }
        catch { return false; }
        if (info.isSymbolicLink() || !info.isFile()) return false;
        diskKeys.add(key);
        if (oldEntry === null) {
          const entry: VaultEntry = { path: relativePath, name: child.name, kind: 'file', extension: extensionOf(child.name), mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size };
          const previous = changes.get(key);
          if (previous !== undefined && (previous.path !== relativePath || previous.absolute !== absolute)) return false;
          changes.set(key, { path: relativePath, oldEntry: null, entry, absolute });
        }
      }
      for (const oldEntry of oldChildren) {
        const key = pathKey(oldEntry.path);
        if (diskKeys.has(key)) continue;
        if (oldEntry.kind === 'folder') return false;
        changes.set(key, { path: oldEntry.path, oldEntry, entry: null, absolute: null });
      }
      reconciledParents.add(parentKey);
      return true;
    };
    for (const event of events) {
      if (event.fileName === null || event.eventType !== 'change' && event.eventType !== 'rename') return false;
      const rawName = Buffer.isBuffer(event.fileName) ? event.fileName.toString() : event.fileName;
      if (rawName === '' || rawName.includes('/') || rawName.includes('\\')) return false;
      if (rawName.startsWith('.noltri-tmp-') || rawName.startsWith('.noltri-trash-')) continue;
      let name: string;
      try { name = normalizeVaultPathComponent(rawName); }
      catch { return false; }
      if (name === '' || name.trim() === '' || name === '.' || name === '..') return false;
      let relativeDirectory: string;
      try { relativeDirectory = normalizeVaultPath(event.relativeDirectory); }
      catch { return false; }
      if (relativeDirectory !== event.relativeDirectory) return false;
      const parentEntry = relativeDirectory === '' ? null : entriesByKey.get(pathKey(relativeDirectory));
      if (relativeDirectory !== '' && (parentEntry?.kind !== 'folder' || parentEntry.path !== relativeDirectory)) return false;
      let absoluteDirectory: string;
      try {
        absoluteDirectory = relativeDirectory === '' ? this.rootPath : await this.safePath(relativeDirectory, false);
        if (!(await lstat(absoluteDirectory)).isDirectory()) return false;
      } catch { return false; }
      if (event.eventType === 'rename') {
        let physicalNames: string[];
        try { physicalNames = await readdir(absoluteDirectory); }
        catch { return false; }
        const canonicalMatches = physicalNames.filter((physicalName) => pathKey(physicalName) === pathKey(rawName));
        if (canonicalMatches.length > 1 || (canonicalMatches.length === 1 && canonicalMatches[0] !== rawName)) return false;
      }

      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const key = pathKey(relativePath);
      const oldEntry = entriesByKey.get(key) ?? null;
      if (oldEntry?.kind === 'folder') return false;
      const previous = changes.get(key);
      if (previous !== undefined && previous.path !== relativePath) return false;
      const mappedAbsolute = oldEntry === null ? null : this.physicalPaths.get(oldEntry.path) ?? null;
      if (mappedAbsolute !== null && path.basename(mappedAbsolute) !== rawName) return false;
      let absolute = mappedAbsolute ?? path.join(absoluteDirectory, rawName);
      if (oldEntry !== null) {
        try { absolute = await this.safePath(oldEntry.path, false); }
        catch (error) {
          if (!missing(error) || !(await reconcileParent(relativeDirectory, absoluteDirectory))) return false;
          continue;
        }
      }
      let info;
      try { info = await lstat(absolute); }
      catch (error) {
        if (oldEntry !== null && missing(error)) {
          if (!(await reconcileParent(relativeDirectory, absoluteDirectory))) return false;
          continue;
        }
        if (oldEntry === null && missing(error)) return false;
        return false;
      }
      if (info.isSymbolicLink() || !info.isFile()) return false;
      const entry: VaultEntry = {
        path: oldEntry?.path ?? relativePath,
        name: path.basename(absolute),
        kind: 'file',
        extension: extensionOf(path.basename(absolute)),
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
        size: info.size,
      };
      if (previous !== undefined && previous.absolute !== absolute) return false;
      changes.set(key, { path: entry.path, oldEntry, entry, absolute });
    }
    if (changes.size === 0) return true;

    const changedKeys = new Set(changes.keys());
    const nextEntries = this.entries.filter((entry) => !changedKeys.has(pathKey(entry.path)));
    const nextPhysicalPaths = new Map(this.physicalPaths);
    for (const change of changes.values()) {
      if (change.oldEntry !== null) nextPhysicalPaths.delete(change.oldEntry.path);
      if (change.entry !== null && change.absolute !== null) {
        nextEntries.push(change.entry);
        nextPhysicalPaths.set(change.entry.path, change.absolute);
      }
    }
    nextEntries.sort((a, b) => a.path.localeCompare(b.path));

    const nextCache = new Map(this.cache);
    const deletedPaths: string[] = [];
    const historyWrites: Array<{ path: string; file: CachedFile }> = [];
    const changedPaths: string[] = [];
    const failureUpdates = new Map<string, { path: string; error: string; at: string } | null>();
    for (const change of changes.values()) {
      const filePath = change.path;
      const old = this.cache.get(filePath);
      if (change.entry === null) {
        if (old !== undefined) {
          historyWrites.push({ path: filePath, file: old });
          nextCache.delete(filePath);
          deletedPaths.push(filePath);
        }
        failureUpdates.set(filePath, null);
        continue;
      }
      const entry = change.entry;
      if (!isMarkdownPath(entry.path)) continue;
      if (change.absolute === null) return false;
      try {
        const absolute = await this.safePath(entry.path, false, nextPhysicalPaths);
        const content = await readFile(absolute, 'utf8');
        const etag = sha256(content);
        let result = this.metadataByHash.get(etag);
        if (result === undefined) {
          if (this.parser === null) throw new Error('Markdown parser worker is not initialized');
          result = await this.parser.parse(content);
          this.metadataByHash.set(etag, result);
        }
        const indexed: CachedFile = {
          path: entry.path, mtime: entry.mtime ?? 0, size: entry.size ?? 0, etag, content, metadata: result.metadata,
          codeRanges: result.codeRanges, frontmatterRange: result.frontmatterRange,
        };
        if (old !== undefined && old.etag !== etag) historyWrites.push({ path: entry.path, file: old });
        nextCache.set(entry.path, indexed);
        if (old?.etag !== etag) changedPaths.push(entry.path);
        failureUpdates.set(entry.path, null);
        this.hashLastUsed.set(etag, Date.now());
      } catch (error) {
        if (missing(error)) return false;
        failureUpdates.set(entry.path, { path: entry.path, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
        if (old !== undefined) nextCache.set(entry.path, old);
      }
    }
    for (const { path: historyPath, file } of historyWrites) await this.addHistory(historyPath, file.content, file.etag, deletedPaths.includes(historyPath));
    for (const entry of nextEntries) {
      if (entry.kind !== 'file') continue;
      const indexed = nextCache.get(entry.path);
      if (indexed?.metadata.frontmatter !== undefined) entry.frontmatter = indexed.metadata.frontmatter;
    }
    const nextLibraryPathByKey = new Map<string, string>();
    const nextSemanticNotePathByKey = new Map<string, string>();
    for (const [filePath, file] of nextCache) {
      const frontmatter = file.metadata.frontmatter;
      if ((frontmatter?.noteType === 'source' || frontmatter?.noteType === 'item') && typeof frontmatter.id === 'string') {
        const key = libraryMapKey(frontmatter.noteType, frontmatter.id);
        if (!nextLibraryPathByKey.has(key)) nextLibraryPathByKey.set(key, filePath);
      }
      if ((frontmatter?.noteType === 'topic' || frontmatter?.noteType === 'chapter')
        && typeof frontmatter.topicId === 'string'
        && (typeof frontmatter.chapterId === 'string' || frontmatter.chapterId === null)) {
        const key = idKey(frontmatter.topicId, frontmatter.chapterId);
        if (!nextSemanticNotePathByKey.has(key)) nextSemanticNotePathByKey.set(key, filePath);
      }
    }
    const oldLinks = JSON.stringify([this.resolvedLinks, this.unresolvedLinks]);
    this.entries = nextEntries;
    this.physicalPaths = nextPhysicalPaths;
    this.cache = nextCache;
    this.libraryPathByKey = nextLibraryPathByKey;
    this.semanticNotePathByKey = nextSemanticNotePathByKey;
    for (const [filePath, failure] of failureUpdates) {
      if (failure === null) this.failedFiles.delete(filePath);
      else this.failedFiles.set(filePath, failure);
    }
    for (const filePath of deletedPaths) this.failedFiles.delete(filePath);
    await this.rebuildLinks();
    for (const filePath of changedPaths) await this.syncSqlProjection(filePath);
    this.attachWatchers();
    this.lastIndexedAt = new Date().toISOString();
    for (const filePath of changedPaths) this.emit('changed', filePath);
    for (const filePath of deletedPaths) this.emit('deleted', filePath);
    if (oldLinks !== JSON.stringify([this.resolvedLinks, this.unresolvedLinks])) this.emit('resolved', '');
    await this.persistHashCache();
    return true;
  }

  private async refreshOnce(force: boolean, watchEvents?: VaultWatchEvent[]): Promise<void> {
    this.indexing = true;
    try {
      if (watchEvents !== undefined && await this.refreshWatchEvents(watchEvents)) return;
      const previousCache = this.cache;
      const folders: VaultEntry[] = [];
      const files: VaultEntry[] = [];
      const nextPhysicalPaths = new Map<string, string>();
      await this.scanDirectory(this.rootPath, '', folders, files, nextPhysicalPaths);
      const knownPaths = new Map<string, string>();
      for (const entry of [...folders, ...files]) {
        const key = pathKey(entry.path);
        const previous = knownPaths.get(key);
        if (previous !== undefined) throw knowledgeError('conflict', `Vault 存在大小写或 Unicode 路径冲突：${previous} / ${entry.path}`);
        knownPaths.set(key, entry.path);
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      folders.sort((a, b) => a.path.localeCompare(b.path));
      const nextCache = new Map<string, CachedFile>();
      const deletedPaths: string[] = [];
      let lastYield = Date.now();
      for (let index = 0; index < files.length; index += 1) {
        const entry = files[index]!;
        if (!isMarkdownPath(entry.path)) continue;
        const old = this.cache.get(entry.path);
        try {
          if (!force && old !== undefined && old.mtime === entry.mtime && old.size === entry.size) {
            nextCache.set(entry.path, old);
            this.failedFiles.delete(entry.path);
            this.hashLastUsed.set(old.etag, Date.now());
            continue;
          }
          const absolute = await this.safePath(entry.path, false, nextPhysicalPaths);
          const content = await readFile(absolute, 'utf8');
          const etag = sha256(content);
          // Keep the last indexed bytes before an external edit replaces them.
          // App writes already snapshot before writing; addHistory's throttle prevents
          // the watcher pass from duplicating that version.
          if (old !== undefined && old.etag !== etag) await this.addHistory(entry.path, old.content, old.etag);
          let result = this.metadataByHash.get(etag);
          if (result === undefined) {
            if (this.parser === null) throw new Error('Markdown parser worker is not initialized');
            result = await this.parser.parse(content);
            this.metadataByHash.set(etag, result);
          }
          this.hashLastUsed.set(etag, Date.now());
          nextCache.set(entry.path, {
            path: entry.path, mtime: entry.mtime ?? 0, size: entry.size ?? 0, etag, content, metadata: result.metadata,
            codeRanges: result.codeRanges, frontmatterRange: result.frontmatterRange,
          });
          this.failedFiles.delete(entry.path);
        } catch (error) {
          this.failedFiles.set(entry.path, { path: entry.path, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
          // A transient read/parser failure must not evict a previously indexed note.
          if (old !== undefined) nextCache.set(entry.path, old);
        }
        if (Date.now() - lastYield >= 100) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYield = Date.now();
        }
      }
      for (const [oldPath, oldFile] of this.cache) {
        if (nextCache.has(oldPath)) continue;
        const stillOnDisk = files.some((entry) => entry.path === oldPath);
        if (stillOnDisk) continue;
        // An external deletion is destructive. Preserve the last indexed bytes
        // even inside the normal 60s throttle window; exact duplicate snapshots
        // are deduplicated by addHistory below.
        await this.addHistory(oldPath, oldFile.content, oldFile.etag, true);
        deletedPaths.push(oldPath);
      }
      const nextLibraryPathByKey = new Map<string, string>();
      const nextSemanticNotePathByKey = new Map<string, string>();
      for (const [filePath, file] of nextCache) {
        const frontmatter = file.metadata.frontmatter;
        if ((frontmatter?.noteType === 'source' || frontmatter?.noteType === 'item') && typeof frontmatter.id === 'string') {
          const key = libraryMapKey(frontmatter.noteType, frontmatter.id);
          if (!nextLibraryPathByKey.has(key)) nextLibraryPathByKey.set(key, filePath);
        }
        if ((frontmatter?.noteType === 'topic' || frontmatter?.noteType === 'chapter')
          && typeof frontmatter.topicId === 'string'
          && (typeof frontmatter.chapterId === 'string' || frontmatter.chapterId === null)) {
          const key = idKey(frontmatter.topicId, frontmatter.chapterId);
          if (!nextSemanticNotePathByKey.has(key)) nextSemanticNotePathByKey.set(key, filePath);
        }
      }
      const changedPaths: string[] = [];
      for (const entry of files) {
        const indexed = nextCache.get(entry.path);
        if (indexed === undefined) continue;
        const frontmatter = indexed.metadata.frontmatter;
        if (frontmatter !== undefined) entry.frontmatter = frontmatter;
        if (previousCache.get(entry.path)?.etag !== indexed.etag) changedPaths.push(entry.path);
      }
      // Publish a complete path/index snapshot atomically; readers must never see a cleared or partial physical-path map.
      this.physicalPaths = nextPhysicalPaths;
      this.entries = [...folders, ...files];
      this.cache = nextCache;
      this.libraryPathByKey = nextLibraryPathByKey;
      this.semanticNotePathByKey = nextSemanticNotePathByKey;
      const oldLinks = JSON.stringify([this.resolvedLinks, this.unresolvedLinks]);
      await this.rebuildLinks();
      for (const filePath of changedPaths) await this.syncSqlProjection(filePath);
      this.attachWatchers();
      this.lastIndexedAt = new Date().toISOString();
      // Publish file revisions only after the matching metadata, link, and SQL indexes are ready.
      for (const filePath of changedPaths) this.emit('changed', filePath);
      for (const filePath of deletedPaths) this.emit('deleted', filePath);
      if (oldLinks !== JSON.stringify([this.resolvedLinks, this.unresolvedLinks])) this.emit('resolved', '');
      await this.persistHashCache();
    } finally { this.indexing = false; }
  }

  private attachWatchers(): void {
    if (this.closed) return;
    const generation = this.watcherGeneration;
    const directories = [
      { absolute: this.rootPath, relative: '' },
      ...this.entries.filter((entry) => entry.kind === 'folder').map((entry) => ({
        absolute: this.physicalPaths.get(entry.path) ?? path.join(this.rootPath, ...entry.path.split('/')),
        relative: entry.path,
      })),
    ];
    const keep = new Set(directories.map(({ absolute }) => absolute));
    for (const [directory, watcher] of this.watchers) {
      if (keep.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const { absolute, relative } of directories) {
      if (this.watchers.has(absolute)) continue;
      try {
        const watcher = watchDirectory(absolute, (eventType, fileName) => {
          if (this.closed || generation !== this.watcherGeneration) return;
          if (this.pendingWatchEvents.length <= 512) this.pendingWatchEvents.push({ relativeDirectory: relative, eventType, fileName });
          else if (this.pendingWatchEvents[0]?.fileName !== null) this.pendingWatchEvents = [{ relativeDirectory: '', eventType: 'overflow', fileName: null }];
          if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            const events = this.pendingWatchEvents;
            this.pendingWatchEvents = [];
            void this.refresh(true, events).catch(() => undefined);
          }, 45);
        });
        watcher.on('error', () => {
          if (generation !== this.watcherGeneration) return;
          watcher.close();
          this.watchers.delete(absolute);
          if (!this.closed) void this.refresh(true).catch(() => undefined);
        });
        this.watchers.set(absolute, watcher);
      } catch { /* a transiently removed folder is discovered by the next parent event */ }
    }
  }

  private emit(kind: 'changed' | 'resolved' | 'deleted', filePath: string): void {
    this.revision += 1;
    this.changes.push({ revision: this.revision, kind, path: filePath });
    if (this.changes.length > CHANGE_LIMIT) this.changes.splice(0, this.changes.length - CHANGE_LIMIT);
  }

  private async ensureReady(): Promise<void> { if (!this.ready) await this.initialize(); }

  private collisionPath(relative: string, except?: string): string | null {
    const key = pathKey(relative);
    const canonical = normalizeVaultPathComponent;
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index).join('/');
      const collision = this.entries.find((entry) => entry.path !== except
        && pathKey(entry.path) === pathKey(prefix)
        && canonical(entry.path) !== prefix);
      if (collision !== undefined) return collision.path;
    }
    for (const entry of this.entries) {
      if (entry.path === except) continue;
      if (pathKey(entry.path) === key) return entry.path;
      if (pathKey(path.posix.dirname(entry.path)) === pathKey(path.posix.dirname(relative)) && pathKey(entry.name) === pathKey(path.posix.basename(relative))) return entry.path;
    }
    return null;
  }

  private async assertPathSpelling(relative: string): Promise<void> {
    let cursor = this.rootPath;
    let prefix = '';
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      let children: string[];
      try { children = await readdir(cursor); }
      catch (error) {
        if (missing(error)) return;
        throw error;
      }
      const part = parts[index]!;
      const matches = children.filter((name) => pathKey(name) === pathKey(part));
      if (matches.length > 1) throw knowledgeError('conflict', `Vault 路径组件存在大小写或 Unicode 冲突：${prefix || part}`);
      const existing = matches[0];
      if (existing === undefined) return;
      const canonicalName = normalizeVaultPathComponent(existing);
      if (canonicalName !== part) throw knowledgeError('conflict', `Vault 路径组件大小写冲突：${prefix ? `${prefix}/` : ''}${existing}`);
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      cursor = this.physicalPaths.get(prefix) ?? path.join(cursor, existing);
      this.physicalPaths.set(prefix, cursor);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw knowledgeError('invalid_request', 'Vault 不跟随符号链接');
      if (index < parts.length - 1 && !info.isDirectory()) throw knowledgeError('conflict', `路径组件不是文件夹：${prefix}`);
    }
  }

  private resolveLinkFromCache(linkpathInput: string, sourcePathInput: string, moved: Map<string, string> = new Map()): string | null {
    const sourcePath = normalizeVaultPath(sourcePathInput);
    const files = this.entries.filter((entry) => entry.kind === 'file').map((entry) => ({ entry, path: moved.get(entry.path) ?? entry.path }));
    const hashToPath = new Map(files.map(({ path: filePath }) => [pathKey(filePath), filePath]));
    const raw = linkpathInput.trim().replace(/^!/, '');
    const withoutAlias = raw.split('|', 1)[0] ?? '';
    const target = withoutAlias.split('#', 1)[0]?.trim() ?? '';
    if (target === '') return sourcePath;
    const rootTarget = target.startsWith('/');
    const hasDirectory = target.includes('/') || target.startsWith('./') || target.startsWith('../') || rootTarget;
    const direct = rootTarget ? target.slice(1) : hasDirectory ? path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target)) : target;
    const candidateNames = new Set([direct.normalize('NFC')]);
    if (path.posix.extname(direct) === '') candidateNames.add(`${direct}.md`);
    for (const candidate of candidateNames) {
      if (candidate === '..' || candidate.startsWith('../')) continue;
      const match = hashToPath.get(pathKey(candidate));
      if (match !== undefined) return match;
    }
    if (hasDirectory) return null;
    const targetKey = pathKey(target);
    const wantedBase = pathKey(basenameWithoutExtension(target));
    const candidates = files.filter(({ entry, path: filePath }) =>
      pathKey(filePath) === targetKey ||
      pathKey(path.posix.basename(filePath)) === targetKey ||
      pathKey(basenameWithoutExtension(filePath)) === wantedBase ||
      this.aliasesOf(entry.path).some((alias) => pathKey(alias) === targetKey),
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!.path;
    const sourceDir = path.posix.dirname(sourcePath);
    const wantedSuffix = targetKey.replace(/^.*\//, '');
    candidates.sort((a, b) => {
      const rank = (filePath: string): [number, number, number, string] => [
        pathKey(filePath).endsWith(wantedSuffix) ? 0 : 1,
        pathKey(path.posix.dirname(filePath)) === pathKey(sourceDir) ? 0 : 1,
        filePath.length,
        filePath,
      ];
      const aa = rank(a.path); const bb = rank(b.path);
      return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]! || String(aa[3]).localeCompare(String(bb[3]));
    });
    return candidates[0]?.path ?? null;
  }

  private resolveMarkdownUrl(linkpath: string, sourcePath: string, moved: Map<string, string> = new Map()): string | null {
    const hash = linkpath.indexOf('#');
    const resource = hash < 0 ? linkpath : linkpath.slice(0, hash);
    const query = resource.indexOf('?');
    const rawPath = query < 0 ? resource : resource.slice(0, query);
    try {
      if (rawPath.startsWith('//')) return null;
      const decoded = decodeURIComponent(rawPath);
      if (decoded === '') return normalizeVaultPath(sourcePath);
      const candidate = path.posix.normalize(decoded.startsWith('/')
        ? decoded.slice(1)
        : path.posix.join(path.posix.dirname(sourcePath), decoded));
      if (candidate === '..' || candidate.startsWith('../')) return null;
      const candidates = [candidate, ...(path.posix.extname(candidate) === '' ? [`${candidate}.md`] : [])];
      const files = new Map<string, string>();
      for (const entry of this.entries) {
        if (entry.kind !== 'file') continue;
        const targetPath = moved.get(entry.path) ?? entry.path;
        files.set(pathKey(entry.path), targetPath);
        files.set(pathKey(targetPath), targetPath);
      }
      for (const item of candidates) {
        const target = files.get(pathKey(item));
        if (target !== undefined) return target;
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveNoteLink(link: NoteLink, sourcePath: string, moved: Map<string, string> = new Map()): string | null {
    return link.kind === 'markdown'
      ? this.resolveMarkdownUrl(link.link, sourcePath, moved)
      : this.resolveLinkFromCache(link.link, sourcePath, moved);
  }

  private markdownLinkTextFor(targetPath: string, sourcePath: string, originalTarget: string, moved: Map<string, string>): string {
    const effectiveTarget = moved.get(targetPath) ?? targetPath;
    const hasExtension = path.posix.extname(originalTarget) !== '';
    const target = hasExtension || !isMarkdownPath(effectiveTarget) ? effectiveTarget : effectiveTarget.replace(/\.md$/i, '');
    const absolute = `/${target}`;
    const relativePath = path.posix.relative(path.posix.dirname(sourcePath), target);
    let relative = relativePath;
    if (this.newLinkFormat === 'absolute') return absolute;
    if (this.newLinkFormat === 'relative') return relative.startsWith('../') ? relative : `./${relative}`;
    const basename = path.posix.basename(target);
    const candidates = [basename, relative, absolute].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return candidates.find((candidate) => this.resolveMarkdownUrl(candidate, sourcePath, moved) === effectiveTarget) ?? absolute;
  }

  private aliasesOf(filePath: string): string[] {
    const value = this.cache.get(filePath)?.metadata.frontmatter;
    if (value === null || typeof value !== 'object') return [];
    const aliases = (value as Record<string, unknown>).aliases ?? (value as Record<string, unknown>).alias;
    if (typeof aliases === 'string') return [aliases];
    return Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === 'string') : [];
  }

  private async rebuildLinks(): Promise<void> {
    const resolved: Record<string, Record<string, number>> = {};
    const unresolved: Record<string, Record<string, number>> = {};
    const bySource = new Map<string, Array<{ target: string | null; linkpath: string; position: NonNullable<CachedNoteMetadata['links']>[number]['position']; original: string; kind: string; embed: boolean }>>();
    let lastYield = Date.now();
    for (const [sourcePath, file] of this.cache) {
      const refs: Array<{ target: string | null; linkpath: string; position: NonNullable<CachedNoteMetadata['links']>[number]['position']; original: string; kind: string; embed: boolean }> = [];
      for (const link of file.metadata.links ?? []) {
        const target = this.resolveNoteLink(link, sourcePath);
        refs.push({ target, linkpath: link.link, position: link.position, original: link.original, kind: link.kind, embed: link.isEmbed === true });
        const index = target === null ? unresolved : resolved;
        const key = target ?? (link.link.split('#', 1)[0] ?? link.link);
        const bucket = index[sourcePath] ?? (index[sourcePath] = {});
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
      bySource.set(sourcePath, refs);
      if (Date.now() - lastYield >= 100) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
    }
    this.resolvedLinks = resolved;
    this.unresolvedLinks = unresolved;
    this.linksBySource = bySource;
  }

  async snapshot(): Promise<VaultSnapshot> {
    await this.ensureReady();
    return { rootPath: this.rootPath, files: this.entries, revision: this.revision };
  }

  async openVault(rootPathInput: string): Promise<VaultSnapshot> {
    await this.ensureReady();
    return await this.serializeMutation(() => this.openVaultInternal(rootPathInput), null);
  }

  private async openVaultInternal(rootPathInput: string): Promise<VaultSnapshot> {
    if (!path.isAbsolute(rootPathInput)) throw knowledgeError('invalid_request', 'Vault 目录必须是绝对路径');
    const requested = path.resolve(rootPathInput);
    await mkdir(requested, { recursive: true });
    const nextRoot = await realpath(requested);
    this.watcherGeneration += 1;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingWatchEvents = [];
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.refreshQueue.catch(() => undefined);
    this.rootPath = nextRoot;
    this.newLinkFormat = this.settingsByRoot.get(sha256(this.rootPath)) ?? 'shortest';
    this.settingsByRoot.set(sha256(this.rootPath), this.newLinkFormat);
    await this.persistSettings();
    this.cache.clear();
    this.entries = [];
    this.physicalPaths.clear();
    this.historyIndex.clear();
    this.historyIndexLoaded = false;
    this.legacyMap = {};
    this.propertyTypes = {};
    this.propertyTypesConfig = {};
    this.propertyTypesMalformed = false;
    this.legacyMapFile = this.mapFileFor(this.rootPath);
    await this.loadPropertyTypes();
    await this.loadLegacyMap();
    await this.loadHashCache(this.rootPath);
    await this.refresh(true);
    await this.migrateLegacyNotes();
    await this.migrateLegacyLibrary();
    await this.refresh(true);
    return this.snapshot();
  }

  async getSettings(requestRoot?: string): Promise<VaultSettings> {
    if (requestRoot !== undefined && !path.isAbsolute(requestRoot)) {
      throw knowledgeError('invalid_request', 'Vault 目录必须是绝对路径');
    }
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(async () => this.settingsValue(), expectedRoot);
  }

  private settingsValue(): VaultSettings {
    return { newLinkFormat: this.newLinkFormat, propertyTypes: { ...this.propertyTypes } };
  }

  async updateSettings(settings: VaultSettings, requestRoot?: string): Promise<VaultSettings> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(async () => {
      if (settings.propertyTypes !== undefined) await this.persistPropertyTypes({ ...this.propertyTypes, ...settings.propertyTypes });
      this.newLinkFormat = settings.newLinkFormat;
      this.settingsByRoot.set(sha256(this.rootPath), this.newLinkFormat);
      await this.persistSettings();
      return this.settingsValue();
    }, expectedRoot);
  }

  private async persistSettings(): Promise<void> {
    await this.atomicWrite(this.settingsFile, JSON.stringify({ rootPath: this.rootPath, newLinkFormat: this.newLinkFormat, vaults: Object.fromEntries(this.settingsByRoot) }, null, 2));
  }

  private async loadPropertyTypes(): Promise<void> {
    for (const relative of ['.noltri/types.json', '.obsidian/types.json']) {
      let absolute: string;
      try { absolute = await this.safePath(relative, false); }
      catch (error) {
        if (missing(error)) continue;
        this.propertyTypesMalformed = true;
        return;
      }
      let value: unknown;
      try { value = JSON.parse(await readFile(absolute, 'utf8')); }
      catch {
        this.propertyTypesMalformed = true;
        return;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        this.propertyTypesMalformed = true;
        return;
      }
      this.propertyTypesConfig = value as Record<string, unknown>;
      const validTypes = new Set(['text', 'number', 'boolean', 'list', 'yaml']);
      this.propertyTypes = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, VaultPropertyTypes[string]] => validTypes.has(String(entry[1]))));
      return;
    }
  }

  private async persistPropertyTypes(propertyTypes: VaultPropertyTypes): Promise<void> {
    if (this.propertyTypesMalformed) throw knowledgeError('invalid_request', 'Vault 属性类型配置无法解析或路径不安全；请先修复配置再保存');
    const relative = '.noltri/types.json';
    let existing: Record<string, unknown> = this.propertyTypesConfig;
    try {
      const absolute = await this.safePath(relative, false);
      const value: unknown = JSON.parse(await readFile(absolute, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('types.json must contain an object');
      existing = { ...existing, ...(value as Record<string, unknown>) };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const absolute = await this.ensureParent(relative);
    await this.safePath(relative, true);
    const merged = { ...existing, ...propertyTypes };
    await this.atomicWrite(absolute, JSON.stringify(merged, null, 2));
    this.propertyTypesConfig = merged;
    this.propertyTypes = propertyTypes;
    this.propertyTypesMalformed = false;
  }

  async createFolder(pathInput: string, requestRoot?: string): Promise<{ path: string }> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.createFolderInternal(pathInput), expectedRoot);
  }

  private async createFolderInternal(pathInput: string): Promise<{ path: string }> {
    const relative = normalizeVaultPath(pathInput);
    if (relative === '') throw knowledgeError('invalid_request', '文件夹路径不能为空');
    await this.assertPathSpelling(relative);
    const collision = this.collisionPath(relative);
    if (collision !== null) throw knowledgeError('conflict', `目标路径已存在或与现有路径大小写冲突：${collision}`);
    let cursor = this.rootPath;
    let prefix = '';
    for (const part of relative.split('/')) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      cursor = this.physicalPaths.get(prefix) ?? path.join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || !info.isDirectory()) throw knowledgeError('conflict', `路径已被非文件夹占用：${prefix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(cursor);
      }
    }
    await this.refresh(true);
    return { path: relative };
  }

  async getFile(relativeInput: string): Promise<NoteFile> {
    await this.ensureReady();
    return await this.getFileInternal(relativeInput);
  }

  private async getFileInternal(relativeInput: string): Promise<NoteFile> {
    const relative = normalizeVaultPath(relativeInput);
    let absolute: string;
    try { absolute = await this.safePath(relative, false); }
    catch (error) {
      if (missing(error)) throw knowledgeError('not_found', `Vault 文件不存在：${relative}`);
      throw error;
    }
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    if (!info.isFile()) throw knowledgeError('invalid_request', 'Vault 文件接口只读取普通文件');
    let currentBytes = bytes;
    let currentInfo = info;
    let cached = this.cache.get(relative);
    if (isMarkdownPath(relative) && cached?.etag !== sha256(bytes)) {
      await this.refresh(true);
      const refreshedPath = await this.safePath(relative, false);
      [currentBytes, currentInfo] = await Promise.all([readFile(refreshedPath), stat(refreshedPath)]);
      cached = this.cache.get(relative);
    }
    const content = currentBytes.toString('utf8');
    return {
      path: relative, content, mtime: currentInfo.mtimeMs, ctime: currentInfo.ctimeMs, size: currentInfo.size, etag: sha256(currentBytes),
      ...(cached === undefined ? {} : { metadata: cached.metadata }),
    };
  }

  async getAsset(relativeInput: string): Promise<VaultAsset> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    const absolute = await this.safePath(relative, false);
    const info = await stat(absolute);
    if (!info.isFile()) throw knowledgeError('invalid_request', '附件路径必须是普通文件');
    if (info.size > 10 * 1024 * 1024) throw knowledgeError('invalid_request', '附件预览限制为 10 MiB');
    const bytes = await readFile(absolute);
    const types: Record<string, string> = {
      '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
      '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.png': 'image/png', '.wav': 'audio/wav',
      '.webm': 'video/webm', '.webp': 'image/webp', '.mp4': 'video/mp4',
    };
    const mimeType = types[path.posix.extname(relative).toLowerCase()] ?? 'application/octet-stream';
    return { path: relative, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
  }

  private async writeFileInternal(relativeInput: string, content: string, expectedEtag: string | undefined, refresh: boolean): Promise<NoteFile> {
    const relative = normalizeVaultPath(relativeInput);
    const collision = this.collisionPath(relative);
    if (collision !== null && collision !== relative) throw knowledgeError('conflict', `Vault 中已有大小写或 Unicode 冲突路径：${collision}`);
    const absolute = await this.safePath(relative, true);
    let current: NoteFile | null = null;
    try { current = await this.getFileInternal(relative); }
    catch (error) { if (!missing(error)) throw error; }
    if (current !== null && expectedEtag === undefined) {
      if (current.content === content) return current;
      throw knowledgeError('conflict', '文件已经存在，请先读取最新版本并携带 etag 保存');
    }
    if (current !== null && expectedEtag !== current.etag) throw knowledgeError('conflict', '文件已被其他编辑更新，请刷新后再保存');
    if (current === null && expectedEtag !== undefined) throw knowledgeError('conflict', '文件已被删除，请刷新后再保存');
    if (current !== null) await this.addHistory(relative, current.content, current.etag);
    const target = await this.ensureParent(relative);
    if (current !== null) {
      const latest = await readFile(target, 'utf8');
      if (sha256(latest) !== current.etag) throw knowledgeError('conflict', '文件在保存期间被外部程序修改');
    }
    await this.atomicWrite(target, content, current !== null);
    const info = await stat(target);
    if (refresh) await this.refreshKnownPaths([relative]);
    return { path: relative, content, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, etag: sha256(content), ...(this.cache.get(relative) === undefined ? {} : { metadata: this.cache.get(relative)!.metadata }) };
  }

  async writeFile(relative: string, content: string, expectedEtag?: string, requestRoot?: string): Promise<NoteFile> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.writeFileInternal(relative, content, expectedEtag, true), expectedRoot);
  }

  private async directoryTree(relative: string): Promise<DirectoryTree> {
    const root = await this.safePath(relative, false);
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw knowledgeError('invalid_request', '路径不是普通文件夹');
    const records: Array<[string, 'file' | 'folder', string?, number?]> = [];
    const files: DirectoryFile[] = [];
    const visit = async (folderPath: string, absolute: string): Promise<void> => {
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const childPath = normalizeVaultPath(`${folderPath}/${child.name}`);
        const childAbsolute = await this.safePath(childPath, false);
        const info = await lstat(childAbsolute);
        if (info.isSymbolicLink()) throw knowledgeError('invalid_request', `目录包含符号链接，无法安全删除：${childPath}`);
        if (info.isDirectory()) {
          records.push([childPath, 'folder']);
          await visit(childPath, childAbsolute);
        } else if (info.isFile()) {
          const bytes = await readFile(childAbsolute);
          const etag = sha256(bytes);
          records.push([childPath, 'file', etag, bytes.byteLength]);
          files.push({ path: childPath, bytes, etag });
        } else {
          throw knowledgeError('invalid_request', `目录包含无法安全删除的文件类型：${childPath}`);
        }
      }
    };
    await visit(relative, root);
    return { etag: sha256(JSON.stringify([this.rootPath, relative, records])), files };
  }

  private backlinkCountFor(targets: ReadonlySet<string>, deletingSources: ReadonlySet<string>): number {
    let count = 0;
    for (const [source, refs] of this.linksBySource) {
      if (deletingSources.has(source)) continue;
      count += refs.filter((ref) => ref.target !== null && targets.has(ref.target)).length;
    }
    return count;
  }

  private async orphanAttachmentsFor(deletingPaths: ReadonlySet<string>, deletingSources: ReadonlySet<string>): Promise<VaultDeletePreview['orphanAttachments']> {
    const orphanByPath = new Map<string, VaultDeletePreview['orphanAttachments'][number]>();
    for (const source of deletingSources) {
      for (const ref of this.linksBySource.get(source) ?? []) {
        const target = ref.target;
        if (target === null || deletingPaths.has(target) || isMarkdownPath(target)) continue;
        const entry = this.entries.find((candidate) => candidate.kind === 'file' && candidate.path === target);
        if (entry === undefined || orphanByPath.has(target)) continue;
        const survives = [...this.linksBySource.entries()].some(([sourcePath, refs]) =>
          !deletingSources.has(sourcePath) && refs.some((candidate) => candidate.target === target));
        if (survives) continue;
        const bytes = await readFile(await this.safePath(target, false));
        orphanByPath.set(target, { path: target, name: entry.name, etag: sha256(bytes), size: bytes.byteLength });
      }
    }
    return [...orphanByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async deletePreview(relativeInput: string): Promise<VaultDeletePreview> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    await this.refresh(true);
    const absolute = await this.safePath(relative, false);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw knowledgeError('invalid_request', 'Vault 不跟随符号链接');
    if (info.isDirectory()) {
      const tree = await this.directoryTree(relative);
      const deletingPaths = new Set(tree.files.map((file) => file.path));
      const deletingSources = new Set(tree.files.filter((file) => isMarkdownPath(file.path)).map((file) => file.path));
      const targets = new Set(deletingSources);
      return {
        path: relative, etag: tree.etag, kind: 'folder', descendantCount: tree.files.length,
        backlinkCount: this.backlinkCountFor(targets, deletingSources),
        orphanAttachments: await this.orphanAttachmentsFor(deletingPaths, deletingSources),
      };
    }
    if (!info.isFile()) throw knowledgeError('invalid_request', '删除预览只支持普通文件或文件夹');
    const bytes = await readFile(absolute);
    const deletingSources = new Set(isMarkdownPath(relative) ? [relative] : []);
    const deletingPaths = new Set([relative]);
    return {
      path: relative, etag: sha256(bytes), kind: 'file', descendantCount: 1,
      backlinkCount: this.backlinkCountFor(new Set(isMarkdownPath(relative) ? [relative] : []), deletingSources),
      orphanAttachments: await this.orphanAttachmentsFor(deletingPaths, deletingSources),
    };
  }

  async deleteFile(relativeInput: string, expectedEtag?: string, orphanPolicy: 'never' | 'always' | 'ask' = 'ask', requestRoot?: string): Promise<{ path: string; deletedAttachments: string[] }> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.deleteFileInternal(relativeInput, expectedEtag, orphanPolicy), expectedRoot);
  }

  private async deleteFileInternal(relativeInput: string, expectedEtag?: string, orphanPolicy: 'never' | 'always' | 'ask' = 'ask'): Promise<{ path: string; deletedAttachments: string[] }> {
    const relative = normalizeVaultPath(relativeInput);
    const absolute = await this.safePath(relative, false);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw knowledgeError('invalid_request', 'Vault 不跟随符号链接');
    const removed: Array<{ path: string; bytes: Buffer }> = [];
    let deletedAttachments: string[] = [];
    let dirtyPaths: string[] = [];
    if (info.isDirectory()) {
      const preview = await this.deletePreview(relative);
      if (expectedEtag === undefined || preview.etag !== expectedEtag) throw knowledgeError('conflict', '文件夹内容已经变化或缺少 etag，请重新预览后再删除');
      if (orphanPolicy === 'ask' && preview.orphanAttachments.length > 0) {
        throw knowledgeError('conflict', '删除后会留下孤儿附件，请确认后使用 always 或选择 never');
      }
      const tree = await this.directoryTree(relative);
      if (tree.etag !== expectedEtag) throw knowledgeError('conflict', '文件夹内容在删除期间被外部修改');
      for (const file of tree.files) {
        const content = isMarkdownPath(file.path) ? file.bytes.toString('utf8') : file.bytes;
        await this.addHistory(file.path, content, file.etag, true);
      }
      const externalAttachments: Array<{ path: string; bytes: Buffer; etag: string }> = [];
      if (orphanPolicy === 'always') {
        for (const attachment of preview.orphanAttachments) {
          const bytes = await readFile(await this.safePath(attachment.path, false));
          const etag = sha256(bytes);
          if (etag !== attachment.etag) throw knowledgeError('conflict', `附件 ${attachment.path} 在删除期间被外部修改`);
          await this.addHistory(attachment.path, bytes, etag, true);
          externalAttachments.push({ path: attachment.path, bytes, etag });
        }
      }
      if ((await this.directoryTree(relative)).etag !== expectedEtag) throw knowledgeError('conflict', '文件夹内容在删除期间被外部修改');
      for (const attachment of externalAttachments) {
        if (sha256(await readFile(await this.safePath(attachment.path, false))) !== attachment.etag) {
          throw knowledgeError('conflict', `附件 ${attachment.path} 在删除期间被外部修改`);
        }
      }
      const staged: Array<{ original: string; trash: string }> = [];
      const stage = async (original: string): Promise<void> => {
        const trash = path.join(this.rootPath, `.noltri-trash-${randomUUID()}`);
        await renameFile(original, trash);
        staged.push({ original, trash });
      };
      try {
        await stage(absolute);
        for (const attachment of externalAttachments) await stage(await this.safePath(attachment.path, false));
        await this.refresh(true);
      } catch (error) {
        const rollbackFailures: string[] = [];
        for (const item of staged.reverse()) {
          try {
            await lstat(item.original);
            rollbackFailures.push(item.original);
          } catch (cause) {
            if (!missing(cause)) { rollbackFailures.push(item.original); continue; }
            try { await renameFile(item.trash, item.original); }
            catch { rollbackFailures.push(item.original); }
          }
        }
        await this.refresh(true).catch(() => undefined);
        if (rollbackFailures.length > 0) throw knowledgeError('internal_error', `文件夹删除已取消，但回滚未完成；历史备份已保留：${rollbackFailures.join(', ')}`);
        throw error;
      }
      await Promise.all(staged.map(({ trash }) => rm(trash, { recursive: true })));
      deletedAttachments = externalAttachments.map(({ path: filePath }) => filePath);
    } else {
      const preview = await this.deletePreview(relative);
      if (expectedEtag === undefined || preview.etag !== expectedEtag) throw knowledgeError('conflict', '文件已被其他程序修改或缺少 etag，请刷新后再删除');
      if (orphanPolicy === 'ask' && preview.orphanAttachments.length > 0) {
        throw knowledgeError('conflict', '删除后会留下孤儿附件，请确认后使用 always 或选择 never');
      }
      const targets = orphanPolicy === 'always' ? [...preview.orphanAttachments] : [];
      const removalPaths = [relative, ...targets.map((item) => item.path)];
      dirtyPaths = removalPaths;
      for (const targetPath of removalPaths) {
        const bytes = await readFile(await this.safePath(targetPath, false));
        const targetEtag = sha256(bytes);
        const expected = targetPath === relative ? expectedEtag : targets.find((item) => item.path === targetPath)?.etag;
        if (targetEtag !== expected) throw knowledgeError('conflict', `文件 ${targetPath} 在删除期间被外部修改`);
        await this.addHistory(targetPath, bytes, targetEtag, true);
        removed.push({ path: targetPath, bytes });
      }
      try {
        for (const item of removed) await rm(await this.safePath(item.path, false));
      } catch (error) {
        for (const item of removed) {
          try { await this.atomicWrite(await this.safePath(item.path, true), item.bytes); }
          catch { /* recovery copy remains in history */ }
        }
        throw error;
      }
      deletedAttachments = targets.map((item) => item.path);
    }
    if (info.isDirectory()) await this.refresh(true);
    else await this.refreshKnownPaths(dirtyPaths);
    return { path: relative, deletedAttachments };
  }

  async getMetadata(relativeInput: string): Promise<CachedNoteMetadata | null> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    return this.cache.get(relative)?.metadata ?? null;
  }

  async getLinks(): Promise<NoteLinksResponse> {
    await this.ensureReady();
    return { revision: this.revision, resolvedLinks: this.resolvedLinks, unresolvedLinks: this.unresolvedLinks };
  }

  async resolveLink(linkpath: string, sourcePath: string, kind: 'wikilink' | 'markdown' = 'wikilink'): Promise<string | null> {
    await this.ensureReady();
    const source = normalizeVaultPath(sourcePath);
    return kind === 'markdown' ? this.resolveMarkdownUrl(linkpath, source) : this.resolveLinkFromCache(linkpath, source);
  }

  async getBacklinks(relativeInput: string): Promise<NoteBacklinksResponse> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    const backlinks: NoteBacklinksResponse['backlinks'] = [];
    for (const [sourcePath, refs] of this.linksBySource) {
      const matches = refs.filter((ref) => ref.target === relative);
      if (matches.length > 0) backlinks.push({ sourcePath, count: matches.length, positions: matches.map((ref) => ref.position) });
    }
    return { revision: this.revision, backlinks: backlinks.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)) };
  }

  async graph(): Promise<VaultGraph> {
    await this.ensureReady();
    const nodes: VaultGraph['nodes'] = [];
    const known = new Set<string>();
    for (const entry of this.entries) {
      if (entry.kind !== 'file') continue;
      const markdown = this.cache.get(entry.path);
      const isNote = markdown !== undefined;
      const headings = markdown?.metadata.headings ?? [];
      nodes.push({
        path: entry.path,
        title: headings[0]?.heading ?? titleOf(entry.path),
        basename: basenameWithoutExtension(entry.path),
        type: isNote ? 'note' : 'attachment',
        ...(entry.extension === undefined ? {} : { extension: entry.extension }),
        ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }),
        ...(entry.ctime === undefined ? {} : { ctime: entry.ctime }),
        tags: (markdown?.metadata.tags ?? []).map((tag) => tag.tag),
      });
      known.add(entry.path);
    }
    const edges: VaultGraph['edges'] = [];
    for (const [sourcePath, targets] of Object.entries(this.resolvedLinks)) {
      for (const [targetPath, count] of Object.entries(targets)) edges.push({ sourcePath, targetPath, count, resolved: true, mtime: this.cache.get(sourcePath)?.mtime });
    }
    const unresolvedNodes = new Map<string, string>();
    for (const [sourcePath, targets] of Object.entries(this.unresolvedLinks)) {
      for (const [targetText, count] of Object.entries(targets)) {
        const targetPath = `unresolved:${targetText}`;
        unresolvedNodes.set(targetPath, targetText);
        edges.push({ sourcePath, targetPath, count, resolved: false, mtime: this.cache.get(sourcePath)?.mtime });
      }
    }
    for (const [unresolvedPath, title] of unresolvedNodes) nodes.push({ path: unresolvedPath, title, basename: title, type: 'unresolved', tags: [] });
    return { nodes, edges, revision: this.revision };
  }

  async changesAfter(after: number): Promise<VaultChangesResponse> {
    await this.ensureReady();
    const oldest = this.changes[0]?.revision ?? this.revision;
    const reset = after > 0 && after < oldest - 1;
    return {
      revision: this.revision,
      reset,
      events: reset ? [] : this.changes.filter((event) => event.revision > after).map(({ kind, path: filePath }) => ({ kind, path: filePath })),
    };
  }

  async diagnostics(): Promise<VaultDiagnostics> {
    await this.ensureReady();
    return {
      revision: this.revision,
      indexing: this.indexing,
      queued: this.parser?.queued ?? 0,
      failedFiles: [...this.failedFiles.values()].sort((a, b) => a.path.localeCompare(b.path)),
      lastIndexedAt: this.lastIndexedAt,
      cache: { loaded: this.cacheLoaded, persisted: this.cachePersisted, entries: this.metadataByHash.size },
      worker: { restarts: this.parser?.restarts ?? 0, timeouts: this.parser?.timeouts ?? 0 },
    };
  }

  private linkTextFor(targetPath: string, sourcePath: string, originalTarget: string, moved: Map<string, string>): string {
    const hasExtension = path.posix.extname(originalTarget) !== '';
    const effectiveTarget = moved.get(targetPath) ?? targetPath;
    const preserveExtension = hasExtension || !isMarkdownPath(effectiveTarget);
    const formattedPath = (value: string) => preserveExtension ? value : value.replace(/\.md$/i, '');
    const absolute = `/${formattedPath(effectiveTarget)}`;
    let relative = formattedPath(path.posix.relative(path.posix.dirname(sourcePath), effectiveTarget));
    if (!relative.startsWith('../') && !relative.startsWith('./')) relative = `./${relative}`;
    if (this.newLinkFormat === 'absolute') return absolute;
    if (this.newLinkFormat === 'relative') return relative;

    const basename = formattedPath(path.posix.basename(effectiveTarget));
    const candidates = [basename, relative, absolute].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return candidates.find((candidate) => this.resolveLinkFromCache(candidate, sourcePath, moved) === effectiveTarget) ?? absolute;
  }

  private rewrittenToken(original: string, targetPath: string, sourcePath: string, oldPath: string, moved: Map<string, string>): string {
    if (original.includes('[[')) {
      const match = /^(!?\[\[)([\s\S]*)(\]\])$/.exec(original);
      if (match === null) return original;
      const inner = match[2] ?? '';
      const aliasIndex = inner.indexOf('|');
      const linkWithSubpath = aliasIndex < 0 ? inner : inner.slice(0, aliasIndex);
      const alias = aliasIndex < 0 ? null : inner.slice(aliasIndex + 1);
      const hash = linkWithSubpath.indexOf('#');
      const originalTarget = hash < 0 ? linkWithSubpath : linkWithSubpath.slice(0, hash);
      const subpath = hash < 0 ? '' : linkWithSubpath.slice(hash);
      const nextTarget = this.linkTextFor(targetPath, sourcePath, originalTarget, moved);
      const nextAlias = alias === basenameWithoutExtension(oldPath) ? basenameWithoutExtension(moved.get(oldPath) ?? oldPath) : alias;
      return `${match[1]}${nextTarget}${subpath}${nextAlias === null ? '' : `|${nextAlias}`}${match[3]}`;
    }
    const match = /^(!?\[[^\]]*\]\()([^\s)]+)([\s\S]*\))$/.exec(original);
    if (match === null) return original;
    const oldTarget = match[2] ?? '';
    const suffixStart = oldTarget.search(/[?#]/);
    const oldLinkPath = suffixStart < 0 ? oldTarget : oldTarget.slice(0, suffixStart);
    const suffix = suffixStart < 0 ? '' : oldTarget.slice(suffixStart);
    let nextTarget = this.markdownLinkTextFor(targetPath, sourcePath, oldLinkPath, moved);
    if (oldLinkPath.includes('%')) nextTarget = nextTarget.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${match[1]}${nextTarget}${suffix}${match[3]}`;
  }

  private rewriteYamlText(content: string, sourcePath: string, nextSourcePath: string, moved: Map<string, string>): string {
    return rewriteYamlLinks(content, (_key, value) => value.replace(/(!?\[\[[^\]]+\]\])/g, (original) => {
      const inner = original.replace(/^!?\[\[/, '').replace(/\]\]$/, '');
      const targetText = (inner.split('|', 1)[0] ?? '').split('#', 1)[0] ?? '';
      const resolved = this.resolveLinkFromCache(targetText, sourcePath);
      if (resolved === null) return original;
      const nextTargetPath = moved.get(resolved) ?? resolved;
      if (nextTargetPath === resolved && nextSourcePath === sourcePath) return original;
      return this.rewrittenToken(original, nextTargetPath, nextSourcePath, resolved, moved);
    }));
  }

  private rewriteReferences(sourcePath: string, content: string, nextSourcePath: string, moved: Map<string, string>): string {
    const cached = this.cache.get(sourcePath);
    if (cached === undefined) return content;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const link of cached.metadata.links ?? []) {
      if (link.kind === 'frontmatter') continue;
      const target = this.resolveNoteLink(link, sourcePath);
      if (target === null) continue;
      const nextTarget = moved.get(target) ?? target;
      if (nextTarget === target && nextSourcePath === sourcePath) continue;
      replacements.push({
        start: link.position.start.offset,
        end: link.position.end.offset,
        value: this.rewrittenToken(link.original, nextTarget, nextSourcePath, target, moved),
      });
    }
    let rewritten = rewriteLinkOccurrences(content, replacements);
    if (content.slice(0, 4).includes('---') && /\[\[[^\]]+\]\]/.test(content.slice(0, 100_000))) {
      rewritten = this.rewriteYamlText(rewritten, sourcePath, nextSourcePath, moved);
    }
    return rewritten;
  }

  async renamePath(pathInput: string, newPathInput: string, expectedEtag?: string, requestRoot?: string): Promise<{ path: string }> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.renamePathInternal(pathInput, newPathInput, expectedEtag), expectedRoot);
  }

  private async renamePathInternal(pathInput: string, newPathInput: string, expectedEtag?: string): Promise<{ path: string }> {
    const oldPath = normalizeVaultPath(pathInput);
    const newPath = normalizeVaultPath(newPathInput);
    if (oldPath === newPath) return { path: newPath };
    await this.assertPathSpelling(newPath);
    const oldAbsolute = await this.safePath(oldPath, false);
    const info = await lstat(oldAbsolute);
    if (info.isSymbolicLink()) throw knowledgeError('invalid_request', 'Vault 不跟随符号链接');
    if (info.isDirectory()) {
      if (expectedEtag === undefined || (await this.directoryTree(oldPath)).etag !== expectedEtag) {
        throw knowledgeError('conflict', '文件夹内容已变化或缺少 etag，请重新预览后再重命名');
      }
    } else if (expectedEtag !== undefined && sha256(await readFile(oldAbsolute)) !== expectedEtag) {
      throw knowledgeError('conflict', '文件已被其他编辑更新，请刷新后再重命名');
    }
    if (info.isDirectory() && pathKey(newPath).startsWith(`${pathKey(oldPath)}/`)) throw knowledgeError('invalid_request', '目录不能移动到自己的子目录');
    const collision = this.collisionPath(newPath, oldPath);
    if (collision !== null) throw knowledgeError('conflict', `目标路径已存在或与现有路径大小写冲突：${collision}`);
    const newAbsolute = await this.safePath(newPath, true);
    try { await lstat(newAbsolute); throw knowledgeError('conflict', `目标路径已存在：${newPath}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.ensureParent(newPath);
    await this.refresh(true);

    const moved = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.kind !== 'file') continue;
      if (entry.path === oldPath || info.isDirectory() && entry.path.startsWith(`${oldPath}/`)) {
        moved.set(entry.path, `${newPath}${entry.path.slice(oldPath.length)}`);
      }
    }
    const rewrites = new Map<string, { nextPath: string; original: string; rewritten: string; etag: string }>();
    for (const [sourcePath, file] of this.cache) {
      const nextSourcePath = moved.get(sourcePath) ?? sourcePath;
      const rewritten = this.rewriteReferences(sourcePath, file.content, nextSourcePath, moved);
      if (rewritten !== file.content) rewrites.set(sourcePath, { nextPath: nextSourcePath, original: file.content, rewritten, etag: file.etag });
    }

    const snapshots = new Map<string, CachedFile>();
    for (const old of moved.keys()) {
      const file = this.cache.get(old);
      if (file !== undefined) snapshots.set(old, file);
    }
    for (const source of rewrites.keys()) {
      const file = this.cache.get(source);
      if (file !== undefined) snapshots.set(source, file);
    }
    const historySeed = snapshots.keys().next().value as string | undefined;
    if (historySeed !== undefined) await this.historyFor(historySeed);
    await Promise.all([...snapshots].map(([relative, file]) => this.addHistory(relative, file.content, file.etag, true)));

    // Recheck every source that will be rewritten. If another editor changed it during planning,
    // cancel before moving anything; a watcher event will re-index the new content.
    await Promise.all([...rewrites].map(async ([source, plan]) => {
      const absolute = await this.safePath(source, false);
      if (sha256(await readFile(absolute, 'utf8')) !== plan.etag) throw knowledgeError('conflict', `文件 ${source} 在重命名期间被外部修改`);
    }));
    if (info.isDirectory() && (await this.directoryTree(oldPath)).etag !== expectedEtag) {
      throw knowledgeError('conflict', '文件夹内容在重命名期间被外部修改');
    }
    await this.movePathNoReplace(oldAbsolute, newAbsolute, info.isFile() ? expectedEtag : undefined);
    const committed: Array<{ path: string; original: string }> = [];
    const previousLegacyMap = { ...this.legacyMap };
    let failedPath = newPath;
    try {
      const written = await Promise.allSettled([...rewrites].map(async ([source, plan]) => {
        const destination = moved.get(source) ?? source;
        const absolute = await this.safePath(destination, false);
        const current = await readFile(absolute, 'utf8');
        if (current !== plan.original) throw knowledgeError('conflict', `文件 ${destination} 在重命名期间被外部修改`);
        await this.atomicWrite(absolute, plan.rewritten);
        committed.push({ path: destination, original: plan.original });
      }));
      const writeFailure = written.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (writeFailure !== undefined) {
        failedPath = committed.at(-1)?.path ?? newPath;
        throw writeFailure.reason;
      }
      for (const [key, mapped] of Object.entries(this.legacyMap)) {
        if (mapped === oldPath || info.isDirectory() && mapped.startsWith(`${oldPath}/`)) this.legacyMap[key] = `${newPath}${mapped.slice(oldPath.length)}`;
      }
      await this.saveLegacyMap();
    } catch (error) {
      this.legacyMap = previousLegacyMap;
      const rollbackFailures: string[] = [];
      for (const entry of committed.reverse()) {
        try { await this.atomicWrite(await this.safePath(entry.path, false), entry.original); }
        catch { rollbackFailures.push(entry.path); }
      }
      try { await this.movePathNoReplace(newAbsolute, oldAbsolute); }
      catch { rollbackFailures.push(newPath); }
      if (rollbackFailures.length > 0) {
        throw knowledgeError('internal_error', `重命名失败，历史备份已保留；回滚未完成：${[failedPath, ...rollbackFailures].join(', ')}`);
      }
      throw error;
    }
    const changedPaths = [oldPath, newPath, ...rewrites.keys(), ...[...rewrites.values()].map((plan) => plan.nextPath)];
    await this.refreshKnownPaths(changedPaths);
    return { path: newPath };
  }

  async renameBlock(relativeInput: string, oldId: string, newId: string, expectedEtag?: string, requestRoot?: string): Promise<RenameVaultBlockResponse> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.renameBlockInternal(relativeInput, oldId, newId, expectedEtag), expectedRoot);
  }

  private async renameBlockInternal(relativeInput: string, oldId: string, newId: string, expectedEtag?: string): Promise<RenameVaultBlockResponse> {
    const relative = normalizeVaultPath(relativeInput);
    if (!/^[A-Za-z0-9-]+$/.test(oldId) || !/^[A-Za-z0-9-]+$/.test(newId) || oldId === newId) {
      throw knowledgeError('invalid_request', '块 ID 只能包含英文字母、数字和连字符，且新旧 ID 必须不同');
    }
    const target = this.cache.get(relative);
    if (target === undefined) throw knowledgeError('not_found', `笔记不存在：${relative}`);
    if (expectedEtag === undefined || target.etag !== expectedEtag) throw knowledgeError('conflict', '笔记已被修改或缺少 etag，请刷新后再改块 ID');
    const block = target.metadata.blocks?.[oldId];
    if (block === undefined) throw knowledgeError('not_found', `块 ID 不存在：${oldId}`);
    if (target.metadata.blocks?.[newId] !== undefined) throw knowledgeError('conflict', `块 ID 已存在：${newId}`);

    const edits = new Map<string, { etag: string; original: string; replacements: Array<{ start: number; end: number; value: string }> }>();
    const targetEdits = { etag: target.etag, original: target.content, replacements: [] as Array<{ start: number; end: number; value: string }> };
    const definition = target.content.slice(block.position.start.offset, block.position.end.offset);
    const marker = new RegExp(`\\^${escapeRegex(oldId)}(?=$|\\s)`);
    const markerMatch = marker.exec(definition);
    if (markerMatch === null) throw knowledgeError('conflict', `块 ${oldId} 的定义位置已失效`);
    const markerStart = block.position.start.offset + markerMatch.index;
    targetEdits.replacements.push({ start: markerStart, end: markerStart + markerMatch[0].length, value: `^${newId}` });
    edits.set(relative, targetEdits);

    for (const file of this.cache.values()) {
      for (const link of file.metadata.links ?? []) {
        if (this.resolveNoteLink(link, file.path) !== relative) continue;
        const match = new RegExp(`#\\^${escapeRegex(oldId)}(?=[|\\]\\)])`, 'i').exec(link.original);
        if (match === null) continue;
        const replacements = edits.get(file.path) ?? { etag: file.etag, original: file.content, replacements: [] };
        replacements.replacements.push({ start: link.position.start.offset + match.index, end: link.position.start.offset + match.index + match[0].length, value: `#^${newId}` });
        edits.set(file.path, replacements);
      }
    }
    const plans = [...edits].map(([filePath, edit]) => ({ path: filePath, ...edit, rewritten: rewriteLinkOccurrences(edit.original, edit.replacements) }));
    for (const plan of plans) await this.addHistory(plan.path, plan.original, plan.etag, true);
    for (const plan of plans) {
      const actual = await readFile(await this.safePath(plan.path, false), 'utf8');
      if (sha256(actual) !== plan.etag) throw knowledgeError('conflict', `文件 ${plan.path} 在块 ID 更新期间被外部修改`);
    }
    const committed: Array<{ path: string; original: string }> = [];
    try {
      for (const plan of plans) {
        await this.atomicWrite(await this.safePath(plan.path, false), plan.rewritten);
        committed.push({ path: plan.path, original: plan.original });
      }
    } catch (error) {
      for (const plan of committed.reverse()) {
        try { await this.atomicWrite(await this.safePath(plan.path, false), plan.original); }
        catch { /* pre-change snapshots remain available in history */ }
      }
      throw error;
    }
    await this.refreshKnownPaths(plans.map((plan) => plan.path));
    const saved = await this.getFile(relative);
    return {
      file: saved,
      updatedFiles: plans.filter((plan) => plan.path !== relative).map((plan) => ({ path: plan.path, etag: this.cache.get(plan.path)?.etag ?? sha256(plan.rewritten) })),
      revision: this.revision,
    };
  }

  async search(query: string, limit = 1000): Promise<NoteSearchResponse> {
    await this.ensureReady();
    const files = this.entries.filter((entry) => entry.kind === 'file').map((entry) => {
      const cached = this.cache.get(entry.path);
      return { path: entry.path, title: cached?.metadata.headings?.[0]?.heading ?? titleOf(entry.path), content: cached?.content ?? '', metadata: cached?.metadata ?? {} };
    });
    const results = searchNotes(query, files, limit);
    return { revision: this.revision, query, results, paths: results.map((hit) => hit.path) };
  }

  async matchPaths(query: string): Promise<{ revision: number; paths: string[]; matchingTags: string[]; attachmentPaths: string[] }> {
    await this.ensureReady();
    const result = await this.search(query, Number.MAX_SAFE_INTEGER);
    return {
      revision: this.revision,
      paths: result.results.map((hit) => hit.path),
      matchingTags: matchingTagNodes(query, [...this.cache.values()].flatMap((file) => file.metadata.tags?.map((tag) => tag.tag) ?? [])),
      attachmentPaths: result.results.filter((hit) => !isMarkdownPath(hit.path)).map((hit) => hit.path),
    };
  }

  async switcher(query: string, limit = 100): Promise<NoteSearchResponse> {
    await this.ensureReady();
    const results = this.entries.filter((entry) => entry.kind === 'file').flatMap((entry) => {
      const cached = this.cache.get(entry.path);
      const title = cached?.metadata.headings?.[0]?.heading ?? titleOf(entry.path);
      const score = Math.max(fuzzyScore(query, title) ?? Number.NEGATIVE_INFINITY, fuzzyScore(query, entry.path) ?? Number.NEGATIVE_INFINITY);
      return Number.isFinite(score) ? [{ path: entry.path, title, score, matches: [], snippet: '', titleMatches: [], snippetMatches: [], matchedTags: [] }] : [];
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
    return { revision: this.revision, query, results };
  }

  async mentions(relativeInput: string): Promise<NoteMentionResponse> {
    await this.ensureReady();
    const target = normalizeVaultPath(relativeInput);
    const file = this.cache.get(target);
    if (file === undefined) throw knowledgeError('not_found', `笔记不存在：${target}`);
    const names = new Set([basenameWithoutExtension(target), ...this.aliasesOf(target)].filter((name) => name.trim() !== ''));
    const mentions: NoteMentionResponse['mentions'] = [];
    for (const source of this.cache.values()) {
      if (source.path === target) continue;
      const existing = this.linksBySource.get(source.path) ?? [];
      const ranges = [
        ...(source.metadata.links ?? []).map((link) => ({ start: link.position.start.offset, end: link.position.end.offset })),
        ...source.codeRanges,
        ...(source.frontmatterRange ? [source.frontmatterRange] : []),
      ];
      const positions: Array<{ start: number; end: number }> = [];
      for (const name of names) {
        const matcher = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(name)}(?![A-Za-z0-9_])`, 'giu');
        for (const match of source.content.matchAll(matcher)) {
          const start = match.index ?? 0; const end = start + (match[0]?.length ?? 0);
          if (ranges.some((range) => start < range.end && end > range.start)) continue;
          if (existing.some((ref) => ref.target === target && start < ref.position.end.offset && end > ref.position.start.offset)) continue;
          positions.push({ start, end });
        }
      }
      if (positions.length > 0) mentions.push({ sourcePath: source.path, positions: positions.sort((a, b) => a.start - b.start).map((range) => positionIn(source.content, range.start, range.end)) });
    }
    return { mentions: mentions.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)) };
  }

  private async addHistory(relative: string, content: string | Buffer, etag: string, force = false): Promise<void> {
    const history = await this.historyFor(relative);
    const now = Date.now();
    const storedContent = Buffer.isBuffer(content) ? content.toString('base64') : content;
    if (history[0]?.etag === etag && history[0]?.content === storedContent) return;
    const latestAt = history[0] === undefined ? 0 : Date.parse(history[0].createdAt);
    if (!force && Number.isFinite(latestAt) && now - latestAt < HISTORY_THROTTLE_MS) return;
    const version: SavedVersion = {
      id: randomUUID(), path: relative, rootPath: this.rootPath, createdAt: new Date(now).toISOString(), etag,
      content: storedContent,
      ...(Buffer.isBuffer(content) ? { encoding: 'base64' as const } : {}),
    };
    await this.atomicWrite(path.join(this.historyDir, `${version.id}.json`), JSON.stringify(version), false);
    const updated = [version, ...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.historyIndex.set(relative, updated);
    const cutoff = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const kept: SavedVersion[] = [];
    for (const old of updated) {
      if (Date.parse(old.createdAt) < cutoff || kept.length >= HISTORY_LIMIT) {
        await rm(path.join(this.historyDir, `${old.id}.json`), { force: true });
      } else kept.push(old);
    }
    this.historyIndex.set(relative, kept);
  }

  private async historyFor(relative: string): Promise<SavedVersion[]> {
    if (!this.historyIndexLoaded) {
      this.historyIndex.clear();
      const names = await readdir(this.historyDir).catch(() => []);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const value = parseHistoryVersion(JSON.parse(await readFile(path.join(this.historyDir, name), 'utf8')) as unknown, name, this.rootPath);
          if (value === null) continue;
          const versions = this.historyIndex.get(value.path) ?? [];
          versions.push(value);
          this.historyIndex.set(value.path, versions);
        } catch { /* ignore an incomplete external file */ }
      }
      for (const versions of this.historyIndex.values()) versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.historyIndexLoaded = true;
    }
    return this.historyIndex.get(relative) ?? [];
  }

  async history(relativeInput: string): Promise<NoteHistoryResponse> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    const versions = await this.historyFor(relative);
    return { versions: versions.map(({ id, createdAt, etag }) => ({ id, createdAt, etag })) };
  }

  async historyVersion(relativeInput: string, versionId: string): Promise<NoteFile> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    if (!isHistoryId(versionId)) throw knowledgeError('invalid_request', '历史版本 id 无效');
    const version = (await this.historyFor(relative)).find((candidate) => candidate.id === versionId);
    if (version === undefined) throw knowledgeError('not_found', '历史版本不存在或已过期');
    if (version.encoding === 'base64') throw knowledgeError('invalid_request', '二进制历史版本不能作为文本预览');
    const metadata = isMarkdownPath(relative) ? await this.parser?.parse(version.content) : undefined;
    return {
      path: relative,
      content: version.content,
      mtime: Date.parse(version.createdAt),
      size: Buffer.byteLength(version.content),
      etag: version.etag,
      ...(metadata === undefined ? {} : { metadata: metadata.metadata }),
    };
  }

  async restoreHistory(relativeInput: string, versionId: string, expectedEtag?: string, requestRoot?: string): Promise<NoteFile> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.restoreHistoryInternal(relativeInput, versionId, expectedEtag), expectedRoot);
  }

  private async restoreHistoryInternal(relativeInput: string, versionId: string, expectedEtag?: string): Promise<NoteFile> {
    const relative = normalizeVaultPath(relativeInput);
    if (!isHistoryId(versionId)) throw knowledgeError('invalid_request', '历史版本 id 无效');
    const versions = await this.historyFor(relative);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (version === undefined) throw knowledgeError('not_found', '历史版本不存在或已过期');
    if (version.encoding === 'base64') {
      const absolute = await this.safePath(relative, true);
      let current: Buffer | null = null;
      try { current = await readFile(await this.safePath(relative, false)); }
      catch (error) { if (!missing(error)) throw error; }
      if (current !== null && (expectedEtag === undefined || sha256(current) !== expectedEtag)) throw knowledgeError('conflict', '文件已被其他编辑更新，请刷新后再恢复');
      if (current === null && expectedEtag !== undefined) throw knowledgeError('conflict', '文件已被删除，请刷新后再恢复');
      if (current !== null) await this.addHistory(relative, current, sha256(current), true);
      const bytes = Buffer.from(version.content, 'base64');
      await this.atomicWrite(absolute, bytes, current !== null);
      const info = await stat(absolute);
      await this.refreshKnownPaths([relative]);
      return { path: relative, content: '', mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, etag: sha256(bytes) };
    }
    let current: NoteFile | null = null;
    try { current = await this.getFile(relative); }
    catch (error) { if (!missing(error)) throw error; }
    if (current !== null && expectedEtag !== current.etag) throw knowledgeError('conflict', '文件已被其他编辑更新，请刷新后再恢复');
    if (current === null && expectedEtag !== undefined) throw knowledgeError('conflict', '文件已被删除，请刷新后再恢复');
    if (current !== null && current.content !== version.content) await this.addHistory(relative, current.content, current.etag, true);
    return await this.writeFileInternal(relative, version.content, current?.etag, true);
  }

  private async legacyPathInternal(topicId: string, chapterId: string | null, refresh: boolean): Promise<{ path: string; exists: boolean }> {
    const key = idKey(topicId, chapterId);
    const mapped = this.legacyMap[key];
    if (mapped !== undefined) return { path: mapped, exists: await this.pathExists(mapped) };
    const topic = await this.repository.findNode(topicId, this.userId);
    const chapter = chapterId === null ? null : await this.repository.findNode(chapterId, this.userId);
    if (topic?.nodeType !== 'topic' || chapterId !== null && chapter?.nodeType !== 'chapter') {
      const filePath = this.defaultLegacyPath(topicId, chapterId);
      return { path: filePath, exists: await this.pathExists(filePath) };
    }
    const base = this.defaultLegacyPath(topicId, chapterId);
    let filePath = base;
    for (let collision = 1; await this.pathExists(filePath); collision += 1) {
      const ext = path.posix.extname(base);
      filePath = `${base.slice(0, -ext.length)}-${String(collision)}${ext}`;
    }
    const legacy = await this.repository.getKnowledgeNote(this.userId, topicId, chapterId);
    const title = chapter?.title ?? topic.title;
    const noteType = chapterId === null ? 'topic' : 'chapter';
    await this.writeFileInternal(filePath, this.documentWithFrontmatter(legacy?.content ?? `# ${title}\n`, {
      id: chapterId ?? topicId, noteType, topicId, chapterId, title,
    }), undefined, false);
    this.legacyMap[key] = filePath;
    await this.saveLegacyMap();
    if (refresh) await this.refreshKnownPaths([filePath]);
    return { path: filePath, exists: true };
  }

  async legacyPath(topicId: string, chapterId: string | null): Promise<{ path: string; exists: boolean }> {
    await this.ensureReady();
    const mapped = this.legacyMap[idKey(topicId, chapterId)];
    if (mapped !== undefined) return { path: mapped, exists: await this.pathExists(mapped) };
    const expectedRoot = this.rootPath;
    return await this.serializeMutation(() => this.legacyPathInternal(topicId, chapterId, true), expectedRoot);
  }

  async getLegacyNote(topicId: string, chapterId: string | null): Promise<{ content: string; updatedAt: string | null; etag: string | null; path: string }> {
    const mapped = await this.legacyPath(topicId, chapterId);
    if (!mapped.exists) return { content: '', updatedAt: null, etag: null, path: mapped.path };
    const note = await this.getFile(mapped.path);
    return { content: markdownBody(note.content), updatedAt: new Date(note.mtime).toISOString(), etag: note.etag, path: note.path };
  }

  async saveLegacyNote(
    topicId: string,
    chapterId: string | null,
    content: string,
    expectedEtag?: string,
    properties?: Record<string, unknown>,
    requestRoot?: string,
  ): Promise<{ content: string; updatedAt: string; etag: string; path: string }> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.saveLegacyNoteInternal(topicId, chapterId, content, expectedEtag, properties), expectedRoot);
  }

  private async saveLegacyNoteInternal(
    topicId: string,
    chapterId: string | null,
    content: string,
    expectedEtag?: string,
    properties?: Record<string, unknown>,
  ): Promise<{ content: string; updatedAt: string; etag: string; path: string }> {
    const mapped = await this.legacyPathInternal(topicId, chapterId, false);
    let current: NoteFile | null = null;
    try { current = await this.getFileInternal(mapped.path); }
    catch (error) { if (!missing(error)) throw error; }
    if (expectedEtag !== undefined && current?.etag !== expectedEtag) throw knowledgeError('conflict', '文件已被其他编辑更新，请刷新后再保存');
    if (current === null && expectedEtag !== undefined) throw knowledgeError('conflict', '文件已被删除，请刷新后再保存');
    const currentContent = current?.content ?? '';
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)\r?\n?/.exec(currentContent);
    if (currentContent.startsWith('---\n') || currentContent.startsWith('---\r\n')) {
      const document = frontmatterMatch === null ? null : parseDocument(frontmatterMatch[1] ?? '');
      if (document === null || document.errors.length > 0 || document.contents !== null && !isMap(document.contents)) {
        throw knowledgeError('invalid_request', 'Frontmatter YAML 无法解析；已停止更新元数据以保留原文');
      }
    }
    const currentFrontmatter = current === null ? {} : parseFrontmatterValue(current.content);
    const identityMatches = currentFrontmatter.id === (chapterId ?? topicId)
      && currentFrontmatter.noteType === (chapterId === null ? 'topic' : 'chapter')
      && currentFrontmatter.topicId === topicId
      && currentFrontmatter.chapterId === chapterId;
    let next: string;
    if (properties === undefined && current !== null && frontmatterMatch !== null && identityMatches) {
      next = `${frontmatterMatch[0]}${content}`;
    } else {
      const topic = await this.repository.findNode(topicId, this.userId);
      if (topic === null || topic.nodeType !== 'topic') throw knowledgeError('not_found', `主题 ${topicId} 不存在`);
      const chapter = chapterId === null ? null : await this.repository.findNode(chapterId, this.userId);
      if (chapterId !== null && (chapter === null || chapter.nodeType !== 'chapter')) throw knowledgeError('not_found', `章节 ${chapterId} 不存在`);
      const nextProperties = properties === undefined
        ? userGraphNoteProperties(currentFrontmatter)
        : userGraphNoteProperties(properties);
      const header = this.documentWithFrontmatter('', {
        ...nextProperties,
        id: chapterId ?? topicId,
        noteType: chapterId === null ? 'topic' : 'chapter',
        topicId,
        chapterId,
        title: chapter?.title ?? topic.title,
      }, true);
      next = `${header}${content}`;
    }
    const saved = await this.writeFileInternal(mapped.path, next, current?.etag, true);
    this.legacyMap[idKey(topicId, chapterId)] = mapped.path;
    await this.saveLegacyMap();
    const note = await this.repository.saveKnowledgeNote({ userId: this.userId, topicId, chapterId, content });
    return { content, updatedAt: note.updatedAt || new Date(saved.mtime).toISOString(), etag: saved.etag, path: saved.path };
  }

  async restoreLegacyNote(topicId: string, chapterId: string | null, requestRoot?: string): Promise<NoteFile> {
    const expectedRoot = await this.mutationRootForCall(requestRoot);
    return await this.serializeMutation(() => this.restoreLegacyNoteInternal(topicId, chapterId), expectedRoot);
  }

  private async restoreLegacyNoteInternal(topicId: string, chapterId: string | null): Promise<NoteFile> {
    const archived = await this.repository.getKnowledgeNote(this.userId, topicId, chapterId);
    if (archived === null) throw knowledgeError('not_found', 'SQLite 中没有可恢复的旧笔记');
    const key = idKey(topicId, chapterId);
    const relative = this.legacyMap[key] ?? this.defaultLegacyPath(topicId, chapterId);
    if (await this.pathExists(relative)) throw knowledgeError('conflict', '目标 Markdown 文件已存在，恢复不会覆盖它');
    const restored = await this.writeFileInternal(relative, archived.content, undefined, false);
    this.legacyMap[key] = relative;
    await this.saveLegacyMap();
    await this.refreshKnownPaths([relative]);
    return restored;
  }

  async resolveSubpath(relativeInput: string, subpath: string): Promise<ReturnType<typeof resolveSubpath>> {
    await this.ensureReady();
    const relative = normalizeVaultPath(relativeInput);
    const file = this.cache.get(relative);
    if (file === undefined) return null;
    return resolveSubpath(file.content, file.metadata, subpath);
  }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
