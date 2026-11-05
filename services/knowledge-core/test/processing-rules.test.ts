import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, symlink, open, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_THRESHOLDS } from '@noltri/schema';
import { ProcessingRulesStore } from '../src/services/processing-rules';
const defaults = { thresholds: { ...DEFAULT_THRESHOLDS }, extractionInstructions: '', classificationInstructions: '' };
const roots: string[] = [];
async function root() { const value = await mkdtemp(join(await realpath(tmpdir()), 'noltri-rules-test-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe('ProcessingRulesStore', () => {
  it('separates draft and applied rules, persists versions, and copy isolates snapshots', async () => {
    const path = await root(); const store = await ProcessingRulesStore.open({ root: path, defaults });
    const initial = store.getAppliedSnapshot();
    expect(store.readDraft()).toEqual({ revision: 0, rules: defaults });
    const draft = await store.saveDraft({ ...defaults, extractionInstructions: 'synthetic extraction' }, 0);
    expect(store.getAppliedSnapshot()).toEqual(initial);
    const applied = await store.applyDraft(draft.revision);
    expect(applied.rules.extractionInstructions).toBe('synthetic extraction');
    expect(applied.versionId).not.toBe(initial.versionId);
    expect(Object.isFrozen(initial.rules.thresholds)).toBe(true);
    expect(() => { (initial.rules.thresholds as { highConfidence: number }).highConfidence = 0; }).toThrow();
    const reloaded = await ProcessingRulesStore.open({ root: path, defaults });
    expect(reloaded.getAppliedSnapshot()).toEqual(applied);
    expect(reloaded.listVersions()).toEqual([initial, applied]);
    const rolled = await reloaded.rollback(initial.versionId, reloaded.readDraft().revision);
    expect(rolled.rules).toEqual(initial.rules);
    expect(rolled.versionId).not.toBe(initial.versionId);
    expect(reloaded.listVersions()[1]).toEqual(applied);
    expect(initial.rules.extractionInstructions).toBe('');
  });
  it('serializes mutations and rejects stale save/apply/rollback', async () => {
    const store = await ProcessingRulesStore.open({ root: await root(), defaults });
    const results = await Promise.allSettled([store.saveDraft(defaults, 0), store.saveDraft(defaults, 0)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(store.applyDraft(0)).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(store.rollback(store.getAppliedSnapshot().versionId, 0)).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(store.rollback('rules-999-0123456789ab', 1)).rejects.toMatchObject({ code: 'version_not_found' });
  });
  it('rejects invalid input without changing durable or applied state', async () => {
    const path = await root(); const store = await ProcessingRulesStore.open({ root: path, defaults });
    const before = await readFile(join(path, 'processing-rules.json'), 'utf8');
    await expect(store.saveDraft({ ...defaults, thresholds: { ...DEFAULT_THRESHOLDS, highConfidence: 2 } }, 0)).rejects.toThrow();
    await expect(store.saveDraft({ ...defaults, extractionInstructions: 'x'.repeat(4001) }, 0)).rejects.toThrow();
    expect(await readFile(join(path, 'processing-rules.json'), 'utf8')).toBe(before);
  });
  it('retains previous state when the fixed atomic write temporary path is unavailable', async () => {
    const path = await root(); const store = await ProcessingRulesStore.open({ root: path, defaults });
    await store.saveDraft({ ...defaults, classificationInstructions: 'synthetic' }, 0);
    const before = await readFile(join(path, 'processing-rules.json'), 'utf8');
    const previous = store.getAppliedSnapshot();
    await mkdir(join(path, '.processing-rules.tmp'));
    await expect(store.applyDraft(1)).rejects.toThrow();
    expect(store.getAppliedSnapshot()).toEqual(previous);
    expect(store.readDraft().revision).toBe(1);
    expect(await readFile(join(path, 'processing-rules.json'), 'utf8')).toBe(before);
  });
  it.each(['directory', 'symlink', 'sync-failure', 'temporary'])('preserves unowned cleanup targets after %s replacement during sync', async (replacement) => {
    const container = await root();
    const path = join(container, 'store');
    await mkdir(path);
    const store = await ProcessingRulesStore.open({ root: path, defaults });
    const previous = store.getAppliedSnapshot();
    const before = await readFile(join(path, 'processing-rules.json'), 'utf8');
    const moved = join(container, 'moved');
    const substitute = join(container, 'substitute');
    await mkdir(substitute);
    const probe = await open(join(path, 'processing-rules.json'), 'r');
    const prototype = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    await probe.close();
    const spy = vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (this: FileHandle) {
      await originalSync.call(this);
      if (replacement === 'temporary') {
        await rename(join(path, '.processing-rules.tmp'), join(container, 'owned.tmp'));
      } else {
        await rename(path, moved);
        if (replacement === 'symlink') await symlink(substitute, path);
        else await mkdir(path);
      }
      await writeFile(join(path, '.processing-rules.tmp'), 'synthetic unowned sentinel');
      if (replacement === 'sync-failure' || replacement === 'temporary') throw new Error('synthetic sync failure');
    });
    try {
      const pending = store.applyDraft(0);
      if (replacement === 'sync-failure' || replacement === 'temporary') await expect(pending).rejects.toThrow('synthetic sync failure');
      else await expect(pending).rejects.toMatchObject({ code: 'unsafe_path' });
      expect(await readFile(join(path, '.processing-rules.tmp'), 'utf8')).toBe('synthetic unowned sentinel');
      expect(await readFile(join(replacement === 'temporary' ? path : moved, 'processing-rules.json'), 'utf8')).toBe(before);
      const ownedTemporary = replacement === 'temporary' ? join(container, 'owned.tmp') : join(moved, '.processing-rules.tmp');
      expect(JSON.parse(await readFile(ownedTemporary, 'utf8')).versions).toHaveLength(2);
      expect(store.getAppliedSnapshot()).toEqual(previous);
      expect(store.readDraft().revision).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('caps and reloads metadata records, rejecting raw text and arbitrary error strings', async () => {
    const path = await root(); const store = await ProcessingRulesStore.open({ root: path, defaults, recordLimit: 2 });
    const record = { taskId: 'task-1', ruleVersionId: store.getAppliedSnapshot().versionId, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', phase: 'extracting' as const, status: 'failed' as const, errorCode: 'extraction_failed' as const };
    for (let i = 0; i < 3; i++) await store.appendRecord({ ...record, recordId: `record-${i}` });
    await expect(store.appendRecord({ ...record, recordId: 'bad', rawText: 'synthetic raw' })).rejects.toThrow();
    await expect(store.appendRecord({ ...record, recordId: 'bad', errorCode: 'stack details' })).rejects.toThrow();
    expect(store.listRecords().map((r) => r.recordId)).toEqual(['record-1', 'record-2']);
    expect((await ProcessingRulesStore.open({ root: path, defaults, recordLimit: 2 })).listRecords()).toEqual(store.listRecords());
  });
  it('fails closed for invalid JSON, unknown schema, and modified snapshot hashes without overwrite', async () => {
    for (const content of ['{', '{"schemaVersion":999}', JSON.stringify({ schemaVersion: 1, unexpected: true })]) {
      const path = await root(); await writeFile(join(path, 'processing-rules.json'), content);
      await expect(ProcessingRulesStore.open({ root: path, defaults })).rejects.toThrow();
      expect(await readFile(join(path, 'processing-rules.json'), 'utf8')).toBe(content);
    }
    const path = await root(); await ProcessingRulesStore.open({ root: path, defaults });
    const state = JSON.parse(await readFile(join(path, 'processing-rules.json'), 'utf8'));
    state.versions[0].rules.extractionInstructions = 'tampered';
    await writeFile(join(path, 'processing-rules.json'), JSON.stringify(state));
    await expect(ProcessingRulesStore.open({ root: path, defaults })).rejects.toThrow();
  });
  it('rejects symlinked roots, ancestors, state and temporary files without touching their targets', async () => {
    const outside = await root(); const container = await root();
    await symlink(outside, join(container, 'linked'));
    await expect(ProcessingRulesStore.open({ root: join(container, 'linked'), defaults })).rejects.toThrow();
    await expect(ProcessingRulesStore.open({ root: join(container, 'linked', 'child'), defaults })).rejects.toThrow();
    const target = join(outside, 'sentinel'); await writeFile(target, 'synthetic sentinel');
    const path = await root(); await symlink(target, join(path, 'processing-rules.json'));
    await expect(ProcessingRulesStore.open({ root: path, defaults })).rejects.toThrow();
    const path2 = await root(); const store = await ProcessingRulesStore.open({ root: path2, defaults });
    await symlink(target, join(path2, '.processing-rules.tmp'));
    await expect(store.saveDraft(defaults, 0)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('synthetic sentinel');
  });
});
