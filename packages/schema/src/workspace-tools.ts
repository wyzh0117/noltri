import {z} from 'zod';
import {contentLocationSchema} from './course-workspace';
const id=z.string().min(1);
const span={from:z.number().int().nonnegative(),to:z.number().int().nonnegative()};
export const linkContextSchema=z.object({courseId:id,courseChapterId:id.nullable().optional(),entryId:id.optional(),referenceFrom:z.number().int().nonnegative().optional(),sourcePath:z.string().optional()});
export const engineLocationSchema=z.object({kind:z.enum(['course','chapter','entry']),courseId:id,courseChapterId:id.nullable().optional(),entryId:id.optional(),blockId:id.optional(),headingPath:z.array(z.string()).optional()});
export const linkResolutionSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('resolved'),target:engineLocationSchema}),
  z.object({status:z.literal('ambiguous'),candidates:z.array(engineLocationSchema)}),
  z.object({status:z.literal('unresolved'),raw:z.string()}),
  z.object({status:z.literal('subpath-missing'),target:engineLocationSchema,subpath:z.string()}),
]);
export type WorkspaceLinkResolution=z.infer<typeof linkResolutionSchema>;
export const resolveWorkspaceLinkRequestSchema=z.object({context:linkContextSchema,rawLink:z.string().max(20000)});
export const workspaceSearchRequestSchema=z.object({query:z.string().max(2000),cursor:z.string().max(2000).optional(),limit:z.number().int().min(1).max(200).optional()});
export const queryHitSchema=z.object({...span,field:z.string()});
export const workspaceSearchResponseSchema=z.object({revision:z.number().int(),query:z.string(),pending:z.boolean(),scanned:z.number().int().nonnegative(),hits:z.array(z.object({id:z.string(),location:contentLocationSchema,title:z.string(),snippet:z.string(),matches:z.array(queryHitSchema)})),cursor:z.string().optional()});
export type WorkspaceSearchResponse=z.infer<typeof workspaceSearchResponseSchema>;
const headingSchema=z.object({...span,depth:z.number(),text:z.string(),path:z.array(z.string()),contentFrom:z.number(),contentTo:z.number()});
const referenceSchema=z.object({...span,kind:z.enum(['wiki','markdown','property','reference']),raw:z.string(),target:z.string(),targetFrom:z.number(),targetTo:z.number(),embed:z.boolean(),label:z.string().optional(),propertyPath:z.array(z.union([z.string(),z.number()])).optional()});
export const indexedLinkSchema=z.object({sourceLocation:contentLocationSchema,entryId:id.nullable(),courseId:id,courseChapterId:id.nullable(),reference:referenceSchema,resolution:linkResolutionSchema,snippet:z.string(),field:z.string().optional()});
export type WorkspaceIndexedLink=z.infer<typeof indexedLinkSchema>;
export const workspaceBacklinksSchema=z.object({revision:z.number().int(),target:contentLocationSchema,references:z.array(indexedLinkSchema),count:z.number().int()});
export type WorkspaceBacklinks=z.infer<typeof workspaceBacklinksSchema>;
export const workspaceMetadataSchema=z.object({revision:z.number().int(),objects:z.array(z.object({id,courseId:id,entryId:id.optional(),kind:z.string().optional(),title:z.string().optional(),path:z.string().optional(),file:z.string().optional(),content:z.string().optional(),tags:z.array(z.string()).optional(),properties:z.record(z.string(),z.unknown()).optional(),location:contentLocationSchema,metadata:z.object({headings:z.array(headingSchema),tags:z.array(z.object({...span,tag:z.string(),property:z.boolean()})),aliases:z.array(z.string()),properties:z.record(z.string(),z.unknown())}).passthrough().optional()})),targets:z.array(z.object({courseId:id,title:z.string(),path:z.string(),aliases:z.array(z.string()).optional(),headings:z.array(headingSchema.extend({courseChapterId:id.nullable().optional(),entryId:id.optional()})).optional(),blocks:z.array(z.object({...span,id:z.string().optional(),alias:z.string().optional(),type:z.string(),text:z.string(),entryId:id.optional(),courseChapterId:id.nullable().optional()})).optional()})),links:z.array(indexedLinkSchema),errors:z.array(z.object({entryId:id,message:z.string()}))});
export type WorkspaceMetadata=z.infer<typeof workspaceMetadataSchema>;
