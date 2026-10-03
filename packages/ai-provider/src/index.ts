import type { AiProviderConfig } from '@noltri/shared';
import { createOfflineProvider } from './offline';
import { createOpenAiProvider } from './openai';
import type { AIProvider } from './types';

export function createProvider(config: AiProviderConfig): AIProvider {
  switch (config.driver) {
    case 'openai':
      return createOpenAiProvider(config);
    case 'offline':
      return createOfflineProvider({ embeddingDim: config.embeddingDim });
    default:
      throw new Error(`Unsupported AI driver "${String(config.driver)}"`);
  }
}

export * from './types';
export { OfflineDeterministicProvider, createOfflineProvider } from './offline';
export { OpenAiCompatibleProvider, createOpenAiProvider } from './openai';
export type { AiProviderConfig };
