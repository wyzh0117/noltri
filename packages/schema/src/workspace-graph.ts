import { z } from 'zod';
import { contentLocationSchema } from './course-workspace';

export const workspaceGraphRequestSchema = z.object({
  focus: contentLocationSchema,
  disciplineId: z.string().optional(),
  view: z.enum(['subject', 'advanced']).default('subject'),
  subjectScope: z.enum(['local', 'whole-discipline']).default('local'),
  advancedScope: z.enum(['focus', 'discipline', 'all']).default('focus'),
  depth: z.number().int().min(1).max(5).default(1),
  filter: z.string().max(2000).default(''),
  groups: z.array(z.object({ query: z.string().max(2000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(20).default([]),
  showTags: z.boolean().default(true),
  showAttachments: z.boolean().default(false),
  showUnresolved: z.boolean().default(false),
  showOrphans: z.boolean().default(true),
  incoming: z.boolean().default(true),
  outgoing: z.boolean().default(true),
  interconnect: z.boolean().default(false),
  arrows: z.boolean().default(false),
});
export type WorkspaceGraphRequest = z.infer<typeof workspaceGraphRequestSchema>;
export const workspaceGraphNodeSchema = z.object({
  id: z.string(), title: z.string(),
  kind: z.enum(['discipline','subdiscipline','course','chapter','tag','attachment','unresolved']),
  targets: z.array(contentLocationSchema),
  boundary: z.boolean().default(false),
  linked: z.boolean().default(false),
  color: z.string().optional(),
  weight: z.number().default(0),
  createdAt: z.string().nullable().default(null),
});
export type WorkspaceGraphNode = z.infer<typeof workspaceGraphNodeSchema>;
export const workspaceGraphEdgeSchema = z.object({
  id: z.string(), from: z.string(), to: z.string(),
  kind: z.enum(['membership','link','embed','tag','attachment']),
  target: contentLocationSchema.optional(),
  createdAt: z.string().nullable().default(null),
});
export type WorkspaceGraphEdge = z.infer<typeof workspaceGraphEdgeSchema>;
export const workspaceGraphSchema = z.object({
  layoutKey: z.string(), revision: z.number().int().nonnegative(),
  nodes: z.array(workspaceGraphNodeSchema), edges: z.array(workspaceGraphEdgeSchema),
});
export type WorkspaceGraph = z.infer<typeof workspaceGraphSchema>;
