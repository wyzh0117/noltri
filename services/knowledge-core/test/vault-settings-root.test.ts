import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { VaultService } from '../src/notes/vault';

const directories: string[] = [];
afterAll(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Vault settings root isolation', () => {
  it('rejects settings reads for a stale root instead of returning the active vault settings', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-vault-settings-root-'));
    directories.push(directory);
    const firstRoot = path.join(directory, 'vault-a');
    const secondRoot = path.join(directory, 'vault-b');
    const repository = new SqliteRepository({ file: path.join(directory, 'profile.sqlite') });
    const vault = new VaultService({ rootPath: firstRoot, dataDir: path.join(directory, 'data'), repository, userId: 'settings-root-test' });
    try {
      const first = await vault.snapshot();
      await vault.updateSettings({ newLinkFormat: 'relative', propertyTypes: { priority: 'number' } }, first.rootPath);
      const second = await vault.openVault(secondRoot);
      await vault.updateSettings({ newLinkFormat: 'absolute', propertyTypes: { status: 'list' } }, second.rootPath);

      expect(await vault.getSettings(second.rootPath)).toMatchObject({ newLinkFormat: 'absolute', propertyTypes: { status: 'list' } });
      let staleReadError: unknown;
      try { await vault.getSettings(first.rootPath); } catch (error) { staleReadError = error; }
      expect(staleReadError).toMatchObject({ code: 'conflict' });
    } finally {
      await vault.close();
      await repository.close();
    }
  });
});
