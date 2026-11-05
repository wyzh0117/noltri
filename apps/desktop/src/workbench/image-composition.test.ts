import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderImageRotationPreview, renderImageStitchPreview, validateImageFileForPreview } from './image-composition';
import type { ImageStitchSource } from './image-composition';

function pngHeader(name: string, width: number, height: number): File {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  header.set([0, 0, 0, 13], 8);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(header.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return new File([header], name, { type: 'image/png' });
}

function gifHeader(name: string, width: number, height: number): File {
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode('GIF89a'));
  const view = new DataView(header.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return new File([header], name, { type: 'image/gif' });
}

function webpHeader(name: string, width: number, height: number): File {
  const header = new Uint8Array(30);
  header.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, header.length - 8, true);
  header.set(new TextEncoder().encode('WEBPVP8X'), 8);
  new DataView(header.buffer).setUint32(16, 10, true);
  const set24 = (offset: number, value: number) => {
    header[offset] = value & 0xff;
    header[offset + 1] = (value >>> 8) & 0xff;
    header[offset + 2] = (value >>> 16) & 0xff;
  };
  set24(24, width - 1);
  set24(27, height - 1);
  return new File([header], name, { type: 'image/webp' });
}

function jpegHeader(name: string, width: number, height: number): File {
  const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 1, 1, 0x11, 0]);
  return new File([header], name, { type: 'image/jpeg' });
}

function jpegHeaderWithExif(name: string, width: number, height: number, orientation: number): File {
  const payload = new Uint8Array(32);
  payload.set([69, 120, 105, 102, 0, 0], 0);
  payload.set([73, 73], 6);
  const view = new DataView(payload.buffer);
  view.setUint16(8, 42, true);
  view.setUint32(10, 8, true);
  view.setUint16(14, 1, true);
  view.setUint16(16, 0x0112, true);
  view.setUint16(18, 3, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, orientation, true);
  view.setUint16(26, 0, true);
  view.setUint32(28, 0, true);

  const app1 = new Uint8Array(4 + payload.length);
  app1.set([0xff, 0xe1, 0, payload.length + 2]);
  app1.set(payload, 4);
  const frame = new Uint8Array([0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 1, 1, 0x11, 0]);
  return new File([new Uint8Array([0xff, 0xd8]), app1, frame], name, { type: 'image/jpeg' });
}

function source(file: File): ImageStitchSource {
  return { assetId: file.name, file, rotationDegrees: 0 };
}

function installCanvas() {
  const context = {
    save: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    restore: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' }))),
  };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { canvas, context };
}

afterEach(() => vi.unstubAllGlobals());

describe('image stitch preview resource limits', () => {
  it('composes annotations into the displayed stitch PNG at each ordered source placement', async () => {
    const rectangle = {
      type: 'rectangle' as const, x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75, color: '#d64a3b', strokeWidth: 4 as const,
    };
    const rotatedText = {
      type: 'text' as const, x1: 0.5, y1: 0.25, x2: 0.5, y2: 0.25, color: '#d64a3b', strokeWidth: 4 as const,
      text: 'second', fontSize: 18 as const, textRotationDegrees: 90 as const,
    };
    const context = {
      save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
    };
    const blob = new Blob(['stitched-png'], { type: 'image/png' });
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: (callback: BlobCallback) => callback(blob) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => ({
      width: file.name === 'first.png' ? 4 : 2,
      height: file.name === 'first.png' ? 3 : 2,
      close: vi.fn(),
    })));
    const first = Object.assign(source(pngHeader('first.png', 4, 3)), { annotations: [rectangle] }) as ImageStitchSource;
    const second = Object.assign(source(pngHeader('second.png', 2, 2)), { annotations: [rotatedText] }) as ImageStitchSource;

    const result = await renderImageStitchPreview([first, second], 'horizontal');

    expect(result).toMatchObject({ width: 6, height: 3, blob, mimeType: 'image/png' });
    expect(context.strokeRect).toHaveBeenCalledWith(1, 0.75, 2, 1.5);
    expect(context.translate).toHaveBeenLastCalledWith(5, 0.5);
    expect(context.rotate).toHaveBeenLastCalledWith(Math.PI / 2);
    expect(context.fillText).toHaveBeenCalledWith('second', 0, 0, 1.5);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('clips rotated edge rectangle, text, and pixelate annotations to each source in both stitch directions', async () => {
    const firstAnnotations = [
      { type: 'rectangle' as const, x1: 0.1, y1: 0.96, x2: 0.95, y2: 1, color: '#d64a3b', strokeWidth: 6 as const },
      { type: 'text' as const, x1: 0.9, y1: 0.94, x2: 0.9, y2: 0.94, color: '#d64a3b', strokeWidth: 4 as const, text: 'EDGE', fontSize: 18 as const, textRotationDegrees: 90 as const },
      { type: 'pixelate' as const, x1: 0.5, y1: 0.5, x2: 1, y2: 1, color: '#d64a3b', strokeWidth: 4 as const },
    ];
    const secondAnnotations = [
      { type: 'rectangle' as const, x1: 0, y1: 0, x2: 0.05, y2: 0.2, color: '#d64a3b', strokeWidth: 6 as const },
      { type: 'text' as const, x1: 0.01, y1: 0.01, x2: 0.01, y2: 0.01, color: '#d64a3b', strokeWidth: 4 as const, text: 'EDGE', fontSize: 18 as const },
      { type: 'pixelate' as const, x1: 0, y1: 0, x2: 1, y2: 1, color: '#d64a3b', strokeWidth: 4 as const },
    ];

    for (const direction of ['horizontal', 'vertical'] as const) {
      const context = {
        save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
        translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
      };
      const pixelContext = { drawImage: vi.fn() };
      const canvas = {
        width: 0, height: 0, getContext: vi.fn(() => context),
        toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['stitched-png'], { type: 'image/png' }))),
      };
      const pixelCanvas = { width: 0, height: 0, getContext: vi.fn(() => pixelContext) };
      let createdCanvases = 0;
      vi.stubGlobal('document', { createElement: vi.fn(() => createdCanvases++ === 0 ? canvas : pixelCanvas) });
      vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => ({
        width: file.name === 'first.png' ? 4 : 2,
        height: file.name === 'first.png' ? 3 : 5,
        close: vi.fn(),
      })));

      const first = Object.assign(source(pngHeader('first.png', 4, 3)), {
        rotationDegrees: 90 as const,
        annotations: firstAnnotations,
      }) as ImageStitchSource;
      const second = Object.assign(source(pngHeader('second.png', 2, 5)), {
        annotations: secondAnnotations,
      }) as ImageStitchSource;

      try {
        const result = await renderImageStitchPreview([first, second], direction);

        expect(context.rect.mock.calls).toEqual(result.placements.map((placement) => [
          placement.x, placement.y, placement.width, placement.height,
        ]));
        expect(context.clip).toHaveBeenCalledTimes(2);
        expect(context.strokeRect).toHaveBeenCalledTimes(2);
        expect(context.fillText).toHaveBeenCalledTimes(2);
        expect(pixelContext.drawImage).toHaveBeenCalledTimes(2);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('renders a rotated derivative from the original without changing its bytes', async () => {
    const { canvas, context } = installCanvas();
    const original = pngHeader('rotate.png', 6, 4);
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 6, height: 4, close })));

    const result = await renderImageRotationPreview({ assetId: 'source-one', file: original, rotationDegrees: 90 });

    expect(result).toMatchObject({ width: 4, height: 6, mimeType: 'image/png' });
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(context.translate).toHaveBeenCalledWith(2, 3);
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(originalBytes);
  });

  it.each([
    { orientation: 1, width: 6, height: 4 },
    { orientation: 3, width: 6, height: 4 },
    { orientation: 6, width: 4, height: 6 },
    { orientation: 8, width: 4, height: 6 },
  ])('uses EXIF orientation $orientation dimensions for JPEG layout', async ({ orientation, width, height }) => {
    installCanvas();
    const file = jpegHeaderWithExif(`exif-${orientation}.jpg`, 6, 4, orientation);
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const dimensions = new Map([
      [file.name, { width, height }],
      ['small.png', { width: 2, height: 2 }],
    ]);
    const decoder = vi.fn(async (input: File) => ({ ...dimensions.get(input.name)!, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decoder);

    const result = await renderImageStitchPreview([source(file), source(pngHeader('small.png', 2, 2))], 'vertical');

    expect(result.width).toBe(width);
    expect(result.height).toBe(height + 2);
    expect(decoder).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(originalBytes);
  });

  it('keeps strict decoded-size checks and combines EXIF orientation with user rotation and layout direction', async () => {
    const { context } = installCanvas();
    const file = jpegHeaderWithExif('exif-6.jpg', 6, 4, 6);
    const close = vi.fn();
    const decoder = vi.fn(async (input: File) => input.name === file.name
      ? { width: 4, height: 6, close }
      : { width: 2, height: 2, close: vi.fn() });
    vi.stubGlobal('createImageBitmap', decoder);
    const rotated = { ...source(file), rotationDegrees: 90 as const };
    const small = source(pngHeader('small.png', 2, 2));

    const horizontal = await renderImageStitchPreview([rotated, small], 'horizontal');
    expect(horizontal.width).toBe(8);
    expect(horizontal.height).toBe(4);
    expect(horizontal.placements[0]).toMatchObject({ x: 0, y: 0, width: 6, height: 4 });
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);

    const vertical = await renderImageStitchPreview([source(file), small], 'vertical');
    expect(vertical.width).toBe(4);
    expect(vertical.height).toBe(8);
    expect(vertical.placements[0]).toMatchObject({ x: 0, y: 0, width: 4, height: 6 });

    const mismatchedClose = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async (input: File) => input.name === file.name
      ? { width: 6, height: 4, close: mismatchedClose }
      : { width: 2, height: 2, close: vi.fn() }));
    await expect(renderImageStitchPreview([source(file), small], 'vertical')).rejects.toThrow(/尺寸与解码结果不一致/);
    expect(mismatchedClose).toHaveBeenCalledOnce();
  });

  it('reads bounded dimensions from all currently accepted raster headers', async () => {
    installCanvas();
    const dimensions = new Map([
      ['tiny.gif', { width: 6, height: 5 }],
      ['tiny.webp', { width: 7, height: 5 }],
      ['tiny.jpg', { width: 8, height: 5 }],
      ['tiny.png', { width: 9, height: 5 }],
      ['small.png', { width: 4, height: 4 }],
    ]);
    const decoder = vi.fn(async (file: File) => ({ ...dimensions.get(file.name)!, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decoder);

    const files = [gifHeader('tiny.gif', 6, 5), webpHeader('tiny.webp', 7, 5), jpegHeader('tiny.jpg', 8, 5), pngHeader('tiny.png', 9, 5)];
    const expectedWidths = [6, 7, 8, 9];
    for (let index = 0; index < files.length; index += 1) {
      const result = await renderImageStitchPreview([source(files[index]!), source(pngHeader('small.png', 4, 4))], 'vertical');
      expect(result.width).toBe(expectedWidths[index]);
      expect(result.height).toBe(9);
    }

    expect(decoder).toHaveBeenCalledTimes(8);
  });

  it('rejects malicious PNG dimensions from the bounded header before decoding', async () => {
    const decoder = vi.fn(async (file: File) => ({ width: file.name === 'malicious.png' ? 1_000_000 : 4, height: 4, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decoder);

    await expect(renderImageStitchPreview([
      source(pngHeader('malicious.png', 1_000_000, 4)),
      source(pngHeader('small.png', 4, 4)),
    ], 'vertical')).rejects.toThrow(/尺寸/);

    expect(decoder).not.toHaveBeenCalled();
  });

  it('applies the existing byte and source-pixel limits to read-only saved asset previews', async () => {
    await expect(validateImageFileForPreview(pngHeader('at-limit.png', 8_000, 8_000)))
      .resolves.toEqual({ width: 8_000, height: 8_000 });
    await expect(validateImageFileForPreview(pngHeader('over-limit.png', 8_001, 8_000)))
      .rejects.toThrow('图片总像素超过预览限制');
    await expect(validateImageFileForPreview(new File(['x'.repeat(20 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' })))
      .rejects.toThrow('图片大小超出预览限制');
  });

  it('rejects cumulative source pixels before decoding any image', async () => {
    const decoder = vi.fn(async () => ({ width: 8_000, height: 5_000, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decoder);

    await expect(renderImageStitchPreview([
      source(pngHeader('large-a.png', 8_000, 5_000)),
      source(pngHeader('large-b.png', 8_000, 5_000)),
    ], 'vertical')).rejects.toThrow(/过大/);

    expect(decoder).not.toHaveBeenCalled();
  });

  it('rejects a header it cannot safely inspect without attempting a full decode', async () => {
    installCanvas();
    const decoder = vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decoder);
    const invalid = new File([new Uint8Array(24)], 'not-a-png.png', { type: 'image/png' });

    await expect(renderImageStitchPreview([source(invalid), source(pngHeader('valid.png', 4, 4))], 'vertical')).rejects.toThrow(/无法安全读取|格式/);

    expect(decoder).not.toHaveBeenCalled();
  });

  it('disposes each bitmap before decoding the next source and cleans up on decode failure', async () => {
    const { canvas } = installCanvas();
    let active = 0;
    let maximumActive = 0;
    const firstClose = vi.fn(() => { active -= 1; });
    const decoder = vi.fn(async (file: File) => {
      if (file.name === 'decode-failure.png') throw new Error('synthetic decode failure');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return { width: 4, height: 4, close: firstClose };
    });
    vi.stubGlobal('createImageBitmap', decoder);

    await expect(renderImageStitchPreview([
      source(pngHeader('first.png', 4, 4)),
      source(pngHeader('decode-failure.png', 4, 4)),
    ], 'vertical')).rejects.toThrow('synthetic decode failure');

    expect(decoder).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(active).toBe(0);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('aborts after decode and disposes the bitmap and canvas', async () => {
    const { canvas } = installCanvas();
    const controller = new AbortController();
    const close = vi.fn();
    const decoder = vi.fn(async () => {
      controller.abort();
      return { width: 4, height: 4, close };
    });
    vi.stubGlobal('createImageBitmap', decoder);

    await expect(renderImageStitchPreview([
      source(pngHeader('first.png', 4, 4)),
      source(pngHeader('second.png', 4, 4)),
    ], 'vertical', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(decoder).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });
});
