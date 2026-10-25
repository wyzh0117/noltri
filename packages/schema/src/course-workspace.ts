import { z } from 'zod';
import { rawSourceSchema } from './knowledge';

const id = z.string().min(1);
const revision = z.number().int().nonnegative();
export const workspacePropertiesSchema = z.record(z.string(), z.unknown());
export const contentLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discipline'), disciplineId: id }),
  z.object({ kind: z.literal('subdiscipline'), disciplineId: id, subdisciplineId: id }),
  z.object({ kind: z.literal('course'), courseId: id, disciplineId: id.optional(), viaParentId: id.optional() }),
  z.object({ kind: z.literal('chapter'), courseId: id, courseChapterId: id, disciplineId: id.optional() }),
  z.object({ kind: z.literal('entry'), courseId: id, courseChapterId: id.nullable(), entryId: id, blockId: id.optional(), headingPath: z.array(z.string()).optional(), disciplineId: id.optional() }),
]);
export type ContentLocation = z.infer<typeof contentLocationSchema>;
export const navigationOriginSchema = z.enum(['card', 'tree', 'search', 'link', 'backlink', 'graph', 'outline', 'history', 'switcher']);
export type NavigationOrigin = z.infer<typeof navigationOriginSchema>;
export interface NavigationOptions { origin: NavigationOrigin; openIn?: 'current' | 'new-tab' | 'split'; preserveGraphContext?: boolean }
export const chapterConceptSchema = z.object({ id, userId: id, title: z.string(), revision });
export type ChapterConcept = z.infer<typeof chapterConceptSchema>;
export const workspaceCourseSchema = z.object({ id, userId: id, title: z.string().trim().min(1).max(200), documentRevision: revision, properties: workspacePropertiesSchema, updatedAt: z.string() });
export type WorkspaceCourse = z.infer<typeof workspaceCourseSchema>;
export const courseChapterSchema = z.object({ id, userId: id, courseId: id, conceptId: id, title: z.string(), order: z.number().int(), revision, properties: workspacePropertiesSchema, detached: z.boolean().default(false) });
export type CourseChapter = z.infer<typeof courseChapterSchema>;
export const contentBlockSchema = z.object({ id, alias: id, from: revision, to: revision });
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export const contentEntrySchema = z.object({ id, userId: id, courseId: id, courseChapterId: id.nullable(), markdown: z.string(), order: z.number().int(), revision, properties: workspacePropertiesSchema, blocks: z.array(contentBlockSchema) });
export type ContentEntry = z.infer<typeof contentEntrySchema>;
export const entrySourceLinkSchema = z.object({ entryId: id, sourceId: id, locations: z.array(workspacePropertiesSchema) });
export type EntrySourceLink = z.infer<typeof entrySourceLinkSchema>;
export const projectionRangeSchema = z.object({ kind: z.enum(['title', 'chapter', 'entry']), from: revision, to: revision, courseChapterId: id.nullable(), entryId: id.nullable(), revision });
export type ProjectionRange = z.infer<typeof projectionRangeSchema>;
export const courseDocumentSchema = z.object({ courseId: id, title: z.string(), documentRevision: revision, markdown: z.string(), chapters: z.array(courseChapterSchema), entries: z.array(contentEntrySchema), properties: workspacePropertiesSchema, sourceLinks: z.array(entrySourceLinkSchema), sources: z.array(rawSourceSchema), projection: z.array(projectionRangeSchema) });
export type CourseDocument = z.infer<typeof courseDocumentSchema>;
export const documentChangeSchema = z.object({ from: revision, to: revision, insert: z.string() });
export type DocumentChange = z.infer<typeof documentChangeSchema>;
export const applyCourseDocumentPatchSchema = z.object({ courseId: id, baseDocumentRevision: revision, entryRevisions: z.record(z.string(), revision), changes: z.array(documentChangeSchema).min(1), requestId: id.max(200) });
export type ApplyCourseDocumentPatchRequest = z.infer<typeof applyCourseDocumentPatchSchema>;
export const moveSourceAssignmentsSchema = z.object({ sourceId: id, entryIds: z.array(id).min(1), toCourseId: id, toCourseChapterId: id.nullable(), expectedEntryRevisions: z.record(z.string(), revision), expectedDocumentRevisions: z.record(z.string(), revision), requestId: id.max(200) });
export type MoveSourceAssignmentsRequest = z.infer<typeof moveSourceAssignmentsSchema>;
export const workspaceMutationResultSchema = z.object({ documents: z.array(courseDocumentSchema), affectedLocations: z.array(contentLocationSchema), revisions: z.record(z.string(), revision), snapshotId: id.nullable() });
export type WorkspaceMutationResult = z.infer<typeof workspaceMutationResultSchema>;
export const resolvedReferenceOwnerSchema = z.object({ content: z.string(), revision, references: z.array(z.object({ from: revision, to: revision, raw: z.string(), targetText: z.string(), field: z.string().optional(), target: contentLocationSchema })) });
export type ResolvedReferenceOwner = z.infer<typeof resolvedReferenceOwnerSchema>;
export const workspaceAttachmentRecordSchema = z.object({ id, userId: id, path: id, originalPath: id, mimeType: id, size: revision, sha256: id, createdAt: z.string(), revision, requestId: id });
export const workspaceContentSchema = z.object({ courses: z.array(workspaceCourseSchema), concepts: z.array(chapterConceptSchema), chapters: z.array(courseChapterSchema), entries: z.array(contentEntrySchema), sourceLinks: z.array(entrySourceLinkSchema), resolvedReferences: z.record(z.string(), resolvedReferenceOwnerSchema).default({}), attachments: z.array(workspaceAttachmentRecordSchema).default([]) });
export type WorkspaceContent = z.infer<typeof workspaceContentSchema>;
export const workspaceSnapshotSchema = z.object({ id, userId: id, createdAt: z.string(), reason: z.string(), actor: z.string(), objectKeys: z.array(id), before: workspaceContentSchema, afterRevisions: z.record(z.string(), revision) });
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export const restoreSnapshotRequestSchema = z.object({ expectedRevisions: z.record(z.string(), revision) });
export const workspaceSettingsSchema = z.object({ snapshotIntervalSeconds: z.number().int().min(0).max(86400).default(60), snapshotRetentionDays: z.number().int().min(1).max(3650).default(30), attachmentCleanup: z.enum(['never', 'ask', 'always']).default('ask') });
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export const workspaceStateSchema = workspaceContentSchema.extend({ revision, snapshots: z.array(workspaceSnapshotSchema), requests: z.record(z.string(), z.object({ fingerprint: z.string(), result: workspaceMutationResultSchema.optional(), attachmentResult: workspacePropertiesSchema.optional() })), tombstones: z.record(z.string(), revision), settings: workspaceSettingsSchema, imports: z.record(z.string(), z.object({ path: id, sourceId: id, courseId: id, entryIds: z.array(id), chapterIds: z.array(id).default([]), revisions: z.record(z.string(), revision), contentHash: id })).default({}), migration: z.object({ version: z.number().int(), mappings: z.record(z.string(), z.string()), unconfirmed: z.array(z.string()) }) });
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export const WORKSPACE_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const patchWorkspacePropertiesSchema = z.object({ owner: z.object({ kind: z.enum(['course', 'chapter', 'entry']), id }), expectedRevision: revision, properties: workspacePropertiesSchema, requestId: id.max(200) });
export type PatchWorkspacePropertiesRequest = z.infer<typeof patchWorkspacePropertiesSchema>;
