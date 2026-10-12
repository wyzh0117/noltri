import { z } from 'zod';

export const SCHEMA_VERSION = 'v1';

export const sourceTypeSchema = z.enum(['web', 'desktop_app', 'agent', 'manual']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const captureClientSchema = z.enum(['extension', 'desktop', 'mcp', 'web_app']);
export type CaptureClient = z.infer<typeof captureClientSchema>;

export const nodeStatusSchema = z.enum(['active', 'archived', 'needs_review']);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const knowledgeItemStatusSchema = z.enum(['active', 'merged', 'archived']);
export type KnowledgeItemStatus = z.infer<typeof knowledgeItemStatusSchema>;

export const processingStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;

export const captureActionSchema = z.enum(['created', 'attached', 'merged']);
export type CaptureAction = z.infer<typeof captureActionSchema>;

/**
 * What a capture reply states instead of a vague success flag (本地桌面版与 Research 开发文档 §7.4):
 * `saved` 已落盘, `processing` 待归纳, `completed` 归纳成功, `needs_review` 需要复核, `failed` 归纳失败但原文已保留.
 * The first two are what a replay of a request the server already holds answers with; a client decides
 * whether to keep retrying from `stage`, never from `items.length`.
 */
export const captureStageSchema = z.enum(['saved', 'processing', 'completed', 'needs_review', 'failed']);
export type CaptureStage = z.infer<typeof captureStageSchema>;

export const confidenceTierSchema = z.enum(['high', 'medium', 'low']);
export type ConfidenceTier = z.infer<typeof confidenceTierSchema>;

export const contextScopeSchema = z.enum(['current_node', 'section', 'tree', 'whole_library']);
export type ContextScope = z.infer<typeof contextScopeSchema>;

/**
 * V1 persists part_of / similar_to / derived_from. The remainder are frozen now so
 * the V2 Graph Engine does not need a schema-breaking migration.
 */
export const edgeRelationSchema = z.enum([
  'part_of',
  'prerequisite_of',
  'similar_to',
  'contrast_with',
  'causes',
  'implements',
  'example_of',
  'supports',
  'contradicts',
  'derived_from',
]);
export type EdgeRelation = z.infer<typeof edgeRelationSchema>;

export const itemLinkRelationSchema = z.enum(['primary', 'example_of', 'supports']);
export type ItemLinkRelation = z.infer<typeof itemLinkRelationSchema>;

export const versionedEntitySchema = z.enum(['knowledge_node', 'knowledge_item', 'raw_source']);
export type VersionedEntity = z.infer<typeof versionedEntitySchema>;

export const structureOperationSchema = z.enum([
  'create',
  'rename',
  'move',
  'reparent',
  'merge',
  'split',
  'archive',
  'restore',
]);
export type StructureOperation = z.infer<typeof structureOperationSchema>;

export const conversationRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const searchModeSchema = z.enum(['semantic', 'keyword', 'hybrid']);
export type SearchMode = z.infer<typeof searchModeSchema>;

/**
 * Forward-compatible fields: V1 only stores them, the UI appears in V3. The labels are the single
 * source of truth for the matching CHECK constraints in `packages/storage/src/sqlite-schema.ts`.
 */
export const masteryLevelSchema = z.enum([
  'collected',
  'organized',
  'understood',
  'explainable',
  'applicable',
  'mastered',
]);
export type MasteryLevel = z.infer<typeof masteryLevelSchema>;

/**
 * Written by Knowledge Core only. Repositories must never derive it from embedding_model or from
 * whether a vector is null.
 */
export const embeddingStatusSchema = z.enum(['none', 'ready', 'failed']);
export type EmbeddingStatus = z.infer<typeof embeddingStatusSchema>;
