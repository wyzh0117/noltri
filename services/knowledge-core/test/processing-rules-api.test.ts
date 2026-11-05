import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_THRESHOLDS } from '@noltri/schema';
import { KnowledgeError } from '@noltri/shared';
import type { Identity } from '../src/auth';
import { ProcessingRulesStore, ProcessingRulesStoreError } from '../src/services/processing-rules';
import * as api from '../src/services/processing-rules-api';
const defaults = { thresholds: { ...DEFAULT_THRESHOLDS }, extractionInstructions: '', classificationInstructions: '' };
const device: Identity = { userId: 'synthetic-user', actor: 'desktop', via: 'dev-token' };
const grant: NonNullable<Identity['grant']> = { id: 'synthetic-grant', label: 'synthetic', client: 'api', scopes: ['read', 'mutate'], secretHash: 'synthetic-nonsecret', nodeIds: null, snippetChars: null, createdAt: '2026-11-02T00:00:00Z', revokedAt: null };
const roots: string[] = [];
async function fixture() {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'noltri-rules-api-test-'));
  roots.push(path);
  return { path, store: await ProcessingRulesStore.open({ root: path, defaults }) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe('authenticated processing rules service', () => {
  it('separates save/apply, preserves immutable history, rolls back with a new version, and persists', async () => {
    const { store, path } = await fixture();
    const initial = await api.readProcessingRules(store, device);
    const rules = { ...defaults, extractionInstructions: 'synthetic instructions' };
    const draft = await api.saveProcessingRulesDraft(store, device, { rules, expectedRevision: 0 });
    expect(draft).toEqual({ rules, revision: 1 });
    expect(draft).not.toHaveProperty('applied');
    expect((await api.readProcessingRules(store, device)).applied).toEqual(initial.applied);
    const applied = await api.applyProcessingRules(store, device, { expectedRevision: 1 });
    expect(applied.draft.revision).toBe(2);
    expect(applied.applied.rules).toEqual(rules);
    expect(Object.isFrozen(applied.applied.rules.thresholds)).toBe(true);
    const rolled = await api.rollbackProcessingRules(store, device, { versionId: initial.applied.versionId, expectedRevision: 2 });
    expect(rolled.draft).toEqual({ rules: defaults, revision: 3 });
    expect(rolled.applied.rules).toEqual(defaults);
    expect(rolled.applied.versionId).not.toBe(initial.applied.versionId);
    const state = await api.readProcessingRules(store, device);
    expect(state.versions).toEqual([initial.applied, applied.applied, rolled.applied]);
    expect(initial.applied.rules).toEqual(defaults);
    expect(await api.readProcessingRules(await ProcessingRulesStore.open({ root: path, defaults }), device)).toEqual(state);
  });
  it('rejects malformed, spoofed, stale and unknown-version requests without changes', async () => {
    const { store, path } = await fixture();
    const before = await readFile(join(path, 'processing-rules.json'), 'utf8');
    const initial = await api.readProcessingRules(store, device);
    for (const extra of [{ token: 'synthetic' }, { userId: 'other' }, { path: '../outside' }, { applied: initial.applied }]) {
      await expect(api.saveProcessingRulesDraft(store, device, { rules: defaults, expectedRevision: 0, ...extra })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(api.applyProcessingRules(store, device, { expectedRevision: 0, ...extra })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(api.rollbackProcessingRules(store, device, { versionId: initial.applied.versionId, expectedRevision: 0, ...extra })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(api.saveProcessingRulesDraft(store, device, { rules: { ...defaults, extractionInstructions: 'x'.repeat(4001) }, expectedRevision: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.applyProcessingRules(store, device, { expectedRevision: -1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.rollbackProcessingRules(store, device, { versionId: '../outside', expectedRevision: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.saveProcessingRulesDraft(store, device, { rules: defaults, expectedRevision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(api.applyProcessingRules(store, device, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(api.rollbackProcessingRules(store, device, { versionId: initial.applied.versionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(api.rollbackProcessingRules(store, device, { versionId: 'rules-999-0123456789ab', expectedRevision: 0 })).rejects.toMatchObject({ code: 'not_found' });
    expect(await readFile(join(path, 'processing-rules.json'), 'utf8')).toBe(before);
    expect(await api.readProcessingRules(store, device)).toEqual(initial);
  });
  it.each<Identity>([{ ...device, via: 'dev-open' }, { ...device, via: 'grant', grant }, { ...device, grant }])('rejects $via identity before accessing any store method', async (identity) => {
    const { store, path } = await fixture();
    const before = await readFile(join(path, 'processing-rules.json'), 'utf8');
    const spies = [vi.spyOn(store, 'readDraft'), vi.spyOn(store, 'getAppliedSnapshot'), vi.spyOn(store, 'listVersions'), vi.spyOn(store, 'listRecords'), vi.spyOn(store, 'saveDraft'), vi.spyOn(store, 'applyDraft'), vi.spyOn(store, 'rollback')];
    for (const operation of [() => api.readProcessingRules(store, identity), () => api.readProcessingRecords(store, identity), () => api.saveProcessingRulesDraft(store, identity, {}), () => api.applyProcessingRules(store, identity, {}), () => api.rollbackProcessingRules(store, identity, {})]) {
      await expect(operation()).rejects.toMatchObject({ code: 'unauthorized' });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await readFile(join(path, 'processing-rules.json'), 'utf8')).toBe(before);
  });
  it('returns only stored metadata records with copy isolation and no write endpoint', async () => {
    const { store } = await fixture();
    const record = { recordId: 'synthetic-record', taskId: 'synthetic-task', ruleVersionId: store.getAppliedSnapshot().versionId, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', phase: 'completed' as const, status: 'succeeded' as const };
    await store.appendRecord(record);
    const response = await api.readProcessingRecords(store, device);
    expect(response).toEqual({ records: [record] });
    response.records.length = 0;
    expect(await api.readProcessingRecords(store, device)).toEqual({ records: [record] });
    expect(api).not.toHaveProperty('appendProcessingRecord');
  });
  it.each(['conflict', 'corrupt', 'unsafe', 'io'])('sanitizes %s storage errors without changing in-memory state', async (kind) => {
    const { store, path } = await fixture();
    const initial = await api.readProcessingRules(store, device);
    const statePath = join(path, 'processing-rules.json');
    if (kind === 'conflict') {
      const other = await ProcessingRulesStore.open({ root: path, defaults });
      await other.saveDraft(defaults, 0);
    } else if (kind === 'corrupt') await writeFile(statePath, '{synthetic-sensitive-instruction');
    else if (kind === 'unsafe') {
      const sentinel = join(path, 'synthetic-sensitive-path');
      await writeFile(sentinel, 'synthetic-sensitive-instruction');
      await rm(statePath); await symlink(sentinel, statePath);
    } else await mkdir(join(path, '.processing-rules.tmp'));
    const failure = await api.saveProcessingRulesDraft(store, device, { rules: defaults, expectedRevision: 0 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KnowledgeError);
    expect(failure).toMatchObject({ code: kind === 'conflict' ? 'conflict' : 'storage_error', details: undefined });
    const encoded = JSON.stringify((failure as KnowledgeError).toJSON());
    expect(encoded).not.toContain(path);
    expect(encoded).not.toContain('synthetic-sensitive');
    expect(encoded).not.toContain('stack');
    expect(store.readDraft()).toEqual(initial.draft);
    expect(store.getAppliedSnapshot()).toEqual(initial.applied);
  });
  it('sanitizes unexpected read errors and maps version capacity to conflict', async () => {
    const { store } = await fixture();
    vi.spyOn(store, 'listRecords').mockImplementation(() => { throw new Error('synthetic-sensitive /path stack'); });
    await expect(api.readProcessingRecords(store, device)).rejects.toMatchObject({ code: 'storage_error', message: 'Processing rules storage unavailable', details: undefined });
    vi.spyOn(store, 'applyDraft').mockRejectedValue(new ProcessingRulesStoreError('version_limit'));
    await expect(api.applyProcessingRules(store, device, { expectedRevision: 0 })).rejects.toMatchObject({ code: 'conflict' });
  });
});
