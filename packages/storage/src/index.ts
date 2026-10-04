import type { KnowledgeRepository, StorageDriverName } from './types';
import { createInMemoryRepository } from './in-memory';

export interface RepositoryOptions {
  driver: StorageDriverName;
  /** Postgres connection string (Supabase pooler or direct). Required for driver "supabase". */
  databaseUrl?: string;
  embeddingDim?: number;
  statementTimeoutMs?: number;
  maxConnections?: number;
  /** SQLite file. Required for driver "sqlite"; `:memory:` is accepted for throw-away stores. */
  sqliteFile?: string;
  /** Default FULL for a profile that must survive a power loss. */
  sqliteSynchronous?: 'FULL' | 'NORMAL' | 'OFF';
  sqliteBusyTimeoutMs?: number;
}

/**
 * Async so the Postgres driver can be imported on demand: browser bundles of
 * @noltri/storage only ever touch the in-memory implementation.
 */
export async function createRepository(options: RepositoryOptions): Promise<KnowledgeRepository> {
  if (options.driver === 'memory') return createInMemoryRepository();
  if (options.driver === 'sqlite') {
    if (!options.sqliteFile) {
      throw new Error('driver "sqlite" requires sqliteFile (the profile database path)');
    }
    const { createSqliteRepository } = await import('./sqlite');
    return createSqliteRepository({
      file: options.sqliteFile,
      synchronous: options.sqliteSynchronous,
      busyTimeoutMs: options.sqliteBusyTimeoutMs,
    });
  }
  if (options.driver === 'supabase') {
    if (!options.databaseUrl) {
      throw new Error('driver "supabase" requires a databaseUrl (DATABASE_URL / DIRECT_URL)');
    }
    const { createSupabaseRepository } = await import('./supabase');
    return createSupabaseRepository({
      databaseUrl: options.databaseUrl,
      embeddingDim: options.embeddingDim ?? 1536,
      statementTimeoutMs: options.statementTimeoutMs,
      maxConnections: options.maxConnections,
    });
  }
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

export * from './types';
export { InMemoryRepository, createInMemoryRepository } from './in-memory';
export type { SupabaseRepositoryOptions } from './supabase';
// Re-exported as types only: the runtime module pulls in `node:sqlite` and must stay behind a
// dynamic import so browser bundles of this package never touch it.
export type { SqliteRepositoryOptions, SqliteStorageStatus } from './sqlite';
export type { SqlitePragmas, SqliteOpenOptions } from './sqlite-schema';
