import { z } from 'zod';
import { thresholdsSchema } from './config';

export const processingRulesSchema = z.object({
  thresholds: thresholdsSchema.strict(),
  extractionInstructions: z.string().max(4000),
  classificationInstructions: z.string().max(4000),
}).strict();
export type ProcessingRules = z.infer<typeof processingRulesSchema>;
export const processingRulesDraftSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rules: processingRulesSchema,
}).strict();
export type ProcessingRulesDraft = z.infer<typeof processingRulesDraftSchema>;
export const processingRuleVersionIdSchema = z.string().regex(/^rules-[1-9][0-9]*-[a-f0-9]{12}$/).max(100);
export const processingRulesSnapshotSchema = z.object({
  versionId: processingRuleVersionIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime().max(40),
  rules: processingRulesSchema,
}).strict();
type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
export type ProcessingRulesSnapshot = DeepReadonly<z.infer<typeof processingRulesSnapshotSchema>>;
// Zod's default ISO datetime validator accepts UTC timestamps with seconds and optional
// fractional digits. The 40-character bound allows at most 19 fractional digits. Pad
// those digits instead of rounding through Date.parse, preserving submillisecond order.
function comparableUtcTimestamp(value: string): string {
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  return `${seconds}.${fraction.padEnd(19, '0')}`;
}
export const processingRecordSchema = z.object({
  recordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  ruleVersionId: processingRuleVersionIdSchema,
  createdAt: z.iso.datetime().max(40),
  updatedAt: z.iso.datetime().max(40),
  phase: z.enum(['queued', 'extracting', 'classifying', 'persisting', 'completed']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  errorCode: z.enum(['extraction_failed', 'classification_failed', 'persistence_failed', 'cancelled', 'internal_error']).optional(),
}).strict().refine((record) => comparableUtcTimestamp(record.updatedAt) >= comparableUtcTimestamp(record.createdAt), { message: 'Record timestamps are out of order' });
export type ProcessingRecord = z.infer<typeof processingRecordSchema>;


/** Authenticated device management contracts; identities and paths never come from bodies. */
const processingRulesRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const processingRulesStateSchema = z.object({
  draft: processingRulesDraftSchema,
  applied: processingRulesSnapshotSchema,
  versions: z.array(processingRulesSnapshotSchema).min(1).max(1000),
}).strict();
export type ProcessingRulesState = { draft: ProcessingRulesDraft; applied: ProcessingRulesSnapshot; versions: ProcessingRulesSnapshot[] };

export const saveProcessingRulesDraftRequestSchema = z.object({
  rules: processingRulesSchema,
  expectedRevision: processingRulesRevisionSchema,
}).strict();
export type SaveProcessingRulesDraftRequest = z.infer<typeof saveProcessingRulesDraftRequestSchema>;
export const saveProcessingRulesDraftResponseSchema = processingRulesDraftSchema;
export type SaveProcessingRulesDraftResponse = ProcessingRulesDraft;

export const applyProcessingRulesRequestSchema = z.object({
  expectedRevision: processingRulesRevisionSchema,
}).strict();
export type ApplyProcessingRulesRequest = z.infer<typeof applyProcessingRulesRequestSchema>;
export const applyProcessingRulesResponseSchema = z.object({
  draft: processingRulesDraftSchema,
  applied: processingRulesSnapshotSchema,
}).strict();
export type ApplyProcessingRulesResponse = { draft: ProcessingRulesDraft; applied: ProcessingRulesSnapshot };

export const rollbackProcessingRulesRequestSchema = z.object({
  versionId: processingRuleVersionIdSchema,
  expectedRevision: processingRulesRevisionSchema,
}).strict();
export type RollbackProcessingRulesRequest = z.infer<typeof rollbackProcessingRulesRequestSchema>;
export const rollbackProcessingRulesResponseSchema = applyProcessingRulesResponseSchema;
export type RollbackProcessingRulesResponse = ApplyProcessingRulesResponse;

export const processingRecordsResponseSchema = z.object({
  records: z.array(processingRecordSchema).max(500),
}).strict();
export type ProcessingRecordsResponse = z.infer<typeof processingRecordsResponseSchema>;
