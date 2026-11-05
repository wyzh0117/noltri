import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VaultService } from '../src/notes/vault';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';

const directories: string[] = [];
afterAll(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function openVault(rootPath: string, dataDir: string, index: number): Promise<{ vault: VaultService; repository: SqliteRepository }> {
  const repository = new SqliteRepository({ file: path.join(dataDir, `profile-${String(index)}.sqlite`) });
  const vault = new VaultService({ rootPath, dataDir, repository, userId: 'property-types-test' });
  return { vault, repository };
}

describe('Vault property type settings', () => {
  it('persists property types in the shared Vault across profile data directories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-property-types-'));
    directories.push(directory);
    const rootPath = path.join(directory, 'vault');
    const first = await openVault(rootPath, path.join(directory, 'profile-a'), 1);
    const second = await openVault(rootPath, path.join(directory, 'profile-b'), 2);
    try {
      await first.vault.updateSettings({ newLinkFormat: 'relative', propertyTypes: { priority: 'number', tags: 'list' } });
      expect(JSON.parse(await readFile(path.join(rootPath, '.noltri', 'types.json'), 'utf8'))).toEqual({ priority: 'number', tags: 'list' });
      expect((await first.vault.snapshot()).files.some((entry) => entry.path.startsWith('.noltri/'))).toBe(false);
      expect(await second.vault.getSettings()).toMatchObject({ propertyTypes: { priority: 'number', tags: 'list' } });
      await expect(lstat(path.join(rootPath, '.obsidian'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await first.vault.close();
      await second.vault.close();
      await first.repository.close();
      await second.repository.close();
    }
  });

  it('reads legacy Obsidian types without writing to that path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-legacy-types-'));
    directories.push(directory);
    const rootPath = path.join(directory, 'vault');
    const legacyPath = path.join(rootPath, '.obsidian', 'types.json');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ priority: 'number', custom: { keep: true } }));
    const { vault, repository } = await openVault(rootPath, path.join(directory, 'profile'), 1);
    try {
      expect((await vault.getSettings()).propertyTypes).toEqual({ priority: 'number' });
      await vault.updateSettings({ newLinkFormat: 'shortest', propertyTypes: { priority: 'text' } });
      expect(await readFile(legacyPath, 'utf8')).toBe(JSON.stringify({ priority: 'number', custom: { keep: true } }));
      expect(JSON.parse(await readFile(path.join(rootPath, '.noltri', 'types.json'), 'utf8'))).toEqual({ priority: 'text', custom: { keep: true } });
    } finally {
      await vault.close();
      await repository.close();
    }
  });

  it('preserves malformed or symlinked types files instead of overwriting them', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-unsafe-types-'));
    directories.push(directory);
    const rootPath = path.join(directory, 'vault');
    const malformedPath = path.join(rootPath, '.noltri', 'types.json');
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, '{broken');
    const malformed = await openVault(rootPath, path.join(directory, 'profile-a'), 1);
    try {
      await expect(malformed.vault.updateSettings({ newLinkFormat: 'shortest', propertyTypes: { priority: 'number' } })).rejects.toThrow('无法解析或路径不安全');
      expect(await readFile(malformedPath, 'utf8')).toBe('{broken');
    } finally {
      await malformed.vault.close();
      await malformed.repository.close();
    }

    await rm(malformedPath);
    const outside = path.join(directory, 'outside.json');
    await writeFile(outside, '{"keep":true}');
    await symlink(outside, malformedPath);
    const linked = await openVault(rootPath, path.join(directory, 'profile-b'), 2);
    try {
      await expect(linked.vault.updateSettings({ newLinkFormat: 'shortest', propertyTypes: { priority: 'number' } })).rejects.toThrow('无法解析或路径不安全');
      expect(await readFile(outside, 'utf8')).toBe('{"keep":true}');
      expect((await lstat(malformedPath)).isSymbolicLink()).toBe(true);
    } finally {
      await linked.vault.close();
      await linked.repository.close();
    }
  });
});
