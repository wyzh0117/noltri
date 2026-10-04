/**
 * The same contract the in-memory and Postgres drivers must satisfy, run against real SQLite files.
 *
 * Each case gets a fresh database in its own temporary directory and closes it afterwards, so
 * `close()` and the migration path are exercised on every run. No `NOLTRI_PG_TEST_URL`, no server,
 * no mocking of the layer under test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/sqlite';
import { describeKnowledgeRepository } from './repository-contract';

const directories: string[] = [];

function nextFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-sqlite-'));
  directories.push(dir);
  return path.join(dir, 'noltri.sqlite');
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describeKnowledgeRepository('sqlite', () => new SqliteRepository({ file: nextFile() }), {
  embeddingDim: 3,
});

describe('sqlite driver opens the file it was given', () => {
  it('reports WAL, FULL and the migrated schema version for a file-backed profile', async () => {
    const repository = new SqliteRepository({ file: nextFile() });
    const status = repository.storageStatus();
    expect(status.driver).toBe('sqlite');
    expect(status.journalMode).toBe('wal');
    expect(status.synchronous).toBe('full');
    expect(status.schemaVersion).toBe(1);
    expect(status.fts5).toBe(true);
    expect(status.vectorInventory).toEqual([]);
    await repository.close();
  });
});
