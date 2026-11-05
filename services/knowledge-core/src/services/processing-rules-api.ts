import { z } from 'zod';
import {
  applyProcessingRulesRequestSchema, applyProcessingRulesResponseSchema,
  processingRecordsResponseSchema, processingRulesStateSchema,
  rollbackProcessingRulesRequestSchema, rollbackProcessingRulesResponseSchema,
  saveProcessingRulesDraftRequestSchema, saveProcessingRulesDraftResponseSchema,
  type ApplyProcessingRulesResponse, type ProcessingRecordsResponse, type ProcessingRulesState,
  type RollbackProcessingRulesResponse, type SaveProcessingRulesDraftResponse,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { Identity } from '../auth';
import { ProcessingRulesStoreError, type ProcessingRulesStore } from './processing-rules';

function requireDevice(identity: Identity): void {
  if (identity.via !== 'dev-token' || identity.grant !== undefined) {
    throw knowledgeError('unauthorized', 'Authenticated device required');
  }
}

function request<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw knowledgeError('invalid_request', 'Invalid processing rules request');
  return parsed.data;
}

/** Validate without replacing the store's immutable snapshot objects. */
function response<T>(schema: z.ZodType, value: T): T {
  if (!schema.safeParse(value).success) throw new ProcessingRulesStoreError('invalid_state');
  return value;
}

async function storage<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ProcessingRulesStoreError) {
      if (error.code === 'revision_conflict' || error.code === 'state_conflict' || error.code === 'version_limit') {
        throw knowledgeError('conflict', 'Processing rules state conflict');
      }
      if (error.code === 'version_not_found') throw knowledgeError('not_found', 'Processing rules version not found');
    }
    // Never forward validation issues, filesystem paths, instructions or original error messages.
    throw knowledgeError('storage_error', 'Processing rules storage unavailable');
  }
}

export async function readProcessingRules(store: ProcessingRulesStore, identity: Identity): Promise<ProcessingRulesState> {
  requireDevice(identity);
  return storage(() => response(processingRulesStateSchema, {
    draft: store.readDraft(), applied: store.getAppliedSnapshot(), versions: store.listVersions(),
  }));
}

export async function saveProcessingRulesDraft(store: ProcessingRulesStore, identity: Identity, input: unknown): Promise<SaveProcessingRulesDraftResponse> {
  requireDevice(identity);
  const body = request(saveProcessingRulesDraftRequestSchema, input);
  return storage(async () => response(saveProcessingRulesDraftResponseSchema, await store.saveDraft(body.rules, body.expectedRevision)));
}

export async function applyProcessingRules(store: ProcessingRulesStore, identity: Identity, input: unknown): Promise<ApplyProcessingRulesResponse> {
  requireDevice(identity);
  const body = request(applyProcessingRulesRequestSchema, input);
  return storage(async () => {
    await store.applyDraft(body.expectedRevision);
    return response(applyProcessingRulesResponseSchema, { draft: store.readDraft(), applied: store.getAppliedSnapshot() });
  });
}

export async function rollbackProcessingRules(store: ProcessingRulesStore, identity: Identity, input: unknown): Promise<RollbackProcessingRulesResponse> {
  requireDevice(identity);
  const body = request(rollbackProcessingRulesRequestSchema, input);
  return storage(async () => {
    await store.rollback(body.versionId, body.expectedRevision);
    return response(rollbackProcessingRulesResponseSchema, { draft: store.readDraft(), applied: store.getAppliedSnapshot() });
  });
}

/** Record writes belong to real Core task execution, never to this management API. */
export async function readProcessingRecords(store: ProcessingRulesStore, identity: Identity): Promise<ProcessingRecordsResponse> {
  requireDevice(identity);
  return storage(() => response(processingRecordsResponseSchema, { records: store.listRecords() }));
}
