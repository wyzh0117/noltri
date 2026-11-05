import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureBatchStatusSchema, type CaptureBatchRequest } from '@noltri/schema';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { createRequestHandler } from '../src/http/router';
import { makeHarness } from './fakes';

const annotation = 'abcdefghijklmnopqrstuvwxSENTINEL-stored-annotation';
const capped = 'abcdefghijklmnopqrstuvw…';
const errorText = 'abcdefghijklmnopqrstuvwxSENTINEL-stored-error';
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const userId = 'snippet-owner';
const batchId = 'snippet-batch';
const sessionId = 'snippet-session';
const source = { type: 'manual' as const };
const capture = { client: 'desktop' as const, capturedAt: '2026-11-02T00:00:00Z' };
const input: CaptureBatchRequest = {
  batchId, sessionId,
  items: [{ requestId: 'snippet-image', kind: 'image', userOrder: 0, assetIds: ['original', 'annotated'], source, capture,
    derivedAssets: [{ assetId: 'annotated', operation: 'annotate', sourceAssetIds: ['original'], annotations: [{ type: 'text', x1: 0, y1: 0, x2: 1, y2: 1, color: '#123456', strokeWidth: 2, fontSize: 24, text: annotation }] }],
  }],
};
const actions = ['create', 'replay', 'list', 'detail', 'image-retry', 'text-retry-success', 'text-retry-failure', 'process'] as const;

describe('actor-bounded capture batch projection', () => {
  for (const identity of ['limited-grant', 'unlimited-grant', 'device'] as const) {
    const cases = actions.map(action => ({ action, whitespace: false }));
    if (identity === 'limited-grant') cases.push({ action: 'detail', whitespace: true });
    it.each(cases)(`${identity}: $action (whitespace=$whitespace) caps outward text only and preserves durable source and image bytes`, async ({ action, whitespace }) => {
      const originalAnnotation = whitespace ? ' '.repeat(24) + 'SENTINEL-after-whitespace' : annotation;
      const expectedAnnotation = whitespace ? '…' : capped;
      const directory = mkdtempSync(path.join(tmpdir(), 'noltri-batch-snippet-'));
      const file = path.join(directory, 'profile.sqlite');
      const repository = new SqliteRepository({ file });
      let reopened: SqliteRepository | undefined;
      let closed = false;
      try {
        const h = makeHarness({ repository });
        const handle = createRequestHandler({ core: h.core, config: h.config, identityResolver: async () => ({
          userId, actor: 'synthetic', via: identity === 'device' ? 'dev-token' : 'grant',
          ...(identity === 'device' ? {} : { grant: { id: 'synthetic-grant', label: 'synthetic', client: 'test', secretHash: 'unused', scopes: ['read', 'capture', 'mutate'], nodeIds: null, snippetChars: identity === 'limited-grant' ? 24 : null, createdAt: '2026', revokedAt: null } }),
        }) });
        for (const assetId of ['original', 'annotated']) await repository.putCaptureAsset({ userId, assetId, sessionId, mimeType: 'image/png', bytes, sha256 });
        const textRetry = action.startsWith('text-retry');
        const body: CaptureBatchRequest = { ...input, items: [...input.items.map(item => ({ ...item, derivedAssets: item.derivedAssets?.map(derived => ({ ...derived, annotations: derived.annotations?.map(entry => ({ ...entry, text: originalAnnotation })) })) })), ...(textRetry ? [{ requestId: 'snippet-text', kind: 'text' as const, userOrder: 1, assetIds: [], text: 'A synthetic full stored text source for an offline retry.', source, capture }] : [])] };
        const call = async (method: string, url: string, payload?: unknown) => {
          const response = await handle(new Request(`http://core.local${url}`, { method, ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) }));
          expect(response.status, await response.clone().text()).toBe(200);
          return await response.json() as Record<string, unknown>;
        };
        if (action !== 'create') {
          // Seed through the public endpoint for a valid payload hash and provenance.
          await call('POST', '/api/capture/batches', body);
          if (textRetry) {
            // A separate unprocessed text request makes retry exercise the real text branches.
            const retryBody = { ...body, batchId: 'snippet-retry-batch', items: body.items.map(item => ({ ...item, requestId: item.kind === 'text' ? 'unprocessed-text-retry' : 'unprocessed-image-retry' })) };
            await repository.createCaptureBatch({ ...retryBody, userId, payloadHash: 'a'.repeat(64) });
            await repository.updateCaptureBatchItem(userId, retryBody.batchId, 'unprocessed-text-retry', { status: 'failed', retryable: true, errorReason: errorText });
          } else {
            await repository.updateCaptureBatchItem(userId, batchId, 'snippet-image', { status: 'failed', retryable: true, errorReason: errorText });
          }
        }
        if (action === 'text-retry-failure') h.provider.fail.add('extract');
        let response: Record<string, unknown>;
        if (action === 'create' || action === 'replay') response = await call('POST', '/api/capture/batches', body);
        else if (action === 'list') response = await call('GET', '/api/capture/batches');
        else if (action === 'detail') response = await call('GET', `/api/capture/batches/${batchId}`);
        else if (action === 'process') response = await call('POST', `/api/capture/batches/${batchId}/process`, {});
        else if (action === 'image-retry') response = await call('POST', `/api/capture/batches/${batchId}/items/snippet-image/retry`, {});
        else response = await call('POST', '/api/capture/batches/snippet-retry-batch/items/unprocessed-text-retry/retry', {});
        const batch = captureBatchStatusSchema.parse(response.batch ?? (response.batches as unknown[] | undefined)?.[0] ?? response);
        const image = batch.items[0]!;
        expect(image.derivedAssets?.[0]?.annotations?.[0]?.text).toBe(identity === 'limited-grant' ? expectedAnnotation : originalAnnotation);
        expect(image.derivedAssets?.[0]).toMatchObject({ assetId: 'annotated', operation: 'annotate', sourceAssetIds: ['original'], annotations: [{ x1: 0, y1: 0, x2: 1, y2: 1, color: '#123456', strokeWidth: 2, fontSize: 24 }] });
        if (['list', 'detail', 'replay'].includes(action)) expect(image.errorReason).toBe(identity === 'limited-grant' ? capped : errorText);
        if (textRetry) expect(batch.items[1]?.status).toBe(action === 'text-retry-failure' ? 'failed' : 'done');
        await repository.close();
        closed = true;
        reopened = new SqliteRepository({ file });
        const stored = await reopened.getCaptureBatch(userId, batch.batchId);
        expect(stored?.items[0]?.derivedAssets?.[0]?.annotations?.[0]?.text).toBe(originalAnnotation);
        if (['list', 'detail', 'replay'].includes(action)) expect(stored?.items[0]?.errorReason).toBe(errorText);
        const asset = await reopened.getCaptureAsset(userId, sessionId, 'annotated');
        expect(asset?.bytes).toEqual(bytes);
        expect(asset?.sha256).toBe(sha256);
      } finally {
        await reopened?.close();
        if (!closed) await repository.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
