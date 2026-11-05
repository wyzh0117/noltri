import { describe, expect, it } from 'vitest';
import * as storage from '../src/index';
import type { RepositoryOptions } from '../src/index';

describe('repository factory lifetime semantics', () => {
  const cases: { label: string; options: RepositoryOptions; temporary: boolean }[] = [
    { label: 'memory without an unused filename', options: { driver: 'memory' }, temporary: true },
    { label: 'memory ignores an unused persistent filename', options: { driver: 'memory', sqliteFile: '/synthetic/unused.sqlite' }, temporary: true },
    { label: 'SQLite explicit memory database', options: { driver: 'sqlite', sqliteFile: ':memory:' }, temporary: true },
    { label: 'SQLite persistent file', options: { driver: 'sqlite', sqliteFile: '/synthetic/profile.sqlite' }, temporary: false },
    { label: 'SQLite file merely named memory is persistent', options: { driver: 'sqlite', sqliteFile: '/synthetic/:memory:' }, temporary: false },
  ];

  it.each(cases)('$label', ({ options, temporary }) => {
    expect(storage.isEphemeralStorage(options)).toBe(temporary);
  });
});
