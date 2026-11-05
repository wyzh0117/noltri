import { createHash } from 'node:crypto';
import { processingRulesSnapshotSchema, type ProcessingRulesSnapshot } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';

/** Content validation; the trusted Core store, never source metadata, supplies this value. */
export function validateTaskRules(value: unknown): ProcessingRulesSnapshot {
  const parsed = processingRulesSnapshotSchema.safeParse(value);
  if (!parsed.success) throw knowledgeError('storage_error', 'Invalid frozen task rules');
  const hash = createHash('sha256').update(JSON.stringify(parsed.data.rules)).digest('hex');
  if (hash !== parsed.data.contentHash || !parsed.data.versionId.endsWith(`-${hash.slice(0, 12)}`)) throw knowledgeError('storage_error', 'Invalid frozen task rules hash');
  return structuredClone(parsed.data);
}
