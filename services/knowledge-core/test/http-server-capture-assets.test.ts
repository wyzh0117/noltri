import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient, apiRoutes } from '@noltri/api-client';
import { rawSourceSchema, inboxResponseSchema, assignSourceResponseSchema } from '@noltri/schema';
import { startServer, type RunningServer } from '../src/server';
import { FileGrantStore, issueGrant } from '../src/authorization';

// Valid 64x48 RGB PNGs from the synthetic updater acceptance fixture, never user images.
const images = [
  { name: 'orange', length: 156, sha256: 'e5696951997e3efe3f597e437bead71296201e694d96efff87df66e3f948808a', base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAY0lEQVR4nO3PwQkAIBDAsNvFTd3Zv0P4CEKhA6Rz9vq64YIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAseu54FOR75RK/aAAAAAElFTkSuQmCC' },
  { name: 'blue', length: 157, sha256: '72c84955ccb2ebce1ccf2bb7153d59270016150cdfddadeb0b87f19bcfee8f0b', base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwFfIViY2kSH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgFtH6TxrNDrdQAAAABJRU5ErkJggg==' },
];

describe('saved capture original bytes through the real Node HTTP adapter', () => {
  let directory: string;
  let running: RunningServer | undefined;
  let base: string;
  let client: ApiClient;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'noltri-asset-http-'));
    const envFile = path.join(directory, 'empty.env');
    writeFileSync(envFile, '');
    const env = {
      NOLTRI_ENV_FILE: envFile, STORAGE_DRIVER: 'sqlite',
      NOLTRI_DATA_DIR: directory, NOLTRI_SQLITE_FILE: path.join(directory, 'synthetic.sqlite'),
      NOLTRI_NOTES_DIR: path.join(directory, 'vault'), NOLTRI_GRANT_FILE: path.join(directory, 'grants.json'),
      NOLTRI_DEV_USER_ID: 'asset-http-test', NOLTRI_DEV_REQUIRE_TOKEN: 'false', NOLTRI_DEV_TOKEN: '',
      AI_PROVIDER: 'offline', AI_EMBEDDINGS_ENABLED: 'false', NOLTRI_VERSION: 'synthetic-中文',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    running = await startServer({ port: 0 });
    base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
    client = new ApiClient({ baseUrl: base });
  });

  afterAll(async () => {
    try { await running?.stop(); }
    finally { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(images)('reads the saved $name original with bounded bytes and intact metadata', async (image) => {
    const bytes = new Uint8Array(Buffer.from(image.base64, 'base64'));
    const assetId = `http-original-${image.name}`;
    const batchId = `http-batch-${image.name}`;
    const upload = await client.uploadCaptureAsset({
      assetId, sessionId: 'asset-http-session', mimeType: 'image/png', sha256: image.sha256, bytes,
    });
    expect(upload.asset.byteLength).toBe(image.length);
    const submitted = await client.createCaptureBatch({
      batchId, sessionId: 'asset-http-session', items: [{
        requestId: `http-request-${image.name}`, kind: 'image', userOrder: 0, assetIds: [assetId],
        source: { type: 'manual' }, capture: { client: 'desktop', capturedAt: '2026-11-03T04:00:00.000Z' },
      }],
    });
    expect(submitted.batch.items[0]?.status).toBe('assets_saved');

    const wire = await fetch(`${base}${apiRoutes.captureBatchAsset(batchId, assetId)}`);
    expect(wire.status).toBe(200);
    expect.soft(wire.headers.get('content-length')).toBe(String(image.length));
    expect(new Uint8Array(await wire.arrayBuffer())).toEqual(bytes);
    const result = await client.readCaptureAsset(batchId, assetId);
    expect(result.bytes).toEqual(bytes);
    expect(result.asset).toMatchObject({ assetId, byteLength: image.length, mimeType: 'image/png', sha256: image.sha256 });
  });

  it.each([24, null])('projects source text, context and failure text for read grant cap %s without changing originals', async (cap) => {
    if (!running || !(running.bundle.grants instanceof FileGrantStore)) throw Error('isolated file-backed grants unavailable');
    const repository = running.bundle.repository;
    const userId = running.bundle.config.devUser;
    const rawText = 'R'.repeat(24) + '-original-text-tail';
    const surroundingContext = 'C'.repeat(24) + '-original-context-tail';
    const errorReason = 'E'.repeat(24) + '-stored-failure-tail';
    const source = await repository.createRawSource({ userId, rawText, surroundingContext, sourceType: 'manual', capturedAt: '2026-11-03T04:00:00.000Z' });
    await repository.updateRawSourceProcessing(source.id, userId, 'failed', errorReason);
    const original = await repository.findRawSource(source.id, userId);
    const credential = await issueGrant(running.bundle.grants, { label: 'synthetic read projection', scopes: ['read'], ...(cap === null ? {} : { snippetChars: cap }) });
    const headers = { authorization: `Bearer ${credential.secret}` };
    const response = await fetch(`${base}/api/inbox/${source.id}`, { headers });
    expect(response.status).toBe(200);
    const received = rawSourceSchema.parse(await response.json());
    expect(received.rawText).toBe(cap === null ? rawText : 'R'.repeat(23) + '…');
    expect.soft(received.surroundingContext).toBe(cap === null ? surroundingContext : 'C'.repeat(23) + '…');
    expect.soft(received.errorReason).toBe(cap === null ? errorReason : 'E'.repeat(23) + '…');
    const inbox = inboxResponseSchema.parse(await (await fetch(`${base}/api/inbox`, { headers })).json());
    expect(inbox.entries.find((entry: { id: string }) => entry.id === source.id)?.errorReason).toBe(cap === null ? errorReason : 'E'.repeat(23) + '…');
    expect(await repository.findRawSource(source.id, userId)).toEqual(original);
  });

  it('preserves null source context and failure text under a bounded read grant', async () => {
    if (!running || !(running.bundle.grants instanceof FileGrantStore)) throw Error('isolated file-backed grants unavailable');
    const source = await running.bundle.repository.createRawSource({ userId: running.bundle.config.devUser, rawText: 'short source', sourceType: 'manual', capturedAt: '2026-11-03T04:00:00.000Z' });
    const credential = await issueGrant(running.bundle.grants, { label: 'synthetic nullable projection', scopes: ['read'], snippetChars: 24 });
    const response = await fetch(`${base}/api/inbox/${source.id}`, { headers: { authorization: `Bearer ${credential.secret}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rawText: 'short source', surroundingContext: null, errorReason: null });
  });

  it.each([24, null])('projects the legacy assign response for mutate grant cap %s while storing the whole item', async (cap) => {
    if (!running || !(running.bundle.grants instanceof FileGrantStore)) throw Error('isolated file-backed grants unavailable');
    const repository = running.bundle.repository;
    const userId = running.bundle.config.devUser;
    const rawText = 'A'.repeat(24) + '-original-legacy-assign-tail';
    const source = await repository.createRawSource({ userId, rawText, sourceType: 'manual', capturedAt: '2026-11-03T04:00:00.000Z' });
    const node = await repository.createNode({ userId, title: 'Synthetic assign target', nodeType: 'topic' });
    const credential = await issueGrant(running.bundle.grants, { label: 'synthetic mutate projection', scopes: ['mutate'], ...(cap === null ? {} : { snippetChars: cap }) });
    const response = await fetch(`${base}/api/inbox/${source.id}/assign`, {
      method: 'POST', headers: { authorization: `Bearer ${credential.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: node.id }),
    });
    expect(response.status).toBe(200);
    const received = assignSourceResponseSchema.parse(await response.json());
    expect(received.item.normalizedText).toBe(cap === null ? rawText : 'A'.repeat(23) + '…');
    expect(received.item.summary).toBeNull();
    expect((await repository.listKnowledgeItemsForNode(node.id, userId))[0]?.normalizedText).toBe(rawText);
    expect((await repository.findRawSource(source.id, userId))?.rawText).toBe(rawText);
  });

  it('frames JSON by its UTF-8 byte count rather than its character count', async () => {
    const response = await fetch(`${base}/api/health`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('synthetic-中文');
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
  });

  it('keeps an empty CORS preflight body without a forbidden length header', async () => {
    const response = await fetch(`${base}${apiRoutes.captureBatchAsset('http-batch-orange', 'http-original-orange')}`, {
      method: 'OPTIONS', headers: {
        origin: 'tauri://localhost', 'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('content-length')).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});
