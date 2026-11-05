import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reviewSourceResponseSchema } from '@noltri/schema';
import type { ClientGrant } from '../src/authorization';
import { afterAll, describe, expect, it } from 'vitest';
import { createInMemoryRepository } from '@noltri/storage';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { createOfflineProvider } from '@noltri/ai-provider';
import { silentLogger } from '@noltri/shared';
import { createKnowledgeCore } from '../src/core';
import { createRequestHandler } from '../src/http/router';
import { captureOf, makeHarness, testConfig } from './fakes';

const dirs: string[] = [];
const stores: SqliteRepository[] = [];
function nextFile() { const dir = mkdtempSync(join(tmpdir(), 'noltri-review-')); dirs.push(dir); return join(dir, 'test.sqlite'); }
afterAll(async () => { for (const store of stores) await store.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture(driver: string, file = nextFile()) {
  const repository = driver === 'memory' ? createInMemoryRepository() : new SqliteRepository({ file });
  if (repository instanceof SqliteRepository) stores.push(repository);
  return { ...makeHarness({ repository }), file, store: repository };
}
async function seed(h: ReturnType<typeof fixture>) {
  const source = await h.repository.createRawSource({ userId: h.actor.userId, rawText: '  original bytes\n背景。  ', sourceType: 'manual', capturedAt: '2026-11-02T00:00:00Z' });
  const node = await h.repository.createNode({ userId: h.actor.userId, title: 'Target' });
  return { source, node };
}
for (const driver of ['memory', 'sqlite']) describe(`durable review (${driver})`, () => {
  it('confirms edited text once and replays before checking stale revision', async () => {
    const h = fixture(driver); const { source, node } = await seed(h);
    const request = { actionId: 'confirm-1', expectedRevision: 0, action: 'confirm' as const, nodeId: node.id, editedText: '  human excerpt  ' };
    const first = await h.core.reviewSource(source.id, request, h.actor);
    expect(first).toMatchObject({ reviewStatus: 'confirmed', reviewRevision: 1, duplicate: false, item: { normalizedText: 'human excerpt', isAiDerived: false } });
    expect(first.path).toEqual([{ id: node.id, title: 'Target' }]);
    expect(await h.core.reviewSource(source.id, request, h.actor)).toEqual({ ...first, duplicate: true });
    expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ rawText: '  original bytes\n背景。  ', reviewStatus: 'confirmed', reviewRevision: 1 });
    await expect(h.core.reviewSource(source.id, { ...request, editedText: 'changed' }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.core.reviewSource(source.id, { ...request, actionId: 'confirm-2', expectedRevision: 1 }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retains source and assets on reject, restores explicitly, and combines filters with whole-library counts', async () => {
    const h = fixture(driver); const { source } = await seed(h);
    await h.repository.putCaptureAsset({ userId: h.actor.userId, sessionId: 's', assetId: 'a', mimeType: 'image/png', sha256: 'a'.repeat(64), bytes: new Uint8Array([1, 2, 3]) });
    await h.repository.updateRawSourceProcessing(source.id, h.actor.userId, 'done');
    await h.core.reviewSource(source.id, { actionId: 'reject', expectedRevision: 0, action: 'reject' }, h.actor);
    expect((await h.repository.getCaptureAsset(h.actor.userId, 's', 'a'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((await h.core.readRawSource(source.id, h.actor))?.rawText).toBe('  original bytes\n背景。  ');
    const inbox = await h.core.listInbox({ reviewStatus: 'rejected', status: 'done', limit: 1 }, h.actor);
    expect(inbox.entries).toMatchObject([{ id: source.id, reviewStatus: 'rejected', reviewRevision: 1 }]);
    expect(inbox.counts).toEqual({ pending: 0, processing: 0, done: 1, failed: 0 });
    expect(inbox.reviewCounts).toEqual({ needs_review: 0, confirmed: 0, deferred: 0, rejected: 1 });
    expect((await h.core.listInbox({ reviewStatus: 'needs_review' }, h.actor)).entries).toEqual([]);
    await expect(h.core.reviewSource(source.id, { actionId: 'wrong-transition', expectedRevision: 1, action: 'defer' }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
    const restore = { actionId: 'restore', expectedRevision: 1, action: 'restore' as const };
    expect(await h.core.reviewSource(source.id, restore, h.actor)).toMatchObject({ reviewStatus: 'needs_review', reviewRevision: 2 });
    expect(await h.core.reviewSource(source.id, restore, h.actor)).toMatchObject({ duplicate: true, reviewRevision: 2 });
    expect(await h.core.reviewSource(source.id, { actionId: 'reject', expectedRevision: 0, action: 'reject' }, h.actor)).toMatchObject({ duplicate: true, reviewStatus: 'rejected', reviewRevision: 1 });
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewStatus: 'needs_review', reviewRevision: 2 });
    await expect(h.core.reviewSource(source.id, { actionId: 'stale', expectedRevision: 0, action: 'defer' }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows only one concurrent revision and hides all foreign actions and targets', async () => {
    const h = fixture(driver); const { source, node } = await seed(h);
    const raced = await Promise.allSettled(['a', 'b'].map(actionId => h.core.reviewSource(source.id, { actionId, expectedRevision: 0, action: 'defer' }, h.actor)));
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await expect(h.core.reviewSource(source.id, { actionId: 'a', expectedRevision: 0, action: 'defer' }, { userId: 'foreign', actor: 'test' })).rejects.toMatchObject({ code: 'not_found' });
    const other = await h.repository.createRawSource({ userId: 'foreign', rawText: 'private', sourceType: 'manual', capturedAt: '2026-11-02' });
    await expect(h.core.reviewSource(other.id, { actionId: 'a', expectedRevision: 0, action: 'confirm', nodeId: node.id }, h.actor)).rejects.toMatchObject({ code: 'not_found' });
    const foreignNode = await h.repository.createNode({ userId: 'foreign', title: 'private target' });
    const ownSource = (await seed(h)).source;
    await expect(h.core.reviewSource(ownSource.id, { actionId: 'foreign-target', expectedRevision: 0, action: 'confirm', nodeId: foreignNode.id }, h.actor)).rejects.toMatchObject({ code: 'not_found' });
    await h.repository.updateNode({ id: node.id, userId: h.actor.userId, status: 'archived' });
    const fresh = await seed(h);
    await expect(h.core.reviewSource(fresh.source.id, { actionId: 'archived', expectedRevision: 0, action: 'confirm', nodeId: node.id }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
    expect(await h.repository.listKnowledgeItemsForSource(fresh.source.id, h.actor.userId)).toHaveLength(0);
  });
  it('does not duplicate existing source text whose stored boundaries contain Unicode whitespace', async () => {
    const h = fixture(driver); const { source, node } = await seed(h);
    const existing = await h.repository.createKnowledgeItem({ userId: h.actor.userId, rawSourceId: source.id, normalizedText: '\u3000human excerpt\u3000', confidence: 1, isAiDerived: false });
    await h.repository.linkItemToNode({ userId: h.actor.userId, itemId: existing.id, nodeId: node.id, relationType: 'primary', confidence: 1 });
    await expect(h.core.reviewSource(source.id, { actionId: 'duplicate', expectedRevision: 0, action: 'confirm', nodeId: node.id, editedText: 'human excerpt' }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
    expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewStatus: 'needs_review', reviewRevision: 0 });
  });
  it.each(['first confirm', 'action replay'])('caps stored text for a snippet-limited mutate grant on %s without truncating the saved action', async (attempt) => {
    const h = fixture(driver); const { node } = await seed(h);
    const rawText = 'A private source whose complete tail is TAIL_SENTINEL_' + 'original bytes '.repeat(12) + 'END';
    const source = await h.repository.createRawSource({ userId: h.actor.userId, rawText, sourceType: 'manual', capturedAt: '2026-11-02' });
    const request = { actionId: 'capped-review', expectedRevision: 0, action: 'confirm' as const, nodeId: node.id };
    const handle = (snippetChars: number | null) => createRequestHandler({ core: h.core, config: h.config, identityResolver: async () => ({ userId: h.actor.userId, actor: 'synthetic', via: 'grant', grant: { id: 'review-grant', label: 'synthetic', client: 'api', scopes: ['mutate'], secretHash: 'unused', nodeIds: null, snippetChars, createdAt: '2026', revokedAt: null } }) });
    const send = async (snippetChars: number | null) => {
      const response = await handle(snippetChars)(new Request(`http://core.local/api/inbox/${source.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
      expect(response.status).toBe(200);
      return reviewSourceResponseSchema.parse(await response.json());
    };
    if (attempt === 'action replay') await send(null);
    const narrow = await send(24);
    expect(narrow.duplicate).toBe(attempt === 'action replay');
    expect(narrow.item?.normalizedText.length).toBeLessThanOrEqual(24);
    expect(narrow.item?.normalizedText.endsWith('…')).toBe(true);
    expect(narrow.item?.normalizedText).not.toContain('TAIL_SENTINEL');
    expect(narrow.item?.summary).toBeNull();
    const narrowReplay = await send(24);
    expect(narrowReplay).toEqual({ ...narrow, duplicate: true });
    const wide = await send(null);
    expect(wide.item?.normalizedText).toBe(rawText);
    expect(wide.item?.id).toBe(narrow.item?.id);
    expect((await h.repository.reviewSource(source.id, h.actor.userId, request)).item?.normalizedText).toBe(rawText);
    expect((await h.repository.findRawSource(source.id, h.actor.userId))?.rawText).toBe(rawText);
    expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
  });
  it('keeps legacy assign working and reports explicit confirmation', async () => {
    const h = fixture(driver); const { source, node } = await seed(h);
    const assigned = await h.core.assignSource(source.id, { nodeId: node.id, text: 'legacy edit' }, h.actor);
    expect(assigned.item.normalizedText).toBe('legacy edit');
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewStatus: 'confirmed' });
    await expect(h.core.assignSource(source.id, { nodeId: node.id, text: 'legacy edit' }, h.actor)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('review HTTP and durable SQLite transaction', () => {
  it('validates actions before mutation and registers the review endpoint', async () => {
    const h = fixture('memory'); const { source } = await seed(h);
    const handle = createRequestHandler({ core: h.core, config: h.config });
    const send = (body: unknown) => handle(new Request(`http://core.local/api/inbox/${source.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    for (const body of [ { actionId: '', expectedRevision: 0, action: 'defer' }, { actionId: 'x', action: 'defer' }, { actionId: 'x', expectedRevision: 0, action: 'confirm' }, { actionId: 'x', expectedRevision: 0, action: 'reject', editedText: 'x' } ]) expect((await send(body)).status).toBe(400);
    const response = await send({ actionId: 'valid', expectedRevision: 0, action: 'defer' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reviewStatus: 'deferred', reviewRevision: 1, duplicate: false });
  });
  it('enforces mutate scope and target access on the review route', async () => {
    const h = fixture('memory'); const { source, node } = await seed(h);
    const grant: { -readonly [K in keyof ClientGrant]: ClientGrant[K] } = { id: 'test-grant', label: 'synthetic', client: 'api', scopes: ['read'], secretHash: 'unused', nodeIds: null as string[] | null, snippetChars: null, createdAt: '2026', revokedAt: null };
    const handle = createRequestHandler({ core: h.core, config: h.config, identityResolver: async () => ({ userId: h.actor.userId, actor: 'synthetic', via: 'grant', grant }) });
    const send = (action: unknown) => handle(new Request(`http://core.local/api/inbox/${source.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }));
    const request = { actionId: 'protected', expectedRevision: 0, action: 'confirm', nodeId: node.id };
    expect((await send(request)).status).toBe(401);
    grant.scopes = ['mutate']; grant.nodeIds = ['outside-target'];
    expect((await send(request)).status).toBe(401);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewRevision: 0 });
    grant.nodeIds = [node.id];
    expect((await send(request)).status).toBe(200);
  });
  it('rolls back item, link, review and action when each SQL write fails; retry makes one item', async () => {
    const h = fixture('sqlite'); const { source, node } = await seed(h);
    const db = new DatabaseSync(h.file);
    const request = { actionId: 'atomic', expectedRevision: 0, action: 'confirm' as const, nodeId: node.id };
    for (const [table, operation] of [['knowledge_items', 'insert'], ['item_node_links', 'insert'], ['raw_sources', 'update'], ['source_review_actions', 'insert']]) {
      db.exec(`create trigger fail_review before ${operation} on ${table} begin select raise(abort, 'synthetic review fault'); end`);
      await expect(h.core.reviewSource(source.id, request, h.actor)).rejects.toMatchObject({ code: 'storage_error' });
      db.exec('drop trigger fail_review');
      expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toEqual([]);
      expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewStatus: 'needs_review', reviewRevision: 0 });
      expect(db.prepare('select count(*) as n from source_review_actions').get()).toMatchObject({ n: 0 });
    }
    db.close();
    const first = await h.core.reviewSource(source.id, request, h.actor);
    const original = h.store as SqliteRepository;
    stores.splice(stores.indexOf(original), 1);
    await original.close();
    const reopened = fixture('sqlite', h.file);
    expect(await reopened.core.reviewSource(source.id, request, reopened.actor)).toEqual({ ...first, duplicate: true });
    expect(await reopened.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
  });
  it('caps a persisted non-null action summary on replay while leaving its saved snapshot complete', async () => {
    const h = fixture('sqlite'); const { source, node } = await seed(h);
    const request = { actionId: 'summary-replay', expectedRevision: 0, action: 'confirm' as const, nodeId: node.id };
    const first = await h.core.reviewSource(source.id, request, h.actor);
    const summary = 'A historical action summary with PRIVATE_TAIL_' + 'detail '.repeat(20);
    // Historical/forward-compatible snapshots can contain a summary even though new manual confirms use null.
    const saved = { ...first, item: { ...first.item!, summary } };
    const db = new DatabaseSync(h.file);
    try {
      db.prepare('update source_review_actions set response_json = ? where user_id = ? and raw_source_id = ? and action_id = ?').run(JSON.stringify(saved), h.actor.userId, source.id, request.actionId);
      const narrow = await h.core.reviewSource(source.id, request, { ...h.actor, snippetChars: 24 });
      expect(narrow.item?.summary?.length).toBeLessThanOrEqual(24);
      expect(narrow.item?.summary?.endsWith('…')).toBe(true);
      expect(narrow.item?.summary).not.toContain('PRIVATE_TAIL');
      expect((await h.core.reviewSource(source.id, request, h.actor)).item?.summary).toBe(summary);
      expect(JSON.parse(String(db.prepare('select response_json from source_review_actions').get()?.response_json))).toEqual(saved);
    } finally { db.close(); }
  });
  it('serializes confirm across two SQLite connections and replays the winner without creating another item', async () => {
    const h = fixture('sqlite'); const { source, node } = await seed(h);
    const other = fixture('sqlite', h.file);
    const request = { actionId: 'same-action', expectedRevision: 0, action: 'confirm' as const, nodeId: node.id };
    const results = await Promise.all([h.core.reviewSource(source.id, request, h.actor), other.core.reviewSource(source.id, request, other.actor)]);
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect(results[0]?.item?.id).toBe(results[1]?.item?.id);
    expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
    await expect(other.core.reviewSource(source.id, { ...request, actionId: 'different-action' }, other.actor)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('leaves offline captures reviewable and automatically confirms only high confidence', async () => {
    const h = fixture('memory');
    const offline = createKnowledgeCore({ repository: h.repository, config: testConfig(), provider: createOfflineProvider(), logger: silentLogger });
    const result = await offline.capture(captureOf('offline source'), h.actor);
    expect(await offline.readRawSource(result.rawSourceId, h.actor)).toMatchObject({ processingStatus: 'pending', reviewStatus: 'needs_review', reviewRevision: 0 });
    for (const confidence of [0.99, 0.6, 0.2]) {
      const scripted = makeHarness({ script: { extract: () => ({ items: [{ text: 'source ' + confidence, confidence, suggestedTitle: 'Target' }] }), classify: () => ({ action: 'create', newNodeTitle: 'Target', confidence, reason: 'synthetic' }) } });
      const captured = await scripted.core.capture(captureOf('source ' + confidence), scripted.actor);
      expect(await scripted.core.readRawSource(captured.rawSourceId, scripted.actor)).toMatchObject({ reviewStatus: confidence === 0.99 ? 'confirmed' : 'needs_review' });
    }
  });
});
