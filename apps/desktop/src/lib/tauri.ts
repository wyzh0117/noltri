import { invoke } from '@tauri-apps/api/core';

export type ProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: { text: boolean; image: boolean };
}

export interface ProviderView {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  models: ProviderModel[];
}

export interface ProviderDraft {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: ProviderModel[];
  /** Blank on edit means retain the saved key. The key is never returned by get_settings. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ModelSettings {
  providers: ProviderDraft[];
  activeProviderId: string | null;
  activeModelId: string | null;
}

export interface DesktopSettings extends Omit<ModelSettings, 'providers'> {
  readonly providers: ProviderView[];
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

export interface FetchAvailableModelsInput {
  providerId?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
}

export const commands = {
  getSettings: () => invoke<DesktopSettings>('get_settings'),
  saveModelSettings: (settings: Pick<ModelSettings, 'providers'> & { clearActive?: boolean }) =>
    invoke<SaveModelsResult>('save_model_settings', { settings }),
  useModel: (settings: Pick<ModelSettings, 'providers'> & { providerId: string; modelId: string }) =>
    invoke<SaveModelsResult>('use_model', { settings }),
  fetchAvailableModels: (input: FetchAvailableModelsInput) =>
    invoke<ProviderModel[]>('fetch_available_models', { input }),
};
