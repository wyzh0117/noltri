import { expect, it } from 'vitest';
import manifest from '../src/manifest.json';
import { loadSettings, originPermissionPattern, SETTINGS_STORAGE_KEY, type SettingsArea } from '../src/settings/storage';
it('uses the isolated Notes Core port for a fresh extension and grants its default origins', async () => {
  const area: SettingsArea = { name: 'sync', get: async () => ({}), set: async () => undefined };
  const settings = await loadSettings(area);
  expect(settings.apiBaseUrl).toBe('http://localhost:18887');
  expect(originPermissionPattern(settings.apiBaseUrl)).toBe('http://localhost:18887/*');
  expect(manifest.host_permissions).toEqual(['http://localhost:18887/*', 'http://127.0.0.1:18887/*']);
});
it('retains an explicitly saved endpoint instead of silently switching its profile', async () => {
  const area: SettingsArea = { name: 'sync', get: async () => ({ [SETTINGS_STORAGE_KEY]: { apiBaseUrl: 'http://127.0.0.1:8787' } }), set: async () => undefined };
  expect((await loadSettings(area)).apiBaseUrl).toBe('http://127.0.0.1:8787');
});
