import { describe, expect, it } from 'vitest';
import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import {
  DEFAULT_SETTINGS,
  isDomainDisabled,
  loadSettings,
  normalizeDomain,
  normalizeSettings,
  originPermissionPattern,
  parseDomainList,
  saveSettings,
  validateApiBaseUrl,
  type SettingsArea,
  type StorageAreaName,
} from '../src/settings/storage';

function memoryArea(name: StorageAreaName = 'sync'): SettingsArea & { read(): Record<string, unknown> } {
  const items: Record<string, unknown> = {};
  return {
    name,
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    set: async (next) => {
      Object.assign(items, next);
    },
    read: () => items,
  };
}

describe('settings storage', () => {
  it('round-trips through the injected sync area', async () => {
    const area = memoryArea();
    await saveSettings({ ...DEFAULT_SETTINGS, apiBaseUrl: 'http://127.0.0.1:8787', disabledDomains: ['Example.com', 'example.com'] }, area);
    const loaded = await loadSettings(area);
    expect(loaded.apiBaseUrl).toBe('http://127.0.0.1:8787');
    expect(loaded.disabledDomains).toEqual(['example.com']);
  });

  it('refuses to persist the access token anywhere but sync storage', async () => {
    const local = memoryArea('local');
    await expect(saveSettings({ ...DEFAULT_SETTINGS, accessToken: 'secret' }, local)).rejects.toThrow(/chrome.storage.sync/);
    expect(local.read()).toEqual({});
  });

  it('survives a partially written or hand-edited record', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ apiBaseUrl: 42, minimumSelectionLength: '3', disabledDomains: ['ok.cn', 7] })).toEqual({
      ...DEFAULT_SETTINGS,
      minimumSelectionLength: MIN_CAPTURE_TEXT_LENGTH,
      disabledDomains: ['ok.cn'],
    });
  });

  it('disables a domain and its subdomains only', () => {
    expect(isDomainDisabled('blog.example.com', ['example.com'])).toBe(true);
    expect(isDomainDisabled('example.com', ['example.com'])).toBe(true);
    expect(isDomainDisabled('notexample.com', ['example.com'])).toBe(false);
    expect(isDomainDisabled('www.example.com', ['WWW.example.com/'])).toBe(true);
  });

  it('validates the API origin before it can be stored', () => {
    expect(validateApiBaseUrl('https://core.example.com/api/')).toEqual({ ok: true, url: 'https://core.example.com/api', message: '' });
    expect(validateApiBaseUrl('not a url').ok).toBe(false);
    expect(validateApiBaseUrl('ftp://core.example.com').ok).toBe(false);
    expect(validateApiBaseUrl('')).toEqual({ ok: false, url: '', message: 'API 地址不能为空' });
    expect(originPermissionPattern('https://core.example.com:8787/api')).toBe('https://core.example.com:8787/*');
  });

  it('parses a free-form disable list into unique domains', () => {
    expect(parseDomainList('example.com, www.a.cn\n b.d.org  example.com')).toEqual(['example.com', 'a.cn', 'b.d.org']);
    expect(parseDomainList('javascript:alert(1)')).toEqual([]);
    expect(normalizeDomain('https://User:pw@host.example.com/x')).toBe('host.example.com');
  });
});
