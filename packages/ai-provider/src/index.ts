import type { AiProviderConfig } from '@noltri/shared';
import { createOfflineProvider } from './offline';
import { createOpenAiProvider } from './openai';
import type { AIProvider } from './types';
import { knowledgeError } from '@noltri/shared';

export function createProvider(config: AiProviderConfig): AIProvider {
  switch (config.driver) {
    case 'openai':
      return createOpenAiProvider(config);
    case 'offline':
      return createOfflineProvider({ embeddingDim: config.embeddingDim });
    case 'disabled':
      return {
        id: 'disabled',
        capabilities: { embeddings: false, chat: false, structuredOutput: false },
        async extractKnowledge() {
          throw knowledgeError('provider_error', '尚未选择 AI 模型，请先在模型设置中选择一个模型。');
        },
        async classifyKnowledge() {
          throw knowledgeError('provider_error', '尚未选择 AI 模型，请先在模型设置中选择一个模型。');
        },
        async embed() {
          throw knowledgeError('provider_error', '尚未选择 AI 模型，请先在模型设置中选择一个模型。');
        },
        async chat() {
          throw knowledgeError('provider_error', '尚未选择 AI 模型，请先在模型设置中选择一个模型。');
        },
      };
    default:
      throw new Error(`Unsupported AI driver "${String(config.driver)}"`);
  }
}

export * from './types';
export { OfflineDeterministicProvider, createOfflineProvider } from './offline';
export { OpenAiCompatibleProvider, createOpenAiProvider } from './openai';
export type { AiProviderConfig, AiProtocol } from '@noltri/shared';
