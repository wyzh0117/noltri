import type { ContextScope } from '@noltri/schema';

export interface ExtractInput {
  /** The user-selected raw text. Never rewritten in place — extraction is read-only. */
  text: string;
  surroundingContext?: string;
  /** Human label for where the text came from, e.g. "网页：Python 官方文档". */
  sourceLabel: string;
  sourceType: string;
  maxItems?: number;
}

export interface ExtractedKnowledge {
  text: string;
  summary?: string;
  confidence: number;
  suggestedTitle?: string;
}

export interface ExtractResult {
  items: ExtractedKnowledge[];
}

export interface ClassificationCandidate {
  id: string;
  title: string;
  summary?: string | null;
  /** Root → candidate title path, so the model can reason about hierarchy. */
  path: string[];
  itemCount?: number;
}

export interface ClassifyInput {
  itemText: string;
  suggestedTitle?: string;
  candidates: ClassificationCandidate[];
  /** Attach when the best match clears this; otherwise create a node. */
  attachThreshold: number;
  scopeHint?: ContextScope;
}

export type ClassificationAction = 'attach' | 'create';

export interface ClassifyDecision {
  action: ClassificationAction;
  /** Present when action === "attach". */
  nodeId?: string;
  /** Present when action === "create"; path may be one or more levels. */
  newNodeTitle?: string;
  newNodePath?: string[];
  confidence: number;
  reason: string;
}

export type ClassifyResult = ClassifyDecision;

export interface EmbedInput {
  texts: string[];
  /** Provider model name; the storage layer records it so vectors stay comparable. */
  model?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  messages: ChatMessage[];
  /** Localised node context; must be assembled by the Context Builder, not the provider. */
  systemContext?: string;
  scope?: ContextScope;
  maxOutputTokens?: number;
}

export interface ChatResult {
  text: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ProviderCapabilities {
  embeddings: boolean;
  chat: boolean;
  structuredOutput: boolean;
}

/**
 * The only surface Knowledge Core may touch. Business code must never import a
 * provider SDK directly — see PROJECT_MASTER §8 "AI Layer".
 */
export interface AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  extractKnowledge(input: ExtractInput): Promise<ExtractResult>;
  classifyKnowledge(input: ClassifyInput): Promise<ClassifyResult>;
  embed(texts: string[]): Promise<number[][]>;
  chat(input: ChatInput): Promise<ChatResult>;
}
