import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { InMemoryRepository } from '../src/in-memory';
import { SqliteRepository } from '../src/sqlite';
import { inspectSqliteLineage, migrateSqlite, SQLITE_MIGRATIONS, SQLITE_SCHEMA_VERSION } from '../src/sqlite-schema';
const dirs: string[] = [];
const stores: SqliteRepository[] = [];
function file() { const dir = mkdtempSync(join(tmpdir(), 'image-snapshot-')); dirs.push(dir); return join(dir, 'synthetic.sqlite'); }
afterAll(async () => { for (const store of stores) await store.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC', 'base64'));
const result = { text: 'A clearly recognized synthetic text.', confidence: 0.99, blocks: [{ kind: 'paragraph' as const, text: 'A clearly recognized synthetic text.' }], uncertainRegions: [] };
for (const driver of ['memory', 'sqlite']) describe(`frozen recognition snapshot ${driver}`, () => {
  function repository() { if (driver === 'memory') return new InMemoryRepository(); const repo = new SqliteRepository({ file: file() }); stores.push(repo); return repo; }
  it('freezes inputs, saves each recognition once and rejects changed or foreign snapshots', async () => {
    const repo = repository();
    const source = await repo.createRawSource({ userId: 'owner', rawText: '', sourceType: 'manual', capturedAt: '2026' });
    const asset = (await repo.putCaptureAsset({ userId: 'owner', sessionId: 'session', assetId: 'original', mimeType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png })).asset;
    const { bytes, userId, ...ref } = asset;
    const input = { userId: 'owner', rawSourceId: source.id, inputFingerprint: 'a'.repeat(64), inputs: [ref] };
    const frozen = await repo.createCaptureRecognitionSnapshot(input);
    expect(frozen).toMatchObject({ version: 1, inputs: [{ assetId: 'original', sha256: asset.sha256 }], results: [] });
    expect(await repo.createCaptureRecognitionSnapshot(input)).toEqual(frozen);
    await expect(repo.createCaptureRecognitionSnapshot({ ...input, inputFingerprint: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    const entry = { assetId: 'original', providerId: 'synthetic', result };
    const saved = await repo.saveCaptureRecognitionResult('owner', source.id, entry);
    expect(saved.results).toHaveLength(1);
    expect(await repo.saveCaptureRecognitionResult('owner', source.id, entry)).toEqual(saved);
    await expect(repo.saveCaptureRecognitionResult('owner', source.id, { ...entry, result: { ...result, text: 'changed' } })).rejects.toMatchObject({ code: 'conflict' });
    expect(await repo.getCaptureRecognitionSnapshot('foreign', source.id)).toBeNull();
    await expect(repo.saveCaptureRecognitionResult('foreign', source.id, entry)).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.saveCaptureRecognitionResult('owner', source.id, { ...entry, assetId: 'unknown' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.findRawSource(source.id, 'owner'))?.rawText).toBe('');
  });
  it('claims one historical image item concurrently and recovers only interrupted work', async () => {
    const repo = repository();
    await repo.putCaptureAsset({ userId: 'owner', sessionId: 's', assetId: 'image', mimeType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png });
    await repo.createCaptureBatch({ userId: 'owner', batchId: 'b', sessionId: 's', payloadHash: 'c'.repeat(64), items: [{ requestId: 'image-request', userOrder: 0, kind: 'image', assetIds: ['image'], source: { type: 'manual' }, capture: { capturedAt: '2026', client: 'desktop' } }] });
    await expect(repo.claimCaptureBatchItemForRetry('foreign', 'b', 'image-request')).rejects.toMatchObject({ code: 'not_found' });
    expect(await repo.recoverInterruptedCaptureBatches()).toBe(0);
    const claims = await Promise.allSettled([repo.claimCaptureBatchItemForProcessing('owner', 'b', 'image-request'), repo.claimCaptureBatchItemForProcessing('owner', 'b', 'image-request')]);
    expect(claims.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(await repo.recoverInterruptedCaptureBatches()).toBe(1);
    expect((await repo.getCaptureBatch('owner', 'b'))?.items[0]).toMatchObject({ status: 'failed', retryable: true });
    await repo.claimCaptureBatchItemForProcessing('owner', 'b', 'image-request');
    expect((await repo.getCaptureBatch('owner', 'b'))?.items[0]).toMatchObject({ status: 'processing', retryable: false });
  });
});
describe('recognition migration12', () => {
  it('accepts historical11, rolls back an interrupted upgrade, then recognizes reopened12', async () => {
    const target = file(); const db = new DatabaseSync(target);
    try {
      for (const step of SQLITE_MIGRATIONS.filter(step => step.version <= 11)) step.apply(db);
      db.exec('pragma user_version = 11');
      expect(inspectSqliteLineage(db)).toMatchObject({ lineage: 'screenshot', userVersion: 11 });
      const before = db.prepare('select type, name, sql from sqlite_schema order by name').all();
      const exec = db.exec.bind(db);
      const spy = vi.spyOn(db, 'exec').mockImplementation(sql => { exec(sql); if (sql.includes('create table capture_image_recognition_snapshots')) throw new Error('synthetic migration fault'); });
      expect(() => migrateSqlite(db)).toThrow('synthetic migration fault');
      spy.mockRestore();
      expect(db.prepare('select type, name, sql from sqlite_schema order by name').all()).toEqual(before);
      expect(db.prepare('pragma user_version').get()).toEqual({ user_version: 11 });
      expect(migrateSqlite(db)).toBe(SQLITE_SCHEMA_VERSION);
      expect(inspectSqliteLineage(db)).toMatchObject({ lineage: 'screenshot', userVersion: SQLITE_SCHEMA_VERSION });
    } finally { db.close(); }
    const reopened = new SqliteRepository({ file: target }); stores.push(reopened);
    expect(reopened.storageStatus().schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
  });
});
