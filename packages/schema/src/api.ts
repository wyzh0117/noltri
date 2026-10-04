import { z } from 'zod';
import {
  conversationMessageSchema,
  conversationSchema,
  knowledgeItemSchema,
  knowledgeNodeSchema,
  rawSourceSchema,
  versionRecordSchema,
} from './knowledge';
import {
  contextScopeSchema,
  edgeRelationSchema,
  nodeStatusSchema,
  processingStatusSchema,
  searchModeSchema,
  type NodeStatus,
} from './enums';

export const apiErrorCodes = [
  'invalid_request',
  'unauthorized',
  'not_found',
  'conflict',
  'provider_error',
  'storage_error',
  'rate_limited',
  'internal_error',
] as const;
export const apiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const nodeIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * What the storage driver says about itself. Cheap and synchronous by contract: health is reachable
 * without a credential, so this must never run a network query, a full scan or an integrity check, and
 * it must never name a connection string. Primitives only, so a client can render it without knowing
 * which driver produced it.
 */
export const storageHealthSchema = z.object({
  driver: z.string(),
  ok: z.boolean(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type StorageHealthPayload = z.infer<typeof storageHealthSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  storageDriver: z.string(),
  storage: storageHealthSchema,
  aiProvider: z.string(),
  embeddingDim: z.number().int(),
  requiresAiKey: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// --- GET /api/tree ---------------------------------------------------------
export const treeQuerySchema = z.object({
  rootId: z.string().min(1).optional(),
  depth: z.coerce.number().int().min(1).max(6).optional(),
});
export type TreeQuery = z.infer<typeof treeQuerySchema>;

export interface TreeNode {
  id: string;
  title: string;
  nodeType: string;
  status: NodeStatus;
  confidence: number | null;
  summary: string | null;
  itemCount: number;
  descendantItemCount: number;
  childCount: number;
  children?: TreeNode[];
}

export const treeNodeSchema: z.ZodType<TreeNode> = z.object({
  id: z.string(),
  title: z.string(),
  nodeType: z.string(),
  status: nodeStatusSchema,
  confidence: z.number().nullable(),
  summary: z.string().nullable(),
  itemCount: z.number().int().min(0),
  descendantItemCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
  children: z.lazy(() => z.array(treeNodeSchema)).optional(),
});

export const treeResponseSchema = z.object({
  rootId: z.string().nullable(),
  nodes: z.array(treeNodeSchema),
  totalNodes: z.number().int().min(0),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;

// --- GET /api/nodes/:id ----------------------------------------------------
export const nodePathSegmentSchema = z.object({
  id: z.string(),
  title: z.string(),
});

export const nodeSourceSummarySchema = z.object({
  rawSourceId: z.string(),
  sourceType: rawSourceSchema.shape.sourceType,
  sourcePlatform: z.string().nullable(),
  sourceApp: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  capturedAt: z.string(),
});
export type NodeSourceSummary = z.infer<typeof nodeSourceSummarySchema>;

export const nodeKnowledgeItemSchema = z.object({
  item: knowledgeItemSchema,
  sources: z.array(nodeSourceSummarySchema),
});
export type NodeKnowledgeItem = z.infer<typeof nodeKnowledgeItemSchema>;

export const relatedNodeSchema = z.object({
  node: knowledgeNodeSchema,
  relationType: edgeRelationSchema,
  confidence: z.number().nullable(),
});

export const nodeDetailSchema = z.object({
  node: knowledgeNodeSchema,
  path: z.array(nodePathSegmentSchema),
  items: z.array(nodeKnowledgeItemSchema),
  children: z.array(knowledgeNodeSchema),
  relatedNodes: z.array(relatedNodeSchema),
  stats: z.object({
    itemCount: z.number().int().min(0),
    sourceCount: z.number().int().min(0),
    childCount: z.number().int().min(0),
  }),
});
export type NodeDetail = z.infer<typeof nodeDetailSchema>;

// --- PATCH /api/nodes/:id --------------------------------------------------
export const patchNodeRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).optional(),
    status: nodeStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field required' });
export type PatchNodeRequest = z.infer<typeof patchNodeRequestSchema>;

// --- POST /api/nodes/:id/move ---------------------------------------------
export const moveNodeRequestSchema = z.object({
  targetParentId: z.string().nullable(),
  relationType: edgeRelationSchema.optional(),
  actor: z.string().max(120).optional(),
});
export type MoveNodeRequest = z.infer<typeof moveNodeRequestSchema>;

export const moveNodeResponseSchema = z.object({
  node: knowledgeNodeSchema,
  versionRecordId: z.string(),
  path: z.array(nodePathSegmentSchema),
  cycleDetected: z.boolean(),
});
export type MoveNodeResponse = z.infer<typeof moveNodeResponseSchema>;

// --- POST /api/search ------------------------------------------------------
export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: searchModeSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  scopeNodeId: z.string().optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchHitSchema = z.object({
  itemId: z.string().nullable(),
  nodeId: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  score: z.number().min(0).max(1),
  matchedBy: z.enum(['semantic', 'keyword', 'both']),
  source: nodeSourceSummarySchema.nullable(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  mode: searchModeSchema,
  hits: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// --- POST /api/node-context ------------------------------------------------
export const nodeContextRequestSchema = z.object({
  nodeId: z.string().min(1),
  scope: contextScopeSchema,
  tokenBudget: z.number().int().min(500).max(60_000).optional(),
});
export type NodeContextRequest = z.infer<typeof nodeContextRequestSchema>;

export const contextSourceSchema = z.object({
  rawSourceId: z.string(),
  label: z.string(),
  excerpt: z.string(),
  url: z.string().nullable(),
  capturedAt: z.string(),
});

export const nodeContextSchema = z.object({
  scope: contextScopeSchema,
  rootNodeId: z.string(),
  node: knowledgeNodeSchema,
  ancestors: z.array(knowledgeNodeSchema),
  children: z.array(knowledgeNodeSchema),
  relatedNodes: z.array(relatedNodeSchema),
  items: z.array(knowledgeItemSchema),
  sources: z.array(contextSourceSchema),
  tokenBudget: z.number().int(),
  estimatedTokens: z.number().int(),
  truncated: z.boolean(),
  markdown: z.string(),
});
export type NodeContext = z.infer<typeof nodeContextSchema>;

// --- POST /api/chat --------------------------------------------------------
export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(20_000),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const nodeChatRequestSchema = z.object({
  nodeId: z.string().min(1),
  scope: contextScopeSchema,
  conversationId: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1).max(60),
});
export type NodeChatRequest = z.infer<typeof nodeChatRequestSchema>;

export const nodeChatResponseSchema = z.object({
  conversationId: z.string(),
  reply: z.string(),
  context: z.object({
    scope: contextScopeSchema,
    usedTokens: z.number().int(),
    citedItemIds: z.array(z.string()),
  }),
});
export type NodeChatResponse = z.infer<typeof nodeChatResponseSchema>;

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
});

export const conversationMessagesResponseSchema = z.object({
  messages: z.array(conversationMessageSchema),
});

export const versionListResponseSchema = z.object({
  records: z.array(versionRecordSchema),
});

// --- GET /api/inbox --------------------------------------------------------
/**
 * The capture feed behind 收件箱. `status` is a comma-separated list of processing statuses because
 * the router builds query objects with `Object.fromEntries`, which collapses repeated keys.
 */
export const inboxQuerySchema = z.object({
  status: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const inboxEntrySchema = z.object({
  id: z.string(),
  sourceType: rawSourceSchema.shape.sourceType,
  sourcePlatform: z.string().nullable(),
  sourceApp: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  capturedAt: z.string(),
  processingStatus: processingStatusSchema,
  errorReason: z.string().nullable(),
  /** Preview only — the full text is one owner-scoped `GET /api/inbox/:id` away. */
  textPreview: z.string(),
  rawTextLength: z.number().int().min(0),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const inboxCountsSchema = z.record(processingStatusSchema, z.number().int().min(0));
export type InboxCounts = z.infer<typeof inboxCountsSchema>;

export const inboxResponseSchema = z.object({
  entries: z.array(inboxEntrySchema),
  /** Whole-library totals per status, so paging never makes a badge lie. */
  counts: inboxCountsSchema,
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

// --- POST /api/inbox/:id/assign -------------------------------------------
export const assignSourceRequestSchema = z.object({
  nodeId: z.string().min(1),
  /** Defaults to the stored raw text; a person may file the sentence they actually want kept. */
  text: z.string().trim().min(1).max(4000).optional(),
});
export type AssignSourceRequest = z.infer<typeof assignSourceRequestSchema>;

export const assignSourceResponseSchema = z.object({
  item: knowledgeItemSchema,
  path: z.array(nodePathSegmentSchema),
});
export type AssignSourceResponse = z.infer<typeof assignSourceResponseSchema>;
