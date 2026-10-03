import { describe, expect, it } from 'vitest';
import { describeResearchRepository } from './research-repository-contract';
import { SupabaseResearchRepository, createSupabaseResearchRepository } from '../src/research-supabase';
import type { SupabaseResearchRepositoryOptions } from '../src/research-supabase';

/**
 * The Postgres-backed half of the contract needs a real database with supabase/migrations applied.
 * There is no local Postgres in CI here, so the suite stays skipped unless a URL is supplied:
 * NOLTRI_PG_TEST_URL=postgresql://… npx vitest run --root packages/storage
 */
const databaseUrl = (process.env['NOLTRI_PG_TEST_URL'] ?? '').trim();

const guarded = databaseUrl.length > 0 ? describe : describe.skip;

guarded('SupabaseResearchRepository against Postgres', () => {
  const options: SupabaseResearchRepositoryOptions = {
    databaseUrl,
    maxConnections: 2,
  };

  describeResearchRepository(
    'SupabaseResearchRepository',
    () => new SupabaseResearchRepository(options),
    { requiresServer: true },
  );

  it('opens and closes a pool through the factory', async () => {
    const repository = createSupabaseResearchRepository(options);
    expect(await repository.ping()).toBe(true);
    await repository.close();
    // close() must not leave the pool usable.
    await expect(repository.ping()).rejects.toThrow();
  }, 30_000);
});

describe('SupabaseResearchRepository options', () => {
  it('refuses a connection string or limit it cannot trust', async () => {
    expect(() => new SupabaseResearchRepository({ databaseUrl: '   ' })).toThrow();
    expect(() => new SupabaseResearchRepository({ databaseUrl: 'postgres://x/y', statementTimeoutMs: 0 })).toThrow();
    expect(() => new SupabaseResearchRepository({ databaseUrl: 'postgres://x/y', maxConnections: 0 })).toThrow();
    expect(() => new SupabaseResearchRepository({ databaseUrl: 'postgres://x/y', maxConnections: 1.5 })).toThrow();
    const repository = createSupabaseResearchRepository({ databaseUrl: 'postgres://x/y' });
    expect(repository.driver).toBe('supabase');
    // Nothing is dialled until a query runs, so the pool only has to be released again.
    await repository.close();
  });
});
