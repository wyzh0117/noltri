import { describe, expect, it } from 'vitest';
import { describeKnowledgeRepository } from './repository-contract';
import { SupabaseRepository, createSupabaseRepository } from '../src/supabase';
import type { SupabaseRepositoryOptions } from '../src/supabase';

/**
 * The Postgres-backed half of the contract needs a real database with supabase/migrations applied.
 * There is no local Postgres in CI here, so the suite stays skipped unless a URL is supplied:
 * NOLTRI_PG_TEST_URL=postgresql://… npx vitest run --root packages/storage
 */
const databaseUrl = (process.env['NOLTRI_PG_TEST_URL'] ?? '').trim();
const VECTOR_DIM = 1536;

const guarded = databaseUrl.length > 0 ? describe : describe.skip;

guarded('SupabaseRepository against Postgres', () => {
  const options: SupabaseRepositoryOptions = {
    databaseUrl,
    embeddingDim: VECTOR_DIM,
    maxConnections: 2,
  };

  describeKnowledgeRepository(
    'SupabaseRepository',
    () => new SupabaseRepository(options),
    { requiresServer: true, embeddingDim: VECTOR_DIM },
  );

  it('opens and closes a pool through the factory', async () => {
    const repository = createSupabaseRepository(options);
    expect(await repository.ping()).toBe(true);
    await repository.close();
    // close() must not leave the pool usable.
    await expect(repository.ping()).rejects.toThrow();
  }, 30_000);
});

describe('SupabaseRepository options', () => {
  it('refuses a connection string or vector width it cannot trust', async () => {
    expect(() => new SupabaseRepository({ databaseUrl: '   ', embeddingDim: VECTOR_DIM })).toThrow();
    expect(() => new SupabaseRepository({ databaseUrl: 'postgres://x/y', embeddingDim: 0 })).toThrow();
    expect(() => new SupabaseRepository({ databaseUrl: 'postgres://x/y', embeddingDim: 1.5 })).toThrow();
    expect(() => new SupabaseRepository({ databaseUrl: 'postgres://x/y', embeddingDim: 8, statementTimeoutMs: 0 })).toThrow();
    expect(() => new SupabaseRepository({ databaseUrl: 'postgres://x/y', embeddingDim: 8, maxConnections: 0 })).toThrow();
    const repository = createSupabaseRepository({ databaseUrl: 'postgres://x/y', embeddingDim: 8 });
    expect(repository.driver).toBe('supabase');
    // Nothing is dialled until a query runs, so the pool only has to be released again.
    await repository.close();
  });
});
