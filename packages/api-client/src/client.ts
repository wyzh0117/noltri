import { z } from 'zod';
import {
  apiErrorSchema,
  processingRulesStateSchema,
  saveProcessingRulesDraftRequestSchema,
  saveProcessingRulesDraftResponseSchema,
  applyProcessingRulesRequestSchema,
  applyProcessingRulesResponseSchema,
  rollbackProcessingRulesRequestSchema,
  rollbackProcessingRulesResponseSchema,
  processingRecordsResponseSchema,
  type ProcessingRulesState,
  type SaveProcessingRulesDraftRequest,
  type SaveProcessingRulesDraftResponse,
  type ApplyProcessingRulesRequest,
  type ApplyProcessingRulesResponse,
  type RollbackProcessingRulesRequest,
  type RollbackProcessingRulesResponse,
  type ProcessingRecordsResponse,

  MAX_CAPTURE_ASSET_BYTES,
  assignSourceRequestSchema,
  reviewSourceRequestSchema,
  reviewSourceResponseSchema,
  type ReviewSourceRequest,
  type ReviewSourceResponse,
  type ReviewStatus,
  assignSourceResponseSchema,
  captureAssetBytesMatchMime,
  captureAssetRefSchema,
  captureBatchListQuerySchema,
  captureBatchListSchema,
  captureAssetUploadResultSchema,
  captureBatchRequestSchema,
  processCaptureBatchRequestSchema,
  captureRecognitionResponseSchema,
  type ProcessCaptureBatchRequest,
  type CaptureRecognitionResponse,
  captureBatchStatusSchema,
  captureBatchSubmitResultSchema,
  captureRequestSchema,
  captureResultSchema,
  createVaultFolderRequestSchema,
  deleteVaultFileRequestSchema,
  deleteVaultFileResponseSchema,
  cachedNoteMetadataSchema,
  vaultDeletePreviewSchema,
  renameVaultBlockRequestSchema,
  renameVaultBlockResponseSchema,
  vaultDiagnosticsSchema,
  vaultAssetSchema,
  chapterResponseSchema,
  chapterTargetSchema,
  createChapterRequestSchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  grantListResponseSchema,
  healthResponseSchema,
  graphMembershipRequestSchema,
  graphNoteSchema,
  graphNoteIndexSchema,
  graphScopeSchema,
  graphSelectionSchema,
  inboxResponseSchema,
  createItemRelationInputSchema,
  createLibraryItemInputSchema,
  itemRelationResponseSchema,
  itemRelationsResponseSchema,
  libraryItemSchema,
  libraryItemsQuerySchema,
  libraryItemsResponseSchema,
  legacyNotePathResponseSchema,
  openVaultRequestSchema,
  noteBacklinksResponseSchema,
  noteFileSchema,
  noteHistoryResponseSchema,
  noteLinksResponseSchema,
  noteMentionResponseSchema,
  noteMatchesResponseSchema,
  noteSearchQuerySchema,
  noteSearchResponseSchema,
  issueGrantRequestSchema,
  issueGrantResponseSchema,
  knowledgeNodeSchema,
  moveNodeResponseSchema,
  nodeChatResponseSchema,
  noteInterpretationRequestSchema,
  noteInterpretationResponseSchema,
  nodeContextSchema,
  nodeDetailSchema,
  renameNoteRequestSchema,
  patchLibraryItemInputSchema,
  rawSourceSchema,
  resolveChapterRequestSchema,
  resolveNoteLinkRequestSchema,
  RETRYABLE_ERROR_CODES,
  revokeGrantResponseSchema,
  restoreNoteHistoryRequestSchema,
  searchResponseSchema,
  saveGraphNoteRequestSchema,
  treeResponseSchema,
  vaultChangesResponseSchema,
  vaultGraphSchema,
  vaultSnapshotSchema,
  vaultSettingsSchema,
  vaultSubpathResponseSchema,
  updateVaultSettingsRequestSchema,
  writeNoteFileRequestSchema,
  type AssignSourceRequest,
  type AssignSourceResponse,
  type CaptureAssetMime,
  type CaptureAssetRef,
  type CaptureAssetUploadResult,
  type CaptureBatchList,
  type CaptureBatchListQuery,
  type CaptureBatchRequest,
  type CaptureBatchStatus,
  type CaptureBatchSubmitResult,
  type CaptureRequest,
  type CaptureResult,
  type CreateVaultFolderRequest,
  type DeleteVaultFileRequest,
  type DeleteVaultFileResponse,
  type CachedNoteMetadata,
  type VaultAsset,
  type VaultDeletePreview,
  type RenameVaultBlockRequest,
  type RenameVaultBlockResponse,
  type VaultDiagnostics,
  type ChapterResponse,
  type ChapterTarget,
  type Conversation,
  type ConversationMessage,
  type CreateChapterRequest,
  type HealthResponse,
  type GraphNote,
  type GraphNoteIndex,
  type GraphScope,
  type GraphSelection,
  type CreateItemRelationInput,
  type CreateLibraryItemInput,
  type ItemRelation,
  type LibraryItem,
  type LibraryItemsQuery,
  type LibraryItemsResponse,
  type LegacyNotePathResponse,
  type NoteBacklinksResponse,
  type NoteFile,
  type NoteHistoryResponse,
  type NoteLinksResponse,
  type NoteMentionResponse,
  type NoteMatchesResponse,
  type NoteSearchResponse,
  type OpenVaultRequest,
  type RenameNoteRequest,
  type RestoreNoteHistoryRequest,
  type InboxResponse,
  type IssueGrantRequest,
  type IssueGrantResponse,
  type KnowledgeNode,
  type MoveNodeRequest,
  type MoveNodeResponse,
  type NodeChatRequest,
  type NodeChatResponse,
  type NoteInterpretationRequest,
  type NoteInterpretationResponse,
  type NodeContext,
  type NodeContextRequest,
  type NodeDetail,
  type PatchNodeRequest,
  type PatchLibraryItemInput,
  type PublicGrant,
  type RawSource,
  type ResolveChapterRequest,
  type SaveGraphNoteRequest,
  type SearchRequest,
  type SearchResponse,
  type VaultChangesResponse,
  type VaultGraph,
  type VaultSnapshot,
  type VaultSettings,
  type UpdateVaultSettingsRequest,
  type WriteNoteFileRequest,
  type TreeQuery,
  type TreeResponse,
} from '@noltri/schema';
import { createId, nowIso } from '@noltri/shared';

/** The grant payload and response types, re-exported so a UI can build one without the schema package. */
export type { GrantScope, IssueGrantRequest, IssueGrantResponse, PublicGrant } from '@noltri/schema';
/** The 限制返回片段 bounds, re-exported as values so a panel can enforce what the Core will accept. */
export { MAX_SNIPPET_CHARS, MIN_SNIPPET_CHARS } from '@noltri/schema';

export const apiRoutes = {
  health: '/api/health',
  processingRules: '/api/admin/processing-rules',
  processingRulesDraft: '/api/admin/processing-rules/draft',
  processingRulesApply: '/api/admin/processing-rules/apply',
  processingRulesRollback: '/api/admin/processing-rules/rollback',
  processingRecords: '/api/admin/processing-records',
  capture: '/api/capture',
  captureAsset: (assetId: string) => `/api/capture/assets/${encodeURIComponent(assetId)}`,
  captureBatches: '/api/capture/batches',
  captureBatchProcess: (batchId: string) => `/api/capture/batches/${encodeURIComponent(batchId)}/process`,
  captureRecognition: (id: string) => `/api/inbox/${encodeURIComponent(id)}/recognition`,
  captureBatch: (batchId: string) => `/api/capture/batches/${encodeURIComponent(batchId)}`,
  captureBatchAsset: (batchId: string, assetId: string) =>
    `/api/capture/batches/${encodeURIComponent(batchId)}/assets/${encodeURIComponent(assetId)}`,
  captureBatchItemRetry: (batchId: string, requestId: string) =>
    `/api/capture/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(requestId)}/retry`,
  items: '/api/items',
  item: (id: string) => `/api/items/${encodeURIComponent(id)}`,
  itemRestore: (id: string) => `/api/items/${encodeURIComponent(id)}/restore`,
  itemRelations: (id: string) => `/api/items/${encodeURIComponent(id)}/relations`,
  itemRelation: (id: string, targetId: string) =>
    `/api/items/${encodeURIComponent(id)}/relations/${encodeURIComponent(targetId)}`,
  tree: '/api/tree',
  graphSelect: '/api/graph/select',
  graphResolveChapter: '/api/graph/resolve-chapter',
  note: (topicId: string) => `/api/notes/${encodeURIComponent(topicId)}`,
  noteChapters: (topicId: string) => `/api/notes/${encodeURIComponent(topicId)}/chapters`,
  vault: '/api/vault',
  vaultSettings: '/api/vault/settings',
  vaultSubpath: '/api/vault/subpath',
  vaultOpen: '/api/vault/open',
  vaultFile: '/api/vault/file',
  vaultAsset: '/api/vault/asset',
  vaultRename: '/api/vault/rename',
  vaultDeletePreview: '/api/vault/delete-preview',
  vaultRenameBlock: '/api/vault/rename-block',
  vaultDiagnostics: '/api/vault/diagnostics',
  vaultMetadata: '/api/vault/metadata',
  vaultLinks: '/api/vault/links',
  vaultBacklinks: '/api/vault/backlinks',
  vaultResolveLink: '/api/vault/resolve-link',
  vaultGraph: '/api/vault/graph',
  vaultChanges: '/api/vault/changes',
  vaultSearch: '/api/vault/search',
  vaultSwitcher: '/api/vault/switcher',
  vaultMatch: '/api/vault/match',
  vaultMentions: '/api/vault/mentions',
  vaultHistory: '/api/vault/history',
  vaultHistoryVersion: '/api/vault/history/version',
  vaultRestoreHistory: '/api/vault/history/restore',
  legacyNotePath: '/api/vault/legacy-note',
  topicChapters: (topicId: string) => `/api/topics/${encodeURIComponent(topicId)}/chapters`,
  chapterTopic: (chapterId: string, topicId: string) =>
    `/api/chapters/${encodeURIComponent(chapterId)}/topics/${encodeURIComponent(topicId)}`,
  inbox: '/api/inbox',
  inboxSource: (id: string) => `/api/inbox/${encodeURIComponent(id)}`,
  inboxAssign: (id: string) => `/api/inbox/${encodeURIComponent(id)}/assign`,
  inboxReview: (id: string) => `/api/inbox/${encodeURIComponent(id)}/review`,
  captureRetry: (id: string) => `/api/capture/${encodeURIComponent(id)}/retry`,
  node: (id: string) => `/api/nodes/${encodeURIComponent(id)}`,
  move: (id: string) => `/api/nodes/${encodeURIComponent(id)}/move`,
  search: '/api/search',
  nodeContext: '/api/node-context',
  chat: '/api/chat',
  noteInterpretation: '/api/note-interpretation',
  conversations: '/api/conversations',
  conversationMessages: (id: string) => `/api/conversations/${encodeURIComponent(id)}/messages`,
  grants: '/api/admin/grants',
  grantRevoke: (id: string) => `/api/admin/grants/${encodeURIComponent(id)}/revoke`,
} as const;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * Whether resending can help. Read from the server envelope when it states one, otherwise derived from
   * the same shared table the server uses, so a queue and a Core never disagree about what may be resent —
   * including for a transport failure that never reached one.
   */
  readonly retryable: boolean;
  /** Correlates this failure with the line the server logged; undefined when no trace was returned. */
  readonly traceId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    envelope: { retryable?: boolean; traceId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = envelope.retryable ?? isRetryableCode(code);
    this.traceId = envelope.traceId;
  }
}

/** Codes the shared table marks as worth resending; a code the client does not know is not retryable. */
function isRetryableCode(code: string): boolean {
  const retryable: ReadonlySet<string> = RETRYABLE_ERROR_CODES;
  return retryable.has(code);
}


/**
 * Check a write payload against the shared contract before the network call, so a form that produced
 * an unsendable 章程 or 证据 gets the zod issues back from the caller's own stack instead of a
 * round-trip to a Core that would reject it anyway.
 */
function validatedRequest<Output>(schema: z.ZodType<Output>, request: unknown, label: string): Output {
  const validated = schema.safeParse(request);
  if (!validated.success) {
    throw new ApiClientError(400, 'invalid_request', `${label} payload is not sendable`, validated.error.issues);
  }
  return validated.data;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token: a 本地客户端授权 credential, or the dev token. */
  token?: string;
  /**
   * Which entry point is calling. The core writes it onto version records for provenance; it is a
   * display hint only and never selects a user.
   */
  clientHint?: 'extension' | 'desktop' | 'mcp' | 'web_app';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface BuildCaptureRequestInput {
  text: string;
  surroundingContext?: string;
  source: CaptureRequest['source'];
  client: CaptureRequest['capture']['client'];
  deviceId?: string;
  capturedAt?: string;
  library?: CaptureRequest['library'];
  /**
   * The idempotency key. A caller that has none — a button press — gets a generated one; a caller that is
   * resending from a queue MUST pass the key it stored, or the resend becomes a second capture.
   */
  requestId?: string;
}

const LIBRARY_IDEMPOTENCY_CLIENT = 'noltri-library-item-v1';

/** A short deterministic id for duplicate collection attempts, scoped by source identity as well as text. */
export function libraryItemRequestId(text: string, source: CaptureRequest['source'], library: CaptureRequest['library']): string {
  const identity = JSON.stringify({
    text,
    source: {
      type: source.type,
      title: source.title ?? '',
      url: source.url ?? '',
      platform: source.platform ?? '',
      appName: source.appName ?? '',
      citation: library?.citation ?? '',
      page: library?.page ?? '',
      doi: library?.doi ?? '',
    },
  });
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < identity.length; index += 1) {
        hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193) >>> 0;
      }
      hash ^= hash >>> 16;
      return hash.toString(16).padStart(8, '0');
    })
    .join('');
}

export function buildCaptureRequest(input: BuildCaptureRequestInput): CaptureRequest {
  const requestId =
    input.requestId ?? (input.library ? libraryItemRequestId(input.text, input.source, input.library) : createId());
  return {
    requestId,
    text: input.text,
    ...(input.surroundingContext ? { surroundingContext: input.surroundingContext } : {}),
    source: input.source,
    capture: {
      capturedAt: input.capturedAt ?? nowIso(),
      client: input.client,
      ...(input.library ? { deviceId: LIBRARY_IDEMPOTENCY_CLIENT } : input.deviceId ? { deviceId: input.deviceId } : {}),
    },
    ...(input.library ? { library: input.library } : {}),
  };
}

/** Typed, validating HTTP client shared by web app, extension and desktop companion. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly clientHint?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.clientHint = options.clientHint;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', apiRoutes.health, healthResponseSchema);
  }

  capture(request: CaptureRequest): Promise<CaptureResult> {
    const validated = captureRequestSchema.safeParse(request);
    if (!validated.success) {
      // Fail before the network call so a broken capture never reaches the pipeline.
      throw new ApiClientError(400, 'invalid_request', 'Capture payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.capture, captureResultSchema, { body: validated.data });
  }

  uploadCaptureAsset(input: {
    assetId: string;
    sessionId: string;
    mimeType: CaptureAssetMime;
    sha256: string;
    bytes: Uint8Array;
  }): Promise<CaptureAssetUploadResult> {
    const validated = captureAssetRefSchema.pick({ assetId: true, sessionId: true, mimeType: true, sha256: true })
      .safeParse({ assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, sha256: input.sha256 });
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Capture asset metadata is not sendable', validated.error.issues);
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES) {
      throw new ApiClientError(400, 'invalid_request', 'Capture asset byte length is out of range');
    }
    const body = new Blob([new Uint8Array(input.bytes).buffer as ArrayBuffer], { type: validated.data.mimeType });
    return this.request('PUT', apiRoutes.captureAsset(validated.data.assetId), captureAssetUploadResultSchema, {
      rawBody: body,
      headers: {
        'content-type': validated.data.mimeType,
        'x-noltri-session-id': validated.data.sessionId,
        'x-noltri-content-sha256': validated.data.sha256,
      },
    });
  }

  createCaptureBatch(input: CaptureBatchRequest): Promise<CaptureBatchSubmitResult> {
    const validated = captureBatchRequestSchema.safeParse(input);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Capture batch payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.captureBatches, captureBatchSubmitResultSchema, { body: validated.data });
  }

  getCaptureBatchStatus(batchId: string): Promise<CaptureBatchStatus> {
    return this.request('GET', apiRoutes.captureBatch(batchId), captureBatchStatusSchema);
  }

  listCaptureBatches(input: Partial<CaptureBatchListQuery> = {}): Promise<CaptureBatchList> {
    const validated = captureBatchListQuerySchema.safeParse(input);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Capture batch list query is invalid', validated.error.issues);
    }
    const query = new URLSearchParams({ limit: String(validated.data.limit) });
    return this.request('GET', `${apiRoutes.captureBatches}?${query}`, captureBatchListSchema);
  }

  async readCaptureAsset(batchId: string, assetId: string): Promise<{ asset: CaptureAssetRef; bytes: Uint8Array }> {
    const parsedBatchId = captureBatchStatusSchema.shape.batchId.safeParse(batchId);
    const parsedAssetId = captureAssetRefSchema.shape.assetId.safeParse(assetId);
    if (!parsedBatchId.success || !parsedAssetId.success) {
      throw new ApiClientError(400, 'invalid_request', 'Capture batch or asset id is invalid');
    }

    const path = apiRoutes.captureBatchAsset(parsedBatchId.data, parsedAssetId.data);
    const response = await this.fetchResponse('GET', path, { headers: { accept: 'application/octet-stream' } });
    if (!response.ok) throw await responseError(response, await readJson(response), path);

    const declaredLength = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > MAX_CAPTURE_ASSET_BYTES) {
      throw new ApiClientError(502, 'internal_error', `Knowledge Core response has an invalid asset length for GET ${path}`);
    }

    const bytes = await readBoundedBytes(response, declaredLength, path);
    const asset = captureAssetRefSchema.safeParse({
      assetId: response.headers.get('x-noltri-asset-id'),
      sessionId: response.headers.get('x-noltri-session-id'),
      mimeType: response.headers.get('content-type'),
      byteLength: Number(response.headers.get('content-length')),
      sha256: response.headers.get('x-noltri-content-sha256'),
      createdAt: response.headers.get('x-noltri-created-at'),
    });
    if (!asset.success || asset.data.assetId !== parsedAssetId.data || asset.data.byteLength !== declaredLength
      || bytes.byteLength !== declaredLength || !captureAssetBytesMatchMime(bytes, asset.data.mimeType)) {
      throw new ApiClientError(502, 'internal_error', `Knowledge Core response did not match the shared contract for GET ${path}`, asset.success ? undefined : asset.error.issues);
    }
    return { asset: asset.data, bytes };
  }

  processingRules(): Promise<ProcessingRulesState> {
    return this.request('GET', apiRoutes.processingRules, processingRulesStateSchema);
  }

  saveProcessingRulesDraft(request: SaveProcessingRulesDraftRequest): Promise<SaveProcessingRulesDraftResponse> {
    const parsed = saveProcessingRulesDraftRequestSchema.safeParse(request);
    if (!parsed.success) throw new ApiClientError(400, 'invalid_request', 'Invalid processing rules draft', parsed.error.issues);
    return this.request('PUT', apiRoutes.processingRulesDraft, saveProcessingRulesDraftResponseSchema, { body: parsed.data });
  }

  applyProcessingRules(request: ApplyProcessingRulesRequest): Promise<ApplyProcessingRulesResponse> {
    const parsed = applyProcessingRulesRequestSchema.safeParse(request);
    if (!parsed.success) throw new ApiClientError(400, 'invalid_request', 'Invalid processing rules apply request', parsed.error.issues);
    return this.request('POST', apiRoutes.processingRulesApply, applyProcessingRulesResponseSchema, { body: parsed.data });
  }

  rollbackProcessingRules(request: RollbackProcessingRulesRequest): Promise<RollbackProcessingRulesResponse> {
    const parsed = rollbackProcessingRulesRequestSchema.safeParse(request);
    if (!parsed.success) throw new ApiClientError(400, 'invalid_request', 'Invalid processing rules rollback request', parsed.error.issues);
    return this.request('POST', apiRoutes.processingRulesRollback, rollbackProcessingRulesResponseSchema, { body: parsed.data });
  }

  processingRecords(): Promise<ProcessingRecordsResponse> {
    return this.request('GET', apiRoutes.processingRecords, processingRecordsResponseSchema);
  }

  processCaptureBatch(batchId: string, request: ProcessCaptureBatchRequest = {}): Promise<CaptureBatchStatus> {
    const parsed = processCaptureBatchRequestSchema.safeParse(request);
    if (!parsed.success) throw new ApiClientError(400, 'invalid_request', 'Invalid image processing selection', parsed.error.issues);
    return this.request('POST', apiRoutes.captureBatchProcess(batchId), captureBatchStatusSchema, { body: parsed.data });
  }
  captureRecognition(rawSourceId: string): Promise<CaptureRecognitionResponse> {
    return this.request('GET', apiRoutes.captureRecognition(rawSourceId), captureRecognitionResponseSchema);
  }

  retryCaptureBatchItem(batchId: string, requestId: string): Promise<CaptureBatchStatus> {
    return this.request('POST', apiRoutes.captureBatchItemRetry(batchId, requestId), captureBatchStatusSchema);
  }

  listItems(query: LibraryItemsQuery = {}): Promise<LibraryItemsResponse> {
    const validated = libraryItemsQuerySchema.safeParse(query);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Items query is not sendable', validated.error.issues);
    }
    const params = new URLSearchParams();
    if (validated.data.nodeId) params.set('nodeId', validated.data.nodeId);
    if (validated.data.query) params.set('query', validated.data.query);
    if (validated.data.kind) params.set('kind', validated.data.kind);
    if (validated.data.state) params.set('state', validated.data.state);
    if (validated.data.limit !== undefined) params.set('limit', String(validated.data.limit));
    if (validated.data.offset !== undefined) params.set('offset', String(validated.data.offset));
    if (validated.data.includeArchived !== undefined) params.set('includeArchived', String(validated.data.includeArchived));
    const suffix = params.toString();
    return this.request('GET', `${apiRoutes.items}${suffix ? `?${suffix}` : ''}`, libraryItemsResponseSchema);
  }

  item(id: string): Promise<LibraryItem> {
    return this.request('GET', apiRoutes.item(id), libraryItemSchema);
  }

  createItem(input: CreateLibraryItemInput): Promise<{ item: LibraryItem }> {
    return this.request('POST', apiRoutes.items, z.object({ item: libraryItemSchema }), {
      body: validatedRequest(createLibraryItemInputSchema, input, 'library item'),
    });
  }

  patchItem(id: string, patch: PatchLibraryItemInput): Promise<{ item: LibraryItem }> {
    return this.request('PATCH', apiRoutes.item(id), z.object({ item: libraryItemSchema }), {
      body: validatedRequest(patchLibraryItemInputSchema, patch, 'library item patch'),
    });
  }

  archiveItem(id: string): Promise<{ item: LibraryItem }> {
    return this.request('DELETE', apiRoutes.item(id), z.object({ item: libraryItemSchema }));
  }

  restoreItem(id: string): Promise<{ item: LibraryItem }> {
    return this.request('POST', apiRoutes.itemRestore(id), z.object({ item: libraryItemSchema }));
  }

  async listItemRelations(id: string): Promise<ItemRelation[]> {
    return (await this.request('GET', apiRoutes.itemRelations(id), itemRelationsResponseSchema)).relations;
  }

  createItemRelation(id: string, input: CreateItemRelationInput): Promise<{ relation: ItemRelation }> {
    return this.request('POST', apiRoutes.itemRelations(id), itemRelationResponseSchema, {
      body: validatedRequest(createItemRelationInputSchema, input, 'item relation'),
    });
  }

  async deleteItemRelation(id: string, targetId: string): Promise<void> {
    await this.request('DELETE', apiRoutes.itemRelation(id, targetId), z.object({ ok: z.literal(true) }));
  }

  tree(query: TreeQuery = {}): Promise<TreeResponse> {
    const params = new URLSearchParams();
    if (query.rootId) params.set('rootId', query.rootId);
    if (query.depth) params.set('depth', String(query.depth));
    const suffix = params.toString();
    return this.request('GET', `${apiRoutes.tree}${suffix ? `?${suffix}` : ''}`, treeResponseSchema);
  }

  vaultSnapshot(): Promise<VaultSnapshot> {
    return this.request('GET', apiRoutes.vault, vaultSnapshotSchema);
  }

  vaultSettings(vaultRootPath?: string): Promise<VaultSettings> {
    return this.request('GET', apiRoutes.vaultSettings, vaultSettingsSchema, {
      ...(vaultRootPath === undefined ? {} : { vaultRootPath }),
    });
  }

  updateVaultSettings(input: UpdateVaultSettingsRequest, vaultRootPath: string): Promise<VaultSettings> {
    return this.request('PUT', apiRoutes.vaultSettings, vaultSettingsSchema, {
      body: validatedRequest(updateVaultSettingsRequestSchema, input, 'vault settings'),
      vaultRootPath,
    });
  }

  createVaultFolder(input: CreateVaultFolderRequest, vaultRootPath: string): Promise<{ path: string }> {
    return this.request('POST', '/api/vault/folder', z.object({ path: z.string() }), {
      body: validatedRequest(createVaultFolderRequestSchema, input, 'vault folder'),
      vaultRootPath,
    });
  }

  openVault(input: OpenVaultRequest): Promise<VaultSnapshot> {
    return this.request('POST', apiRoutes.vaultOpen, vaultSnapshotSchema, {
      body: validatedRequest(openVaultRequestSchema, input, 'vault root'),
    });
  }

  vaultFile(path: string): Promise<NoteFile> {
    return this.request('GET', `${apiRoutes.vaultFile}?${new URLSearchParams({ path })}`, noteFileSchema);
  }

  getVaultAsset(path: string): Promise<VaultAsset> {
    return this.request('GET', `${apiRoutes.vaultAsset}?${new URLSearchParams({ path })}`, vaultAssetSchema);
  }

  saveVaultFile(input: WriteNoteFileRequest, vaultRootPath: string): Promise<NoteFile> {
    return this.request('PUT', apiRoutes.vaultFile, noteFileSchema, {
      body: validatedRequest(writeNoteFileRequestSchema, input, 'vault note'),
      vaultRootPath,
    });
  }

  renameVaultFile(input: RenameNoteRequest, vaultRootPath: string): Promise<{ path: string }> {
    return this.request('POST', apiRoutes.vaultRename, z.object({ path: z.string() }), {
      body: validatedRequest(renameNoteRequestSchema, input, 'vault rename'),
      vaultRootPath,
    });
  }

  deletePreview(path: string): Promise<VaultDeletePreview> {
    return this.request('GET', `${apiRoutes.vaultDeletePreview}?${new URLSearchParams({ path })}`, vaultDeletePreviewSchema);
  }

  deleteVaultFile(path: string, expectedEtag: string, orphanPolicy: DeleteVaultFileRequest['orphanPolicy'], vaultRootPath: string): Promise<DeleteVaultFileResponse> {
    const input: DeleteVaultFileRequest = { path, expectedEtag, orphanPolicy };
    const validated = validatedRequest(deleteVaultFileRequestSchema, input, 'vault delete');
    const params = new URLSearchParams({ path: validated.path, orphanPolicy: validated.orphanPolicy });
    if (validated.expectedEtag !== undefined) params.set('expectedEtag', validated.expectedEtag);
    return this.request('DELETE', `${apiRoutes.vaultFile}?${params}`, deleteVaultFileResponseSchema, { vaultRootPath });
  }

  renameVaultBlock(input: RenameVaultBlockRequest, vaultRootPath: string): Promise<RenameVaultBlockResponse> {
    return this.request('POST', apiRoutes.vaultRenameBlock, renameVaultBlockResponseSchema, {
      body: validatedRequest(renameVaultBlockRequestSchema, input, 'vault block rename'),
      vaultRootPath,
    });
  }

  vaultDiagnostics(): Promise<VaultDiagnostics> {
    return this.request('GET', apiRoutes.vaultDiagnostics, vaultDiagnosticsSchema);
  }

  vaultMetadata(path: string): Promise<{ path: string; metadata: CachedNoteMetadata | null }> {
    return this.request('GET', `${apiRoutes.vaultMetadata}?${new URLSearchParams({ path })}`, z.object({
      path: z.string(),
      metadata: cachedNoteMetadataSchema.nullable(),
    }));
  }

  vaultSubpath(path: string, subpath: string): Promise<{ position: import('@noltri/schema').NotePosition | null }> {
    return this.request('GET', `${apiRoutes.vaultSubpath}?${new URLSearchParams({ path, subpath })}`, vaultSubpathResponseSchema);
  }

  vaultLinks(): Promise<NoteLinksResponse> {
    return this.request('GET', apiRoutes.vaultLinks, noteLinksResponseSchema);
  }

  vaultBacklinks(path: string): Promise<NoteBacklinksResponse> {
    return this.request('GET', `${apiRoutes.vaultBacklinks}?${new URLSearchParams({ path })}`, noteBacklinksResponseSchema);
  }

  resolveVaultLink(linkpath: string, sourcePath: string, kind: 'wikilink' | 'markdown' = 'wikilink'): Promise<{ path: string | null }> {
    return this.request('POST', apiRoutes.vaultResolveLink, z.object({ path: z.string().nullable() }), {
      body: validatedRequest(resolveNoteLinkRequestSchema, { linkpath, sourcePath, kind }, 'note link'),
    });
  }

  vaultGraph(): Promise<VaultGraph> {
    return this.request('GET', apiRoutes.vaultGraph, vaultGraphSchema);
  }

  vaultChanges(after: number): Promise<VaultChangesResponse> {
    return this.request('GET', `${apiRoutes.vaultChanges}?${new URLSearchParams({ after: String(after) })}`, vaultChangesResponseSchema);
  }

  searchVault(query: string, limit = 50): Promise<NoteSearchResponse> {
    return this.noteQuery(apiRoutes.vaultSearch, query, limit);
  }

  switcherVault(query: string, limit = 20): Promise<NoteSearchResponse> {
    return this.noteQuery(apiRoutes.vaultSwitcher, query, limit);
  }

  async vaultMatch(query: string): Promise<NoteMatchesResponse> {
    const params = new URLSearchParams({ q: query });
    return this.request('GET', `${apiRoutes.vaultMatch}?${params}`, noteMatchesResponseSchema);
  }

  vaultMentions(path: string): Promise<NoteMentionResponse> {
    return this.request('GET', `${apiRoutes.vaultMentions}?${new URLSearchParams({ path })}`, noteMentionResponseSchema);
  }

  vaultHistory(path: string): Promise<NoteHistoryResponse> {
    return this.request('GET', `${apiRoutes.vaultHistory}?${new URLSearchParams({ path })}`, noteHistoryResponseSchema);
  }

  vaultHistoryVersion(path: string, versionId: string): Promise<NoteFile> {
    const params = new URLSearchParams({ path, versionId });
    return this.request('GET', `${apiRoutes.vaultHistoryVersion}?${params}`, noteFileSchema);
  }

  restoreVaultHistory(input: RestoreNoteHistoryRequest, vaultRootPath: string): Promise<NoteFile> {
    return this.request('POST', apiRoutes.vaultRestoreHistory, noteFileSchema, {
      body: validatedRequest(restoreNoteHistoryRequestSchema, input, 'restore note history'),
      vaultRootPath,
    });
  }

  legacyNotePath(topicId: string, chapterId: string | null): Promise<LegacyNotePathResponse> {
    const params = new URLSearchParams({ topicId, ...(chapterId === null ? {} : { chapterId }) });
    return this.request('GET', `${apiRoutes.legacyNotePath}?${params}`, legacyNotePathResponseSchema);
  }

  private noteQuery(path: string, query: string, limit: number): Promise<NoteSearchResponse> {
    const validated = noteSearchQuerySchema.safeParse({ q: query, limit });
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Vault query is not sendable', validated.error.issues);
    }
    const params = new URLSearchParams({ q: validated.data.q, limit: String(validated.data.limit) });
    return this.request('GET', `${path}?${params}`, noteSearchResponseSchema);
  }

  selectGraph(scope: GraphScope): Promise<GraphSelection> {
    return this.request('POST', apiRoutes.graphSelect, graphSelectionSchema, {
      body: validatedRequest(graphScopeSchema, scope, 'graph scope'),
    });
  }

  resolveChapter(request: ResolveChapterRequest): Promise<ChapterTarget> {
    return this.request('POST', apiRoutes.graphResolveChapter, chapterTargetSchema, {
      body: validatedRequest(resolveChapterRequestSchema, request, 'resolve chapter'),
    });
  }

  graphNote(topicId: string, chapterId: string | null = null): Promise<GraphNote> {
    const suffix = chapterId === null ? '' : `?chapterId=${encodeURIComponent(chapterId)}`;
    return this.request('GET', `${apiRoutes.note(topicId)}${suffix}`, graphNoteSchema);
  }

  listGraphNotes(topicId: string): Promise<GraphNoteIndex> {
    return this.request('GET', apiRoutes.noteChapters(topicId), graphNoteIndexSchema);
  }

  saveGraphNote(topicId: string, input: SaveGraphNoteRequest, vaultRootPath: string): Promise<GraphNote> {
    return this.request('PUT', apiRoutes.note(topicId), graphNoteSchema, {
      body: validatedRequest(saveGraphNoteRequestSchema, input, 'save note'),
      vaultRootPath,
    });
  }

  createChapter(topicId: string, input: CreateChapterRequest): Promise<ChapterResponse> {
    return this.request('POST', apiRoutes.topicChapters(topicId), chapterResponseSchema, {
      body: validatedRequest(createChapterRequestSchema, input, 'create chapter'),
    });
  }

  connectChapter(chapterId: string, topicId: string): Promise<ChapterResponse> {
    return this.request('PUT', apiRoutes.chapterTopic(chapterId, topicId), chapterResponseSchema, {
      body: validatedRequest(graphMembershipRequestSchema, { chapterId, topicId }, 'chapter membership'),
    });
  }

  async disconnectChapter(chapterId: string, topicId: string): Promise<void> {
    await this.request('DELETE', apiRoutes.chapterTopic(chapterId, topicId), z.object({ ok: z.literal(true) }));
  }

  nodeDetail(id: string): Promise<NodeDetail> {
    return this.request('GET', apiRoutes.node(id), nodeDetailSchema);
  }

  /** 收件箱 feed. `status` is comma-separated, matching the server's query contract. */
  inbox(query: { status?: string; reviewStatus?: ReviewStatus; limit?: number; offset?: number } = {}): Promise<InboxResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.reviewStatus) params.set('reviewStatus', query.reviewStatus);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const suffix = params.toString();
    return this.request('GET', `${apiRoutes.inbox}${suffix ? `?${suffix}` : ''}`, inboxResponseSchema);
  }

  rawSource(id: string): Promise<RawSource> {
    return this.request('GET', apiRoutes.inboxSource(id), rawSourceSchema);
  }

  reviewSource(rawSourceId: string, request: ReviewSourceRequest): Promise<ReviewSourceResponse> {
    const validated = reviewSourceRequestSchema.safeParse(request);
    if (!validated.success) throw new ApiClientError(400, 'invalid_request', 'Review payload is not sendable', validated.error.issues);
    return this.request('POST', apiRoutes.inboxReview(rawSourceId), reviewSourceResponseSchema, { body: validated.data });
  }

  assignSource(rawSourceId: string, request: AssignSourceRequest): Promise<AssignSourceResponse> {
    const validated = assignSourceRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Assign payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.inboxAssign(rawSourceId), assignSourceResponseSchema, { body: validated.data });
  }

  /**
   * Re-run the compile pipeline for a saved capture. Body-less POST: the server already owns the text,
   * so a retry can never resend content the user did not capture.
   */
  retryCapture(rawSourceId: string): Promise<CaptureResult> {
    return this.request('POST', apiRoutes.captureRetry(rawSourceId), captureResultSchema);
  }

  patchNode(id: string, patch: PatchNodeRequest): Promise<KnowledgeNode> {
    return this.request('PATCH', apiRoutes.node(id), knowledgeNodeSchema, { body: patch });
  }

  moveNode(id: string, request: MoveNodeRequest): Promise<MoveNodeResponse> {
    return this.request('POST', apiRoutes.move(id), moveNodeResponseSchema, { body: request });
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.request('POST', apiRoutes.search, searchResponseSchema, { body: request });
  }

  nodeContext(request: NodeContextRequest): Promise<NodeContext> {
    return this.request('POST', apiRoutes.nodeContext, nodeContextSchema, { body: request });
  }

  chat(request: NodeChatRequest): Promise<NodeChatResponse> {
    return this.request('POST', apiRoutes.chat, nodeChatResponseSchema, {
      body: request,
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
  }

  interpretNote(request: NoteInterpretationRequest): Promise<NoteInterpretationResponse> {
    const validated = validatedRequest(noteInterpretationRequestSchema, request, 'Note interpretation');
    return this.request('POST', apiRoutes.noteInterpretation, noteInterpretationResponseSchema, {
      body: validated,
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
  }

  /** Threads Core kept for this caller, optionally narrowed to one node. */
  async conversations(nodeId?: string): Promise<Conversation[]> {
    const suffix = nodeId === undefined ? '' : `?nodeId=${encodeURIComponent(nodeId)}`;
    const result = await this.request('GET', `${apiRoutes.conversations}${suffix}`, conversationListResponseSchema);
    return result.conversations;
  }

  /** The stored transcript, in the order Knowledge Core wrote it. */
  async conversationMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.request(
      'GET',
      apiRoutes.conversationMessages(conversationId),
      conversationMessagesResponseSchema,
    );
    return result.messages;
  }

  /**
   * 连接中心's list: every local client this Core knows, its scopes and whether it is still live.
   * Deliberately credential-free, so a screenshot of this panel never leaks a key.
   */
  async grants(): Promise<PublicGrant[]> {
    return (await this.request('GET', apiRoutes.grants, grantListResponseSchema)).grants;
  }

  /**
   * Mint a per-client credential. The plaintext `secret` exists in this one response only — the store
   * keeps a digest, so there is no call that reads a live key back.
   */
  issueGrant(request: IssueGrantRequest): Promise<IssueGrantResponse> {
    const validated = issueGrantRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new ApiClientError(400, 'invalid_request', 'Grant payload is not sendable', validated.error.issues);
    }
    return this.request('POST', apiRoutes.grants, issueGrantResponseSchema, { body: validated.data });
  }

  /** Revocation is immediate: a connection that is already open fails on its next request. */
  async revokeGrant(id: string): Promise<PublicGrant> {
    return (await this.request('POST', apiRoutes.grantRevoke(id), revokeGrantResponseSchema)).grant;
  }

  private async request<Output>(
    method: string,
    path: string,
    responseSchema: z.ZodType<Output>,
    init: { body?: unknown; rawBody?: Blob; headers?: Record<string, string>; timeoutMs?: number; vaultRootPath?: string } = {},
  ): Promise<Output> {
    const response = await this.fetchResponse(method, path, init);

    const payload: unknown = await readJson(response);
    if (!response.ok) throw await responseError(response, payload, path);

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      throw new ApiClientError(
        502,
        'internal_error',
        `Knowledge Core response did not match the shared contract for ${method} ${path}`,
        validated.error.issues,
      );
    }
    return validated.data;
  }

  private async fetchResponse(
    method: string,
    path: string,
    init: { body?: unknown; rawBody?: Blob; headers?: Record<string, string>; timeoutMs?: number; vaultRootPath?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.clientHint) headers['x-noltri-client'] = this.clientHint;
    if (init.vaultRootPath !== undefined) {
      if (init.vaultRootPath.length === 0) throw new ApiClientError(400, 'invalid_request', 'Vault root context is required for writes');
      headers['x-noltri-vault-root'] = encodeURIComponent(init.vaultRootPath);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiClientError(0, 'internal_error', describeNetworkError(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function responseError(response: Response, payload: unknown, path: string): Promise<ApiClientError> {
  const parsed = apiErrorSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiClientError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.details,
      { retryable: parsed.data.error.retryable, traceId: parsed.data.error.traceId },
    );
  }
  return new ApiClientError(response.status, 'internal_error', `Request failed for ${path} with status ${response.status}`, payload);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function readBoundedBytes(response: Response, expectedLength: number, path: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ApiClientError(502, 'internal_error', `Knowledge Core response has no asset body for GET ${path}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedLength || total > MAX_CAPTURE_ASSET_BYTES) {
        await reader.cancel();
        throw new ApiClientError(502, 'internal_error', `Knowledge Core response exceeded its declared asset length for GET ${path}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError(502, 'internal_error', `Knowledge Core asset response could not be read for GET ${path}`);
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedLength) throw new ApiClientError(502, 'internal_error', `Knowledge Core response did not match its declared asset length for GET ${path}`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Request timed out';
    return error.message;
  }
  return 'Network request failed';
}
