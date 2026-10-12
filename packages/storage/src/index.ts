import type { KnowledgeRepository, StorageDriverName } from './types';
import { createInMemoryRepository } from './in-memory';

export interface RepositoryOptions {
  driver: StorageDriverName;
  /** SQLite file. Required for driver "sqlite"; `:memory:` is accepted for throw-away stores. */
  sqliteFile?: string;
  sqliteSynchronous?: 'FULL' | 'NORMAL' | 'OFF';
  sqliteBusyTimeoutMs?: number;
}

/** Keep the Node SQLite driver behind a dynamic import for browser consumers. */
export async function createRepository(options: RepositoryOptions): Promise<KnowledgeRepository> {
  if (options.driver === 'memory') return createInMemoryRepository();
  if (options.driver === 'sqlite') {
    if (!options.sqliteFile) throw new Error('driver "sqlite" requires sqliteFile (the profile database path)');
    const { createSqliteRepository } = await import('./sqlite');
    return createSqliteRepository({
      file: options.sqliteFile,
      synchronous: options.sqliteSynchronous,
      busyTimeoutMs: options.sqliteBusyTimeoutMs,
    });
  }
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

export * from './types';
export { InMemoryRepository, createInMemoryRepository } from './in-memory';
export type { SqliteRepositoryOptions, SqliteStorageStatus } from './sqlite';
export type { SqlitePragmas, SqliteOpenOptions } from './sqlite-schema';
