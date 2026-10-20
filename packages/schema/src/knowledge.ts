import { z } from 'zod';
import {
  conversationRoleSchema,
  contextScopeSchema,
  edgeRelationSchema,
  itemLinkRelationSchema,
  knowledgeItemStatusSchema,
  masteryLevelSchema,
  nodeStatusSchema,
  processingStatusSchema,
  sourceTypeSchema,
  structureOperationSchema,
  versionedEntitySchema,
} from './enums';

export const jsonValueSchema = z.record(z.string(), z.unknown());
export type JsonValue = Record<string, unknown>;

export const rawSourceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  rawText: z.string(),
  surroundingContext: z.string().nullable(),
  sourceType: sourceTypeSchema,
  sourcePlatform: z.string().nullable(),
  sourceApp: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  capturedAt: z.string(),
  metadata: jsonValueSchema,
  processingStatus: processingStatusSchema,
  errorReason: z.string().nullable(),
  createdAt: z.string(),
  /** Idempotency pair: null for every capture written before P3 and for any caller that states no key. */
  requestId: z.string().nullable(),
  clientId: z.string().nullable(),
});
export type RawSource = z.infer<typeof rawSourceSchema>;

export const knowledgeItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  rawSourceId: z.string(),
  normalizedText: z.string(),
  summary: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  status: knowledgeItemStatusSchema,
  isAiDerived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

export const knowledgeNodeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  nodeType: z.string(),
  parentId: z.string().nullable(),
  status: nodeStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  embeddingModel: z.string().nullable(),
  masteryLevel: masteryLevelSchema.nullable().default('collected'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeNode = z.infer<typeof knowledgeNodeSchema>;

export const knowledgeEdgeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  relationType: edgeRelationSchema,
  confidence: z.number().min(0).max(1).nullable(),
  source: z.string(),
  createdAt: z.string(),
});
export type KnowledgeEdge = z.infer<typeof knowledgeEdgeSchema>;

export const knowledgeNoteSchema = z.object({
  userId: z.string(),
  topicId: z.string(),
  chapterId: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeNote = z.infer<typeof knowledgeNoteSchema>;

export const itemNodeLinkSchema = z.object({
  id: z.string(),
  userId: z.string(),
  itemId: z.string(),
  nodeId: z.string(),
  relationType: itemLinkRelationSchema,
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
});
export type ItemNodeLink = z.infer<typeof itemNodeLinkSchema>;

export const versionRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  entityType: versionedEntitySchema,
  entityId: z.string(),
  operation: structureOperationSchema,
  before: jsonValueSchema,
  after: jsonValueSchema,
  actor: z.string(),
  createdAt: z.string(),
});
export type VersionRecord = z.infer<typeof versionRecordSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  nodeId: z.string().nullable(),
  scope: contextScopeSchema,
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: conversationRoleSchema,
  content: z.string(),
  contextNodeId: z.string().nullable(),
  createdAt: z.string(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const createRawSourceInputSchema = z.object({
  userId: z.string(),
  rawText: z.string(),
  surroundingContext: z.string().nullable().optional(),
  sourceType: sourceTypeSchema,
  sourcePlatform: z.string().nullable().optional(),
  sourceApp: z.string().nullable().optional(),
  sourceTitle: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  capturedAt: z.string(),
  metadata: jsonValueSchema.optional(),
  requestId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
});
export type CreateRawSourceInput = z.infer<typeof createRawSourceInputSchema>;

export const createKnowledgeItemInputSchema = z.object({
  userId: z.string(),
  rawSourceId: z.string(),
  normalizedText: z.string(),
  summary: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  embedding: z.array(z.number()).optional(),
  isAiDerived: z.boolean().optional(),
});
export type CreateKnowledgeItemInput = z.infer<typeof createKnowledgeItemInputSchema>;

export const createNodeInputSchema = z.object({
  userId: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  nodeType: z.string().optional(),
  parentId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().nullable().optional(),
});
export type CreateNodeInput = z.infer<typeof createNodeInputSchema>;

export const updateNodeInputSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(4000).nullable().optional(),
  status: nodeStatusSchema.optional(),
  parentId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().nullable().optional(),
});
export type UpdateNodeInput = z.infer<typeof updateNodeInputSchema>;
