import { createServer, type Server } from 'node:http';
import { createProvider, type AIProvider } from '@noltri/ai-provider';
import {
  createLogger,
  currentEnv,
  envInt,
  envString,
  loadAiConfig,
  type AiProviderConfig,
  type EnvSource,
} from '@noltri/shared';
import { createAiRequestHandler, healthPayload, type AiRequestHandler } from './handler';

const logger = createLogger('ai-service');

export interface AiService {
  provider: AIProvider;
  config: AiProviderConfig;
  handler: AiRequestHandler;
}

export function corsOriginOf(env: EnvSource): string {
  return envString(env, 'AI_CORS_ORIGIN', envString(env, 'CORS_ORIGIN', '*'));
}

/** Same adapter Knowledge Core uses, reached over HTTP instead of in-process. */
export function createAiService(env: EnvSource = currentEnv()): AiService {
  const config = loadAiConfig(env);
  const provider = createProvider(config);
  return {
    provider,
    config,
    handler: createAiRequestHandler({ provider, config, corsOrigin: corsOriginOf(env) }),
  };
}

export function serveAiService(env: EnvSource = currentEnv()): { server: Server; port: number } {
  const service = createAiService(env);
  const host = envString(env, 'AI_SERVICE_HOST', '127.0.0.1');
  const port = envInt(env, 'AI_SERVICE_PORT', 8791);
  const server = createServer(service.handler);
  const health = healthPayload(service.config, service.provider.id);
  server.listen(port, host, () => {
    logger.info('AI provider service listening', {
      host,
      port,
      driver: health.driver,
      chatModel: health.chatModel,
      embedModel: health.embedModel,
      hasApiKey: health.hasApiKey,
    });
  });
  server.on('error', (error: Error) => {
    logger.error('AI service failed to start', { reason: error.message });
  });
  return { server, port };
}
