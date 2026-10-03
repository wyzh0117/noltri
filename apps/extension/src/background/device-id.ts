import { createId } from '@noltri/shared';
import type { SettingsArea } from '../settings/storage';

export const DEVICE_ID_STORAGE_KEY = 'noltri.deviceId';

/**
 * A stable per-install device id, kept in `chrome.storage.local` (device-scoped by design, never synced).
 * It is the only value the extension writes to local storage: the access token must stay in sync storage.
 */
export async function ensureDeviceId(area: SettingsArea, generate: () => string = createId): Promise<string> {
  const stored = await area.get(DEVICE_ID_STORAGE_KEY);
  const existing = stored?.[DEVICE_ID_STORAGE_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const deviceId = generate();
  await area.set({ [DEVICE_ID_STORAGE_KEY]: deviceId });
  return deviceId;
}
