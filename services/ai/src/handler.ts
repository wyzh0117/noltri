import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AIProvider, ChatInput, ClassifyInput, ExtractInput } from '@noltri/ai-provider';
import { asKnowledgeError, knowledgeError, type AiProviderConfig } from '@noltri/shared';
import {
  chatRequestSchema,
  classifyRequestSchema,
  embedRequestSchema,
  extractRequestSchema,
} from './schemas';

const MAX_BODY_BYTES = 1_000_000;

export type AiRequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface AiServiceDeps {
  provider: AIProvider;
  config: AiProviderConfig;
  corsOrigin?: string;
}

export interface HealthPayload {
  status: 'ok';
  provider: string;
  driver: string;
  chatModel: string;
  embedModel: string;
  embeddingDim: number;
  timeoutMs: number;
  baseUrl: string;
  /** Never the key itself: the presence flag is all this service reports. */
  hasApiKey: boolean;
  requiresApiKey: boolean;
}

export function healthPayload(config: AiProviderConfig, providerId: string): HealthPayload {
  return {
    status: 'ok',
    provider: providerId,
    driver: config.driver,
    chatModel: config.chatModel,
    embedModel: config.embedModel,
    embeddingDim: config.embeddingDim,
    timeoutMs: config.timeoutMs,
    baseUrl: config.baseUrl,
    hasApiKey: config.apiKey.trim().length > 0,
    requiresApiKey: config.driver === 'openai',
  };
}

function validationFailure(error: unknown, label: string) {
  if (error instanceof z.ZodError) {
    return knowledgeError('invalid_request', `${label} 请求体校验失败 / request body failed validation`, error.issues);
  }
  return asKnowledgeError(error);
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-max-age', '600');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on('data', (piece: Buffer) => {
      received += piece.length;
      if (received > MAX_BODY_BYTES) {
        reject(knowledgeError('invalid_request', '请求体超过 1MB 上限 / body too large'));
        request.destroy();
        return;
      }
      chunks.push(piece);
    });
    request.on('error', (error: Error) => {
      reject(knowledgeError('invalid_request', `读取请求体失败 / could not read body: ${error.message}`));
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        reject(knowledgeError('invalid_request', '请求体必须是 JSON 对象 / an empty body is not accepted'));
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(knowledgeError('invalid_request', '请求体不是合法 JSON / body is not valid JSON'));
      }
    });
  });
}

async function dispatch(deps: AiServiceDeps, pathname: string, body: unknown): Promise<unknown> {
  const { provider } = deps;
  switch (pathname) {
    case '/extract': {
      const input: ExtractInput = validation(body, extractRequestSchema, 'extract');
      return await provider.extractKnowledge(input);
    }
    case '/classify': {
      const input: ClassifyInput = validation(body, classifyRequestSchema, 'classify');
      return await provider.classifyKnowledge(input);
    }
    case '/embed': {
      const { texts } = validation(body, embedRequestSchema, 'embed');
      const vectors = await provider.embed(texts);
      return {
        model: deps.config.embedModel,
        dim: deps.config.embeddingDim,
        count: vectors.length,
        vectors,
      };
    }
    case '/chat': {
      const input: ChatInput = validation(body, chatRequestSchema, 'chat');
      return await provider.chat(input);
    }
    default:
      throw knowledgeError('not_found', `未知端点 ${pathname} / unknown endpoint`);
  }
}

function validation<T>(body: unknown, schema: { parse(data: unknown): T }, label: string): T {
  try {
    return schema.parse(body);
  } catch (error) {
    throw validationFailure(error, label);
  }
}

export function createAiRequestHandler(deps: AiServiceDeps): AiRequestHandler {
  const corsOrigin = deps.corsOrigin ?? '*';
  return (request, response) => {
    void handle(deps, corsOrigin, request, response);
  };
}

async function handle(
  deps: AiServiceDeps,
  corsOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = (request.url ?? '/').split('?')[0];
  const method = request.method ?? 'GET';
  try {
    if (method === 'OPTIONS') {
      setCors(response, corsOrigin);
      response.writeHead(204);
      response.end();
      return;
    }
    setCors(response, corsOrigin);
    if (pathname === '/health') {
      if (method !== 'GET') throw knowledgeError('invalid_request', '仅支持 GET /health');
      sendJson(response, 200, healthPayload(deps.config, deps.provider.id));
      return;
    }
    if (method !== 'POST') throw knowledgeError('invalid_request', `${pathname} 仅支持 POST`);
    const body = await readJsonBody(request);
    sendJson(response, 200, await dispatch(deps, pathname, body));
  } catch (error) {
    const mapped = validationFailure(error, pathname);
    sendJson(response, mapped.status, mapped.toJSON());
  }
}
