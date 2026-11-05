/** Historical SQL fixtures come from git objects, never from an installed profile or current migrations. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import historical from './fixtures/sqlite-lineage/historical-migrations.json';
import * as schema from '../src/sqlite-schema';

type Lineage = 'empty' | 'main' | 'screenshot' | 'v3-course-workspace' | 'unknown';
type Inspection = { lineage: Lineage; userVersion: number };
const stamp = '2026-11-02T00:00:00.000Z';
const databases: DatabaseSync[] = [];
const directories: string[] = [];

function database(file = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  databases.push(db);
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(lineage: 'main' | 'screenshot' | 'v3', version: number, file?: string): DatabaseSync {
  const db = database(file);
  for (const [step, sql] of Object.entries(historical.common)) {
    if (Number(step) <= version) db.exec(sql);
  }
  if (lineage === 'v3') db.exec(historical.v3CourseWorkspace8);
  if (lineage === 'screenshot') {
    for (const [step, sql] of Object.entries(historical.screenshot)) {
      if (Number(step) <= version) db.exec(sql);
    }
  }
  db.exec(`pragma user_version = ${version}`);
  db.prepare(`insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at)
    values ('source', 'synthetic-user', '合成原文: never a user profile', 'manual', ?, ?)`).run(stamp, stamp);
  db.prepare(`insert into knowledge_nodes (id, user_id, title, created_at, updated_at)
    values ('topic', 'synthetic-user', '合成主题', ?, ?)`).run(stamp, stamp);
  db.prepare(`insert into knowledge_items
    (id, user_id, raw_source_id, normalized_text, confidence, created_at, updated_at)
    values ('item', 'synthetic-user', 'source', '合成知识正文', 0.75, ?, ?)`).run(stamp, stamp);
  db.exec(`insert into keyword_index (entity_id, entity_type, user_id, tokens)
    values ('item', 'knowledge_item', 'synthetic-user', 'synthetic tokens')`);
  if (version >= 3) {
    db.prepare(`insert into research_projects (id, user_id, name, created_at, updated_at)
      values ('project', 'synthetic-user', '合成旧项目', ?, ?)`).run(stamp, stamp);
    db.prepare(`insert into research_evidence (id, project_id, user_id, type, title, created_at, updated_at)
      values ('evidence', 'project', 'synthetic-user', 'note', '合成旧证据', ?, ?)`).run(stamp, stamp);
  }
  if (version >= 7) {
    db.prepare(`insert into knowledge_notes (user_id, topic_id, content, created_at, updated_at)
      values ('synthetic-user', 'topic', '合成笔记正文', ?, ?)`).run(stamp, stamp);
  }
  if (lineage === 'v3') {
    db.prepare(`insert into course_workspaces values ('synthetic-user', 7, ?)`).run(
      '{"courses":[{"id":"course","title":"合成课程","content":"合成课程正文"}]}',
    );
  }
  if (lineage === 'screenshot') {
    db.prepare(`insert into capture_assets values ('synthetic-user', 'asset', 'session', 'image/png', ?, 4, ?, ?)`)
      .run('a'.repeat(64), new Uint8Array([0, 1, 128, 255]), stamp);
    db.prepare(`insert into capture_batches values ('synthetic-user', 'batch', 'session', ?, ?, ?)`)
      .run('b'.repeat(64), stamp, stamp);
    db.prepare(`insert into capture_batch_items
      (user_id, batch_id, request_id, user_order, kind, status, request_json, raw_source_id, updated_at)
      values ('synthetic-user', 'batch', 'request', 0, 'image', 'done', '{"synthetic":true}', 'source', ?)`)
      .run(stamp);
    if (version >= 9) db.exec('update knowledge_items set capture_point_index = 0');
    if (version >= 10) {
      db.exec('update knowledge_items set capture_analysis_version = 3');
      db.prepare(`insert into capture_processing_plans values
        ('synthetic-user', 'source', 3, '[{"text":"合成冻结提取"}]', ?, ?)`).run(stamp, stamp);
    }
  }
  return db;
}

function inspect(db: DatabaseSync): Inspection {
  const api = schema as typeof schema & { inspectSqliteLineage?: (db: DatabaseSync) => Inspection };
  expect(api.inspectSqliteLineage, 'read-only lineage inspection is a public schema API').toBeTypeOf('function');
  return api.inspectSqliteLineage!(db);
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

/** Includes every row (including FTS shadow data), complete DDL, both schema counters and temp DDL. */
function snapshot(db: DatabaseSync) {
  const objects = db.prepare('select type, name, tbl_name, sql from sqlite_schema order by type, name').all();
  const tables = db.prepare(`select name from sqlite_schema where type = 'table' and name not glob 'sqlite_*' order by name`).all();
  return {
    userVersion: db.prepare('pragma user_version').get(),
    schemaVersion: db.prepare('pragma schema_version').get(),
    tempSchemaVersion: db.prepare('pragma temp.schema_version').get(),
    objects,
    tables: tables.map(({ name }) => {
      const columns = db.prepare(`pragma table_info(${quote(String(name))})`).all().map((column) => String(column.name));
      return { name: String(name), columns, rows: rows(db, String(name), columns) };
    }),
  };
}

function rows(db: DatabaseSync, table: string, columns: string[]) {
  const selected = columns.map(quote).join(', ');
  return db.prepare(`select ${selected} from ${quote(table)} order by ${selected}`).all();
}

function expectRowsPreserved(db: DatabaseSync, before: ReturnType<typeof snapshot>) {
  for (const table of before.tables) {
    expect(rows(db, table.name, table.columns), `all preexisting ${table.name} values survive`).toEqual(table.rows);
  }
}

function expectRefusedUnchanged(db: DatabaseSync, reason: RegExp) {
  const before = snapshot(db);
  expect(() => schema.migrateSqlite(db)).toThrow(reason);
  expect(snapshot(db)).toEqual(before);
}

describe('lineage-aware SQLite migration', () => {
  // Catch: treating an integer version as authority over a different architecture.
  it('refuses the public v3 course-workspace v8 without executing any DDL or changing a row', () => {
    const db = fixture('v3', 8);
    expectRefusedUnchanged(db, /v3-course-workspace.*8.*preserve.*compatible importer/i);
    expect(inspect(db)).toMatchObject({ lineage: 'v3-course-workspace', userVersion: 8 });
  });

  // Catch: skipping unknown schemas merely because their version is current or newer.
  it.each([0, 8, 10, 11])('refuses unrelated schema at user_version %i unchanged', (version) => {
    const db = database();
    db.exec(`create table foreign_content (body text, bytes blob); pragma user_version = ${version}`);
    db.prepare('insert into foreign_content values (?, ?)').run('合成外来正文', new Uint8Array([7, 8, 9]));
    expectRefusedUnchanged(db, /unknown.*preserve/i);
    expect(inspect(db)).toMatchObject({ lineage: 'unknown', userVersion: version });
  });

  it('initializes an empty v0 database and recognizes the resulting screenshot lineage', () => {
    const db = database();
    expect(inspect(db)).toMatchObject({ lineage: 'empty', userVersion: 0 });
    expect(schema.migrateSqlite(db)).toBe(schema.SQLITE_SCHEMA_VERSION);
    expect(inspect(db)).toMatchObject({ lineage: 'screenshot', userVersion: schema.SQLITE_SCHEMA_VERSION });
  });

  // Catch: rejecting supported historical databases or deleting earlier data during their upgrade.
  it.each([1, 2, 3, 4, 5, 6, 7])('upgrades independently derived main v%i and preserves all existing values', (version) => {
    const db = fixture('main', version);
    expect(inspect(db)).toMatchObject({ lineage: 'main', userVersion: version });
    const before = snapshot(db);
    expect(schema.migrateSqlite(db)).toBe(schema.SQLITE_SCHEMA_VERSION);
    expectRowsPreserved(db, before);
    expect(inspect(db)).toMatchObject({ lineage: 'screenshot', userVersion: schema.SQLITE_SCHEMA_VERSION });
    const upgraded = snapshot(db);
    expect(schema.migrateSqlite(db)).toBe(schema.SQLITE_SCHEMA_VERSION);
    expect(snapshot(db)).toEqual(upgraded);
  });

  it.each([8, 9, 10])('accepts screenshot v%i and preserves image bytes, batch state and point identity', (version) => {
    const db = fixture('screenshot', version);
    const before = snapshot(db);
    expect(inspect(db)).toMatchObject({ lineage: 'screenshot', userVersion: version });
    expect(schema.migrateSqlite(db)).toBe(schema.SQLITE_SCHEMA_VERSION);
    expectRowsPreserved(db, before);
    expect(db.prepare('select capture_point_index, capture_analysis_version from knowledge_items').get()).toEqual({
      capture_point_index: version >= 9 ? 0 : null,
      capture_analysis_version: version >= 10 ? 3 : 1,
    });
  });

  // Catch: trusting a marker table while overlooking incompatible constraints/indexes/extra data.
  it.each([
    ['missing capture table', 'screenshot', 8, 'drop table capture_assets'],
    ['missing unique index', 'screenshot', 10, 'drop index knowledge_items_capture_point_uq'],
    ['wrong point identity index', 'screenshot', 10, `drop index knowledge_items_capture_point_uq;
      create unique index knowledge_items_capture_point_uq on knowledge_items (user_id, raw_source_id, capture_point_index) where capture_point_index is not null`],
    ['extra column', 'screenshot', 8, 'alter table capture_assets add column unknown_body text'],
    ['mixed course and capture lineage', 'screenshot', 8, historical.v3CourseWorkspace8],
    ['spoofed version', 'main', 7, 'pragma user_version = 8'],
    ['future version', 'screenshot', 10, 'pragma user_version = 13'],
    ['missing core index', 'main', 7, 'drop index raw_sources_user_idx'],
    ['unrelated table with SQLite-like name', 'main', 7, 'create table sqliteXforeign (body text)'],
    ['temporary shadow table', 'main', 7, 'create temp table knowledge_items (body text)'],
  ] as const)('refuses %s before schema changes', (_name, lineage, version, alteration) => {
    const db = fixture(lineage, version);
    db.exec(alteration);
    expectRefusedUnchanged(db, /unknown.*preserve/i);
  });

  // Catch: committing early migrations when a later driver write fails.
  it('rolls back the entire supported upgrade if a later migration write fails', () => {
    const db = fixture('main', 7);
    const before = snapshot(db);
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      exec(sql);
      if (sql.includes('create table if not exists capture_processing_plans')) throw new Error('synthetic interrupted write');
    });
    expect(() => schema.migrateSqlite(db)).toThrow('synthetic interrupted write');
    expect(snapshot(db)).toEqual(before);
  });

  // Catch: openSqlite changing journal mode/probing FTS before rejecting a foreign profile.
  it('rejects v3 on writable open before changing the file, journal mode or creating siblings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-lineage-synthetic-'));
    directories.push(dir);
    const file = path.join(dir, 'synthetic.sqlite');
    const seeded = fixture('v3', 8, file);
    const before = snapshot(seeded);
    seeded.close();
    databases.splice(databases.indexOf(seeded), 1);
    const bytes = readFileSync(file);
    let unexpectedlyOpened: ReturnType<typeof schema.openSqlite> | undefined;
    try {
      expect(() => { unexpectedlyOpened = schema.openSqlite({ file }); }).toThrow(/v3-course-workspace/i);
    } finally {
      unexpectedlyOpened?.db.close();
    }
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(['synthetic.sqlite']);
    const reopened = database(file);
    expect(reopened.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(snapshot(reopened)).toEqual(before);
  });

  it('allows read-only inspection of the blocked course lineage without modifying its file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-lineage-readonly-'));
    directories.push(dir);
    const file = path.join(dir, 'synthetic.sqlite');
    const seeded = fixture('v3', 8, file);
    seeded.close();
    databases.splice(databases.indexOf(seeded), 1);
    const bytes = readFileSync(file);
    const opened = schema.openSqlite({ file, readOnly: true });
    try {
      expect(inspect(opened.db)).toMatchObject({ lineage: 'v3-course-workspace', userVersion: 8 });
      expect(opened.db.prepare('select revision, state_json from course_workspaces').get()).toEqual({
        revision: 7, state_json: '{"courses":[{"id":"course","title":"合成课程","content":"合成课程正文"}]}',
      });
    } finally { opened.db.close(); }
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(['synthetic.sqlite']);
  });
});
