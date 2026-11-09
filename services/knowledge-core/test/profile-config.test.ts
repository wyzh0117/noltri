import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoreConfig, resolveDataDirectory, resolveSqliteFile, resolveVaultDirectory } from '../src/config';

const syntheticHome = '/synthetic-home';
beforeEach(() => { vi.spyOn(os, 'homedir').mockReturnValue(syntheticHome); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Notes product profile configuration', () => {
  // Returning the retired line's home when no override is supplied must fail this regression.
  it('uses a separate Notes default for the database, data and Vault without probing a profile', () => {
    const config = loadCoreConfig({ STORAGE_DRIVER: 'memory', AI_PROVIDER: 'offline' });
    expect(config.dataDir).toBe('/synthetic-home/.noltri-notes/data');
    expect(config.sqliteFile).toBe('/synthetic-home/.noltri-notes/data/noltri.sqlite');
    expect(config.vaultDir).toBe('/synthetic-home/.noltri-notes/data/vault');
    expect(config.grantFile).toBe('');
    expect(config.version).toBe('0.1.0');
  });

  it('keeps an explicit data override and requires it to select a retired profile path', () => {
    const explicit = { NOLTRI_DATA_DIR: '/synthetic-home/.noltri/data' };
    expect(resolveDataDirectory(explicit)).toBe('/synthetic-home/.noltri/data');
    expect(resolveSqliteFile(explicit)).toBe('/synthetic-home/.noltri/data/noltri.sqlite');
    expect(resolveVaultDirectory(explicit)).toBe('/synthetic-home/.noltri/data/vault');
    expect(resolveDataDirectory({})).not.toBe('/synthetic-home/.noltri/data');
  });

  it('preserves an explicit database and data-directory precedence without opening either', () => {
    const explicit = { NOLTRI_SQLITE_FILE: '/synthetic-profiles/selected.sqlite' };
    expect(resolveSqliteFile(explicit)).toBe('/synthetic-profiles/selected.sqlite');
    expect(resolveDataDirectory(explicit)).toBe('/synthetic-profiles');
    const both = { ...explicit, NOLTRI_DATA_DIR: '/synthetic-data' };
    expect(resolveSqliteFile(both)).toBe('/synthetic-profiles/selected.sqlite');
    expect(resolveDataDirectory(both)).toBe('/synthetic-data');
    expect(resolveSqliteFile({ NOLTRI_SQLITE_FILE: 'chosen.sqlite' })).toBe(path.resolve('chosen.sqlite'));
  });

  it('treats empty overrides as the new default and retains explicit Vault/version settings', () => {
    expect(resolveDataDirectory({ NOLTRI_DATA_DIR: '', NOLTRI_SQLITE_FILE: '' })).toBe('/synthetic-home/.noltri-notes/data');
    expect(resolveVaultDirectory({ NOLTRI_NOTES_DIR: '/synthetic-vault' })).toBe('/synthetic-vault');
    expect(loadCoreConfig({ STORAGE_DRIVER: 'memory', AI_PROVIDER: 'offline', NOLTRI_VERSION: 'synthetic-build' }).version).toBe('synthetic-build');
  });
});

it('keeps distributed manifests and the runtime default on one Notes release identity', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const json = (relative: string) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
  const manifests = [
    'package.json', 'apps/desktop/package.json', 'apps/extension/package.json',
    'packages/ai-provider/package.json', 'packages/api-client/package.json', 'packages/schema/package.json',
    'packages/shared/package.json', 'packages/storage/package.json', 'services/ai/package.json',
    'services/knowledge-core/package.json', 'services/mcp-server/package.json', 'apps/extension/src/manifest.json',
  ];
  for (const manifest of manifests) expect(json(manifest).version, manifest).toBe('0.1.0');
  const desktop = json('apps/desktop/src-tauri/tauri.conf.json');
  expect(desktop.version).toBe(loadCoreConfig({ STORAGE_DRIVER: 'memory', AI_PROVIDER: 'offline' }).version);
  expect(desktop.identifier).toBe('com.noltri.notes');
  const cargo = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
  expect(cargoVersion).toBe('0.1.0');
  const lock = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  const lockVersion = lock.match(/\[\[package\]\]\nname = "noltri-companion"\nversion = "([^"]+)"/)?.[1];
  expect(lockVersion).toBe(cargoVersion);
});
