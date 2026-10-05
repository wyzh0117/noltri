import type { KnowledgeRepository, StorageDriverName } from './types';
import type { ResearchRepository } from './research-types';
import { createInMemoryRepository } from './in-memory';
import { createInMemoryResearchRepository } from './research-in-memory';

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

/**
 * The research half of the seam (Research V1): the same drivers and the same options object, so a
 * desktop profile hands one `sqliteFile` to both factories and the two repositories share the file —
 * WAL is what lets the second handle read while the first writes.
 *
 * There is deliberately no Postgres research driver here: the archived `research-supabase.ts` and its
 * two migrations stayed in `ad1d0c6` rather than being carried into the local-desktop build.
 */
export async function createResearchRepository(options: RepositoryOptions): Promise<ResearchRepository> {
  if (options.driver === 'memory') return createInMemoryResearchRepository();
  if (options.driver === 'sqlite') {
    if (!options.sqliteFile) {
      throw new Error('driver "sqlite" requires sqliteFile (the profile database path)');
    }
    const { createSqliteResearchRepository } = await import('./sqlite-research');
    return createSqliteResearchRepository({
      file: options.sqliteFile,
      synchronous: options.sqliteSynchronous,
      busyTimeoutMs: options.sqliteBusyTimeoutMs,
    });
  }
  if (options.driver === 'supabase') {
    throw new Error('research has no supabase driver in this branch (memory and sqlite only)');
  }
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

export * from './types';
export * from './research-types';
export { InMemoryRepository, createInMemoryRepository } from './in-memory';
export { InMemoryResearchRepository, createInMemoryResearchRepository } from './research-in-memory';
export type { SupabaseRepositoryOptions } from './supabase';
// Re-exported as types only: the runtime module pulls in `node:sqlite` and must stay behind a
// dynamic import so browser bundles of this package never touch it.
export type { SqliteRepositoryOptions, SqliteStorageStatus } from './sqlite';
export type { SqliteResearchRepositoryOptions, SqliteResearchStorageStatus } from './sqlite-research';
export type { SqlitePragmas, SqliteOpenOptions } from './sqlite-schema';
