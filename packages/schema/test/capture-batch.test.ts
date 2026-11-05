import { describe, expect, it } from 'vitest';
import {
  captureAssetBytesMatchMime,
  captureBatchListQuerySchema,
  captureBatchListSchema,
  captureBatchRequestSchema,
  MAX_CAPTURE_BATCH_BODY_BYTES,
} from '../src/capture-batch';

const textItem = (requestId: string, userOrder: number) => ({
  requestId,
  kind: 'text' as const,
  userOrder,
  text: '原文内容足够长，用于验证批量收集结构。',
  source: { type: 'desktop_app' as const },
  capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' as const },
});

describe('capture batch schema', () => {
  it('bounds recent batch list queries and validates the shared response shape', () => {
    expect(captureBatchListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(captureBatchListQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    for (const limit of ['0', '51', '1.5', 'not-a-number']) {
      expect(captureBatchListQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(captureBatchListSchema.parse({ batches: [] })).toEqual({ batches: [] });
    expect(captureBatchListSchema.safeParse({ batches: [{}] }).success).toBe(false);
  });

  it('accepts mixed items with stable order and defaults empty asset lists', () => {
    const parsed = captureBatchRequestSchema.parse({
      batchId: 'batch-1', sessionId: 'session-1',
      items: [
        { requestId: 'image-01', kind: 'image', userOrder: 0, assetIds: ['asset-1'], source: { type: 'desktop_app' }, capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' } },
        textItem('text-0001', 1),
      ],
    });
    expect(parsed.items[1]?.assetIds).toEqual([]);
    expect(parsed.items.map((item) => item.userOrder)).toEqual([0, 1]);
  });

  it('rejects duplicate request IDs, duplicate order values, and image items without saved assets', () => {
    const base = { batchId: 'batch-1', sessionId: 'session-1' };
    expect(captureBatchRequestSchema.safeParse({ ...base, items: [textItem('same-request', 0), textItem('same-request', 1)] }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({ ...base, items: [textItem('request-a', 0), textItem('request-b', 0)] }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({
      ...base,
      items: [{ requestId: 'image-01', kind: 'image', userOrder: 0, assetIds: [], source: { type: 'desktop_app' }, capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' } }],
    }).success).toBe(false);
  });

  it('shares the server JSON body cap and exact supported image signatures', () => {
    expect(MAX_CAPTURE_BATCH_BODY_BYTES).toBe(256_000);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff]);
    const gif = new TextEncoder().encode('GIF89a');
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(captureAssetBytesMatchMime(png, 'image/png')).toBe(true);
    expect(captureAssetBytesMatchMime(jpeg, 'image/jpeg')).toBe(true);
    expect(captureAssetBytesMatchMime(gif, 'image/gif')).toBe(true);
    expect(captureAssetBytesMatchMime(webp, 'image/webp')).toBe(true);
    expect(captureAssetBytesMatchMime(png, 'image/jpeg')).toBe(false);
  });

  it('records derived asset provenance and rejects missing source or output references', () => {
    const rotation = {
      assetId: 'rotated-one', operation: 'rotate', sourceAssetIds: ['original-one'], rotationDegrees: 90,
    };
    const stitch = {
      assetId: 'stitched-one-two', operation: 'stitch', sourceAssetIds: ['original-one', 'original-two'], direction: 'horizontal',
    };
    const annotated = {
      assetId: 'annotated-one', operation: 'annotate', sourceAssetIds: ['original-one'], rotationDegrees: 90,
      annotations: [
        { type: 'rectangle', x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.8, color: '#d64a3b', strokeWidth: 4 },
        { type: 'text', x1: 0.05, y1: 0, x2: 0.05, y2: 0, color: '#d64a3b', strokeWidth: 4, text: 'edge note', fontSize: 24, textRotationDegrees: 90 },
      ],
    };
    const image = (requestId: string, userOrder: number, assetIds: string[], derivedAssets?: unknown[]) => ({
      requestId, kind: 'image', userOrder, assetIds, ...(derivedAssets === undefined ? {} : { derivedAssets }),
      source: { type: 'desktop_app' },
      capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
    });
    const valid = {
      batchId: 'derived-batch', sessionId: 'derived-session',
      items: [
        image('image-one', 0, ['original-one', 'rotated-one', 'stitched-one-two', 'annotated-one'], [rotation, stitch, annotated]),
        image('image-two', 1, ['original-two']),
      ],
    };

    const parsed = captureBatchRequestSchema.parse(valid);
    expect(parsed.items[0]?.derivedAssets).toEqual([rotation, stitch, annotated]);
    expect(captureBatchRequestSchema.safeParse({
      ...valid,
      items: [image('image-one', 0, ['original-one', 'annotated-one'], [{ ...annotated, annotations: [{ ...annotated.annotations[0], x2: 1.1 }] }]), image('image-two', 1, ['original-two'])],
    }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({
      ...valid,
      items: [image('image-one', 0, ['original-one', 'annotated-one'], [{ ...annotated, annotations: [{ ...annotated.annotations[0], textRotationDegrees: 45 }] }]), image('image-two', 1, ['original-two'])],
    }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({
      ...valid,
      items: [image('image-one', 0, ['original-one', 'annotated-one'], [{ ...annotated, annotations: [{ ...annotated.annotations[0], type: 'rectangle', text: undefined, fontSize: undefined, textRotationDegrees: 90 }] }]), image('image-two', 1, ['original-two'])],
    }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({
      ...valid,
      items: [image('image-one', 0, ['original-one'], [rotation]), image('image-two', 1, ['original-two'])],
    }).success).toBe(false);
    expect(captureBatchRequestSchema.safeParse({
      ...valid,
      items: [image('image-one', 0, ['original-one', 'rotated-one'], [{ ...rotation, sourceAssetIds: ['missing-original'] }]), image('image-two', 1, ['original-two'])],
    }).success).toBe(false);
  });
});
