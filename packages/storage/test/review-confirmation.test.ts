import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewSourceResponse } from '@noltri/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { createInMemoryRepository } from '../src/in-memory';
import { SqliteRepository } from '../src/sqlite';
import { reviewConfirmationOf } from '../src/review';

const dirs: string[] = [];
const stores = new Set<SqliteRepository>();
afterAll(async () => {
  for (const store of stores) await store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
for (const driver of ['memory', 'sqlite']) describe(`confirmation repository (${driver})`, () => {
  it('reads only the owned current revision through an earlier defer/restore history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noltri-confirmation-repo-')); dirs.push(dir);
    const file = join(dir, 'test.sqlite');
    let repository = driver === 'memory' ? createInMemoryRepository() : new SqliteRepository({ file });
    if (repository instanceof SqliteRepository) stores.add(repository);
    const source = await repository.createRawSource({ userId: 'owner', rawText: 'original', sourceType: 'manual', capturedAt: '2026' });
    const node = await repository.createNode({ userId: 'owner', title: 'Saved destination' });
    await repository.reviewSource(source.id, 'owner', { actionId: 'defer', expectedRevision: 0, action: 'defer' });
    await repository.reviewSource(source.id, 'owner', { actionId: 'restore', expectedRevision: 1, action: 'restore' });
    const saved = await repository.reviewSource(source.id, 'owner', { actionId: 'confirm', expectedRevision: 2, action: 'confirm', nodeId: node.id, editedText: 'human result' });
    if (repository instanceof SqliteRepository) {
      await repository.close(); stores.delete(repository);
      const reopened = new SqliteRepository({ file }); stores.add(reopened); repository = reopened;
    }
    const expected = { rawSourceId: source.id, reviewRevision: 3, knowledgeItemId: saved.item!.id,
      text: 'human result', targetNodeId: node.id, path: saved.path };
    expect(await repository.readReviewConfirmation(source.id, 'owner', 3)).toEqual(expected);
    expect(await repository.readReviewConfirmation(source.id, 'foreign', 3)).toBeNull();
    expect(await repository.readReviewConfirmation(source.id, 'owner', 1)).toBeNull();
    expect(await repository.readReviewConfirmation(source.id, 'owner', 4)).toBeNull();
    expect(await repository.readReviewConfirmation('missing', 'owner', 3)).toBeNull();
    const returned = await repository.readReviewConfirmation(source.id, 'owner', 3);
    returned!.path[0]!.title = 'caller changed';
    expect(await repository.readReviewConfirmation(source.id, 'owner', 3)).toEqual(expected);
  });
});

const response: ReviewSourceResponse = { reviewStatus: 'confirmed', reviewRevision: 1, duplicate: false,
  item: { id: 'item', userId: 'owner', rawSourceId: 'source', normalizedText: 'human', summary: null, confidence: 1,
    status: 'active', isAiDerived: false, createdAt: '2026', updatedAt: '2026' },
  path: [{ id: 'parent', title: 'Saved parent' }, { id: 'leaf', title: 'Saved leaf' }] };
const action = { fingerprint: JSON.stringify(['confirm', 0, 'leaf', '  human  ']), response };
const read = (actions: Parameters<typeof reviewConfirmationOf>[3]) => reviewConfirmationOf('source', 'owner', 1, actions);

describe('confirmation audit validation shared by both drivers', () => {
  it('accepts serialized SQLite and object memory records, returning fresh nested objects', () => {
    expect(read([action])).toEqual(read([{ ...action, response: JSON.stringify(response) }]));
    const result = read([action]); result!.path[0]!.title = 'changed';
    expect(response.path![0]!.title).toBe('Saved parent');
    expect(read([{ ...action, fingerprint: JSON.stringify(['confirm', 0, 'leaf', null]) }])?.text).toBe('human');
  });
  it.each([
    ['empty history', []],
    ['bad JSON response', [{ ...action, response: '{' }]],
    ['bad JSON intent', [{ ...action, fingerprint: '{' }]],
    ['invalid response schema', [{ ...action, response: { ...response, duplicate: undefined } }]],
    ['foreign owner', [{ ...action, response: { ...response, item: { ...response.item, userId: 'foreign' } } }]],
    ['foreign source', [{ ...action, response: { ...response, item: { ...response.item, rawSourceId: 'foreign' } } }]],
    ['nonmanual result', [{ ...action, response: { ...response, item: { ...response.item, isAiDerived: true } } }]],
    ['missing item', [{ ...action, response: { ...response, item: undefined } }]],
    ['empty path', [{ ...action, response: { ...response, path: [] } }]],
    ['cyclic path', [{ ...action, response: { ...response, path: [{ id: 'leaf', title: 'a' }, { id: 'leaf', title: 'b' }] } }]],
    ['wrong intent target', [{ ...action, fingerprint: JSON.stringify(['confirm', 0, 'other', 'human']) }]],
    ['wrong intent revision', [{ ...action, fingerprint: JSON.stringify(['confirm', 1, 'leaf', 'human']) }]],
    ['changed human text', [{ ...action, fingerprint: JSON.stringify(['confirm', 0, 'leaf', 'other human text']) }]],
    ['non-confirm action', [{ ...action, fingerprint: JSON.stringify(['defer', 0, null, null]) }]],
    ['ambiguous result', [action, structuredClone(action)]],
  ])('fails closed for %s', (_label, actions) => {
    expect(read(actions)).toBeNull();
  });
});
