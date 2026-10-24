import { z } from 'zod';

export const vaultEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'folder']),
  extension: z.string().optional(),
  ctime: z.number().optional(),
  mtime: z.number().optional(),
  size: z.number().optional(),
});
export type VaultEntry = z.infer<typeof vaultEntrySchema>;

export const vaultSnapshotSchema = z.object({
  rootPath: z.string(),
  files: z.array(vaultEntrySchema),
  revision: z.number().int(),
});
export type VaultSnapshot = z.infer<typeof vaultSnapshotSchema>;

export const vaultLinkFormatSchema = z.enum(['absolute', 'relative', 'shortest']);
export const vaultSettingsSchema = z.object({ newLinkFormat: vaultLinkFormatSchema });
export type VaultSettings = z.infer<typeof vaultSettingsSchema>;
export const updateVaultSettingsRequestSchema = vaultSettingsSchema;
export type UpdateVaultSettingsRequest = z.infer<typeof updateVaultSettingsRequestSchema>;

export const notePositionSchema = z.object({
  start: z.object({ line: z.number().int(), col: z.number().int(), offset: z.number().int() }),
  end: z.object({ line: z.number().int(), col: z.number().int(), offset: z.number().int() }),
});
export type NotePosition = z.infer<typeof notePositionSchema>;
export const vaultSubpathResponseSchema = z.object({ position: notePositionSchema.nullable() });
export type VaultSubpathResponse = z.infer<typeof vaultSubpathResponseSchema>;

export const noteLinkSchema = z.object({
  link: z.string(),
  original: z.string(),
  displayText: z.string().optional(),
  position: notePositionSchema,
  isEmbed: z.boolean().optional(),
  kind: z.enum(['wikilink', 'markdown', 'frontmatter']),
});
export type NoteLink = z.infer<typeof noteLinkSchema>;

export const noteHeadingSchema = z.object({ heading: z.string(), level: z.number().int(), position: notePositionSchema });
export const noteTagSchema = z.object({ tag: z.string(), position: notePositionSchema, field: z.enum(['content', 'frontmatter']).optional() });
export const noteBlockSchema = z.object({ id: z.string(), position: notePositionSchema });
export const cachedNoteMetadataSchema = z.object({
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  frontmatterPosition: notePositionSchema.optional(),
  frontmatterLinks: z.array(z.object({ key: z.string(), link: z.string(), original: z.string(), displayText: z.string().optional(), position: notePositionSchema })).optional(),
  links: z.array(noteLinkSchema).optional(),
  embeds: z.array(noteLinkSchema).optional(),
  tags: z.array(noteTagSchema).optional(),
  headings: z.array(noteHeadingSchema).optional(),
  sections: z.array(z.object({ type: z.string(), position: notePositionSchema, id: z.string().optional() })).optional(),
  listItems: z.array(z.object({ position: notePositionSchema, parent: z.number().int(), task: z.string().optional(), id: z.string().optional() })).optional(),
  blocks: z.record(z.string(), noteBlockSchema).optional(),
  footnotes: z.record(z.string(), noteBlockSchema).optional(),
  footnoteRefs: z.array(z.object({ id: z.string(), position: notePositionSchema })).optional(),
  referenceLinks: z.record(z.string(), z.object({ link: z.string(), original: z.string(), position: notePositionSchema })).optional(),
});
export type CachedNoteMetadata = z.infer<typeof cachedNoteMetadataSchema>;

export const noteFileSchema = z.object({
  path: z.string(), content: z.string(), mtime: z.number(), ctime: z.number().optional(), size: z.number(), etag: z.string(),
  metadata: cachedNoteMetadataSchema.optional(),
});
export type NoteFile = z.infer<typeof noteFileSchema>;
export const readNoteFileResponseSchema = noteFileSchema;
export const writeNoteFileRequestSchema = z.object({ path: z.string().min(1), content: z.string(), expectedEtag: z.string().optional() });
export type WriteNoteFileRequest = z.infer<typeof writeNoteFileRequestSchema>;
export const deleteVaultFileRequestSchema = z.object({
  path: z.string().min(1),
  expectedEtag: z.string().optional(),
  orphanPolicy: z.enum(['never', 'always', 'ask']).default('ask'),
});
export type DeleteVaultFileRequest = z.infer<typeof deleteVaultFileRequestSchema>;
export const vaultDeletePreviewSchema = z.object({
  path: z.string(), etag: z.string(), backlinkCount: z.number().int(),
  kind: z.enum(['file', 'folder']).default('file'), descendantCount: z.number().int().nonnegative().default(1),
  orphanAttachments: z.array(z.object({ path: z.string(), name: z.string(), etag: z.string(), size: z.number(), mimeType: z.string().optional() })),
});
export type VaultDeletePreview = z.infer<typeof vaultDeletePreviewSchema>;
export const deleteVaultFileResponseSchema = z.object({ path: z.string(), deletedAttachments: z.array(z.string()) });
export type DeleteVaultFileResponse = z.infer<typeof deleteVaultFileResponseSchema>;
export const renameVaultBlockRequestSchema = z.object({
  path: z.string().min(1), oldId: z.string().min(1), newId: z.string().min(1), expectedEtag: z.string().optional(),
});
export type RenameVaultBlockRequest = z.infer<typeof renameVaultBlockRequestSchema>;
export const renameVaultBlockResponseSchema = z.object({
  file: noteFileSchema, updatedFiles: z.array(z.object({ path: z.string(), etag: z.string() })), revision: z.number().int(),
});
export type RenameVaultBlockResponse = z.infer<typeof renameVaultBlockResponseSchema>;
export const vaultDiagnosticsSchema = z.object({
  revision: z.number().int(), indexing: z.boolean(), queued: z.number().int(),
  failedFiles: z.array(z.object({ path: z.string(), error: z.string(), at: z.string() })),
  lastIndexedAt: z.string().nullable(),
  cache: z.object({ loaded: z.boolean(), persisted: z.boolean(), entries: z.number().int() }),
  worker: z.object({ restarts: z.number().int(), timeouts: z.number().int() }),
});
export type VaultDiagnostics = z.infer<typeof vaultDiagnosticsSchema>;
export const renameNoteRequestSchema = z.object({ path: z.string().min(1), newPath: z.string().min(1), expectedEtag: z.string().optional() });
export type RenameNoteRequest = z.infer<typeof renameNoteRequestSchema>;
export const createVaultFolderRequestSchema = z.object({ path: z.string().min(1).max(4096) });
export type CreateVaultFolderRequest = z.infer<typeof createVaultFolderRequestSchema>;
export const vaultAssetSchema = z.object({ path: z.string(), mimeType: z.string(), dataUrl: z.string() });
export type VaultAsset = z.infer<typeof vaultAssetSchema>;
export const openVaultRequestSchema = z.object({ rootPath: z.string().min(1).max(4096) });
export type OpenVaultRequest = z.infer<typeof openVaultRequestSchema>;
export const resolveNoteLinkRequestSchema = z.object({
  linkpath: z.string(),
  sourcePath: z.string(),
  kind: z.enum(['wikilink', 'markdown']).optional(),
});
export type ResolveNoteLinkRequest = z.infer<typeof resolveNoteLinkRequestSchema>;

export const noteLinksResponseSchema = z.object({
  revision: z.number().int(),
  resolvedLinks: z.record(z.string(), z.record(z.string(), z.number().int())),
  unresolvedLinks: z.record(z.string(), z.record(z.string(), z.number().int())),
});
export type NoteLinksResponse = z.infer<typeof noteLinksResponseSchema>;
export const noteBacklinksResponseSchema = z.object({ backlinks: z.array(z.object({ sourcePath: z.string(), count: z.number().int(), positions: z.array(notePositionSchema) })) });
export type NoteBacklinksResponse = z.infer<typeof noteBacklinksResponseSchema>;

export const vaultGraphNodeSchema = z.object({
  path: z.string(),
  title: z.string(),
  basename: z.string(),
  type: z.enum(['note', 'attachment', 'unresolved']),
  extension: z.string().optional(),
  mtime: z.number().optional(),
  ctime: z.number().optional(),
  tags: z.array(z.string()).default([]),
});
export type VaultGraphNode = z.infer<typeof vaultGraphNodeSchema>;
export const vaultGraphEdgeSchema = z.object({ sourcePath: z.string(), targetPath: z.string(), count: z.number().int(), resolved: z.boolean(), mtime: z.number().optional() });
export type VaultGraphEdge = z.infer<typeof vaultGraphEdgeSchema>;
export const vaultGraphSchema = z.object({ nodes: z.array(vaultGraphNodeSchema), edges: z.array(vaultGraphEdgeSchema), revision: z.number().int() });
export type VaultGraph = z.infer<typeof vaultGraphSchema>;

export const vaultChangeSchema = z.object({ kind: z.enum(['changed', 'resolved', 'deleted']), path: z.string() });
export const vaultChangesResponseSchema = z.object({ revision: z.number().int(), reset: z.boolean(), events: z.array(vaultChangeSchema) });
export type VaultChangesResponse = z.infer<typeof vaultChangesResponseSchema>;

export const noteSearchMatchSchema = z.object({ start: z.number().int(), end: z.number().int(), field: z.enum(['content', 'path', 'frontmatter']) });
export const noteSearchResultSchema = z.object({
  path: z.string(), title: z.string(), score: z.number(), matches: z.array(noteSearchMatchSchema), snippet: z.string(),
  titleMatches: z.array(z.object({ start: z.number().int(), end: z.number().int() })).default([]),
  snippetMatches: z.array(z.object({ start: z.number().int(), end: z.number().int() })).default([]),
  matchedTags: z.array(z.string()).default([]),
});
export const noteSearchResponseSchema = z.object({ revision: z.number().int(), query: z.string(), results: z.array(noteSearchResultSchema), paths: z.array(z.string()).optional() });
export type NoteSearchResponse = z.infer<typeof noteSearchResponseSchema>;
export const noteSearchQuerySchema = z.object({ q: z.string().max(2000), limit: z.coerce.number().int().min(1).max(10000).optional() });
export const noteMatchesResponseSchema = z.object({ revision: z.number().int(), paths: z.array(z.string()), matchingTags: z.array(z.string()).default([]), attachmentPaths: z.array(z.string()).default([]) });
export type NoteMatchesResponse = z.infer<typeof noteMatchesResponseSchema>;
export const noteMentionResponseSchema = z.object({ mentions: z.array(z.object({ sourcePath: z.string(), positions: z.array(notePositionSchema) })) });
export type NoteMentionResponse = z.infer<typeof noteMentionResponseSchema>;
export const noteHistoryResponseSchema = z.object({ versions: z.array(z.object({ id: z.string(), createdAt: z.string(), etag: z.string() })) });
export type NoteHistoryResponse = z.infer<typeof noteHistoryResponseSchema>;
export const noteHistoryVersionResponseSchema = noteFileSchema;
export type NoteHistoryVersionResponse = z.infer<typeof noteHistoryVersionResponseSchema>;
export const restoreNoteHistoryRequestSchema = z.object({ path: z.string().min(1), versionId: z.string().min(1), expectedEtag: z.string().optional() });
export type RestoreNoteHistoryRequest = z.infer<typeof restoreNoteHistoryRequestSchema>;
export const legacyNotePathResponseSchema = z.object({ path: z.string(), exists: z.boolean() });
export type LegacyNotePathResponse = z.infer<typeof legacyNotePathResponseSchema>;
export const restoreLegacyNoteRequestSchema = z.object({ topicId: z.string().min(1), chapterId: z.string().min(1).nullable() });
export type RestoreLegacyNoteRequest = z.infer<typeof restoreLegacyNoteRequestSchema>;
