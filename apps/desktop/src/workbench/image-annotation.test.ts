import { afterEach, describe, expect, it, vi } from 'vitest';
import { addImageAnnotation, buildCaptureBatchRequest, createIntakeSession, enqueueIntakeImages, rotateIntakeImage, undoImageAnnotation } from './intake-session';
import { renderImageAnnotationPreview } from './image-composition';
import { imageEditSignature, rotateAnnotationClockwise } from './image-edit-model';
import type { ImageAnnotation } from './image-edit-model';
import { prepareIntakeDerivedAssets } from './intake-derived-assets';

function pngHeader(width = 8, height = 6): File {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  header.set([0, 0, 0, 13], 8);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(header.buffer).setUint32(16, width, false);
  new DataView(header.buffer).setUint32(20, height, false);
  return new File([header], 'fixture.png', { type: 'image/png' });
}

const rectangle: ImageAnnotation = {
  type: 'rectangle', x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8, color: '#d64a3b', strokeWidth: 4,
};
const arrow: ImageAnnotation = {
  type: 'arrow', x1: 0.15, y1: 0.25, x2: 0.75, y2: 0.65, color: '#d64a3b', strokeWidth: 2,
};
const textAnnotation: ImageAnnotation = {
  type: 'text', x1: 0.2, y1: 0.3, x2: 0.2, y2: 0.3, color: '#d64a3b', strokeWidth: 4, text: 'fixture text', fontSize: 24,
};

function queuedSession() {
  const session = createIntakeSession({ createId: (() => { let n = 0; return () => `id-${++n}`; })() });
  return enqueueIntakeImages(session, [pngHeader()], { createPreviewUrl: () => 'fixture://original' }).session;
}

afterEach(() => vi.unstubAllGlobals());

describe('image annotation editing', () => {
  it('adds and undoes annotations on the selected source without changing its bytes', async () => {
    const session = queuedSession();
    const image = session.images[0]!;
    const originalBytes = new Uint8Array(await image.file.arrayBuffer());
    const edited = addImageAnnotation(session, image.assetId, rectangle);

    expect(edited.images[0]?.edit.annotations).toEqual([rectangle]);
    expect(edited.images[0]?.file).toBe(image.file);
    expect(new Uint8Array(await image.file.arrayBuffer())).toEqual(originalBytes);
    expect(undoImageAnnotation(edited, image.assetId).images[0]?.edit.annotations).toEqual([]);
  });

  it('keeps annotation geometry anchored when the source rotates clockwise', () => {
    const session = queuedSession();
    const image = session.images[0]!;
    const edited = addImageAnnotation(session, image.assetId, rectangle);
    const rotated = rotateIntakeImage(edited, image.assetId);

    expect(rotated.images[0]?.edit.rotationDegrees).toBe(90);
    expect(rotated.images[0]?.edit.annotations[0]).toMatchObject({ x1: 0.8, y1: 0.1, x2: 0.2, y2: 0.6 });
  });

  it.each([
    { turns: 0, rotationDegrees: 0, width: 200, height: 120, x: 10, y: 0, textRotationDegrees: 0 },
    { turns: 1, rotationDegrees: 90, width: 120, height: 200, x: 120, y: 10, textRotationDegrees: 90 },
    { turns: 2, rotationDegrees: 180, width: 200, height: 120, x: 190, y: 120, textRotationDegrees: 180 },
    { turns: 3, rotationDegrees: 270, width: 120, height: 200, x: 0, y: 190, textRotationDegrees: 270 },
  ])('keeps edge text visible after $rotationDegrees degrees of image rotation', async ({ turns, rotationDegrees, width, height, x, y, textRotationDegrees }) => {
    const file = pngHeader(200, 120);
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const edgeText: ImageAnnotation = {
      type: 'text', x1: 0.05, y1: 0, x2: 0.05, y2: 0, color: '#d64a3b', strokeWidth: 4,
      text: 'edge text', fontSize: 24,
    };
    const annotation = Array.from({ length: turns }).reduce<ImageAnnotation>((current) => rotateAnnotationClockwise(current), edgeText);
    const context = {
      save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn(), fillText: vi.fn(),
    };
    const blob = new Blob(['rendered-png'], { type: 'image/png' });
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: (callback: BlobCallback) => callback(blob) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 200, height: 120, close: vi.fn() })));

    const result = await renderImageAnnotationPreview({
      assetId: 'edge-source', file, rotationDegrees: rotationDegrees as 0 | 90 | 180 | 270, annotations: [annotation],
    });

    expect(result).toMatchObject({ width, height });
    expect(context.translate).toHaveBeenLastCalledWith(x, y);
    expect(context.rotate).toHaveBeenLastCalledWith(textRotationDegrees * Math.PI / 180);
    expect(context.fillText).toHaveBeenLastCalledWith('edge text', 0, 0, 190);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(originalBytes);
  });

  it('renders the selected edit to one PNG blob and disposes the source bitmap', async () => {
    const draw = vi.fn();
    const strokeRect = vi.fn();
    const bitmapClose = vi.fn();
    const context = {
      save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: draw, restore: vi.fn(),
      strokeRect, beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fillText: vi.fn(), setLineDash: vi.fn(),
    };
    const blob = new Blob(['rendered-png'], { type: 'image/png' });
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: (callback: BlobCallback) => callback(blob) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8, height: 6, close: bitmapClose })));
    const source = { assetId: 'original', file: pngHeader(), rotationDegrees: 0 as const, annotations: [rectangle, arrow, textAnnotation] };

    const result = await renderImageAnnotationPreview(source);

    expect(result.blob).toBe(blob);
    expect(result).toMatchObject({ sourceAssetId: 'original', width: 8, height: 6, mimeType: 'image/png' });
    expect(strokeRect).toHaveBeenCalledOnce();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledOnce();
    expect(context.translate.mock.lastCall?.[0]).toBeCloseTo(1.6);
    expect(context.translate.mock.lastCall?.[1]).toBeCloseTo(1.8);
    expect(context.rotate).toHaveBeenLastCalledWith(0);
    expect(context.fillText).toHaveBeenCalledWith('fixture text', 0, 0, 6.4);
    expect(bitmapClose).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('aborts PNG encoding and releases the source bitmap and canvas', async () => {
    const bitmapClose = vi.fn();
    const context = {
      save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn(),
    };
    let toBlobCallback: BlobCallback | undefined;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => { toBlobCallback = callback; }),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8, height: 6, close: bitmapClose })));
    const controller = new AbortController();
    const completion = renderImageAnnotationPreview({
      assetId: 'original', file: pngHeader(), rotationDegrees: 0, annotations: [],
    }, controller.signal).then(
      () => 'resolved',
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'rejected',
    );

    await vi.waitFor(() => expect(toBlobCallback).toBeTypeOf('function'));
    controller.abort();
    const result = await Promise.race([
      completion,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);

    expect(result).toBe('aborted');
    expect(bitmapClose).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('pixelates only the selected normalized region with a short-lived bounded canvas', async () => {
    const sourceContext = { save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() };
    const pixelContext = { drawImage: vi.fn(), imageSmoothingEnabled: true };
    const output = new Blob(['png'], { type: 'image/png' });
    const mainCanvas = { width: 0, height: 0, getContext: () => sourceContext, toBlob: (callback: BlobCallback) => callback(output) };
    const pixelCanvas = { width: 0, height: 0, getContext: () => pixelContext };
    vi.stubGlobal('document', { createElement: vi.fn().mockReturnValueOnce(mainCanvas).mockReturnValueOnce(pixelCanvas) });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8, height: 6, close: vi.fn() })));
    const pixelate: ImageAnnotation = { type: 'pixelate', x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75, color: '#d64a3b', strokeWidth: 4 };

    const result = await renderImageAnnotationPreview({ assetId: 'original', file: pngHeader(), rotationDegrees: 0, annotations: [pixelate] });

    expect(result.blob).toBe(output);
    expect(pixelContext.drawImage).toHaveBeenCalledOnce();
    expect(sourceContext.drawImage).toHaveBeenCalledTimes(2);
    expect(pixelCanvas.width).toBe(0);
    expect(pixelCanvas.height).toBe(0);
  });

  it('submits the exact cached preview blob as an annotate derivative with original provenance', async () => {
    const session = queuedSession();
    const source = session.images[0]!;
    const edited = rotateIntakeImage(addImageAnnotation(session, source.assetId, rectangle), source.assetId);
    const image = edited.images[0]!;
    const previewBlob = new Blob(['the exact displayed output'], { type: 'image/png' });
    const derived = await prepareIntakeDerivedAssets(edited.images, undefined, () => 'derived-annotated', [], [
      { assetId: image.assetId, signature: imageEditSignature(image.edit), blob: previewBlob },
    ]);
    const request = buildCaptureBatchRequest({ ...edited, derivedAssets: derived });
    const item = request.items.find((candidate) => candidate.requestId === image.requestId)!;

    expect(derived).toHaveLength(1);
    expect(derived[0]?.blob).toBe(previewBlob);
    expect(item.assetIds).toEqual([image.assetId, 'derived-annotated']);
    expect(item.derivedAssets).toEqual([{
      assetId: 'derived-annotated', operation: 'annotate', sourceAssetIds: [image.assetId], rotationDegrees: 90,
      annotations: [{ ...rectangle, x1: 0.8, y1: 0.1, x2: 0.2, y2: 0.6 }],
    }]);
    expect(new Uint8Array(await image.file.arrayBuffer())).toEqual(new Uint8Array(await source.file.arrayBuffer()));
  });

  it('persists the rotated text glyph orientation with the exact annotation preview derivative', async () => {
    const session = queuedSession();
    const source = session.images[0]!;
    const edgeText: ImageAnnotation = {
      type: 'text', x1: 0.05, y1: 0, x2: 0.05, y2: 0, color: '#d64a3b', strokeWidth: 4,
      text: 'edge text', fontSize: 24,
    };
    const edited = rotateIntakeImage(addImageAnnotation(session, source.assetId, edgeText), source.assetId);
    const image = edited.images[0]!;
    const previewBlob = new Blob(['rotated text png'], { type: 'image/png' });
    const derived = await prepareIntakeDerivedAssets(edited.images, undefined, () => 'derived-rotated-text', [], [
      { assetId: image.assetId, signature: imageEditSignature(image.edit), blob: previewBlob },
    ]);
    const request = buildCaptureBatchRequest({ ...edited, derivedAssets: derived });
    const annotation = request.items[0]?.derivedAssets?.[0]?.annotations?.[0];

    expect(image.edit.annotations[0]).toMatchObject({ x1: 1, y1: 0.05, textRotationDegrees: 90 });
    expect(derived[0]?.blob).toBe(previewBlob);
    expect(annotation).toMatchObject({ x1: 1, y1: 0.05, textRotationDegrees: 90 });
    expect(new Uint8Array(await image.file.arrayBuffer())).toEqual(new Uint8Array(await source.file.arrayBuffer()));
  });

  it('reuses an unchanged annotation derivative after an uncertain or failed upload', async () => {
    const session = queuedSession();
    const source = session.images[0]!;
    const edited = rotateIntakeImage(addImageAnnotation(session, source.assetId, rectangle), source.assetId);
    const image = edited.images[0]!;
    const blob = new Blob(['previously prepared output'], { type: 'image/png' });
    const previous = {
      assetId: 'stable-annotated',
      operation: 'annotate' as const,
      sourceAssetIds: [image.assetId],
      rotationDegrees: 90 as const,
      annotations: [...image.edit.annotations],
      blob,
      mimeType: 'image/png' as const,
      uploadStatus: 'uncertain' as const,
      error: 'response lost',
    };
    let allocated = 0;
    const prepared = await prepareIntakeDerivedAssets(edited.images, undefined, () => `new-${++allocated}`, [previous]);

    expect(prepared).toEqual([previous]);
    expect(prepared[0]?.blob).toBe(blob);
    expect(allocated).toBe(0);
  });
});
