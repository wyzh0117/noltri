import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntakeSession, enqueueIntakeImages, rotateIntakeImage } from './intake-session';
import type { IntakeDerivedAsset } from './intake-session';
import { prepareIntakeDerivedAssets } from './intake-derived-assets';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function pngFile(name: string): File {
  const header = new Uint8Array(24);
  header.set(png.subarray(0, 8));
  header.set([0, 0, 0, 13], 8);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(header.buffer).setUint32(16, 4, false);
  new DataView(header.buffer).setUint32(20, 3, false);
  return new File([header], name, { type: 'image/png' });
}

afterEach(() => vi.unstubAllGlobals());

describe('intake derived asset preparation', () => {
  it('uses the current ordered sources and the exact stitch Blob shown by preview', async () => {
    const session = createIntakeSession({ createId: (() => { let n = 0; return () => `source-${++n}`; })() });
    let queued = enqueueIntakeImages(session, [pngFile('first.png'), pngFile('second.png')], {
      createId: (() => { let n = 0; return () => `image-${++n}`; })(),
      createPreviewUrl: (file) => `fixture://${file.name}`,
    }).session;
    queued = rotateIntakeImage(queued, queued.images[0]!.assetId);
    const previewBlob = new Blob([Uint8Array.from([...png, 0x42])], { type: 'image/png' });
    const encodedRotation = new Blob([Uint8Array.from([...png, 0x43])], { type: 'image/png' });
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(encodedRotation),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 3, close: vi.fn() })));

    const prepared = await prepareIntakeDerivedAssets(queued.images, {
      blob: previewBlob,
      direction: 'vertical',
      sourceAssetIds: queued.images.map((image) => image.assetId),
    }, (() => { let n = 0; return () => `derived-${++n}`; })());

    expect(prepared.map(({ assetId, operation, sourceAssetIds }) => ({ assetId, operation, sourceAssetIds }))).toEqual([
      { assetId: 'derived-1', operation: 'rotate', sourceAssetIds: [queued.images[0]!.assetId] },
      { assetId: 'derived-2', operation: 'stitch', sourceAssetIds: queued.images.map((image) => image.assetId) },
    ]);
    expect(prepared[0]?.blob).toBe(encodedRotation);
    expect(prepared[1]?.blob).toBe(previewBlob);
    expect(new Uint8Array(await prepared[1]!.blob.arrayBuffer())).toEqual(new Uint8Array(await previewBlob.arrayBuffer()));
    expect(queued.images.map((image) => image.file.name)).toEqual(['first.png', 'second.png']);
  });

  it('reuses a prepared rotation and stitch identity when a deterministic rejection is retried unchanged', async () => {
    const session = createIntakeSession({ createId: () => 'session' });
    let queued = enqueueIntakeImages(session, [pngFile('first.png'), pngFile('second.png')], {
      createId: (() => { let n = 0; return () => `image-${++n}`; })(),
      createPreviewUrl: (file) => `fixture://${file.name}`,
    }).session;
    queued = rotateIntakeImage(queued, queued.images[0]!.assetId);
    const previewBlob = new Blob([Uint8Array.from([...png, 0x52])], { type: 'image/png' });
    const encodedRotation = new Blob([Uint8Array.from([...png, 0x53])], { type: 'image/png' });
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(encodedRotation),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 3, close: vi.fn() })));
    let nextId = 0;
    const createId = () => `fresh-${++nextId}`;
    const previous = [
      {
        assetId: 'stable-rotation', operation: 'rotate', sourceAssetIds: [queued.images[0]!.assetId],
        rotationDegrees: 90, mimeType: 'image/png', blob: encodedRotation, uploadStatus: 'failed', error: 'temporary fixture rejection',
      },
      {
        assetId: 'stable-stitch', operation: 'stitch', sourceAssetIds: queued.images.map((image) => image.assetId),
        direction: 'vertical', mimeType: 'image/png', blob: previewBlob, uploadStatus: 'uncertain', error: 'response lost',
      },
    ] as unknown as IntakeDerivedAsset[];

    const retried = await prepareIntakeDerivedAssets(queued.images, {
      blob: previewBlob,
      direction: 'vertical',
      sourceAssetIds: queued.images.map((image) => image.assetId),
    }, createId, previous);

    expect(retried.map((asset) => asset.assetId)).toEqual(['stable-rotation', 'stable-stitch']);
    expect(retried[0]).toBe(previous[0]);
    expect(retried[1]).toBe(previous[1]);
    expect(nextId).toBe(0);
  });

  it('does not reuse a stitch derivative when direction changes', async () => {
    const session = createIntakeSession({ createId: () => 'session' });
    const queued = enqueueIntakeImages(session, [pngFile('first.png'), pngFile('second.png')], {
      createId: (() => { let n = 0; return () => `image-${++n}`; })(),
      createPreviewUrl: (file) => `fixture://${file.name}`,
    }).session;
    const currentPreview = new Blob([Uint8Array.from([...png, 0x62])], { type: 'image/png' });
    const oldPreview = new Blob([Uint8Array.from([...png, 0x61])], { type: 'image/png' });
    const previous = [{
      assetId: 'old-stitch', operation: 'stitch', sourceAssetIds: queued.images.map((image) => image.assetId),
      direction: 'vertical', mimeType: 'image/png', blob: oldPreview, uploadStatus: 'saved',
    }] as unknown as IntakeDerivedAsset[];
    let nextId = 0;

    const retried = await prepareIntakeDerivedAssets(queued.images, {
      blob: currentPreview,
      direction: 'horizontal',
      sourceAssetIds: queued.images.map((image) => image.assetId),
    }, () => `fresh-${++nextId}`, previous);

    expect(retried).toHaveLength(1);
    expect(retried[0]?.assetId).toBe('fresh-1');
    expect(retried[0]?.blob).toBe(currentPreview);
    expect(retried[0]?.direction).toBe('horizontal');
  });
});
