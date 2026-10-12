import { z } from 'zod';
import { itemLinkRelationSchema, sourceTypeSchema } from './enums';
import { MAX_CAPTURE_TEXT_LENGTH, MIN_CAPTURE_TEXT_LENGTH } from './capture-limits';

export const libraryItemKindSchema = z.enum(['knowledge', 'paper_excerpt', 'web_page', 'image']);
export type LibraryItemKind = z.infer<typeof libraryItemKindSchema>;

export const itemRelationKindSchema = z.enum(['supports', 'contradicts', 'related']);
export type ItemRelationKind = z.infer<typeof itemRelationKindSchema>;
export const itemRelationDirectionSchema = z.enum(['outgoing', 'incoming']);

const pathSchema = z.array(z.string().trim().min(1).max(200)).max(6);
const tagsSchema = z.array(z.string().trim().min(1).max(80)).max(30);
const webUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  }, 'only credential-free http and https URLs are accepted');
export const previewImageUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  }, 'image previews must use credential-free https URLs');
export const captureSourceUrlSchema = webUrlSchema;

export const librarySourceMetadataSchema = z.object({
  citation: z.string().trim().max(1200).nullable().optional(),
  page: z.string().trim().max(80).nullable().optional(),
  author: z.string().trim().max(300).nullable().optional(),
  doi: z.string().trim().max(200).nullable().optional(),
});

export const libraryMetadataSchema = z.object({
  kind: libraryItemKindSchema.optional(),
  subjectPath: pathSchema.optional(),
  researchPoint: z.string().trim().max(1000).nullable().optional(),
  tags: tagsSchema.optional(),
  previewImageUrl: previewImageUrlSchema.nullable().optional(),
  citation: z.string().trim().max(1200).nullable().optional(),
  page: z.string().trim().max(80).nullable().optional(),
  author: z.string().trim().max(300).nullable().optional(),
  doi: z.string().trim().max(200).nullable().optional(),
  archivedAt: z.string().datetime().nullable().optional(),
  /** Preserves each extracted point's exact links while a card is archived. */
  archivedLinks: z.array(z.object({
    itemId: z.string(),
    nodeId: z.string(),
    relationType: itemLinkRelationSchema,
    confidence: z.number().min(0).max(1),
  })).optional(),
});
export type LibraryMetadata = z.infer<typeof libraryMetadataSchema>;

export const librarySourceSchema = z.object({
  type: sourceTypeSchema,
  title: z.string().nullable(),
  url: z.string().nullable(),
  platform: z.string().nullable(),
  appName: z.string().nullable(),
  capturedAt: z.string(),
  citation: z.string().nullable(),
  page: z.string().nullable(),
  author: z.string().nullable(),
  doi: z.string().nullable(),
});

export const libraryItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  kind: libraryItemKindSchema,
  source: librarySourceSchema,
  previewImageUrl: previewImageUrlSchema.nullable(),
  subjectPath: pathSchema,
  researchPoint: z.string().nullable(),
  tags: tagsSchema,
  aiStatus: z.enum(['pending', 'processing', 'ready', 'failed']),
  createdAt: z.string(),
  archived: z.boolean(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

const createSourceSchema = z.object({
  type: sourceTypeSchema,
  title: z.string().trim().max(600).optional(),
  url: webUrlSchema.optional(),
  platform: z.string().trim().max(120).optional(),
  appName: z.string().trim().max(120).optional(),
  capturedAt: z.string().trim().min(4).max(64).optional(),
  ...librarySourceMetadataSchema.shape,
});

export const createLibraryItemInputSchema = z.object({
  content: z.string().min(MIN_CAPTURE_TEXT_LENGTH).max(MAX_CAPTURE_TEXT_LENGTH)
    .refine((content) => content.trim().length >= MIN_CAPTURE_TEXT_LENGTH),
  kind: libraryItemKindSchema,
  source: createSourceSchema,
  subjectPath: pathSchema.optional(),
  researchPoint: z.string().trim().max(1000).nullable().optional(),
  tags: tagsSchema.optional(),
  previewImageUrl: previewImageUrlSchema.nullable().optional(),
});
export type CreateLibraryItemInput = z.infer<typeof createLibraryItemInputSchema>;

export const patchLibraryItemInputSchema = z
  .object({
    content: z.string().min(MIN_CAPTURE_TEXT_LENGTH).max(MAX_CAPTURE_TEXT_LENGTH)
      .refine((content) => content.trim().length >= MIN_CAPTURE_TEXT_LENGTH).optional(),
    kind: libraryItemKindSchema.optional(),
    source: z.object({
      type: sourceTypeSchema.optional(),
      title: z.string().trim().max(600).nullable().optional(),
      url: webUrlSchema.nullable().optional(),
      platform: z.string().trim().max(120).nullable().optional(),
      appName: z.string().trim().max(120).nullable().optional(),
      capturedAt: z.string().trim().min(4).max(64).optional(),
      ...librarySourceMetadataSchema.shape,
    }).partial().optional(),
    subjectPath: pathSchema.optional(),
    researchPoint: z.string().trim().max(1000).nullable().optional(),
    tags: tagsSchema.optional(),
    previewImageUrl: previewImageUrlSchema.nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: 'at least one field required' });
export type PatchLibraryItemInput = z.infer<typeof patchLibraryItemInputSchema>;

export const libraryItemsQuerySchema = z.object({
  nodeId: z.string().trim().min(1).optional(),
  query: z.string().trim().max(200).transform((value) => value.length === 0 ? undefined : value).optional(),
  kind: libraryItemKindSchema.optional(),
  state: z.enum(['all', 'organize', 'archive']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeArchived: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  ]).optional(),
});
export type LibraryItemsQuery = z.infer<typeof libraryItemsQuerySchema>;

export const libraryItemsResponseSchema = z.object({
  items: z.array(libraryItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type LibraryItemsResponse = z.infer<typeof libraryItemsResponseSchema>;

export const createItemRelationInputSchema = z.object({
  targetId: z.string().trim().min(1).max(200),
  relation: itemRelationKindSchema,
});
export type CreateItemRelationInput = z.infer<typeof createItemRelationInputSchema>;

export const itemRelationSchema = z.object({
  targetId: z.string(),
  relation: itemRelationKindSchema,
  direction: itemRelationDirectionSchema,
  createdAt: z.string(),
});
export type ItemRelation = z.infer<typeof itemRelationSchema>;

export const itemRelationsResponseSchema = z.object({ relations: z.array(itemRelationSchema) });
export const itemRelationResponseSchema = z.object({ relation: itemRelationSchema });

/** Per-capture fields the browser/desktop form adds while all entry points share the same source table. */
export const captureLibraryMetadataSchema = z.object({
  kind: libraryItemKindSchema,
  subjectPath: pathSchema.optional(),
  researchPoint: z.string().trim().max(1000).nullable().optional(),
  tags: tagsSchema.optional(),
  previewImageUrl: previewImageUrlSchema.nullable().optional(),
  citation: z.string().trim().max(1200).nullable().optional(),
  page: z.string().trim().max(80).nullable().optional(),
  author: z.string().trim().max(300).nullable().optional(),
  doi: z.string().trim().max(200).nullable().optional(),
});
export type CaptureLibraryMetadata = z.infer<typeof captureLibraryMetadataSchema>;
