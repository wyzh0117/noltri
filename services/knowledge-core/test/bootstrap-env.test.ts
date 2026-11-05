import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
const io = vi.hoisted(() => ({ exists: vi.fn(), dotenv: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: io.exists }));
vi.mock('dotenv', () => ({ config: io.dotenv, default: { config: io.dotenv } }));
import { loadRootEnv } from '../src/server';
import { loadCoreConfig } from '../src/config';
beforeEach(() => {
  io.exists.mockReset().mockReturnValue(true);
  io.dotenv.mockReset().mockReturnValue({ parsed: {} });
  vi.spyOn(os, 'homedir').mockReturnValue('/synthetic-home');
  vi.stubEnv('NOLTRI_ENV_FILE', '');
  vi.stubEnv('NOLTRI_DATA_DIR', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const probes = () => io.exists.mock.calls.map(call => String(call[0]));
const loaded = () => io.dotenv.mock.calls.map(call => String(call[0].path));
// A cwd walk, retired home probe, or fallback after an explicit selection must fail these cases.
describe('explicit Notes bootstrap environment selection', () => {
  it('probes only the new home when no environment file or data directory is selected', () => {
    loadRootEnv();
    expect(probes()).toEqual(['/synthetic-home/.noltri-notes/.env.local', '/synthetic-home/.noltri-notes/.env']);
    expect(loaded()).toEqual(probes());
  });
  it('also accepts only the explicitly selected data profile without walking project parents', () => {
    vi.stubEnv('NOLTRI_DATA_DIR', '/synthetic-current-profile');
    loadRootEnv();
    expect(probes()).toEqual(['/synthetic-home/.noltri-notes/.env.local', '/synthetic-current-profile/.env.local', '/synthetic-home/.noltri-notes/.env', '/synthetic-current-profile/.env']);
    expect(loaded()).toEqual(probes());
  });
  it('loads a selected environment file exclusively, even when other profiles exist', () => {
    vi.stubEnv('NOLTRI_ENV_FILE', '/synthetic-selected/only.env');
    vi.stubEnv('NOLTRI_DATA_DIR', '/synthetic-unused-profile');
    loadRootEnv();
    expect(probes()).toEqual(['/synthetic-selected/only.env']);
    expect(loaded()).toEqual(['/synthetic-selected/only.env']);
  });
  it('does not fall back when the explicit environment file is missing', () => {
    vi.stubEnv('NOLTRI_ENV_FILE', '/synthetic-selected/missing.env');
    io.exists.mockImplementation((name: string) => name !== '/synthetic-selected/missing.env');
    loadRootEnv();
    expect(probes()).toEqual(['/synthetic-selected/missing.env']);
    expect(loaded()).toEqual([]);
  });
});
it('defaults the source Core to the isolated Notes port', () => {
  expect(loadCoreConfig({ STORAGE_DRIVER: 'memory', AI_PROVIDER: 'offline' }).port).toBe(18887);
});
