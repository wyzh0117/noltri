import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@noltri/storage';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { createOfflineProvider, type ImageRecognitionResult, type RecognizeImageInput } from '@noltri/ai-provider';
import { captureBatchStatusSchema, captureRecognitionResponseSchema, type CaptureBatchRequest } from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createKnowledgeCore } from '../src/core';
import { createRequestHandler } from '../src/http/router';
import { ScriptedProvider, testConfig } from './fakes';
const pngs = ['iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGNgYPj/H4KhDAA/0gf5tBJPzQAAAABJRU5ErkJggg==', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVR4nGNg+A+FMAYAQ84H+fei4u8AAAAASUVORK5CYII='].map(value => Uint8Array.from(Buffer.from(value, 'base64')));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clear: ImageRecognitionResult = { text: 'Recognition is derived content, never the immutable original.', confidence: 0.99, blocks: [{ kind: 'paragraph', text: 'Recognition is derived content, never the immutable original.' }], uncertainRegions: [] };
class ImageProvider extends ScriptedProvider {
  override readonly capabilities = { embeddings: false, chat: true, structuredOutput: true, imageRecognition: true };
  readonly images: RecognizeImageInput[] = [];
  result = clear;
  beforeRecognition?: () => Promise<void>;
  recognitionFailure = false;
  constructor() { super([], { extract: input => ({ items: [{ text: input.text, confidence: 0.99, suggestedTitle: 'Image topic' }] }), classify: () => ({ action: 'create', newNodeTitle: 'Image topic', confidence: 0.99, reason: 'synthetic' }) }); }
  async recognizeImage(input: RecognizeImageInput): Promise<ImageRecognitionResult> {
    this.images.push({ ...input, bytes: Uint8Array.from(input.bytes) });
    await this.beforeRecognition?.();
    if (this.recognitionFailure) throw new Error('synthetic recognition failure');
    return structuredClone(this.result);
  }
}
const stores: SqliteRepository[] = []; const dirs: string[] = [];
function newFile() { const dir = mkdtempSync(join(tmpdir(), 'image-core-')); dirs.push(dir); return join(dir, 'synthetic.sqlite'); }
afterAll(async () => { for (const store of stores) await store.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture(driver: string, file = newFile()) {
  const repository = driver === 'sqlite' ? new SqliteRepository({ file }) : new InMemoryRepository();
  if (repository instanceof SqliteRepository) stores.push(repository);
  const provider = new ImageProvider(); const config = testConfig({ embeddingEnabled: false });
  const core = createKnowledgeCore({ repository, provider, config, logger: silentLogger });
  const actor = { userId: config.devUser, actor: 'synthetic' };
  return { repository, provider, config, core, actor, file };
}
function item(requestId = 'image-request', userOrder = 0): CaptureBatchRequest['items'][number] {
 return { requestId, userOrder, kind: 'image', text: '注', assetIds: ['original'], source: { type: 'desktop_app' }, capture: { capturedAt: '2026-11-02', client: 'desktop', deviceId: 'synthetic-device' }, library: { kind: 'image' } };
}
function batch(items = [item()]): CaptureBatchRequest { return { batchId: 'image-batch', sessionId: 'image-session', items }; }
async function assets(h: ReturnType<typeof fixture>) {
 for (const [index, assetId] of ['original', 'edited', 'stitched', 'other'].entries()) await h.repository.putCaptureAsset({ userId: h.actor.userId, sessionId: 'image-session', assetId, mimeType: 'image/png', sha256: sha(pngs[index % 3]!), bytes: pngs[index % 3]! });
}
function handler(h: ReturnType<typeof fixture>, options: { snippetChars?: number; scopes?: ('read' | 'mutate' | 'capture')[]; nodeIds?: string[]; userId?: string } = {}) {
 return createRequestHandler({ core: h.core, config: h.config, identityResolver: async () => ({ userId: options.userId ?? h.actor.userId, actor: 'synthetic', via: 'grant', grant: { id: 'test-grant', label: 'synthetic', client: 'api', scopes: options.scopes ?? ['read', 'mutate', 'capture'], secretHash: 'unused', nodeIds: options.nodeIds ?? null, snippetChars: options.snippetChars ?? null, createdAt: '2026', revokedAt: null } }) });
}
async function send(h: ReturnType<typeof fixture>, path: string, body?: unknown, options: Parameters<typeof handler>[1] = {}) {
 const response = await handler(h, options)(new Request('http://core.local' + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }));
 return { status: response.status, body: await response.json() as any };
}
async function historical(h: ReturnType<typeof fixture>, input = batch()) {
 await assets(h); return h.repository.createCaptureBatch({ ...input, userId: h.actor.userId, payloadHash: 'a'.repeat(64) });
}
const processPath = '/api/capture/batches/image-batch/process';
for (const driver of ['memory', 'sqlite']) describe(`source-first image processing ${driver}`, () => {
 it('persists source, exact provenance and frozen input before provider; replays without OCR or duplicate knowledge', async () => {
  const h = fixture(driver); await assets(h);
  h.provider.beforeRecognition = async () => {
   const sources = await h.repository.listInbox({ userId: h.actor.userId });
   expect(sources).toHaveLength(1);
   expect(sources[0]).toMatchObject({ rawText: '注', metadata: { capture: { kind: 'image', batchId: 'image-batch', assetRefs: [{ assetId: 'original', sha256: sha(pngs[0]!) }] } } });
   expect((await h.repository.getCaptureBatch(h.actor.userId, 'image-batch'))?.items[0]?.rawSourceId).toBe(sources[0]!.id);
   expect((await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, sources[0]!.id))?.inputs[0]?.assetId).toBe('original');
  };
  const first = await send(h, '/api/capture/batches', batch()); expect(first.status).toBe(200);
  const current = captureBatchStatusSchema.parse(first.body.batch); expect(current.items[0]?.status).toBe('done');
  const sourceId = current.items[0]!.rawSourceId!;
  expect(h.provider.images[0]?.bytes).toEqual(pngs[0]);
  expect((await h.repository.findRawSource(sourceId, h.actor.userId))).toMatchObject({ rawText: '注', reviewStatus: 'confirmed', processingStatus: 'done' });
  expect(h.provider.extractInputs[0]?.text).toContain(clear.text);
  expect((await send(h, '/api/capture/batches', batch())).body.duplicate).toBe(true);
  expect((await send(h, processPath, {})).status).toBe(200);
  expect(h.provider.images).toHaveLength(1); expect(h.provider.extractInputs).toHaveLength(1);
  expect(await h.repository.listKnowledgeItemsForSource(sourceId, h.actor.userId)).toHaveLength(1);
  const dto = captureRecognitionResponseSchema.parse((await send(h, `/api/inbox/${sourceId}/recognition`)).body);
  expect(dto.processingText).toContain(clear.text); expect(dto.snapshot?.results[0]?.result.text).toBe(clear.text);
  expect(dto.provenance.assetRefs[0]?.sha256).toBe(sha(pngs[0]!));
 });
 it('processes historical images, freezes OCR across extraction failure and retries without another source or manual item', async () => {
  const h = fixture(driver); await historical(h); h.provider.fail.add('extract');
  const failed = await send(h, processPath, {}); expect(failed.status).toBe(200);
  const failedItem = captureBatchStatusSchema.parse(failed.body).items[0]!;
  expect(failedItem).toMatchObject({ status: 'failed', retryable: true });
  expect((await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, failedItem.rawSourceId!))?.results).toHaveLength(1);
  h.provider.fail.delete('extract');
  const retried = await send(h, '/api/capture/batches/image-batch/items/image-request/retry', {});
  expect(retried.status).toBe(200); expect(retried.body.items[0].status).toBe('done');
  expect(h.provider.images).toHaveLength(1);
  expect(await h.repository.listInbox({ userId: h.actor.userId })).toHaveLength(1);
  expect(await h.repository.listKnowledgeItemsForSource(failedItem.rawSourceId!, h.actor.userId)).toHaveLength(1);
 });
 it('preserves originals on recognition failure and reuses the same source on a later success', async () => {
  const h = fixture(driver); await historical(h); h.provider.recognitionFailure = true;
  const failed = await send(h, processPath, {}); expect(failed.body.items[0]).toMatchObject({ status: 'failed', retryable: true });
  const id = failed.body.items[0].rawSourceId;
  expect((await h.repository.findRawSource(id, h.actor.userId))?.rawText).toBe('注');
  h.provider.recognitionFailure = false;
  const retried = await send(h, '/api/capture/batches/image-batch/items/image-request/retry', {});
  expect(retried.body.items[0]).toMatchObject({ status: 'done', rawSourceId: id });
  expect((await h.repository.getCaptureAsset(h.actor.userId, 'image-session', 'original'))?.bytes).toEqual(pngs[0]);
 });
 it.each(['unsupported', 'offline'])('leaves %s images explicitly pending with a stable source', async mode => {
  const h = fixture(driver); await historical(h);
  if (mode === 'offline') h.core = createKnowledgeCore({ repository: h.repository, config: h.config, provider: createOfflineProvider(), logger: silentLogger });
  else h.provider.capabilities.imageRecognition = false;
  const response = await send(h, processPath, {}); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ status: 'assets_saved', processingReason: mode, retryable: false });
  const source = await h.repository.findRawSource(response.body.items[0].rawSourceId, h.actor.userId);
  expect(source).toMatchObject({ processingStatus: 'pending', reviewStatus: 'needs_review', rawText: '注' });
  expect(h.provider.images).toHaveLength(0); expect(h.provider.extractInputs).toHaveLength(0);
 });
 it.each(['uncertain_region', 'low_confidence', 'short', 'empty'])('freezes %s output for review without auto-extraction', async mode => {
  const h = fixture(driver); await historical(h);
  h.provider.result = { ...clear, ...(mode === 'short' || mode === 'empty' ? { text: mode === 'empty' ? '' : 'x' } : mode === 'low_confidence' ? { confidence: 0.4 } : { uncertainRegions: [{ reason: 'uncertain source region', text: 'partial' }] }) };
  const response = await send(h, processPath, {}); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ status: 'needs_review', retryable: false });
  const id = response.body.items[0].rawSourceId;
  expect((await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id))?.results).toHaveLength(1);
  expect((await h.repository.findRawSource(id, h.actor.userId))?.reviewStatus).toBe('needs_review');
  await send(h, processPath, {}); await h.core.retryCapture(id, h.actor);
  expect(h.provider.images).toHaveLength(1); expect(h.provider.extractInputs).toHaveLength(0);
 });
 it.each(['rotate', 'annotate'])('uses one edited representation (%s), ignores a cross-item stitch, and selects an unambiguous whole composite once', async mode => {
  const h = fixture(driver); const image = item();
  image.assetIds = ['original', 'edited', 'stitched']; image.derivedAssets = [mode === 'rotate' ? { assetId: 'edited', operation: 'rotate', sourceAssetIds: ['original'], rotationDegrees: 90 } : { assetId: 'edited', operation: 'annotate', sourceAssetIds: ['original'], annotations: [{ type: 'pixelate', x1: 0, y1: 0, x2: 1, y2: 1, color: '#000000', strokeWidth: 2 }] }, { assetId: 'stitched', operation: 'stitch', sourceAssetIds: ['original', 'other'], direction: 'vertical' }];
  await historical(h, batch([image])); const result = await send(h, processPath, {});
  expect(result.body.items[0].status).toBe('done'); expect(h.provider.images).toHaveLength(1); expect(h.provider.images[0]?.bytes).toEqual(pngs[1]);
  const composite = fixture(driver); const combined = { ...item(), kind: 'composite' as const, assetIds: ['original', 'edited', 'stitched'], derivedAssets: [{ assetId: 'stitched', operation: 'stitch' as const, sourceAssetIds: ['original', 'edited'], direction: 'vertical' as const }] };
  await historical(composite, batch([combined])); expect((await send(composite, processPath, {})).body.items[0].status).toBe('done'); expect(composite.provider.images).toHaveLength(1); expect(composite.provider.images[0]?.bytes).toEqual(pngs[2]);
 });
 it('keeps an image-only source truly empty and completes accepted work despite a request abort', async () => {
  const h = fixture(driver); const original = item(); delete original.text; await historical(h, batch([original]));
  let release!: () => void; let entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  h.provider.beforeRecognition = async () => { entered(); await gate; };
  const controller = new AbortController();
  const request = new Request('http://core.local' + processPath, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: '{}' });
  const work = handler(h)(request); await started; controller.abort(); release();
  const response = await work; expect(response.status).toBe(200); const saved = captureBatchStatusSchema.parse(await response.json()).items[0]!;
  expect(saved.status).toBe('done');
  expect(await h.repository.findRawSource(saved.rawSourceId!, h.actor.userId)).toMatchObject({ rawText: '', metadata: { capture: { originalTextPresent: false } } });
  expect(await h.repository.listKnowledgeItemsForSource(saved.rawSourceId!, h.actor.userId)).toHaveLength(1);
 });
 it('reports offline pending even when OCR is already frozen and extraction previously failed', async () => {
  const h = fixture(driver); await historical(h); h.provider.fail.add('extract');
  const failed = await send(h, processPath, {}); const id = failed.body.items[0].rawSourceId;
  h.core = createKnowledgeCore({ repository: h.repository, config: h.config, provider: createOfflineProvider(), logger: silentLogger });
  const response = await send(h, '/api/capture/batches/image-batch/items/image-request/retry', {});
  expect(response.body.items[0]).toMatchObject({ status: 'assets_saved', processingReason: 'offline', rawSourceId: id, retryable: false });
  expect((await h.repository.findRawSource(id, h.actor.userId))?.processingStatus).toBe('pending');
  expect(h.provider.images).toHaveLength(1);
 });
 it.each([
  ['core', 'needs_review'], ['http', 'needs_review'], ['core', 'deferred'], ['http', 'rejected'],
 ] as const)('persists offline pending through generic %s retry while retaining %s review and frozen image data', async (entrypoint, reviewStatus) => {
  const h = fixture(driver); await historical(h); h.provider.fail.add('extract');
  const failed = await send(h, processPath, {}); const id = failed.body.items[0].rawSourceId;
  expect(failed.body.items[0].status).toBe('failed');
  if (reviewStatus !== 'needs_review') await h.core.reviewSource(id, { actionId: 'human-review-before-offline', expectedRevision: 0, action: reviewStatus === 'deferred' ? 'defer' : 'reject' }, h.actor);
  const before = (await h.repository.findRawSource(id, h.actor.userId))!;
  const snapshot = await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id);
  const original = await h.repository.getCaptureAsset(h.actor.userId, 'image-session', 'original');
  expect(snapshot?.results).toHaveLength(1); expect(before.processingStatus).toBe('failed');
  h.core = createKnowledgeCore({ repository: h.repository, config: h.config, provider: createOfflineProvider(), logger: silentLogger });
  const retry = async () => {
   if (entrypoint === 'core') return h.core.retryCapture(id, h.actor);
   const response = await send(h, `/api/capture/${id}/retry`, {}); expect(response.status).toBe(200); return response.body;
  };
  expect(await retry()).toMatchObject({ rawSourceId: id, stage: 'saved', processingStatus: 'pending' });
  const after = (await h.repository.findRawSource(id, h.actor.userId))!;
  expect(after).toMatchObject({ processingStatus: 'pending', errorReason: null, reviewStatus, reviewRevision: before.reviewRevision, rawText: before.rawText, metadata: before.metadata });
  expect(await retry()).toMatchObject({ rawSourceId: id, processingStatus: 'pending' });
  expect(await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id)).toEqual(snapshot);
  expect(await h.repository.getCaptureAsset(h.actor.userId, 'image-session', 'original')).toEqual(original);
  expect(await h.repository.listKnowledgeItemsForSource(id, h.actor.userId)).toEqual([]);
 });
 it.each(['core', 'http'])('preserves a human-confirmed image outcome through offline generic %s retry', async entrypoint => {
  const h = fixture(driver); await historical(h); h.provider.fail.add('extract');
  const failed = await send(h, processPath, {}); const id = failed.body.items[0].rawSourceId;
  const node = await h.repository.createNode({ userId: h.actor.userId, title: 'Human target' });
  await h.core.reviewSource(id, { actionId: 'human-confirmed', expectedRevision: 0, action: 'confirm', nodeId: node.id, editedText: 'Human decision retained while image processing is offline.' }, h.actor);
  const before = await h.repository.findRawSource(id, h.actor.userId);
  const snapshot = await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id);
  const original = await h.repository.getCaptureAsset(h.actor.userId, 'image-session', 'original');
  const items = await h.repository.listKnowledgeItemsForSource(id, h.actor.userId);
  h.core = createKnowledgeCore({ repository: h.repository, config: h.config, provider: createOfflineProvider(), logger: silentLogger });
  const response = entrypoint === 'core' ? await h.core.retryCapture(id, h.actor) : (await send(h, `/api/capture/${id}/retry`, {})).body;
  expect(response).toMatchObject({ rawSourceId: id, stage: 'completed', processingStatus: 'done' });
  expect(await h.repository.findRawSource(id, h.actor.userId)).toEqual(before);
  expect(await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id)).toEqual(snapshot);
  expect(await h.repository.getCaptureAsset(h.actor.userId, 'image-session', 'original')).toEqual(original);
  expect(await h.repository.listKnowledgeItemsForSource(id, h.actor.userId)).toEqual(items);
 });
 it('keeps legacy offline text retry persistence unchanged', async () => {
  const h = fixture(driver);
  const source = await h.repository.createRawSource({ userId: h.actor.userId, rawText: 'Legacy text capture without image provenance.', sourceType: 'manual', capturedAt: '2026' });
  await h.repository.updateRawSourceProcessing(source.id, h.actor.userId, 'failed', 'legacy failure');
  h.core = createKnowledgeCore({ repository: h.repository, config: h.config, provider: createOfflineProvider(), logger: silentLogger });
  expect(await h.core.retryCapture(source.id, h.actor)).toMatchObject({ processingStatus: 'pending', stage: 'saved' });
  expect(await h.repository.findRawSource(source.id, h.actor.userId)).toMatchObject({ processingStatus: 'failed', errorReason: 'legacy failure', reviewStatus: 'needs_review', reviewRevision: 0 });
 });
 it('retains oversized derived input for manual review instead of silently truncating it', async () => {
  const h = fixture(driver); const image = item(); image.text = 'x'.repeat(40_000); await historical(h, batch([image]));
  const response = await send(h, processPath, {});
  expect(response.body.items[0]).toMatchObject({ status: 'needs_review', processingReason: 'recognition_too_long' });
  const id = response.body.items[0].rawSourceId;
  expect((await h.repository.findRawSource(id, h.actor.userId))?.rawText).toBe(image.text);
  const dto = captureRecognitionResponseSchema.parse((await send(h, `/api/inbox/${id}/recognition`)).body);
  expect(dto.processingText).toBeNull(); expect(dto.snapshot?.results[0]?.result.text).toBe(clear.text); expect(h.provider.extractInputs).toHaveLength(0);
 });
 it('pauses ambiguous edited inputs instead of recognizing all derivatives', async () => {
  const h = fixture(driver); const image = item(); image.assetIds = ['original', 'edited', 'stitched']; image.derivedAssets = ['edited', 'stitched'].map(assetId => ({ assetId, operation: 'rotate' as const, sourceAssetIds: ['original'], rotationDegrees: 90 as const }));
  await historical(h, batch([image])); const response = await send(h, processPath, {});
  expect(response.body.items[0]).toMatchObject({ status: 'needs_review', processingReason: 'input_selection_required' }); expect(h.provider.images).toHaveLength(0);
 });
 it('claims concurrent processing once and caps every derived text response without altering the snapshot', async () => {
  const h = fixture(driver); await historical(h);
  let release!: () => void; let entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  h.provider.result = { ...clear, text: 'Visible derived text then PRIVATE_TAIL_' + 'details '.repeat(20), blocks: [{ kind: 'code', text: 'Visible code derived then PRIVATE_TAIL_' + 'code '.repeat(20) }], uncertainRegions: [{ reason: 'Visible uncertain region PRIVATE_TAIL_' + 'reason '.repeat(20), text: 'Visible partial text then PRIVATE_TAIL_' + 'partial '.repeat(20) }] };
  h.provider.beforeRecognition = async () => { entered(); await gate; };
  const first = send(h, processPath, {}); await started;
  const other = driver === 'sqlite' ? fixture(driver, h.file) : h;
  const racing = await send(other, processPath, {}); expect(racing.status).toBe(200); release();
  const completed = await first; const id = completed.body.items[0].rawSourceId;
  expect(h.provider.images).toHaveLength(1); if (other !== h) expect(other.provider.images).toHaveLength(0);
  const narrow = await send(h, `/api/inbox/${id}/recognition`, undefined, { snippetChars: 24 });
  expect(narrow.status).toBe(200); expect(JSON.stringify(narrow.body)).not.toContain('PRIVATE_TAIL');
  const wide = await send(h, `/api/inbox/${id}/recognition`); expect(wide.body.snapshot.results[0].result.text).toContain('PRIVATE_TAIL');
  expect((await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id))?.results[0]?.result.text).toContain('PRIVATE_TAIL');
  expect((await send(h, processPath, {}, { scopes: ['read'] })).status).toBe(401);
  expect((await send(h, `/api/inbox/${id}/recognition`, undefined, { scopes: ['mutate'] })).status).toBe(401);
  expect((await send(h, `/api/inbox/${id}/recognition`, undefined, { nodeIds: ['outside'] })).status).toBe(401);
  expect((await send(h, `/api/inbox/${id}/recognition`, undefined, { userId: 'foreign' })).status).toBe(404);
 });
});
describe('SQLite image processing reopen', () => {
 it('retains the source when a remote success cannot be snapshotted and retries without duplicate durable items', async () => {
  const h = fixture('sqlite'); await historical(h); const db = new DatabaseSync(h.file);
  h.provider.beforeRecognition = async () => { db.exec("create trigger fail_snapshot before update on capture_image_recognition_snapshots begin select raise(abort, 'synthetic snapshot failure'); end"); };
  const failed = await send(h, processPath, {}); const id = failed.body.items[0].rawSourceId;
  expect(failed.body.items[0]).toMatchObject({ status: 'failed', retryable: true });
  expect((await h.repository.getCaptureRecognitionSnapshot(h.actor.userId, id))?.results).toEqual([]);
  db.exec('drop trigger fail_snapshot'); db.close(); h.provider.beforeRecognition = undefined;
  const retried = await send(h, '/api/capture/batches/image-batch/items/image-request/retry', {});
  expect(retried.body.items[0]).toMatchObject({ status: 'done', rawSourceId: id });
  // No remote idempotency key exists: success before a snapshot fault may cause a second call.
  expect(h.provider.images).toHaveLength(2);
  expect(await h.repository.listInbox({ userId: h.actor.userId })).toHaveLength(1);
  expect(await h.repository.listKnowledgeItemsForSource(id, h.actor.userId)).toHaveLength(1);
 });
 it('reuses recognized bytes after close/reopen and an interrupted extraction', async () => {
  const h = fixture('sqlite'); await historical(h); h.provider.fail.add('extract');
  const failed = await send(h, processPath, {}); const id = failed.body.items[0].rawSourceId;
  const original = h.repository as SqliteRepository; stores.splice(stores.indexOf(original), 1); await original.close();
  const reopened = fixture('sqlite', h.file); const retry = await send(reopened, '/api/capture/batches/image-batch/items/image-request/retry', {});
  expect(retry.body.items[0]).toMatchObject({ status: 'done', rawSourceId: id }); expect(reopened.provider.images).toHaveLength(0);
  expect(await reopened.repository.listKnowledgeItemsForSource(id, reopened.actor.userId)).toHaveLength(1);
 });
});
