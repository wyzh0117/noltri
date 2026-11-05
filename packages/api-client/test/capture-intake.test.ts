import { describe, expect, it } from 'vitest';
import type { CaptureAssetUploadResult, CaptureBatchRequest, CaptureBatchStatus, CaptureBatchSubmitResult } from '@noltri/schema';
import { ApiClient, ApiClientError, apiRoutes } from '../src/client';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function stub(responses: unknown[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return new Response(JSON.stringify(responses[calls.length - 1]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const capturedAt = '2026-10-29T10:00:00.000Z';
const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = 'a'.repeat(64);

const assetResponse: CaptureAssetUploadResult = {
  duplicate: false,
  asset: { assetId: 'asset-1', sessionId: 'session-1', mimeType: 'image/png', byteLength: 8, sha256, createdAt: capturedAt },
};

const batchRequest: CaptureBatchRequest = {
  batchId: 'batch-1',
  sessionId: 'session-1',
  items: [
    {
      requestId: 'text-request-1', kind: 'text', userOrder: 0, text: '保留原始换行\n第二行。', assetIds: [],
      source: { type: 'manual' }, capture: { client: 'desktop', capturedAt }, library: { kind: 'knowledge' },
    },
    {
      requestId: 'image/request-1', kind: 'image', userOrder: 1, assetIds: ['asset-1'],
      source: { type: 'manual' }, capture: { client: 'desktop', capturedAt }, library: { kind: 'image' },
    },
  ],
};

const batchStatus: CaptureBatchStatus = {
  batchId: 'batch-1', sessionId: 'session-1', createdAt: capturedAt, updatedAt: capturedAt,
  items: [
    { requestId: 'text-request-1', kind: 'text', userOrder: 0, assetIds: [], status: 'failed', duplicate: false, retryable: true, errorReason: 'provider timeout', updatedAt: capturedAt },
    { requestId: 'image/request-1', kind: 'image', userOrder: 1, assetIds: ['asset-1'], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: capturedAt },
  ],
};

describe('ApiClient capture intake endpoints', () => {
  it('lists recent batches with a validated bounded limit', async () => {
    const { calls, fetchImpl } = stub([{ batches: [batchStatus] }]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    const result = await client.listCaptureBatches({ limit: 7 });

    expect(result.batches[0]?.batchId).toBe('batch-1');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.captureBatches}?limit=7`);
    expect(() => client.listCaptureBatches({ limit: 51 })).toThrowError(ApiClientError);
    expect(calls).toHaveLength(1);
  });

  it('reads batch-scoped image bytes and validates the returned metadata and length', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png', 'content-length': String(bytes.byteLength),
          'x-noltri-asset-id': 'asset-1', 'x-noltri-session-id': 'session-1',
          'x-noltri-content-sha256': sha256, 'x-noltri-created-at': capturedAt,
        },
      });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', token: 'desktop-token', fetchImpl });

    const result = await client.readCaptureAsset('batch-1', 'asset-1');

    expect(result).toEqual({
      asset: { assetId: 'asset-1', sessionId: 'session-1', mimeType: 'image/png', byteLength: 8, sha256, createdAt: capturedAt },
      bytes,
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.captureBatchAsset('batch-1', 'asset-1')}`);
    expect(calls[0]?.headers.get('accept')).toBe('application/octet-stream');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer desktop-token');
  });

  it('rejects path-like IDs before a batch-asset request', async () => {
    const { calls, fetchImpl } = stub([]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await expect(client.readCaptureAsset('batch-1', '../asset')).rejects.toMatchObject({ name: 'ApiClientError', status: 400 });
    expect(calls).toEqual([]);
  });

  it('rejects an oversized asset response before reading its body', async () => {
    const fetchImpl = (async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(20 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await expect(client.readCaptureAsset('batch-1', 'asset-1')).rejects.toMatchObject({ status: 502 });
  });

  it('stops reading when the response body exceeds its declared length', async () => {
    const fetchImpl = (async () => new Response(Uint8Array.from([...bytes, 0]), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await expect(client.readCaptureAsset('batch-1', 'asset-1')).rejects.toMatchObject({ status: 502 });
  });

  it('uploads exact original bytes with the session and SHA headers', async () => {
    const { calls, fetchImpl } = stub([assetResponse]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', token: 'desktop-token', clientHint: 'desktop', fetchImpl });

    const result = await client.uploadCaptureAsset({ assetId: 'asset-1', sessionId: 'session-1', mimeType: 'image/png', sha256, bytes });

    expect(result.asset.byteLength).toBe(8);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.captureAsset('asset-1')}`);
    expect(calls[0]?.headers.get('content-type')).toBe('image/png');
    expect(calls[0]?.headers.get('x-noltri-session-id')).toBe('session-1');
    expect(calls[0]?.headers.get('x-noltri-content-sha256')).toBe(sha256);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer desktop-token');
    expect(await new Response(calls[0]?.body).arrayBuffer()).toEqual(bytes.buffer);
  });

  it('rejects invalid asset metadata before network I/O', async () => {
    const { calls, fetchImpl } = stub([assetResponse]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    expect(() => client.uploadCaptureAsset({ assetId: 'bad/id', sessionId: 'session-1', mimeType: 'image/png', sha256, bytes }))
      .toThrowError(ApiClientError);
    expect(calls).toEqual([]);
  });

  it('submits an ordered text-and-image batch with the original text intact', async () => {
    const result: CaptureBatchSubmitResult = { duplicate: false, batch: batchStatus };
    const { calls, fetchImpl } = stub([result]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    const submitted = await client.createCaptureBatch(batchRequest);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.captureBatches}`);
    expect(JSON.parse(String(calls[0]?.body))).toEqual(batchRequest);
    expect(submitted.batch.items.map((item) => item.userOrder)).toEqual([0, 1]);
  });

  it('reads the durable status and retries one failed request id with URL encoding', async () => {
    const { calls, fetchImpl } = stub([batchStatus, batchStatus]);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    const read = await client.getCaptureBatchStatus('batch-1');
    const retried = await client.retryCaptureBatchItem('batch-1', 'image/request-1');

    expect(read.items[1]?.status).toBe('assets_saved');
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', `http://127.0.0.1:8787${apiRoutes.captureBatch('batch-1')}`],
      ['POST', `http://127.0.0.1:8787${apiRoutes.captureBatchItemRetry('batch-1', 'image/request-1')}`],
    ]);
    expect(calls[1]?.body).toBeUndefined();
    expect(retried.items[0]?.retryable).toBe(true);
  });
});
