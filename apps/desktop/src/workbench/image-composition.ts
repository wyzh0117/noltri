import { MAX_CAPTURE_ASSET_BYTES } from '@noltri/schema';
import { buildImageStitchLayout } from './image-edit-model';
import type { ImageAnnotation, ImageRotationDegrees, ImageStitchDirection, ImageStitchLayout, ImageStitchInput } from './image-edit-model';

export interface ImageStitchSource {
  assetId: string;
  file: File;
  rotationDegrees: ImageRotationDegrees;
  annotations?: readonly ImageAnnotation[];
}

export interface ImageStitchPreview extends ImageStitchLayout {
  blob: Blob;
  mimeType: 'image/png';
}

export interface ImageRotationPreview {
  sourceAssetId: string;
  rotationDegrees: 90 | 180 | 270;
  width: number;
  height: number;
  blob: Blob;
  mimeType: 'image/png';
}

export interface ImageAnnotationPreviewSource extends ImageStitchSource {
  annotations: readonly ImageAnnotation[];
}

export interface ImageAnnotationPreview {
  sourceAssetId: string;
  rotationDegrees: ImageRotationDegrees;
  annotations: readonly ImageAnnotation[];
  width: number;
  height: number;
  blob: Blob;
  mimeType: 'image/png';
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface DecodedImage extends ImageDimensions {
  source: CanvasImageSource;
  dispose: () => void;
}

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_IMAGE_EDGE = 16_384;
const MAX_TOTAL_SOURCE_PIXELS = 64_000_000;

function failHeader(name: string): never {
  throw new Error(`无法安全读取图片尺寸或图片格式不受支持：${name}。原图仍保留，请尝试其他格式。`);
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value)) return null;
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13) return null;
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
  if (bytes.length < 20) return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    return {
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return null;
}

function isJpegSof(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

interface ExifOrientation {
  found: boolean;
  value: number;
}

function readExifOrientation(bytes: Uint8Array, dataOffset: number, dataLength: number): ExifOrientation | null | undefined {
  if (dataLength < 6
    || bytes[dataOffset] !== 0x45 || bytes[dataOffset + 1] !== 0x78
    || bytes[dataOffset + 2] !== 0x69 || bytes[dataOffset + 3] !== 0x66
    || bytes[dataOffset + 4] !== 0 || bytes[dataOffset + 5] !== 0) return undefined;

  const tiffOffset = dataOffset + 6;
  const tiffLength = dataLength - 6;
  if (tiffLength < 8) return null;
  const littleEndian = bytes[tiffOffset] === 0x49 && bytes[tiffOffset + 1] === 0x49;
  const bigEndian = bytes[tiffOffset] === 0x4d && bytes[tiffOffset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + tiffOffset, tiffLength);
  if (view.getUint16(2, littleEndian) !== 42) return null;

  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset > tiffLength - 2) return null;
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const entriesOffset = ifdOffset + 2;
  const entriesLength = entryCount * 12;
  if (!Number.isSafeInteger(entriesLength) || entriesLength > tiffLength - entriesOffset) return null;

  let orientation: number | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    if (view.getUint16(entryOffset, littleEndian) !== 0x0112) continue;
    if (orientation !== null
      || view.getUint16(entryOffset + 2, littleEndian) !== 3
      || view.getUint32(entryOffset + 4, littleEndian) !== 1) return null;
    const value = view.getUint16(entryOffset + 8, littleEndian);
    if (value < 1 || value > 8) return null;
    orientation = value;
  }
  return { found: orientation !== null, value: orientation ?? 1 };
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let orientation = 1;
  let foundOrientation = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (isJpegSof(marker)) {
      if (segmentLength < 8) return null;
      const current = {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
      if (dimensions !== null && (dimensions.width !== current.width || dimensions.height !== current.height)) return null;
      dimensions = current;
    } else if (marker === 0xe1) {
      const parsedOrientation = readExifOrientation(bytes, offset + 2, segmentLength - 2);
      if (parsedOrientation === null) return null;
      if (parsedOrientation?.found) {
        if (foundOrientation) return null;
        orientation = parsedOrientation.value;
        foundOrientation = true;
      }
    }
    offset += segmentLength;
  }
  if (dimensions === null) return null;
  return orientation >= 5 && orientation <= 8
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

function validateDimensions(dimensions: ImageDimensions, name: string): ImageDimensions {
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || !Number.isSafeInteger(width * height)) {
    throw new Error(`图片尺寸无效或过大：${name}。原图仍保留。`);
  }
  return dimensions;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('拼接预览已取消。', 'AbortError');
}

async function inspectImageDimensions(file: File, signal?: AbortSignal): Promise<ImageDimensions> {
  throwIfAborted(signal);
  if (file.size <= 0 || file.size > MAX_CAPTURE_ASSET_BYTES) throw new Error(`图片大小超出预览限制：${file.name}。原图仍保留。`);
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer());
  throwIfAborted(signal);
  const dimensions = readPngDimensions(bytes)
    ?? readGifDimensions(bytes)
    ?? readWebpDimensions(bytes)
    ?? readJpegDimensions(bytes);
  if (dimensions === null) failHeader(file.name);
  return validateDimensions(dimensions, file.name);
}

export async function validateImageFileForPreview(file: File): Promise<ImageDimensions> {
  const dimensions = await inspectImageDimensions(file);
  if (dimensions.width * dimensions.height > MAX_TOTAL_SOURCE_PIXELS) {
    throw new Error('图片总像素超过预览限制；原件仍保留。');
  }
  return dimensions;
}

function abortError(): DOMException {
  return new DOMException('拼接预览已取消。', 'AbortError');
}

async function decodeImage(file: File, dimensions: ImageDimensions, signal?: AbortSignal): Promise<DecodedImage> {
  throwIfAborted(signal);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (signal?.aborted) {
      bitmap.close();
      throw abortError();
    }
    if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) {
      bitmap.close();
      throw new Error(`图片头部尺寸与解码结果不一致：${file.name}。原图仍保留。`);
    }
    return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        element.src = '';
        cleanup();
        reject(abortError());
      };
      element.onload = () => { cleanup(); resolve(element); };
      element.onerror = () => { cleanup(); reject(new Error(`无法解码图片：${file.name}`)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      element.src = objectUrl;
    });
    if (image.naturalWidth !== dimensions.width || image.naturalHeight !== dimensions.height) {
      throw new Error(`图片头部尺寸与解码结果不一致：${file.name}。原图仍保留。`);
    }
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToPng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      canvas.toBlob((blob) => {
        cleanup();
        if (signal?.aborted) {
          reject(abortError());
        } else if (blob === null) {
          reject(new Error('浏览器无法生成图片预览。'));
        } else if (blob.size === 0 || blob.size > MAX_CAPTURE_ASSET_BYTES) {
          reject(new Error(`图片派生结果大小超出 1 字节至 ${MAX_CAPTURE_ASSET_BYTES.toLocaleString()} 字节限制；原图仍保留。`));
        } else {
          resolve(blob);
        }
      }, 'image/png');
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function renderImageRotationPreview(source: ImageStitchSource, signal?: AbortSignal): Promise<ImageRotationPreview> {
  if (source.rotationDegrees === 0) throw new Error('图片无需旋转，不生成重复派生图。');
  const measured = await inspectImageDimensions(source.file, signal);
  const width = source.rotationDegrees === 90 || source.rotationDegrees === 270 ? measured.height : measured.width;
  const height = source.rotationDegrees === 90 || source.rotationDegrees === 270 ? measured.width : measured.height;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_TOTAL_SOURCE_PIXELS) {
    throw new Error(`旋转派生图尺寸过大：${source.file.name}。原图仍保留。`);
  }
  throwIfAborted(signal);
  const decoded = await decodeImage(source.file, measured, signal);
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    if (context === null) throw new Error('浏览器无法创建旋转图片画布。');
    throwIfAborted(signal);
    context.save();
    try {
      context.translate(width / 2, height / 2);
      context.rotate(source.rotationDegrees * Math.PI / 180);
      context.drawImage(decoded.source, -decoded.width / 2, -decoded.height / 2);
    } finally {
      context.restore();
    }
    throwIfAborted(signal);
    const blob = await canvasToPng(canvas, signal);
    throwIfAborted(signal);
    return { sourceAssetId: source.assetId, rotationDegrees: source.rotationDegrees, width, height, blob, mimeType: 'image/png' };
  } finally {
    decoded.dispose();
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function drawImageAnnotation(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  annotation: ImageAnnotation,
  width: number,
  height: number,
  originX = 0,
  originY = 0,
): void {
  const localX1 = annotation.x1 * width;
  const localY1 = annotation.y1 * height;
  const localX2 = annotation.x2 * width;
  const localY2 = annotation.y2 * height;
  const x1 = originX + localX1;
  const y1 = originY + localY1;
  const x2 = originX + localX2;
  const y2 = originY + localY2;
  context.save();
  try {
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = annotation.strokeWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (annotation.type === 'rectangle') {
      context.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (annotation.type === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLength = Math.max(annotation.strokeWidth * 3, Math.min(28, Math.hypot(x2 - x1, y2 - y1) * 0.2));
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.moveTo(x2, y2);
      context.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
      context.moveTo(x2, y2);
      context.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
      context.stroke();
    } else if (annotation.type === 'text') {
      const rotationDegrees = annotation.textRotationDegrees ?? 0;
      const maxLineWidth = rotationDegrees === 0
        ? width - localX1
        : rotationDegrees === 90
          ? height - localY1
          : rotationDegrees === 180
            ? localX1
            : localY1;
      context.font = `600 ${annotation.fontSize ?? 24}px sans-serif`;
      context.textBaseline = 'top';
      context.translate(x1, y1);
      context.rotate(rotationDegrees * Math.PI / 180);
      context.fillText(annotation.text ?? '', 0, 0, Math.max(1, maxLineWidth));
    } else {
      const x = originX + Math.max(0, Math.min(localX1, localX2));
      const y = originY + Math.max(0, Math.min(localY1, localY2));
      const regionWidth = Math.min(originX + width - x, Math.abs(x2 - x1));
      const regionHeight = Math.min(originY + height - y, Math.abs(y2 - y1));
      if (regionWidth < 1 || regionHeight < 1) return;
      const pixelCanvas = document.createElement('canvas');
      const pixelWidth = Math.max(1, Math.ceil(regionWidth / 12));
      const pixelHeight = Math.max(1, Math.ceil(regionHeight / 12));
      pixelCanvas.width = pixelWidth;
      pixelCanvas.height = pixelHeight;
      try {
        const pixelContext = pixelCanvas.getContext('2d', { alpha: true });
        if (pixelContext === null) throw new Error('浏览器无法创建像素化预览。');
        pixelContext.imageSmoothingEnabled = true;
        pixelContext.drawImage(canvas, x, y, regionWidth, regionHeight, 0, 0, pixelWidth, pixelHeight);
        context.imageSmoothingEnabled = false;
        context.drawImage(pixelCanvas, 0, 0, pixelWidth, pixelHeight, x, y, regionWidth, regionHeight);
        context.imageSmoothingEnabled = true;
      } finally {
        pixelCanvas.width = 0;
        pixelCanvas.height = 0;
      }
    }
  } finally {
    context.restore();
  }
}

/** Render rotation and annotations from the untouched source. The returned PNG is also the submission derivative. */
export async function renderImageAnnotationPreview(
  source: ImageAnnotationPreviewSource,
  signal?: AbortSignal,
): Promise<ImageAnnotationPreview> {
  const measured = await inspectImageDimensions(source.file, signal);
  const width = source.rotationDegrees === 90 || source.rotationDegrees === 270 ? measured.height : measured.width;
  const height = source.rotationDegrees === 90 || source.rotationDegrees === 270 ? measured.width : measured.height;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_TOTAL_SOURCE_PIXELS) {
    throw new Error(`标注派生图尺寸过大：${source.file.name}。原图仍保留。`);
  }
  throwIfAborted(signal);
  const decoded = await decodeImage(source.file, measured, signal);
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    if (context === null) throw new Error('浏览器无法创建标注图片画布。');
    context.save();
    try {
      context.translate(width / 2, height / 2);
      context.rotate(source.rotationDegrees * Math.PI / 180);
      context.drawImage(decoded.source, -decoded.width / 2, -decoded.height / 2);
    } finally {
      context.restore();
    }
    for (const annotation of source.annotations) {
      throwIfAborted(signal);
      drawImageAnnotation(context, canvas, annotation, width, height);
    }
    throwIfAborted(signal);
    const blob = await canvasToPng(canvas, signal);
    throwIfAborted(signal);
    return {
      sourceAssetId: source.assetId,
      rotationDegrees: source.rotationDegrees,
      annotations: source.annotations,
      width,
      height,
      blob,
      mimeType: 'image/png',
    };
  } finally {
    decoded.dispose();
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function renderImageStitchPreview(
  sources: readonly ImageStitchSource[],
  direction: ImageStitchDirection,
  signal?: AbortSignal,
): Promise<ImageStitchPreview> {
  if (sources.length < 2) throw new Error('至少需要两张图片才能生成拼接预览。');

  const dimensions: ImageStitchInput[] = [];
  let sourcePixels = 0;
  for (const source of sources) {
    const measured = await inspectImageDimensions(source.file, signal);
    sourcePixels += measured.width * measured.height;
    if (!Number.isSafeInteger(sourcePixels) || sourcePixels > MAX_TOTAL_SOURCE_PIXELS) {
      throw new Error('图片组的总像素过大；请减少图片数量或拆分预览。所有原图仍保留。');
    }
    dimensions.push({ assetId: source.assetId, ...measured, rotationDegrees: source.rotationDegrees });
  }

  throwIfAborted(signal);
  const layout = buildImageStitchLayout(dimensions, direction);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  try {
    const context = canvas.getContext('2d', { alpha: true });
    if (context === null) throw new Error('浏览器无法创建拼接画布。');

    for (let index = 0; index < sources.length; index += 1) {
      throwIfAborted(signal);
      const source = sources[index]!;
      const placement = layout.placements[index]!;
      const measured = dimensions[index]!;
      const decoded = await decodeImage(source.file, measured, signal);
      try {
        throwIfAborted(signal);
        context.save();
        try {
          context.translate(placement.x + placement.width / 2, placement.y + placement.height / 2);
          context.rotate(source.rotationDegrees * Math.PI / 180);
          context.drawImage(decoded.source, -decoded.width / 2, -decoded.height / 2);
        } finally {
          context.restore();
        }
        const annotations = source.annotations ?? [];
        if (annotations.length > 0) {
          context.save();
          try {
            context.beginPath();
            context.rect(placement.x, placement.y, placement.width, placement.height);
            context.clip();
            for (const annotation of annotations) {
              throwIfAborted(signal);
              drawImageAnnotation(context, canvas, annotation, placement.width, placement.height, placement.x, placement.y);
            }
          } finally {
            context.restore();
          }
        }
      } finally {
        decoded.dispose();
      }
    }
    throwIfAborted(signal);
    const blob = await canvasToPng(canvas);
    throwIfAborted(signal);
    return { ...layout, blob, mimeType: 'image/png' };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
