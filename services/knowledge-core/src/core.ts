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
  ChapterResponse,
  ChapterTarget,
  Conversation,
  ConversationMessage,
  CreateChapterRequest,
  GraphNote,
  GraphNoteIndex,
  GraphScope,
  GraphSelection,
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
  ResolveChapterRequest,
  SaveGraphNoteRequest,
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
import type { ActorContext, CoreDeps, GraphNoteStore } from './types';
import { retryCapture, runCapture } from './pipeline/capture';
import { getTree } from './services/tree';
import { connectChapter, createChapter, disconnectChapter, getGraphNote, listGraphNotes, resolveChapter, saveGraphNote, selectGraph } from './services/graph';
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
  graphNoteStore?: GraphNoteStore;
}

export interface KnowledgeCore {
  readonly deps: CoreDeps;
  /** Validate -> save RawSource first -> extract -> normalize -> embed -> similarity -> classify -> persist. */
  capture(input: CaptureRequest, actor: ActorContext): Promise<CaptureResult>;
  /** Re-runs extraction onward from the stored raw text of a previously failed source. */
  retryCapture(rawSourceId: string, actor: ActorContext): Promise<CaptureResult>;
  getTree(query: TreeQuery, actor: ActorContext): Promise<TreeResponse>;
  selectGraph(scope: GraphScope, actor: ActorContext): Promise<GraphSelection>;
  resolveChapter(request: ResolveChapterRequest, actor: ActorContext): Promise<ChapterTarget>;
  getGraphNote(topicId: string, chapterId: string | null, actor: ActorContext): Promise<GraphNote>;
  listGraphNotes(topicId: string, actor: ActorContext): Promise<GraphNoteIndex>;
  saveGraphNote(topicId: string, request: SaveGraphNoteRequest, actor: ActorContext): Promise<GraphNote>;
  createChapter(topicId: string, request: CreateChapterRequest, actor: ActorContext): Promise<ChapterResponse>;
  connectChapter(chapterId: string, topicId: string, actor: ActorContext): Promise<ChapterResponse>;
  disconnectChapter(chapterId: string, topicId: string, actor: ActorContext): Promise<void>;
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
    ...(options.graphNoteStore === undefined ? {} : { graphNoteStore: options.graphNoteStore }),
  };
  // One id per running instance, not per request, so callers can detect a Core restart.
  const instanceId = createId();

  return {
    deps,
    capture: (input, actor) => runCapture(deps, actor, input),
    retryCapture: (rawSourceId, actor) => retryCapture(deps, actor, rawSourceId),
    getTree: (query, actor) => getTree(deps, actor, query),
    selectGraph: (scope, actor) => selectGraph(deps, actor, scope),
    resolveChapter: (request, actor) => resolveChapter(deps, actor, request),
    getGraphNote: (topicId, chapterId, actor) => getGraphNote(deps, actor, topicId, chapterId),
    listGraphNotes: (topicId, actor) => listGraphNotes(deps, actor, topicId),
    saveGraphNote: (topicId, request, actor) => saveGraphNote(deps, actor, topicId, request),
    createChapter: (topicId, request, actor) => createChapter(deps, actor, topicId, request),
    connectChapter: (chapterId, topicId, actor) => connectChapter(deps, actor, chapterId, topicId),
    disconnectChapter: (chapterId, topicId, actor) => disconnectChapter(deps, actor, chapterId, topicId),
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
    status: !missingKey && storage.ok ? 'ok' : 'degraded',
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
