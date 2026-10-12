import { invoke } from '@tauri-apps/api/core';

export interface DesktopSettings {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly mcpEndpoint: string;
}

export const commands = {
  getSettings: () => invoke<DesktopSettings>('get_settings'),
};
