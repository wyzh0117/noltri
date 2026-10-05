/**
 * Offline, deterministic test doubles.
 *
 * `createInMemoryRepository` is the storage double and `OfflineDeterministicProvider` the model double
 * (no network, stable vectors). `ScriptedProvider` layers on top of it so a test can pin an exact
 * extraction / classification answer, force a failure, and read the shared timeline that proves the
 * pipeline ordering V1_DEVELOPMENT §9 requires.
 */
import type {
  AIProvider,
  ChatInput,
  ChatResult,
  ClassifyInput,
  ClassifyResult,
  ExtractInput,
  ExtractResult,
  ExtractedKnowledge,
  ProviderCapabilities,
} from '@noltri/ai-provider';
import { createOfflineProvider } from '@noltri/ai-provider';
import type { CaptureClient, CaptureRequest } from '@noltri/schema';
import { createId, nowIso, silentLogger } from '@noltri/shared';
import { createInMemoryRepository, type KnowledgeRepository } from '@noltri/storage';
import { loadCoreConfig, type CoreConfig } from '../src/config';
import { createKnowledgeCore, type KnowledgeCore } from '../src/core';
import type { ActorContext } from '../src/types';

export type TimelineKind = 'repo' | 'ai';
export interface TimelineEntry {
  kind: TimelineKind;
  call: string;
  arg?: unknown;
}

export function testConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return { ...loadCoreConfig({}), ...overrides };
}

export function thresholdsOf(overrides: Partial<CoreConfig['thresholds']> = {}): CoreConfig['thresholds'] {
  return { ...loadCoreConfig({}).thresholds, ...overrides };
}

export function captureOf(
  text: string,
  client: CaptureClient = 'web_app',
  source: Partial<CaptureRequest['source']> = {},
  requestId: string = createId(),
): CaptureRequest {
  return {
    requestId,
    text,
    source: { type: client === 'extension' ? 'web' : client === 'desktop' ? 'desktop_app' : 'manual', ...source },
    capture: { capturedAt: nowIso(), client },
  };
}

/** Records every repository method call into a shared, ordered timeline. */
export function tracedRepository(inner: KnowledgeRepository, timeline: TimelineEntry[]): KnowledgeRepository {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          timeline.push({ kind: 'repo', call: String(property) });
          const method = value as (...inner: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      return value;
    },
  });
}

export type FailFlag = 'extract' | 'classify' | 'embed' | 'chat';

export interface Script {
  extract?: (input: ExtractInput) => ExtractResult;
  classify?: (input: ClassifyInput) => ClassifyResult;
  chat?: (input: ChatInput) => ChatResult;
  fail?: FailFlag[];
}

/**
 * Deterministic provider: defaults to the offline model behaviour, but every answer can be pinned and
 * every call is observable.
 */
export class ScriptedProvider implements AIProvider {
  readonly id = 'scripted';
  readonly capabilities: ProviderCapabilities = { embeddings: true, chat: true, structuredOutput: true };

  private readonly inner = createOfflineProvider({ embeddingDim: 1536 });
  readonly fail: Set<FailFlag>;

  constructor(
    private readonly timeline: TimelineEntry[],
    private readonly script: Script = {},
  ) {
    this.fail = new Set(script.fail ?? []);
  }

  readonly extractInputs: ExtractInput[] = [];
  readonly classifyInputs: ClassifyInput[] = [];
  readonly chatInputs: ChatInput[] = [];
  readonly embedInputs: string[][] = [];

  private record(kind: TimelineKind, call: string, arg: unknown): void {
    this.timeline.push({ kind, call, arg });
    if (this.fail.has(call as FailFlag)) {
      throw new Error(`scripted provider failure on ${call}`);
    }
  }

  async extractKnowledge(input: ExtractInput): Promise<ExtractResult> {
    this.record('ai', 'extract', input);
    this.extractInputs.push(input);
    if (this.script.extract !== undefined) return this.script.extract(input);
    return await this.inner.extractKnowledge(input);
  }

  async classifyKnowledge(input: ClassifyInput): Promise<ClassifyResult> {
    this.record('ai', 'classify', input);
    this.classifyInputs.push(input);
    if (this.script.classify !== undefined) return this.script.classify(input);
    return await this.inner.classifyKnowledge(input);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.record('ai', 'embed', texts);
    this.embedInputs.push(texts);
    return await this.inner.embed(texts);
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    this.record('ai', 'chat', input);
    this.chatInputs.push(input);
    if (this.script.chat !== undefined) return this.script.chat(input);
    return await this.inner.chat(input);
  }

  /** Convenience for tests that need one fixed extraction answer. */
  static extracted(items: ExtractedKnowledge[]): Script {
    return { extract: () => ({ items }) };
  }
}

export interface Harness {
  core: KnowledgeCore;
  repository: KnowledgeRepository;
  provider: ScriptedProvider;
  timeline: TimelineEntry[];
  actor: ActorContext;
  config: CoreConfig;
}

export function makeHarness(options: { config?: CoreConfig; script?: Script; repository?: KnowledgeRepository } = {}): Harness {
  const timeline: TimelineEntry[] = [];
  const config = options.config ?? testConfig();
  const inner = options.repository ?? createInMemoryRepository();
  const repository = tracedRepository(inner, timeline);
  const provider = new ScriptedProvider(timeline, options.script ?? {});
  const core = createKnowledgeCore({ repository, provider, config, logger: silentLogger });
  return {
    core,
    repository,
    provider,
    timeline,
    config,
    actor: { userId: config.devUser, actor: 'test' },
  };
}

export function repoCalls(timeline: TimelineEntry[]): string[] {
  return timeline.filter((entry) => entry.kind === 'repo').map((entry) => entry.call);
}

/**
 * Structure and evidence written straight through the repository seam, for the services whose subject
 * is not the capture pipeline (tree, search, context, conversation).
 */
export async function createNodeRecord(
  harness: Harness,
  title: string,
  parentId: string | null = null,
): Promise<string> {
  const node = await harness.repository.createNode({
    userId: harness.actor.userId,
    title,
    parentId,
    nodeType: 'topic',
    confidence: 0.8,
  });
  return node.id;
}

export interface ItemFixture {
  readonly itemId: string;
  readonly rawSourceId: string;
}

export async function attachItemRecord(
  harness: Harness,
  nodeId: string,
  text: string,
  source: { sourceType?: 'web' | 'desktop_app' | 'agent' | 'manual'; sourceTitle?: string; sourceUrl?: string } = {},
): Promise<ItemFixture> {
  const rawSource = await harness.repository.createRawSource({
    userId: harness.actor.userId,
    rawText: text,
    sourceType: source.sourceType ?? 'manual',
    sourceTitle: source.sourceTitle ?? null,
    sourceUrl: source.sourceUrl ?? null,
    capturedAt: nowIso(),
  });
  const [embedding] = await harness.provider.embed([text]);
  const item = await harness.repository.createKnowledgeItem({
    userId: harness.actor.userId,
    rawSourceId: rawSource.id,
    normalizedText: text,
    summary: null,
    confidence: 0.8,
    embedding,
    embeddingModel: 'offline-deterministic',
    embeddingStatus: 'ready',
  });
  await harness.repository.linkItemToNode({
    userId: harness.actor.userId,
    itemId: item.id,
    nodeId,
    relationType: 'primary',
    confidence: 0.8,
  });
  return { itemId: item.id, rawSourceId: rawSource.id };
}

export function aiCalls(timeline: TimelineEntry[]): string[] {
  return timeline.filter((entry) => entry.kind === 'ai').map((entry) => entry.call);
}

export function indexOfCall(timeline: TimelineEntry[], kind: TimelineKind, call: string): number {
  return timeline.findIndex((entry) => entry.kind === kind && entry.call === call);
}

export const CHINESE_TEXT =
  'Python 的元组一旦创建就不能修改，因此可以作为字典的键使用。列表则可以随时追加元素，但不能作为字典的键。';
