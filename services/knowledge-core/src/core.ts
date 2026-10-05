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
  AssignSourceRequest,
  AssignSourceResponse,
  CaptureRequest,
  CaptureResult,
  Conversation,
  ConversationMessage,
  HealthResponse,
  InboxQuery,
  InboxResponse,
  MoveNodeRequest,
  MoveNodeResponse,
  NodeChatRequest,
  NodeChatResponse,
  NodeContextRequest,
  NodeDetail,
  PatchNodeRequest,
  RawSource,
  SearchRequest,
  SearchResponse,
  TreeQuery,
  TreeResponse,
  KnowledgeNode,
  NodeContext,
} from '@noltri/schema';
import { CORE_PRODUCT_ID, CORE_PROTOCOL_VERSION } from '@noltri/schema';
import { createId, silentLogger, type Logger } from '@noltri/shared';
import type { KnowledgeRepository } from '@noltri/storage';
import type { CoreConfig } from './config';
import type { ActorContext, CoreDeps } from './types';
import type { ResearchDomain } from './research';
import { retryCapture, runCapture } from './pipeline/capture';
import { getTree } from './services/tree';
import { assignSource, listInbox, readRawSource } from './services/inbox';
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
  /**
   * Research façade, built by the host from its own `ResearchRepository`. Optional on purpose: a
   * knowledge-only embed (an MCP bundle, a test harness) stays constructable without opening a second
   * database handle it would never use. Archiving a node then skips the R03 复核标记 step entirely rather
   * than failing — the same optionality applies, and it is why `CoreDeps` carries it too.
   */
  research?: ResearchDomain;
}

export interface KnowledgeCore {
  readonly deps: CoreDeps;
  /** The Research half of this Core's data, or absent when the host never wired a research repository. */
  readonly research?: ResearchDomain;
  /** Validate -> save RawSource first -> extract -> normalize -> embed -> similarity -> classify -> persist. */
  capture(input: CaptureRequest, actor: ActorContext): Promise<CaptureResult>;
  /** Re-runs extraction onward from the stored raw text of a previously failed source. */
  retryCapture(rawSourceId: string, actor: ActorContext): Promise<CaptureResult>;
  getTree(query: TreeQuery, actor: ActorContext): Promise<TreeResponse>;
  /** Newest-first capture feed plus whole-library status counts — 收件箱. */
  listInbox(query: InboxQuery, actor: ActorContext): Promise<InboxResponse>;
  /** Full text of one capture for manual triage; null when it is not the caller's. */
  readRawSource(rawSourceId: string, actor: ActorContext): Promise<RawSource | null>;
  /** File a capture under a node without any AI stage; the no-model path into the tree. */
  assignSource(rawSourceId: string, request: AssignSourceRequest, actor: ActorContext): Promise<AssignSourceResponse>;
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
    research: options.research,
  };
  // One id per running instance, not per request: a caller that sees it change is talking to a Core that
  // restarted underneath it, which is exactly what the Native Messaging relay has to detect.
  const instanceId = createId();

  return {
    deps,
    research: options.research,
    capture: (input, actor) => runCapture(deps, actor, input),
    retryCapture: (rawSourceId, actor) => retryCapture(deps, actor, rawSourceId),
    getTree: (query, actor) => getTree(deps, actor, query),
    listInbox: (query, actor) => listInbox(deps, actor, query),
    readRawSource: (rawSourceId, actor) => readRawSource(deps, actor, rawSourceId),
    assignSource: (rawSourceId, request, actor) => assignSource(deps, actor, rawSourceId, request),
    getNodeDetail: (nodeId, actor) => getNodeDetail(deps, actor, nodeId),
    patchNode: (nodeId, patch, actor) => patchNodeRecord(deps, actor, nodeId, patch),
    moveNode: (nodeId, request, actor) => moveNodeRecord(deps, actor, nodeId, request),
    search: (request, actor) => searchKnowledge(deps, actor, request),
    buildNodeContext: (request, actor) => assembleContext(deps, actor, request),
    chat: (request, actor) => chatTurn(deps, actor, request),
    listConversations: (actor, nodeId) => listConversationRows(deps, actor, nodeId),
    listConversationMessages: (conversationId, actor) => listMessageRows(deps, actor, conversationId),
    health: () => healthOf(deps, instanceId),
  };
}

/**
 * Reports wiring without touching the network or scanning the library: a provider that cannot embed, an
 * OpenAI-compatible driver with no key, and a storage driver that does not consider itself usable all
 * show up as `degraded` rather than as a green light.
 *
 * It also answers *who* is answering. A loopback port that returns JSON is not proof that Noltri is
 * listening — the desktop host and the browser relay have to identify the product, the running instance
 * and the protocol before they forward a user's text (本地桌面版开发文档 §16).
 */
function healthOf(deps: CoreDeps, instanceId: string): HealthResponse {
  const { config, provider, repository } = deps;
  const missingKey = config.ai.driver === 'openai' && config.ai.apiKey.trim().length === 0;
  const storage = repository.storageHealth();
  return {
    status: provider.capabilities.embeddings && !missingKey && storage.ok ? 'ok' : 'degraded',
    productId: CORE_PRODUCT_ID,
    instanceId,
    protocolVersion: CORE_PROTOCOL_VERSION,
    version: config.version,
    storageDriver: repository.driver,
    storage,
    aiProvider: provider.id,
    embeddingDim: config.embeddingDim,
    requiresAiKey: config.ai.driver === 'openai',
  };
}
