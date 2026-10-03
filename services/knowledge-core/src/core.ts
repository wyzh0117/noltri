/**
 * Knowledge Core — the only place knowledge logic lives (PROJECT_MASTER §2.3).
 *
 * Extension, Desktop Companion, MCP and the Web App all call these same methods; none of them may
 * implement their own classification, dedupe, merge or tree logic. The object is framework-agnostic:
 * `src/http/router.ts` adapts it to web-standard Request/Response, a future Desktop Local Core can
 * hold it in-process, and tests can drive it directly.
 */
import type { AIProvider } from '@noltri/ai-provider';
import type {
  CaptureRequest,
  CaptureResult,
  Conversation,
  ConversationMessage,
  HealthResponse,
  MoveNodeRequest,
  MoveNodeResponse,
  NodeChatRequest,
  NodeChatResponse,
  NodeContextRequest,
  NodeDetail,
  PatchNodeRequest,
  SearchRequest,
  SearchResponse,
  TreeQuery,
  TreeResponse,
  KnowledgeNode,
  NodeContext,
} from '@noltri/schema';
import { silentLogger, type Logger } from '@noltri/shared';
import type { KnowledgeRepository } from '@noltri/storage';
import type { CoreConfig } from './config';
import type { ActorContext, CoreDeps } from './types';
import type { ResearchDomain } from './research';
import { retryCapture, runCapture } from './pipeline/capture';
import { getTree } from './services/tree';
import { getNodeDetail, patchNode as patchNodeRecord } from './services/node';
import { moveNode as moveNodeRecord } from './services/move';
import { search as searchKnowledge } from './services/search';
import { buildNodeContext as assembleContext } from './services/context';
import { chat as chatTurn, listConversations as listConversationRows, listMessages as listMessageRows } from './services/conversation';

export interface KnowledgeCoreOptions {
  repository: KnowledgeRepository;
  provider: AIProvider;
  config: CoreConfig;
  logger?: Logger;
  /** Research Domain extension (Research V1). Optional so knowledge-only embeds stay possible. */
  research?: ResearchDomain;
}

export interface KnowledgeCore {
  readonly deps: CoreDeps;
  /** Research Domain facade (Research V1); absent only in knowledge-only embeddings. */
  readonly research?: ResearchDomain;
  /** Validate -> save RawSource first -> extract -> normalize -> embed -> similarity -> classify -> persist. */
  capture(input: CaptureRequest, actor: ActorContext): Promise<CaptureResult>;
  /** Re-runs extraction onward from the stored raw text of a previously failed source. */
  retryCapture(rawSourceId: string, actor: ActorContext): Promise<CaptureResult>;
  getTree(query: TreeQuery, actor: ActorContext): Promise<TreeResponse>;
  getNodeDetail(nodeId: string, actor: ActorContext): Promise<NodeDetail>;
  patchNode(nodeId: string, patch: PatchNodeRequest, actor: ActorContext): Promise<KnowledgeNode>;
  moveNode(nodeId: string, request: MoveNodeRequest, actor: ActorContext): Promise<MoveNodeResponse>;
  search(request: SearchRequest, actor: ActorContext): Promise<SearchResponse>;
  buildNodeContext(request: NodeContextRequest, actor: ActorContext): Promise<NodeContext>;
  chat(request: NodeChatRequest, actor: ActorContext): Promise<NodeChatResponse>;
  listConversations(actor: ActorContext, nodeId?: string): Promise<Conversation[]>;
  listConversationMessages(conversationId: string, actor: ActorContext): Promise<ConversationMessage[]>;
  health(): HealthResponse;
}

export function createKnowledgeCore(options: KnowledgeCoreOptions): KnowledgeCore {
  const deps: CoreDeps = {
    repository: options.repository,
    provider: options.provider,
    config: options.config,
    logger: options.logger ?? silentLogger,
  };

  return {
    deps,
    research: options.research,
    capture: (input, actor) => runCapture(deps, actor, input),
    retryCapture: (rawSourceId, actor) => retryCapture(deps, actor, rawSourceId),
    getTree: (query, actor) => getTree(deps, actor, query),
    getNodeDetail: (nodeId, actor) => getNodeDetail(deps, actor, nodeId),
    patchNode: (nodeId, patch, actor) => patchNodeRecord(deps, actor, nodeId, patch),
    moveNode: (nodeId, request, actor) => moveNodeRecord(deps, actor, nodeId, request),
    search: (request, actor) => searchKnowledge(deps, actor, request),
    buildNodeContext: (request, actor) => assembleContext(deps, actor, request),
    chat: (request, actor) => chatTurn(deps, actor, request),
    listConversations: (actor, nodeId) => listConversationRows(deps, actor, nodeId),
    listConversationMessages: (conversationId, actor) => listMessageRows(deps, actor, conversationId),
    health: () => healthOf(deps),
  };
}

/**
 * Reports wiring without touching the network: a provider that cannot embed, or an OpenAI-compatible
 * driver with no key, is honest about being degraded.
 */
function healthOf(deps: CoreDeps): HealthResponse {
  const { config, provider, repository } = deps;
  const missingKey = config.ai.driver === 'openai' && config.ai.apiKey.trim().length === 0;
  return {
    status: provider.capabilities.embeddings && !missingKey ? 'ok' : 'degraded',
    version: config.version,
    storageDriver: repository.driver,
    aiProvider: provider.id,
    embeddingDim: config.embeddingDim,
    requiresAiKey: config.ai.driver === 'openai',
  };
}
