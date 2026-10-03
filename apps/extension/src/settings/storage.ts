import { MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';

export const SETTINGS_STORAGE_KEY = 'noltri.settings';

/** Default matches `NOLTRI_API_BASE_URL` in the repository `.env.example`. */
export const DEFAULT_API_BASE_URL = 'http://localhost:8787';

export interface ExtensionSettings {
  apiBaseUrl: string;
  accessToken: string;
  minimumSelectionLength: number;
  autoShowButton: boolean;
  disabledDomains: string[];
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  accessToken: '',
  minimumSelectionLength: MIN_CAPTURE_TEXT_LENGTH,
  autoShowButton: true,
  disabledDomains: [],
};

export type StorageAreaName = 'sync' | 'local' | 'session' | 'managed';

/**
 * Minimal storage surface the extension depends on, so every settings call is testable
 * with a plain in-memory fake instead of `chrome.storage`.
 */
export interface SettingsArea {
  readonly name: StorageAreaName;
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ChromeStorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function asSettingsArea(area: ChromeStorageAreaLike, name: StorageAreaName): SettingsArea {
  return {
    name,
    get: async (key) => area.get(key),
    set: async (items) => {
      await area.set(items);
    },
  };
}

export function syncArea(): SettingsArea {
  return asSettingsArea(chrome.storage.sync, 'sync');
}

export function localArea(): SettingsArea {
  return asSettingsArea(chrome.storage.local, 'local');
}

export function parseDomainList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;\n]+/)
        .map((entry) => normalizeDomain(entry))
        .filter((entry) => entry.length > 0),
    ),
  );
}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  // Parsing as a URL (with a scheme added when the user pasted a whole address) is what makes
  // credentials, ports and paths disappear instead of turning into a bogus "domain".
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname.replace(/^www\./, '');
    return /^[a-z0-9.-]+$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

/** Tolerant reader: a partially written or hand-edited record must never break the content script. */
export function normalizeSettings(raw: unknown): ExtensionSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const record = raw as Record<string, unknown>;
  const minimumLength = toFiniteNumber(record.minimumSelectionLength);
  return {
    apiBaseUrl: typeof record.apiBaseUrl === 'string' && record.apiBaseUrl.length > 0 ? record.apiBaseUrl : DEFAULT_API_BASE_URL,
    accessToken: typeof record.accessToken === 'string' ? record.accessToken : '',
    minimumSelectionLength: clamp(minimumLength ?? MIN_CAPTURE_TEXT_LENGTH, MIN_CAPTURE_TEXT_LENGTH, 500),
    autoShowButton: typeof record.autoShowButton === 'boolean' ? record.autoShowButton : true,
    disabledDomains: Array.isArray(record.disabledDomains)
      ? record.disabledDomains.filter((entry): entry is string => typeof entry === 'string').map(normalizeDomain).filter((entry) => entry.length > 0)
      : [],
  };
}

export async function loadSettings(area: SettingsArea = syncArea()): Promise<ExtensionSettings> {
  const items = await area.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(items?.[SETTINGS_STORAGE_KEY]);
}

/**
 * Settings are the only thing kept in `chrome.storage.sync`, and that includes the access token.
 * `chrome.storage.local` is writable by any other extension with the broad `storage` permission and
 * is where device ids live, so writing a token there is refused rather than merely discouraged.
 */
export async function saveSettings(settings: ExtensionSettings, area: SettingsArea = syncArea()): Promise<void> {
  const cleaned: ExtensionSettings = {
    ...settings,
    apiBaseUrl: validateApiBaseUrl(settings.apiBaseUrl).url,
    minimumSelectionLength: clamp(settings.minimumSelectionLength, MIN_CAPTURE_TEXT_LENGTH, 500),
    disabledDomains: Array.from(new Set(settings.disabledDomains.map(normalizeDomain).filter((entry) => entry.length > 0))),
  };
  if (cleaned.accessToken.length > 0 && area.name !== 'sync') {
    throw new Error('refusing to persist the access token outside chrome.storage.sync');
  }
  await area.set({ [SETTINGS_STORAGE_KEY]: cleaned });
}

export function isDomainDisabled(hostname: string, disabledDomains: readonly string[]): boolean {
  const target = normalizeDomain(hostname);
  if (target.length === 0) return false;
  return disabledDomains.some((raw) => {
    const entry = normalizeDomain(raw);
    return entry.length > 0 && (target === entry || target.endsWith(`.${entry}`));
  });
}

export interface UrlValidation {
  readonly ok: boolean;
  readonly url: string;
  readonly message: string;
}

export function validateApiBaseUrl(value: string): UrlValidation {
  const trimmed = value.trim().replace(/\/+$/, '');
  const fail = (message: string): UrlValidation => ({ ok: false, url: trimmed, message });
  if (trimmed.length === 0) return fail('API 地址不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail('API 地址不是合法 URL，例如 http://localhost:8787');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('API 地址只能使用 http 或 https');
  }
  if (!parsed.hostname) return fail('API 地址缺少域名');
  return { ok: true, url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, message: '' };
}

/** Match pattern accepted by `chrome.permissions.request`, so a self-hosted Core can be granted. */
export function originPermissionPattern(baseUrl: string): string {
  const parsed = new URL(validateApiBaseUrl(baseUrl).url);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Math.round(Number(value));
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
