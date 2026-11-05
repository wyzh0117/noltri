export type ImageRotationDegrees = 0 | 90 | 180 | 270;
export type ImageStitchDirection = 'vertical' | 'horizontal';
export type ImageAnnotationTool = 'rectangle' | 'arrow' | 'text' | 'pixelate';

export interface ImageAnnotation {
  type: ImageAnnotationTool;
  /** Normalized coordinates in the image's current rotated orientation. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: 2 | 4 | 6;
  text?: string;
  fontSize?: 18 | 24 | 32;
  textRotationDegrees?: ImageRotationDegrees;
}

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface ImageAnnotationOptions {
  color: string;
  strokeWidth: 2 | 4 | 6;
  text?: string;
  fontSize?: 18 | 24 | 32;
}

export interface IntakeImageEdit {
  rotationDegrees: ImageRotationDegrees;
  annotations: readonly ImageAnnotation[];
}

export interface ImageStitchInput {
  assetId: string;
  width: number;
  height: number;
  rotationDegrees: ImageRotationDegrees;
}

export interface ImageStitchPlacement {
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageStitchLayout {
  direction: ImageStitchDirection;
  width: number;
  height: number;
  sourceAssetIds: string[];
  placements: ImageStitchPlacement[];
}

export const IDENTITY_IMAGE_EDIT: IntakeImageEdit = Object.freeze({ rotationDegrees: 0, annotations: Object.freeze([]) });

const MAX_STITCH_EDGE = 16_384;
const MAX_STITCH_PIXELS = 64_000_000;

export function nextImageRotation(rotationDegrees: ImageRotationDegrees): ImageRotationDegrees {
  return ((rotationDegrees + 90) % 360) as ImageRotationDegrees;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) throw new Error('标注位置无效。');
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

export function createImageAnnotation(
  type: ImageAnnotationTool,
  start: AnnotationPoint,
  end: AnnotationPoint,
  options: ImageAnnotationOptions,
): ImageAnnotation {
  if (!['rectangle', 'arrow', 'text', 'pixelate'].includes(type)) throw new Error('标注工具无效。');
  if (!/^#[0-9a-fA-F]{6}$/.test(options.color)) throw new Error('标注颜色无效。');
  if (![2, 4, 6].includes(options.strokeWidth)) throw new Error('标注线宽无效。');
  const annotation: ImageAnnotation = {
    type,
    x1: clampUnit(start.x),
    y1: clampUnit(start.y),
    x2: clampUnit(end.x),
    y2: clampUnit(end.y),
    color: options.color,
    strokeWidth: options.strokeWidth,
    ...(type === 'text' ? { text: options.text?.slice(0, 200) ?? '', fontSize: options.fontSize ?? 24, textRotationDegrees: 0 as const } : {}),
  };
  if (type === 'text' && annotation.text?.trim() === '') throw new Error('请输入标注文字。');
  return annotation;
}

export function rotateAnnotationClockwise(annotation: ImageAnnotation): ImageAnnotation {
  const rotate = (x: number, y: number): AnnotationPoint => ({
    x: Number((1 - y).toFixed(6)),
    y: Number(x.toFixed(6)),
  });
  const start = rotate(annotation.x1, annotation.y1);
  const end = rotate(annotation.x2, annotation.y2);
  return {
    ...annotation,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    ...(annotation.type === 'text'
      ? { textRotationDegrees: nextImageRotation(annotation.textRotationDegrees ?? 0) }
      : {}),
  };
}

export function annotationSignature(annotations: readonly ImageAnnotation[]): string {
  return JSON.stringify(annotations);
}

export function imageEditSignature(edit: IntakeImageEdit): string {
  return JSON.stringify({ rotationDegrees: edit.rotationDegrees, annotations: edit.annotations });
}

function rotatedSize(input: ImageStitchInput): { width: number; height: number } {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw new Error('图片尺寸必须为正整数。');
  }
  if (![0, 90, 180, 270].includes(input.rotationDegrees)) throw new Error('图片旋转角度无效。');
  return input.rotationDegrees === 90 || input.rotationDegrees === 270
    ? { width: input.height, height: input.width }
    : { width: input.width, height: input.height };
}

export function buildImageStitchLayout(inputs: readonly ImageStitchInput[], direction: ImageStitchDirection): ImageStitchLayout {
  if (inputs.length < 2) throw new Error('至少需要两张图片才能生成拼接预览。');
  if (direction !== 'vertical' && direction !== 'horizontal') throw new Error('请明确选择纵向或横向拼接。');

  const sizes = inputs.map(rotatedSize);
  const width = direction === 'vertical'
    ? Math.max(...sizes.map((size) => size.width))
    : sizes.reduce((total, size) => total + size.width, 0);
  const height = direction === 'vertical'
    ? sizes.reduce((total, size) => total + size.height, 0)
    : Math.max(...sizes.map((size) => size.height));

  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > MAX_STITCH_EDGE || height > MAX_STITCH_EDGE || width * height > MAX_STITCH_PIXELS) {
    throw new Error('拼接预览尺寸过大；请减少图片数量或拆分预览。');
  }

  let offset = 0;
  const placements = inputs.map((input, index): ImageStitchPlacement => {
    const size = sizes[index]!;
    const placement = {
      assetId: input.assetId,
      x: direction === 'horizontal' ? offset : 0,
      y: direction === 'vertical' ? offset : 0,
      width: size.width,
      height: size.height,
    };
    offset += direction === 'horizontal' ? size.width : size.height;
    return placement;
  });

  return { direction, width, height, sourceAssetIds: inputs.map((input) => input.assetId), placements };
}
