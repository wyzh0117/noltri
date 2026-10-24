import { z } from 'zod';

export const graphScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discipline'), disciplineId: z.string().min(1) }),
  z.object({ kind: z.literal('subdiscipline'), disciplineId: z.string().min(1), subdisciplineId: z.string().min(1) }),
  z.object({ kind: z.literal('topic'), disciplineId: z.string().min(1), anchorTopicId: z.string().min(1) }),
]);
export type GraphScope = z.infer<typeof graphScopeSchema>;

export const graphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  nodeType: z.enum(['topic', 'chapter']),
  parentId: z.string().nullable(),
  summary: z.string().nullable(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  relationType: z.literal('part_of'),
  source: z.string(),
  implicit: z.boolean().optional(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphDiagnosticSchema = z.object({
  entityId: z.string(),
  reason: z.enum(['duplicate-id', 'self-loop', 'missing-endpoint', 'cross-discipline']),
});
export type GraphDiagnostic = z.infer<typeof graphDiagnosticSchema>;

export const graphSelectionSchema = z.object({
  scope: graphScopeSchema,
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  diagnostics: z.array(graphDiagnosticSchema).optional(),
});
export type GraphSelection = z.infer<typeof graphSelectionSchema>;

export const resolveChapterRequestSchema = z.object({
  chapterId: z.string().min(1),
  activeTopicId: z.string().min(1).optional(),
  scope: graphScopeSchema,
});
export type ResolveChapterRequest = z.infer<typeof resolveChapterRequestSchema>;

export const chapterTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resolved'), topicId: z.string(), chapterId: z.string() }),
  z.object({ kind: z.literal('choose-topic'), chapterId: z.string(), topicIds: z.array(z.string()).min(2) }),
  z.object({ kind: z.literal('unavailable') }),
]);
export type ChapterTarget = z.infer<typeof chapterTargetSchema>;

export const graphNoteSchema = z.object({
  topicId: z.string(),
  chapterId: z.string().nullable(),
  content: z.string(),
  updatedAt: z.string().nullable(),
  path: z.string().optional(),
  etag: z.string().nullable(),
});
export type GraphNote = z.infer<typeof graphNoteSchema>;
/** Bounds the legacy GraphNote API; Vault file writes use the larger file-oriented request contract. */
export const MAX_GRAPH_NOTE_CHARS = 40_000;

export const graphNoteIndexEntrySchema = z.object({
  topicId: z.string(),
  chapterId: z.string().nullable(),
  chapterTitle: z.string().nullable(),
  updatedAt: z.string(),
  attached: z.boolean(),
  path: z.string().optional(),
});
export type GraphNoteIndexEntry = z.infer<typeof graphNoteIndexEntrySchema>;

export const graphNoteIndexSchema = z.object({ notes: z.array(graphNoteIndexEntrySchema) });
export type GraphNoteIndex = z.infer<typeof graphNoteIndexSchema>;

export const saveGraphNoteRequestSchema = z.object({
  chapterId: z.string().min(1).max(128).nullable(),
  content: z.string().max(MAX_GRAPH_NOTE_CHARS, `正文不能超过 ${String(MAX_GRAPH_NOTE_CHARS)} 个字符`),
  expectedEtag: z.string().optional(),
});
export type SaveGraphNoteRequest = z.infer<typeof saveGraphNoteRequestSchema>;

export const createChapterRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type CreateChapterRequest = z.infer<typeof createChapterRequestSchema>;

export const chapterResponseSchema = z.object({
  chapter: graphNodeSchema,
  edge: graphEdgeSchema,
});
export type ChapterResponse = z.infer<typeof chapterResponseSchema>;

export const graphMembershipRequestSchema = z.object({
  chapterId: z.string().min(1),
  topicId: z.string().min(1),
});
export type GraphMembershipRequest = z.infer<typeof graphMembershipRequestSchema>;
