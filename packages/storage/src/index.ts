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
}

/**
 * Async so the Postgres driver can be imported on demand: browser bundles of
 * @noltri/storage only ever touch the in-memory implementation.
 */
export async function createRepository(options: RepositoryOptions): Promise<KnowledgeRepository> {
  if (options.driver === 'memory') return createInMemoryRepository();
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
 * Research Domain storage seam (Research V1). Same drivers as the knowledge repository;
 * research tables are additive so coding projects keep their exact previous behaviour.
 */
export async function createResearchRepository(
  options: RepositoryOptions,
): Promise<ResearchRepository> {
  if (options.driver === 'memory') return createInMemoryResearchRepository();
  if (options.driver === 'supabase') {
    if (!options.databaseUrl) {
      throw new Error('driver "supabase" requires a databaseUrl (DATABASE_URL / DIRECT_URL)');
    }
    const { createSupabaseResearchRepository } = await import('./research-supabase');
    return createSupabaseResearchRepository({
      databaseUrl: options.databaseUrl,
      statementTimeoutMs: options.statementTimeoutMs,
      maxConnections: options.maxConnections,
    });
  }
  throw new Error(`Unknown storage driver "${String(options.driver)}"`);
}

export * from './types';
export * from './research-types';
export { InMemoryRepository, createInMemoryRepository } from './in-memory';
export type { SupabaseRepositoryOptions } from './supabase';
export type { SupabaseResearchRepositoryOptions } from './research-supabase';
