import { cosineSimilarity, deriveTitle, normalizeKnowledgeText, splitSentences, truncate, uniqueTokens } from '@noltri/shared';
import type {
  AIProvider,
  ChatInput,
  ChatResult,
  ClassifyInput,
  ClassifyResult,
  EmbedInput,
  ExtractInput,
  ExtractResult,
  ProviderCapabilities,
} from './types';

export interface OfflineProviderOptions {
  embeddingDim?: number;
}

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

/**
 * No-network provider used by tests and by `AI_PROVIDER=offline`.
 * Replies are clearly labelled: this never passes itself off as a model call.
 */
export class OfflineDeterministicProvider implements AIProvider {
  readonly id = 'offline';
  readonly capabilities: ProviderCapabilities = {
    embeddings: true,
    chat: true,
    structuredOutput: false,
  };

  private readonly dim: number;

  constructor(options: OfflineProviderOptions = {}) {
    this.dim = options.embeddingDim ?? 1536;
  }

  async extractKnowledge(input: ExtractInput): Promise<ExtractResult> {
    const maxItems = input.maxItems ?? 6;
    const sentences = splitSentences(normalizeKnowledgeText(input.text));
    const items = sentences.slice(0, maxItems).map((sentence) => {
      const length = sentence.length;
      const hasCode = /[{};]|->|=>|\bdef\b|\bclass\b|\basync\b/.test(sentence);
      const hasNumber = /\d/.test(sentence);
      const confidence = Math.min(
        0.95,
        0.6 + (length > 24 ? 0.12 : 0) + (length > 80 ? 0.08 : 0) + (hasCode ? 0.1 : 0) + (hasNumber ? 0.05 : 0),
      );
      return {
        text: sentence,
        summary: truncate(sentence, 160),
        confidence: Number(confidence.toFixed(2)),
        suggestedTitle: deriveTitle(sentence, 28),
      };
    });
    return { items };
  }

  async classifyKnowledge(input: ClassifyInput): Promise<ClassifyResult> {
    const scored = input.candidates
      .map((candidate) => {
        const haystack = [candidate.title, candidate.summary ?? '', candidate.path.join(' ')].join(' ');
        const score = cosineSimilarity(this.vectorOf(input.itemText), this.vectorOf(haystack));
        return { candidate, score };
      })
      .sort((first, second) => second.score - first.score);

    const best = scored[0];
    if (best && best.score >= input.attachThreshold) {
      return {
        action: 'attach',
        nodeId: best.candidate.id,
        confidence: Number(best.score.toFixed(3)),
        reason: `向量与已有节点「${best.candidate.title}」最接近`,
      };
    }

    const domain = scored.find((entry) => entry.candidate.path.length === 1 && entry.score > 0.15)?.candidate;
    const title = input.suggestedTitle ?? deriveTitle(input.itemText, 28);
    return {
      action: 'create',
      newNodeTitle: title,
      newNodePath: domain ? [domain.title, title] : [title],
      confidence: Number(Math.max(0.2, best ? best.score : 0.2).toFixed(3)),
      reason: best
        ? `最高相似度 ${best.score.toFixed(2)} 低于归档阈值 ${input.attachThreshold}`
        : '知识库中还没有可比较的节点',
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorOf(text));
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const lastUser = [...input.messages].reverse().find((message) => message.role === 'user');
    const contextLength = (input.systemContext ?? '').length;
    return {
      text:
        `（本地离线 Provider：未调用真实模型，仅证明节点上下文装载链路可用）\n\n` +
        `已装载上下文：${contextLength} 个字符，作用域 ${input.scope ?? 'current_node'}。\n` +
        `问题：${lastUser?.content ?? '(无)'}`,
      model: 'offline-deterministic',
    };
  }

  private vectorOf(text: string): number[] {
    const normalized = normalizeKnowledgeText(text).toLowerCase();
    const values = new Array<number>(this.dim).fill(0);
    for (const token of uniqueTokens(normalized)) {
      const hash = fnv1a(token);
      values[hash % this.dim] += 1;
      values[(hash >>> 8) % this.dim] += 0.5;
    }
    let magnitude = 0;
    for (const value of values) magnitude += value * value;
    magnitude = Math.sqrt(magnitude);
    if (magnitude === 0) return values;
    return values.map((value) => value / magnitude);
  }
}

export function createOfflineProvider(options: OfflineProviderOptions = {}): AIProvider {
  return new OfflineDeterministicProvider(options);
}
