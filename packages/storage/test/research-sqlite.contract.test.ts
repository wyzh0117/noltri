/**
 * The research contract, run against real SQLite files.
 *
 * The same assertion set the in-memory driver satisfies, on a file-backed profile, so `close()` and the
 * version-3 migration are exercised on every run. No server, no mocking of the layer under test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { SqliteResearchRepository } from '../src/sqlite-research';
import { describeResearchRepository } from './research-repository-contract';

const directories: string[] = [];

function nextFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-research-'));
  directories.push(dir);
  return path.join(dir, 'research.sqlite');
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describeResearchRepository('sqlite', () => new SqliteResearchRepository({ file: nextFile() }));
