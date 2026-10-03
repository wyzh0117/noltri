import { z } from 'zod';
import {
  deriveTitle,
  isKnowledgeError,
  knowledgeError,
  normalizeKnowledgeText,
  truncate,
  type AiProviderConfig,
} from '@noltri/shared';
import {
  buildClassifyUserPrompt,
  buildExtractUserPrompt,
  classifyCorrectionMessage,
  classifySystemPrompt,
  extractSystemPrompt,
  NODE_CONTEXT_LABEL,
  withJsonOnlyReminder,
} from './prompts';
import type {
  AIProvider,
  ChatInput,
  ChatMessage,
  ChatResult,
  ClassifyInput,
  ClassifyDecision,
  ClassifyResult,
  ExtractInput,
  ExtractResult,
  ExtractedKnowledge,
  ProviderCapabilities,
} from './types';

type JsonMap = Record<string, unknown>;

export interface OpenAiProviderOptions {
  /** Extra attempts after the first one for HTTP 429 / 5xx / aborts. Defaults to 2. */
  maxRetries?: number;
  /** Base of the jittered exponential backoff. Defaults to 250ms. */
  backoffBaseMs?: number;
}

const MAX_PROMPT_TEXT_CHARS = 20_000;
const MAX_PROMPT_CONTEXT_CHARS = 4_000;
const EMBED_BATCH_SIZE = 100;
const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const SUMMARY_CHARS = 160;
const TITLE_CHARS = 28;
const REASON_CHARS = 120;
const RAW_SNIPPET_CHARS = 240;
const DEGRADED_CONFIDENCE = 0.25;

const chatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().optional(),
      completion_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});

const embeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        embedding: z.array(z.number().finite()).min(1),
      }),
    )
    .min(1),
});

const extractedItemSchema = z.object({
  text: z.string().min(1),
  summary: z.string().nullish(),
  confidence: z.number().min(0).max(1),
  suggestedTitle: z.string().nullish(),
});
const extractPayloadSchema = z.object({ items: z.array(extractedItemSchema) });

const classifyPayloadSchema = z.object({
  action: z.enum(['attach', 'create']),
  nodeId: z.string().min(1).nullish(),
  newNodeTitle: z.string().min(1).nullish(),
  newNodePath: z.array(z.string().min(1)).nullish(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

type ChatResponse = z.infer<typeof chatResponseSchema>;
type ClassifyPayload = z.infer<typeof classifyPayloadSchema>;

type RequestFailure =
  | { kind: 'retryable_rate'; message: string }
  | { kind: 'retryable_status'; message: string }
  | { kind: 'retryable_abort'; message: string }
  | { kind: 'retryable_network'; message: string };

class UpstreamHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, endpoint: string) {
    super(`HTTP ${String(status)} from ${endpoint}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.body = body;
  }
}

class TimeoutAbort extends Error {
  constructor(endpoint: string, timeoutMs: number) {
    super(`模型服务超时：${endpoint} 在 ${String(timeoutMs)}ms 内未响应（AI_REQUEST_TIMEOUT_MS）`);
    this.name = 'TimeoutAbort';
  }
}

function requireConfigValue(value: string, envVar: string, purpose: string): string {
  if (value.trim().length === 0) {
    throw knowledgeError(
      'invalid_request',
      `driver=openai 需要配置 ${envVar}（${purpose}）/ ${envVar} is required for the OpenAI-compatible provider`,
    );
  }
  return value.trim();
}

function endpoint(baseUrl: string, segment: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(`${root}/${segment}`);
  } catch {
    throw knowledgeError('invalid_request', `AI_BASE_URL 不是合法的 http(s) endpoint："${root}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw knowledgeError('invalid_request', `AI_BASE_URL 必须使用 http(s) 协议，实际为 "${url.protocol}"`);
  }
  return url.toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

function messageField(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? error.message : `${issue.path.join('.')}: ${issue.message}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function looksLikeFormatRejection(body: string): boolean {
  return /response_format|json|format|structured/i.test(body);
}

function jsonSpanOf(raw: string): string | undefined {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const open = body.search(/[{[]/);
  if (open < 0) return undefined;
  const closer = body.charAt(open) === '{' ? '}' : ']';
  const close = body.lastIndexOf(closer);
  if (close <= open) return undefined;
  return body.slice(open, close + 1);
}

function parseModelJson(raw: string, label: string): unknown {
  const snippet = truncate(raw.trim(), RAW_SNIPPET_CHARS);
  const span = jsonSpanOf(raw);
  if (span === undefined) {
    throw knowledgeError('provider_error', `${label}: 模型未返回 JSON / model output contained no JSON`, {
      raw: snippet,
    });
  }
  try {
    return JSON.parse(span) as unknown;
  } catch {
    throw knowledgeError('provider_error', `${label}: 模型返回的 JSON 无法解析 / malformed JSON`, {
      raw: snippet,
    });
  }
}

function toProviderError(error: unknown, label: string) {
  if (isKnowledgeError(error)) return error;
  if (error instanceof UpstreamHttpError) {
    return knowledgeError('provider_error', `${label}: ${error.name} — ${truncate(error.body, 200)}`, {
      status: error.status,
      raw: truncate(error.body, RAW_SNIPPET_CHARS),
    });
  }
  if (error instanceof TimeoutAbort) {
    return knowledgeError('provider_error', `${label}: ${truncate(error.message, 200)}`);
  }
  return knowledgeError('provider_error', `${label}: ${truncate(errorText(error), 200)}`);
}

/**
 * BYOK adapter for any OpenAI-compatible endpoint (`/chat/completions` + `/embeddings`).
 * Global fetch only: no provider SDK may leak into Knowledge Core (PROJECT_MASTER §8).
 */
export class OpenAiCompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible';
  readonly capabilities: ProviderCapabilities = {
    embeddings: true,
    chat: true,
    structuredOutput: true,
  };

  private readonly config: AiProviderConfig;
  private readonly chatEndpoint: string;
  private readonly embedEndpoint: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;

  constructor(config: AiProviderConfig, options: OpenAiProviderOptions = {}) {
    const apiKey = requireConfigValue(config.apiKey, 'AI_API_KEY', 'BYOK 密钥');
    const baseUrl = requireConfigValue(config.baseUrl, 'AI_BASE_URL', '模型服务 endpoint');
    const chatModel = requireConfigValue(config.chatModel, 'AI_CHAT_MODEL', '对话模型名');
    const embedModel = requireConfigValue(config.embedModel, 'AI_EMBED_MODEL', '向量模型名');
    if (!Number.isInteger(config.embeddingDim) || config.embeddingDim <= 0) {
      throw knowledgeError(
        'invalid_request',
        `AI_EMBEDDING_DIM 必须是正整数，实际为 ${String(config.embeddingDim)}`,
      );
    }
    this.config = { ...config, apiKey, baseUrl, chatModel, embedModel };
    this.chatEndpoint = endpoint(baseUrl, 'chat/completions');
    this.embedEndpoint = endpoint(baseUrl, 'embeddings');
    this.maxRetries = clamp(Math.trunc(options.maxRetries ?? 2), 0, 5);
    this.backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 250);
  }

  async extractKnowledge(input: ExtractInput): Promise<ExtractResult> {
    return this.guarded('extractKnowledge', async () => {
      const text = normalizeKnowledgeText(input.text);
      if (text.length === 0) {
        throw knowledgeError('invalid_request', 'extractKnowledge 需要非空的选中文本');
      }
      const maxItems = Math.trunc(clamp(input.maxItems ?? DEFAULT_MAX_ITEMS, 1, 50));
      const messages: ChatMessage[] = [
        { role: 'system', content: extractSystemPrompt(maxItems) },
        {
          role: 'user',
          content: buildExtractUserPrompt({
            text: truncate(text, MAX_PROMPT_TEXT_CHARS),
            surroundingContext:
              input.surroundingContext === undefined
                ? undefined
                : truncate(normalizeKnowledgeText(input.surroundingContext), MAX_PROMPT_CONTEXT_CHARS),
            sourceLabel: input.sourceLabel,
            sourceType: input.sourceType,
            maxItems,
          }),
        },
      ];
      const payload = await this.requestJsonObject(messages, 'extractKnowledge');
      const parsed = extractPayloadSchema.safeParse(Array.isArray(payload) ? { items: payload } : payload);
      if (!parsed.success) {
        throw knowledgeError('provider_error', `extractKnowledge: 模型 JSON 契约不符 / schema mismatch`, {
          issue: messageField(parsed.error),
          raw: truncate(typeof payload === 'string' ? payload : JSON.stringify(payload), RAW_SNIPPET_CHARS),
        });
      }
      const items: ExtractedKnowledge[] = [];
      for (const candidate of parsed.data.items) {
        const itemText = normalizeKnowledgeText(candidate.text);
        if (itemText.length < 2) continue;
        items.push({
          text: itemText,
          summary: truncate(candidate.summary?.trim() || itemText, SUMMARY_CHARS),
          confidence: roundTo(clamp(candidate.confidence, 0, 1), 2),
          suggestedTitle: truncate(
            candidate.suggestedTitle?.trim() || deriveTitle(itemText, TITLE_CHARS),
            TITLE_CHARS,
          ),
        });
        if (items.length >= maxItems) break;
      }
      return { items };
    });
  }

  async classifyKnowledge(input: ClassifyInput): Promise<ClassifyResult> {
    return this.guarded('classifyKnowledge', async () => {
      if (input.itemText.trim().length === 0) {
        throw knowledgeError('invalid_request', 'classifyKnowledge 需要非空的知识点文本');
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: classifySystemPrompt(input.attachThreshold) },
        { role: 'user', content: buildClassifyUserPrompt(input) },
      ];
      const first = await this.classifyOnce(messages, input);
      if (first.kind === 'decision') return first.decision;

      const corrected: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(first.payload) },
        { role: 'user', content: classifyCorrectionMessage(first.problem) },
      ];
      const second = await this.classifyOnce(corrected, input);
      if (second.kind === 'decision') return second.decision;
      return this.degradeToCreate(input, `${first.problem}；重试后仍失败：${second.problem}`);
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.guarded('embed', async () => {
      if (texts.length === 0) return [];
      const vectors: number[][] = [];
      for (const batch of chunk(texts, EMBED_BATCH_SIZE)) {
        const json = await this.request(this.embedEndpoint, {
          model: this.config.embedModel,
          input: batch,
          dimensions: this.config.embeddingDim,
        });
        const parsed = embeddingResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw knowledgeError('provider_error', `embeddings 响应契约不符 / unexpected shape`, {
            issue: messageField(parsed.error),
          });
        }
        const byIndex = new Map<number, number[]>();
        parsed.data.data.forEach((entry, position) => {
          byIndex.set(entry.index ?? position, entry.embedding);
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const vector = byIndex.get(offset);
          if (vector === undefined) {
            throw knowledgeError('provider_error', `embeddings 响应缺少第 ${String(offset)} 条向量`);
          }
          if (vector.length !== this.config.embeddingDim) {
            throw knowledgeError(
              'provider_error',
              `向量维度不匹配：AI_EMBEDDING_DIM=${String(this.config.embeddingDim)}，实际 ${String(vector.length)}。请核对 AI_EMBED_MODEL`,
            );
          }
          vectors.push(vector);
        }
      }
      return vectors;
    });
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    return this.guarded('chat', async () => {
      if (input.messages.length === 0) {
        throw knowledgeError('invalid_request', 'chat 需要至少一条消息');
      }
      const messages: ChatMessage[] = [];
      const context = input.systemContext?.trim();
      if (context !== undefined && context.length > 0) {
        const scopeNote = input.scope === undefined ? '' : `（作用域 scope：${input.scope}）`;
        messages.push({
          role: 'system',
          content: `【${NODE_CONTEXT_LABEL} / NODE CONTEXT】${scopeNote}\n${truncate(context, MAX_PROMPT_CONTEXT_CHARS * 4)}`,
        });
      }
      for (const message of input.messages) {
        messages.push({ role: message.role, content: message.content });
      }
      const response = await this.complete(
        this.chatPayload(messages, { wantsJson: false, structured: false, maxOutputTokens: input.maxOutputTokens }),
      );
      const text = contentOf(response);
      return {
        text,
        model: response.model ?? this.config.chatModel,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
      };
    });
  }

  private async guarded<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toProviderError(error, label);
    }
  }

  private chatPayload(
    messages: ChatMessage[],
    options: { wantsJson: boolean; structured: boolean; maxOutputTokens?: number },
  ): JsonMap {
    const payload: JsonMap = {
      model: this.config.chatModel,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: this.config.temperature,
      max_tokens: Math.trunc(clamp(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 1, 32_000)),
    };
    if (options.wantsJson && options.structured) {
      payload.response_format = { type: 'json_object' };
    }
    return payload;
  }

  private async complete(payload: JsonMap): Promise<ChatResponse> {
    const json = await this.request(this.chatEndpoint, payload);
    const parsed = chatResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw knowledgeError('provider_error', 'chat/completions 响应契约不符 / unexpected shape', {
        issue: messageField(parsed.error),
      });
    }
    return parsed.data;
  }

  /** One JSON-mode chat call; falls back once when response_format is unsupported. */
  private async requestJsonObject(messages: ChatMessage[], label: string): Promise<unknown> {
    try {
      const response = await this.complete(
        this.chatPayload(messages, { wantsJson: true, structured: true }),
      );
      return parseModelJson(contentOf(response), label);
    } catch (error) {
      if (!(error instanceof UpstreamHttpError) || error.status !== 400) throw error;
      if (!looksLikeFormatRejection(error.body)) throw error;
      const fallbackMessages = withJsonOnlyReminder(messages);
      const response = await this.complete(
        this.chatPayload(fallbackMessages, { wantsJson: true, structured: false }),
      );
      return parseModelJson(contentOf(response), label);
    }
  }

  private async request(url: string, payload: JsonMap): Promise<unknown> {
    const attempts = this.maxRetries + 1;
    let lastFailure: RequestFailure | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.backoffMs(attempt));
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        const body = await response.text();
        if (response.ok) {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            throw knowledgeError('provider_error', `模型服务响应体不是合法 JSON / body is not JSON`, {
              status: response.status,
              raw: truncate(body, RAW_SNIPPET_CHARS),
            });
          }
        }
        if (response.status === 401 || response.status === 403) {
          throw knowledgeError(
            'unauthorized',
            `模型服务鉴权失败 (HTTP ${String(response.status)})，请检查 AI_API_KEY / authentication rejected`,
          );
        }
        if (response.status === 429) {
          lastFailure = { kind: 'retryable_rate', message: `HTTP 429 rate limited` };
          continue;
        }
        if (response.status >= 500) {
          lastFailure = {
            kind: 'retryable_status',
            message: `HTTP ${String(response.status)}: ${truncate(body, 200)}`,
          };
          continue;
        }
        throw new UpstreamHttpError(response.status, body, url);
      } catch (error) {
        if (isKnowledgeError(error) || error instanceof UpstreamHttpError) throw error;
        if (isAbortLike(error)) {
          lastFailure = {
            kind: 'retryable_abort',
            message: `请求在 ${String(this.config.timeoutMs)}ms 内未完成（AI_REQUEST_TIMEOUT_MS）`,
          };
          continue;
        }
        lastFailure = { kind: 'retryable_network', message: errorText(error) };
      }
    }
    if (lastFailure?.kind === 'retryable_rate') {
      throw knowledgeError(
        'rate_limited',
        `模型服务持续限流 (HTTP 429)，已尝试 ${String(attempts)} 次 / still rate limited`,
      );
    }
    if (lastFailure?.kind === 'retryable_abort') {
      throw new TimeoutAbort(url, this.config.timeoutMs);
    }
    if (lastFailure === undefined) {
      throw knowledgeError('provider_error', '模型服务调用失败 / provider call failed');
    }
    throw knowledgeError(
      'provider_error',
      `模型服务调用失败（已尝试 ${String(attempts)} 次）：${lastFailure.message}`,
    );
  }

  private backoffMs(attempt: number): number {
    const exponential = this.backoffBaseMs * 2 ** (attempt - 1);
    return Math.round(exponential / 2 + Math.random() * (exponential / 2));
  }

  private async classifyOnce(
    messages: ChatMessage[],
    input: ClassifyInput,
  ): Promise<{ kind: 'decision'; decision: ClassifyDecision } | { kind: 'invalid'; problem: string; payload: unknown }> {
    const payload = await this.requestJsonObject(messages, 'classifyKnowledge');
    const parsed = classifyPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        problem: `输出契约不符（${messageField(parsed.error)}）`,
        payload,
      };
    }
    const data = parsed.data;
    if (data.action === 'attach') {
      const known = new Set(input.candidates.map((candidate) => candidate.id));
      const nodeId = data.nodeId?.trim();
      if (nodeId === undefined || nodeId.length === 0 || !known.has(nodeId)) {
        return {
          kind: 'invalid',
          problem: `nodeId "${String(data.nodeId)}" 不在候选节点列表中`,
          payload: data,
        };
      }
      if (data.confidence < input.attachThreshold) {
        return {
          kind: 'decision',
          decision: this.createDecision(
            data,
            input,
            `匹配把握度 ${String(roundTo(data.confidence, 2))} 低于归档阈值 ${String(input.attachThreshold)}`,
          ),
        };
      }
      return {
        kind: 'decision',
        decision: {
          action: 'attach',
          nodeId,
          confidence: roundTo(data.confidence, 3),
          reason: truncate(data.reason, REASON_CHARS),
        },
      };
    }
    return { kind: 'decision', decision: this.createDecision(data, input, data.reason) };
  }

  private createDecision(data: ClassifyPayload, input: ClassifyInput, reason: string): ClassifyDecision {
    const title = truncate(
      data.newNodeTitle?.trim() || input.suggestedTitle?.trim() || deriveTitle(input.itemText, TITLE_CHARS),
      TITLE_CHARS,
    );
    const path = (data.newNodePath ?? []).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (path.length === 0 || path[path.length - 1] !== title) path.push(title);
    return {
      action: 'create',
      newNodeTitle: title,
      newNodePath: path.slice(0, 4),
      confidence: roundTo(clamp(data.confidence, 0, 1), 3),
      reason: truncate(reason, REASON_CHARS),
    };
  }

  private degradeToCreate(input: ClassifyInput, problem: string): ClassifyDecision {
    const title = truncate(input.suggestedTitle?.trim() || deriveTitle(input.itemText, TITLE_CHARS), TITLE_CHARS);
    return {
      action: 'create',
      newNodeTitle: title,
      newNodePath: [title],
      confidence: DEGRADED_CONFIDENCE,
      reason: `模型未返回可映射的候选节点，降级为新建（${truncate(problem, REASON_CHARS - 20)}）`,
    };
  }
}

function contentOf(response: ChatResponse): string {
  const content = response.choices[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw knowledgeError('provider_error', '模型未返回文本内容 / empty message content');
  }
  return content;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenAiProvider(config: AiProviderConfig, options?: OpenAiProviderOptions): AIProvider {
  return new OpenAiCompatibleProvider(config, options);
}
