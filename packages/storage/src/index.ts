import type { KnowledgeRepository, StorageDriverName } from './types';
import type { ResearchRepository } from './research-types';
import { createInMemoryRepository } from './in-memory';
import { createInMemoryResearchRepository } from './research-in-memory';

export interface RepositoryOptions {
  driver: StorageDriverName;
  /** SQLite file. Required for driver "sqlite"; `:memory:` is accepted for throw-away stores. */
  sqliteFile?: string;
  /** Default FULL for a profile that must survive a power loss. */
  sqliteSynchronous?: 'FULL' | 'NORMAL' | 'OFF';
  sqliteBusyTimeoutMs?: number;
}

/**
 * Async so the SQLite driver can be imported on demand: browser bundles of
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
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

/**
 * Whether `createResearchRepository` can serve this driver. A host asks instead of comparing driver
 * names itself, so the list of research drivers lives only in the file that implements them.
 */
export function supportsResearchDriver(driver: StorageDriverName): boolean {
  return driver === 'memory' || driver === 'sqlite';
}

/**
 * The research half of the seam (Research V1): the same drivers and the same options object, so a
 * desktop profile hands one `sqliteFile` to both factories and the two repositories share the file —
 * WAL is what lets the second handle read while the first writes.
 *
 * The archived `research-supabase.ts` and its two migrations stayed in `ad1d0c6`: the local-desktop
 * build carries no hosted driver for this half.
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
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

export * from './types';
export * from './research-types';
export { InMemoryRepository, createInMemoryRepository } from './in-memory';
export { InMemoryResearchRepository, createInMemoryResearchRepository } from './research-in-memory';
// Re-exported as types only: the runtime module pulls in `node:sqlite` and must stay behind a
// dynamic import so browser bundles of this package never touch it.
export type { SqliteRepositoryOptions, SqliteStorageStatus } from './sqlite';
export type { SqliteResearchRepositoryOptions, SqliteResearchStorageStatus } from './sqlite-research';
export type { SqlitePragmas, SqliteOpenOptions } from './sqlite-schema';
