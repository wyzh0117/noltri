import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import historical from './fixtures/sqlite-lineage/historical-migrations.json';
import { inspectSqliteLineage, migrateSqlite, SQLITE_SCHEMA_VERSION } from '../src/sqlite-schema';

describe('review migration', () => {
  it('upgrades the trusted screenshot 10 and keeps legacy done sources reviewable', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const sql of Object.values(historical.common)) db.exec(sql);
      for (const sql of Object.values(historical.screenshot)) db.exec(sql);
      db.exec("pragma user_version = 10; insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at, processing_status) values ('old', 'user', 'original', 'manual', '2026', '2026', 'done')");
      expect(migrateSqlite(db)).toBe(SQLITE_SCHEMA_VERSION);
      expect(db.prepare('select raw_text, processing_status, review_status, review_revision from raw_sources').get()).toEqual({ raw_text: 'original', processing_status: 'done', review_status: 'needs_review', review_revision: 0 });
      expect(inspectSqliteLineage(db)).toEqual({ lineage: 'screenshot', userVersion: SQLITE_SCHEMA_VERSION });
      expect(migrateSqlite(db)).toBe(SQLITE_SCHEMA_VERSION);
      db.exec('create table external_unknown (id text)');
      const shape = db.prepare('select sql from sqlite_schema order by name').all();
      expect(inspectSqliteLineage(db)).toEqual({ lineage: 'unknown', userVersion: SQLITE_SCHEMA_VERSION });
      expect(() => migrateSqlite(db)).toThrow(/unknown/);
      expect(db.prepare('select sql from sqlite_schema order by name').all()).toEqual(shape);
    } finally { db.close(); }
  });
});
