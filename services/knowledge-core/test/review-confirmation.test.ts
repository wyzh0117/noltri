import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rawSourceSchema, type ReviewSourceResponse } from '@noltri/schema';
import type { ClientGrant } from '../src/authorization';
import { createInMemoryRepository } from '@noltri/storage';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequestHandler } from '../src/http/router';
import { makeHarness } from './fakes';

const dirs: string[] = [];
const stores = new Set<SqliteRepository>();
function fixture(driver: string, file?: string) {
  if (file === undefined && driver === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'noltri-confirmation-')); dirs.push(dir); file = join(dir, 'test.sqlite');
  }
  const repository = driver === 'sqlite' ? new SqliteRepository({ file: file! }) : createInMemoryRepository();
  if (repository instanceof SqliteRepository) stores.add(repository);
  return { ...makeHarness({ repository }), file, store: repository };
}
afterAll(async () => {
  for (const store of stores) await store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
async function seed(h: ReturnType<typeof fixture>) {
  const source = await h.repository.createRawSource({ userId: h.actor.userId, rawText: 'immutable synthetic original', sourceType: 'manual', capturedAt: '2026-11-04' });
  const parent = await h.repository.createNode({ userId: h.actor.userId, title: 'Saved parent' });
  const node = await h.repository.createNode({ userId: h.actor.userId, title: 'Saved leaf', parentId: parent.id });
  return { source, node, parent };
}
async function confirm(h: ReturnType<typeof fixture>, sourceId: string, nodeId: string) {
  return h.core.reviewSource(sourceId, { actionId: 'manual-confirm', expectedRevision: 0, action: 'confirm', nodeId, editedText: 'human draft with FULL_SYNTHETIC_TAIL' }, h.actor);
}
function expected(sourceId: string, result: ReviewSourceResponse) {
  return { rawSourceId: sourceId, reviewRevision: result.reviewRevision, knowledgeItemId: result.item!.id,
    text: result.item!.normalizedText, targetNodeId: result.path!.at(-1)!.id, path: result.path };
}

for (const driver of ['memory', 'sqlite']) describe(`read-only review confirmation (${driver})`, () => {
  it('rehydrates the exact manual result after reopening, ignoring unrelated items and changed catalog titles', async () => {
    let h = fixture(driver); const { source, node, parent } = await seed(h);
    await h.repository.createKnowledgeItem({ userId: h.actor.userId, rawSourceId: source.id, normalizedText: 'first unrelated item', confidence: 1, isAiDerived: false });
    const saved = await confirm(h, source.id, node.id);
    await h.repository.createKnowledgeItem({ userId: h.actor.userId, rawSourceId: source.id, normalizedText: 'later automatic item', confidence: 1, isAiDerived: true });
    await h.repository.updateNode({ id: parent.id, userId: h.actor.userId, title: 'Renamed catalog parent' });
    const mutation = vi.spyOn(h.repository, 'reviewSource');
    mutation.mockClear();
    if (h.store instanceof SqliteRepository) {
      const original = h.store; await original.close(); stores.delete(original);
      h = fixture(driver, h.file);
    }
    const result = await h.core.readRawSource(source.id, h.actor);
    expect(result).toMatchObject({ rawText: source.rawText, reviewStatus: 'confirmed', reviewRevision: 1, reviewConfirmation: expected(source.id, saved) });
    expect(mutation).not.toHaveBeenCalled();
    expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(3);
    expect(await h.core.readRawSource(source.id, { ...h.actor, userId: 'foreign' })).toBeNull();
  });

  it('does not fabricate a human result for pending, deferred or legacy automatic confirmations', async () => {
    const h = fixture(driver); const { source } = await seed(h);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewConfirmation: null });
    await h.core.reviewSource(source.id, { actionId: 'defer', expectedRevision: 0, action: 'defer' }, h.actor);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewConfirmation: null });
    const automatic = (await seed(h)).source;
    await h.repository.markRawSourceConfirmed(automatic.id, h.actor.userId);
    expect(await h.core.readRawSource(automatic.id, h.actor)).toMatchObject({ reviewStatus: 'confirmed', reviewConfirmation: null });
  });

  it('keeps GET read-scoped and caps the added text without changing the durable snapshot', async () => {
    const h = fixture(driver); const { source, node } = await seed(h);
    const saved = await confirm(h, source.id, node.id);
    const grant: ClientGrant = { id: 'read-confirmation', label: 'synthetic', client: 'api', scopes: ['read'],
      secretHash: 'unused', nodeIds: null, snippetChars: 12, createdAt: '2026', revokedAt: null };
    const read = (current: ClientGrant) => createRequestHandler({ core: h.core, config: h.config,
      identityResolver: async () => ({ userId: h.actor.userId, actor: 'synthetic', via: 'grant', grant: current }) })(new Request(`http://core.local/api/inbox/${source.id}`));
    const result = await read(grant);
    expect(result.status).toBe(200);
    const narrow = rawSourceSchema.parse(await result.json());
    expect(narrow.reviewConfirmation).toMatchObject({ knowledgeItemId: saved.item!.id, path: saved.path });
    expect(narrow.reviewConfirmation?.text).toHaveLength(12);
    expect(narrow.reviewConfirmation?.text.endsWith('…')).toBe(true);
    expect(narrow.reviewConfirmation?.text).not.toContain('FULL_SYNTHETIC_TAIL');
    expect((await read({ ...grant, nodeIds: [node.id] })).status).toBe(401);
    expect((await read({ ...grant, scopes: ['mutate'] })).status).toBe(401);
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewConfirmation: expected(source.id, saved) });
    // Mutating returned DTOs cannot edit the stored action or its source revision.
    const wide = await h.core.readRawSource(source.id, h.actor);
    if (wide?.reviewConfirmation) { wide.reviewConfirmation.text = 'caller changed'; wide.reviewConfirmation.path[0]!.title = 'caller changed'; }
    expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ rawText: source.rawText, reviewRevision: 1, reviewConfirmation: expected(source.id, saved) });
  });
});

describe('SQLite review audit read safety', () => {
  it('never writes, replays, or truncates saved actions while reading the projection', async () => {
    const h = fixture('sqlite'); const { source, node } = await seed(h); const saved = await confirm(h, source.id, node.id);
    const db = new DatabaseSync(h.file!);
    try {
      const before = db.prepare('select * from source_review_actions').all();
      for (const table of ['raw_sources', 'knowledge_items', 'item_node_links', 'source_review_actions']) {
        for (const operation of ['insert', 'update', 'delete']) db.exec(`create trigger no_${operation}_${table} before ${operation} on ${table} begin select raise(abort, 'unexpected GET write'); end`);
      }
      expect(await h.core.readRawSource(source.id, { ...h.actor, snippetChars: 9 })).toMatchObject({ reviewConfirmation: { text: 'human dr…' } });
      expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewConfirmation: expected(source.id, saved) });
      expect(db.prepare('select * from source_review_actions').all()).toEqual(before);
    } finally { db.close(); }
  });

  it.each(['bad-json', 'wrong-user', 'wrong-source', 'wrong-revision', 'ai-item', 'empty-path', 'non-confirm-intent', 'wrong-intent-revision', 'wrong-intent-target', 'ambiguous'])('fails closed for %s rather than guessing from knowledge items', async fault => {
    const h = fixture('sqlite'); const { source, node } = await seed(h); const saved = await confirm(h, source.id, node.id);
    const db = new DatabaseSync(h.file!);
    try {
      const response = structuredClone(saved);
      let intent = JSON.stringify(['confirm', 0, node.id, 'human draft with FULL_SYNTHETIC_TAIL']);
      if (fault === 'wrong-user') response.item!.userId = 'foreign';
      if (fault === 'wrong-source') response.item!.rawSourceId = 'foreign-source';
      if (fault === 'wrong-revision') response.reviewRevision = 2;
      if (fault === 'ai-item') response.item!.isAiDerived = true;
      if (fault === 'empty-path') response.path = [];
      if (fault === 'non-confirm-intent') intent = JSON.stringify(['defer', 0, null, null]);
      if (fault === 'wrong-intent-revision') intent = JSON.stringify(['confirm', 1, node.id, null]);
      if (fault === 'wrong-intent-target') intent = JSON.stringify(['confirm', 0, 'foreign-target', null]);
      db.prepare('update source_review_actions set response_json = ?, intent_json = ?').run(fault === 'bad-json' ? '{' : JSON.stringify(response), intent);
      if (fault === 'ambiguous') db.prepare('insert into source_review_actions select user_id, raw_source_id, ?, intent_json, response_json, created_at from source_review_actions').run('other-action');
      expect(await h.core.readRawSource(source.id, h.actor)).toMatchObject({ reviewStatus: 'confirmed', reviewRevision: 1, reviewConfirmation: null });
      expect(await h.repository.listKnowledgeItemsForSource(source.id, h.actor.userId)).toHaveLength(1);
    } finally { db.close(); }
  });
});
