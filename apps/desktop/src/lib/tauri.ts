import { invoke } from '@tauri-apps/api/core';

export interface ModelProfile {
  id: string;
  name: string;
  provider: 'deepseek' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ModelSettings {
  modelProfiles: ModelProfile[];
  activeModelId: string | null;
}

export interface DesktopSettings extends ModelSettings {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly mcpEndpoint: string;
  readonly runtimeStatus: 'starting' | 'external' | 'dev' | 'managed' | 'failed';
}

export interface SaveModelsResult {
  readonly applied: boolean;
  readonly runtimeStatus: DesktopSettings['runtimeStatus'];
  readonly message: string;
}

export const commands = {
  getSettings: () => invoke<DesktopSettings>('get_settings'),
  saveModelSettings: (settings: ModelSettings) => invoke<SaveModelsResult>('save_model_settings', { settings }),
};
