import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema, captureBatchListSchema } from '@noltri/schema';
import type { ClientGrant } from '../src/authorization';
import { createRequestHandler } from '../src/http/router';
import { makeHarness, testConfig, type Harness } from './fakes';

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const imageHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = { type: 'desktop_app' as const };
const capture = { capturedAt: '2026-11-01T02:00:00.000Z', client: 'desktop' as const, deviceId: 'acceptance-device' };

function grant(scopes: ClientGrant['scopes'], nodeIds: ClientGrant['nodeIds'] = null): ClientGrant {
  return {
    id: 'test-grant', label: 'test', client: 'test', scopes, secretHash: 'test-hash', nodeIds,
    snippetChars: null, createdAt: '2026-11-01T02:00:00.000Z', revokedAt: null,
  };
}

function handlerOf(harness: Harness, scopes?: ClientGrant['scopes'], nodeIds: ClientGrant['nodeIds'] = null) {
  return createRequestHandler({
    core: harness.core,
    config: harness.config,
    // Test-only identity seam; production identity comes from the credential resolver.
    identityResolver: async (request) => ({
      userId: request.headers.get('x-test-user') ?? 'capture-owner',
      actor: 'desktop',
      via: scopes === undefined ? 'dev-open' : 'grant',
      ...(scopes === undefined ? {} : { grant: grant(scopes, nodeIds) }),
    }),
  });
}

function request(method: string, path: string, options: { user?: string; body?: string | Uint8Array; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://core.local${path}`, {
    method,
    headers: { ...(options.user === undefined ? {} : { 'x-test-user': options.user }), ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function storeImage(handle: ReturnType<typeof handlerOf>, assetId: string, sessionId = 'session-readback') {
  const response = await handle(request('PUT', `/api/capture/assets/${assetId}`, {
    body: imageBytes,
    headers: {
      'content-type': 'image/png',
      'x-noltri-session-id': sessionId,
      'x-noltri-content-sha256': imageHash(imageBytes),
    },
  }));
  expect(response.status, await response.clone().text()).toBe(200);
}

async function createBatch(handle: ReturnType<typeof handlerOf>, user = 'capture-owner') {
  for (const assetId of ['original-a', 'original-b', 'stitched', 'orphan']) await storeImage(handle, assetId);
  const response = await handle(request('POST', '/api/capture/batches', {
    user,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      batchId: 'batch-readback', sessionId: 'session-readback',
      // Deliberately reverse request order: Core should persist the user's order.
      items: [
        { requestId: 'image-b-request', kind: 'image', userOrder: 1, assetIds: ['original-b'], source, capture },
        {
          requestId: 'image-a-request', kind: 'image', userOrder: 0, assetIds: ['original-a', 'stitched'],
          derivedAssets: [{ assetId: 'stitched', operation: 'stitch', sourceAssetIds: ['original-a', 'original-b'], direction: 'horizontal' }],
          source, capture,
        },
      ],
    }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}

describe('saved capture batch readback', () => {
  it('lists one persisted batch in user order and reads original and derived bytes through that batch', async () => {
    const harness = makeHarness();
    const handle = handlerOf(harness);
    const submitted = await createBatch(handle);
    const submitBody = await submitted.json() as { batch: { items: Array<{ status: string }> } };
    expect(submitBody.batch.items.map((item) => item.status)).toEqual(['assets_saved', 'assets_saved']);
    expect(harness.provider.extractInputs).toEqual([]);

    const response = await handle(request('GET', '/api/capture/batches?limit=10'));
    expect(response.status).toBe(200);
    const listed = captureBatchListSchema.parse(await response.json());
    expect(listed.batches).toHaveLength(1);
    expect(listed.batches[0]).toMatchObject({ batchId: 'batch-readback', sessionId: 'session-readback' });
    expect(listed.batches[0]?.items.map((item) => item.requestId)).toEqual(['image-a-request', 'image-b-request']);
    expect(listed.batches[0]?.items[0]).toMatchObject({
      userOrder: 0,
      assetIds: ['original-a', 'stitched'],
      derivedAssets: [{ assetId: 'stitched', operation: 'stitch', sourceAssetIds: ['original-a', 'original-b'], direction: 'horizontal' }],
      status: 'assets_saved',
    });

    for (const assetId of ['original-a', 'stitched']) {
      const assetResponse = await handle(request('GET', `/api/capture/batches/batch-readback/assets/${assetId}`, {
        headers: { origin: 'tauri://localhost' },
      }));
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get('content-type')).toBe('image/png');
      expect(assetResponse.headers.get('cache-control')).toBe('private, no-store');
      expect(assetResponse.headers.get('x-noltri-session-id')).toBe('session-readback');
      expect(assetResponse.headers.get('access-control-allow-origin')).toBe('*');
      expect(assetResponse.headers.get('access-control-expose-headers')?.split(',').map((header) => header.trim())).toEqual(expect.arrayContaining([
        'content-length', 'x-noltri-asset-id', 'x-noltri-session-id', 'x-noltri-content-sha256', 'x-noltri-created-at',
      ]));
      expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(imageBytes);
    }

    const ownerlessList = captureBatchListSchema.parse(await (await handle(request('GET', '/api/capture/batches', { user: 'another-user' }))).json());
    expect(ownerlessList.batches).toEqual([]);
    expect((await handle(request('GET', '/api/capture/batches/batch-readback/assets/original-a', { user: 'another-user' }))).status).toBe(404);
    expect((await handle(request('GET', '/api/capture/batches/batch-readback/assets/orphan'))).status).toBe(404);
  });

  it('requires read scope, rejects unbounded limits, and refuses path-like asset IDs', async () => {
    const harness = makeHarness();
    const unrestricted = handlerOf(harness);
    await createBatch(unrestricted);

    const captureOnly = handlerOf(harness, ['capture']);
    const denied = await captureOnly(request('GET', '/api/capture/batches'));
    expect(denied.status).toBe(401);
    expect(apiErrorSchema.parse(await denied.json()).error.details).toMatchObject({ reason: 'scope_not_granted' });

    expect((await unrestricted(request('GET', '/api/capture/batches?limit=51'))).status).toBe(400);
    const traversal = await unrestricted(request('GET', '/api/capture/batches/batch-readback/assets/bad%2Fasset'));
    expect(traversal.status).toBe(400);
    expect(apiErrorSchema.parse(await traversal.json()).error.code).toBe('invalid_request');

    const nodeScoped = handlerOf(harness, ['read'], ['node-one']);
    expect((await nodeScoped(request('GET', '/api/capture/batches'))).status).toBe(401);
  });

  it('answers the Tauri bearer preflight without broadening the configured origin policy', async () => {
    const preflight = (handle: ReturnType<typeof handlerOf>) => handle(new Request('http://core.local/api/capture/batches/batch-readback/assets/original-a', {
      method: 'OPTIONS',
      headers: {
        origin: 'tauri://localhost',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    }));
    const defaultResponse = await preflight(handlerOf(makeHarness()));
    expect(defaultResponse.status).toBe(204);
    expect(defaultResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(defaultResponse.headers.get('access-control-allow-methods')).toContain('GET');
    expect(defaultResponse.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(defaultResponse.headers.get('access-control-expose-headers')).toContain('content-length');

    const restrictedResponse = await preflight(handlerOf(makeHarness({ config: testConfig({ corsOrigin: 'https://allowed.example' }) })));
    expect(restrictedResponse.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });
});
