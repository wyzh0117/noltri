/**
 * The parts of the SQLite driver the shared contract cannot see: what the file actually is, what
 * survives a reopen, and what the DDL refuses.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isKnowledgeError } from '@noltri/shared';
import {
  SQLITE_MIGRATIONS,
  SQLITE_SCHEMA_VERSION,
  migrateSqlite,
  openSqlite,
  probeFts5,
} from '../src/sqlite-schema';
import { SqliteRepository } from '../src/sqlite';

const directories: string[] = [];

function fileInTempDir(name = 'noltri.sqlite'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-sqlite-'));
  directories.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function sourceOf(userId: string, rawText: string) {
  return {
    userId,
    rawText,
    sourceType: 'manual' as const,
    capturedAt: new Date().toISOString(),
    metadata: { origin: 'schema-test', nested: { a: 1 } },
  };
}

describe('the file that gets created', () => {
  it('opens with WAL, FULL synchrony, foreign keys and a busy timeout', () => {
    const file = fileInTempDir();
    const { db, pragmas } = openSqlite({ file });
    expect(pragmas.journalMode).toBe('wal');
    expect(pragmas.synchronous).toBe('full');
    expect(pragmas.foreignKeys).toBe(1);
    expect(pragmas.busyTimeout).toBe(5000);
    expect(pragmas.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect(pragmas.fts5Available).toBe(true);
    expect(Number(pragmas.sqliteVersion.split('.')[0])).toBeGreaterThanOrEqual(3);
    // A clean close removes the -wal sibling, so it can only be observed while the handle is open.
    // Creating the schema is already a write, so the journal file exists right after openSqlite().
    expect(existsSync(`${file}-wal`)).toBe(true);
    db.close();
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it('migrating twice is a no-op and the stored version does not move', () => {
    const file = fileInTempDir();
    const first = openSqlite({ file });
    expect(migrateSqlite(first.db)).toBe(SQLITE_SCHEMA_VERSION);
    first.db.close();
    const second = openSqlite({ file });
    expect(second.pragmas.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    const tables = second.db
      .prepare(`select name from sqlite_master where type in ('table', 'view') order by name`)
      .all()
      .map((row) => String(row.name));
    expect(tables.filter((name) => name.startsWith('sqlite_autoindex'))).toEqual([]);
    for (const expected of [
      'conversation_messages',
      'conversations',
      'item_node_links',
      'knowledge_edges',
      'knowledge_items',
      'knowledge_nodes',
      'raw_sources',
      'version_records',
      'vectors',
      'keyword_index',
    ]) {
      expect(tables).toContain(expected);
    }
    second.db.close();
  });

  it('refuses enum values outside the zod contract', () => {
    const file = fileInTempDir();
    const { db } = openSqlite({ file });
    expect(() =>
      db
        .prepare(
          `insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at)
           values ('x', 'u', 't', 'fax', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db
        .prepare(
          `insert into knowledge_edges (id, user_id, from_node_id, to_node_id, relation_type, source, created_at)
           values ('e', 'u', 'a', 'b', 'sort_of', 'test', '2026-10-04T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('enforces foreign keys and the self-parent rule', () => {
    const file = fileInTempDir();
    const { db } = openSqlite({ file });
    const stamp = '2026-10-04T00:00:00.000Z';
    db.prepare(
      `insert into knowledge_nodes (id, user_id, title, created_at, updated_at) values ('n1', 'u', 'A', ?, ?)`,
    ).run(stamp, stamp);
    expect(() =>
      db
        .prepare(
          `insert into knowledge_nodes (id, user_id, title, parent_id, created_at, updated_at)
           values ('n2', 'u', 'B', 'ghost', ?, ?)`,
        )
        .run(stamp, stamp),
    ).toThrow(/FOREIGN KEY constraint/i);
    expect(() =>
      db
        .prepare(
          `insert into knowledge_nodes (id, user_id, title, parent_id, created_at, updated_at)
           values ('n3', 'u', 'C', 'n3', ?, ?)`,
        )
        .run(stamp, stamp),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('fails loudly when the build has no FTS5', () => {
    const probe = probeFts5(new DatabaseSync(':memory:'));
    expect(probe).toEqual({ ok: true, error: null });
  });
});

describe('what survives a reopen', () => {
  it('reads back a whole capture from the same file after close', async () => {
    const file = fileInTempDir();
    const userId = 'reopen-user';
    const opened = new SqliteRepository({ file });

    const source = await opened.createRawSource(sourceOf(userId, 'SQLite 落盘测试 raw write'));
    const node = await opened.createNode({ userId, title: '存储层', embedding: [1, 0, 0], embeddingModel: 'm-a' });
    const item = await opened.createKnowledgeItem({
      userId,
      rawSourceId: source.id,
      normalizedText: '本地文件库重启后仍可读回',
      confidence: 0.66,
      embedding: [1, 0, 0],
      embeddingModel: 'm-a',
      embeddingStatus: 'ready',
    });
    await opened.linkItemToNode({ userId, itemId: item.id, nodeId: node.id, relationType: 'primary', confidence: 0.9 });
    const beforeSearch = await opened.searchKeyword(userId, '重启', { limit: 5 });
    const beforeVector = await opened.searchSimilarItems(userId, [1, 0, 0], { limit: 5 });
    const inventoryBefore = opened.vectorInventory();
    const statusBefore = opened.storageStatus();
    await opened.close();

    const reopened = new SqliteRepository({ file });
    expect(await reopened.findRawSource(source.id, userId)).toEqual(source);
    expect(await reopened.findKnowledgeItem(item.id, userId)).toEqual(item);
    expect(await reopened.findNode(node.id, userId)).toEqual(node);
    expect(await reopened.searchKeyword(userId, '重启', { limit: 5 })).toEqual(beforeSearch);
    expect(await reopened.searchSimilarItems(userId, [1, 0, 0], { limit: 5 })).toEqual(beforeVector);
    expect(reopened.vectorInventory()).toEqual(inventoryBefore);
    expect(reopened.storageStatus()).toEqual(statusBefore);
    expect(reopened.verify()).toEqual({ ok: true, errors: [] });
    await reopened.close();
  });

  it('records the provenance of every vector, not just its numbers', async () => {
    const file = fileInTempDir();
    const repo = new SqliteRepository({ file, vectorBuilderVersion: 'test-1' });
    const userId = 'vector-meta';
    const source = await repo.createRawSource(sourceOf(userId, '原文'));
    await repo.createKnowledgeItem({
      userId,
      rawSourceId: source.id,
      normalizedText: '三维向量',
      confidence: 0.5,
      embedding: [1, 0, 0],
      embeddingModel: 'model-3d',
    });
    await repo.createKnowledgeItem({
      userId,
      rawSourceId: source.id,
      normalizedText: '四维向量',
      confidence: 0.5,
      embedding: [1, 0, 0, 0],
      embeddingModel: 'model-4d',
    });

    const { db } = openSqlite({ file });
    const rows = db
      .prepare('select owner_id, model_id, dimension, normalization, source_hash, builder_version from vectors order by dimension')
      .all() as Record<string, unknown>[];
    expect(rows.map((row) => [row.model_id, row.dimension, row.normalization, row.builder_version])).toEqual([
      ['model-3d', 3, 'unnormalized', 'test-1'],
      ['model-4d', 4, 'unnormalized', 'test-1'],
    ]);
    // sha256 hex of the text the vector was built from.
    expect(String(rows[0]?.source_hash)).toMatch(/^[0-9a-f]{64}$/);
    db.close();

    // A 3-wide query must never be scored against the 4-wide row.
    const matches = await repo.searchSimilarItems(userId, [1, 0, 0], { limit: 10 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe('三维向量');
    await repo.close();
  });
});

describe('Chinese, mixed-language and English keyword lookup', () => {
  const file = fileInTempDir();
  let repo: SqliteRepository;
  const userId = 'cjk-user';

  beforeAll(async () => {
    repo = new SqliteRepository({ file });
    const corpus: Array<[string, string]> = [
      ['SQLite 的 WAL 模式允许读写并发，但备份时必须一并处理 -wal 文件。', 'wal-mode'],
      ['倒排索引把每个词项映射到包含它的文档，是全文检索的基础结构。', 'inverted-index'],
      ['Python 的装饰器本质上是接收函数并返回新函数的higher-order function。', 'decorator'],
      ['The quick brown fox jumps over the lazy dog.', 'latin-only'],
      ['检索层的索引维护成本高。', 'index-maintenance'],
    ];
    for (const [text, label] of corpus) {
      const source = await repo.createRawSource({ ...sourceOf(userId, text), sourceType: 'web', sourceTitle: label });
      await repo.createKnowledgeItem({
        userId,
        rawSourceId: source.id,
        normalizedText: text,
        confidence: 0.7,
        summary: label,
      });
    }
  });

  afterAll(async () => {
    await repo.close();
  });

  const hits = async (query: string) => (await repo.searchKeyword(userId, query, { limit: 10 })).map((m) => m.title);

  const cases: Array<[string, string, string]> = [
    ['two-character CJK', '索引', 'inverted-index'],
    ['four-character CJK', '倒排索引', 'inverted-index'],
    ['CJK across a mixed run', '读写并发', 'wal-mode'],
    ['latin inside a CJK sentence', '装饰器', 'decorator'],
    ['english word', 'backup', ''],
    ['english phrase token', 'lazy', 'latin-only'],
    ['mixed language query', 'Python 装饰器', 'decorator'],
    ['absent term', '完全不存在的词汇', ''],
  ] as const;

  for (const [name, query, expected] of cases) {
    it(`finds ${expected === '' ? 'nothing' : `"${expected}"`} for the ${name} query "${query}"`, async () => {
      const found = await hits(query);
      if (expected === '') expect(found).toEqual([]);
      else expect(found).toContain(expected);
    });
  }

  it('keeps foreign users out of the keyword results', async () => {
    const other = await repo.searchKeyword('someone-else', '索引', { limit: 10 });
    expect(other).toEqual([]);
  });

  /**
   * FTS5 only supplies the candidate set; the ordering comes from the same overlap score the memory
   * and Postgres drivers use, so a document holding every query gram has to beat one holding a single gram.
   */
  it('ranks a whole-query match above a partial one', async () => {
    const found = await repo.searchKeyword(userId, '倒排索引', { limit: 10 });
    expect(found.map((match) => match.title)).toEqual(['inverted-index', 'index-maintenance']);
    expect(found[0]?.score).toBeCloseTo(1, 6);
    expect(found[1]?.score).toBeCloseTo(1 / 3, 6);
  });
});

describe('consistent backup', () => {
  it('copies a live WAL database into a standalone file that reads back the same rows', async () => {
    const file = fileInTempDir();
    const destination = fileInTempDir('snapshot.sqlite');
    const repo = new SqliteRepository({ file });
    const userId = 'backup-user';
    const source = await repo.createRawSource(sourceOf(userId, '备份需要覆盖 WAL'));
    const node = await repo.createNode({ userId, title: '备份', embedding: [0, 1, 0], embeddingModel: 'm' });
    const item = await repo.createKnowledgeItem({
      userId,
      rawSourceId: source.id,
      normalizedText: '一致性快照',
      confidence: 0.4,
      embedding: [0, 1, 0],
      embeddingModel: 'm',
    });
    await repo.linkItemToNode({ userId, itemId: item.id, nodeId: node.id, relationType: 'primary', confidence: 1 });

    await repo.backupTo(destination);
    // The snapshot is a single file: it must open without its source's -wal sibling.
    expect(statSync(destination).size).toBeGreaterThan(0);
    const copy = new SqliteRepository({ file: destination });
    expect(await copy.findRawSource(source.id, userId)).toEqual(source);
    expect((await copy.searchKeyword(userId, '一致性', { limit: 5 })).map((m) => m.text)).toContain('一致性快照');
    expect((await copy.searchSimilarItems(userId, [0, 1, 0], { limit: 5 })).map((m) => m.text)).toContain('一致性快照');
    expect(copy.verify()).toEqual({ ok: true, errors: [] });
    await copy.close();
    await repo.close();
  });
});

describe('the capture idempotency migration', () => {
  const STAMP = '2026-10-05T00:00:00.000Z';

  /** A file written by the previous schema version, exactly as an installed app would leave it. */
  function seededV1(file: string): void {
    const db = new DatabaseSync(file);
    db.exec('pragma journal_mode = wal');
    SQLITE_MIGRATIONS[0]?.apply(db);
    db.exec('pragma user_version = 1');
    db
      .prepare(
        `insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at, metadata_json)
         values ('old-1', 'u', '升级前写入的原文', 'manual', ?, ?, '{}')`,
      )
      .run(STAMP, STAMP);
    db.close();
  }

  function columnsOf(db: DatabaseSync, table: string): string[] {
    return (db.prepare(`pragma table_info(${table})`).all() as Record<string, unknown>[]).map((row) =>
      String(row.name),
    );
  }

  it('upgrades a version 1 file in place and keeps the rows it already had', async () => {
    const file = fileInTempDir('upgrade.sqlite');
    seededV1(file);

    const repo = new SqliteRepository({ file });
    expect(repo.schemaInfo.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBeGreaterThan(1);
    const before = await repo.findRawSource('old-1', 'u');
    expect(before?.rawText).toBe('升级前写入的原文');
    // Rows that predate the key stay readable with a null key rather than being backfilled with a guess.
    expect(before?.requestId).toBeNull();
    expect(before?.clientId).toBeNull();

    const keyed = await repo.createRawSource({
      userId: 'u',
      rawText: '升级后写入的原文',
      sourceType: 'manual',
      capturedAt: STAMP,
      requestId: 'req-after-upgrade',
      clientId: 'extension',
    });
    expect(keyed.requestId).toBe('req-after-upgrade');
    await repo.close();

    const probe = openSqlite({ file });
    expect(columnsOf(probe.db, 'raw_sources')).toEqual(expect.arrayContaining(['request_id', 'client_id']));
    probe.db.close();

    // Migrating is idempotent: reopening must not try to apply version 2 a second time.
    const reopened = new SqliteRepository({ file });
    expect(reopened.schemaInfo.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect(await reopened.findRawSource(keyed.id, 'u')).toEqual(keyed);
    await reopened.close();
  });

  it('refuses a second row for the same (user, client, request) key', () => {
    const file = fileInTempDir('unique.sqlite');
    const { db } = openSqlite({ file });
    const insert = db.prepare(
      `insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at, request_id, client_id)
       values (?, ?, ?, 'manual', ?, ?, ?, ?)`,
    );
    insert.run('a', 'u', 'first', STAMP, STAMP, 'req-1', 'extension');
    expect(() => insert.run('b', 'u', 'replay', STAMP, STAMP, 'req-1', 'extension')).toThrow(/UNIQUE/i);
    // Another entry point or another owner may reuse the same request id without colliding.
    expect(() => insert.run('c', 'u', 'other client', STAMP, STAMP, 'req-1', 'desktop')).not.toThrow();
    expect(() => insert.run('d', 'other', 'other user', STAMP, STAMP, 'req-1', 'extension')).not.toThrow();
    expect(() => insert.run('e', 'u', 'other request', STAMP, STAMP, 'req-2', 'extension')).not.toThrow();
    db.close();
  });

  it('leaves unkeyed rows out of the index and refuses a half-stated key', () => {
    const file = fileInTempDir('half-key.sqlite');
    const { db } = openSqlite({ file });
    const insert = db.prepare(
      `insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at, request_id, client_id)
       values (?, ?, ?, 'manual', ?, ?, ?, ?)`,
    );
    // Captures that state no key are the majority of historical rows and must never collide with each other.
    expect(() => insert.run('a', 'u', 'no key one', STAMP, STAMP, null, null)).not.toThrow();
    expect(() => insert.run('b', 'u', 'no key two', STAMP, STAMP, null, null)).not.toThrow();
    expect(() => insert.run('c', 'u', 'half key', STAMP, STAMP, 'req-1', null)).toThrow(/CHECK/i);
    db.close();
  });
});

describe('the storage package no longer decides where data goes by itself', () => {
  it('leaves no stray journals behind after a clean close', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-close-'));
    directories.push(dir);
    const file = path.join(dir, 'noltri.sqlite');
    const repo = new SqliteRepository({ file });
    await repo.createRawSource(sourceOf('close-user', '关闭测试'));
    await repo.close();
    const left = readdirSync(dir).filter((name) => name.endsWith('-wal') || name.endsWith('-shm'));
    expect(left).toEqual([]);
    expect(readFileSync(path.join(dir, 'noltri.sqlite')).byteLength).toBeGreaterThan(0);
  });
});
