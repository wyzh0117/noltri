import { createIntakeDerivedAsset } from './intake-session';
import type { IntakeDerivedAsset, IntakeImage } from './intake-session';
import { renderImageAnnotationPreview, renderImageRotationPreview } from './image-composition';
import { annotationSignature, imageEditSignature } from './image-edit-model';
import type { ImageStitchDirection } from './image-edit-model';

export interface IntakeStitchDerivativePreview {
  blob: Blob;
  direction: ImageStitchDirection;
  sourceAssetIds: string[];
}

export interface IntakeAnnotationDerivativePreview {
  assetId: string;
  signature: string;
  blob: Blob;
}

/** Prepare immutable PNG outputs from the current edits. The stitch Blob is the one already shown in preview. */
export async function prepareIntakeDerivedAssets(
  images: readonly IntakeImage[],
  stitchPreview?: IntakeStitchDerivativePreview,
  createId?: () => string,
  previousAssets: readonly IntakeDerivedAsset[] = [],
  annotationPreviews: readonly IntakeAnnotationDerivativePreview[] = [],
): Promise<IntakeDerivedAsset[]> {
  const derivedAssets: IntakeDerivedAsset[] = [];
  for (const image of images) {
    if (image.edit.annotations.length > 0) {
      const signature = imageEditSignature(image.edit);
      const reusable = previousAssets.find((asset) => asset.operation === 'annotate'
        && asset.sourceAssetIds.length === 1
        && asset.sourceAssetIds[0] === image.assetId
        && (asset.rotationDegrees ?? 0) === image.edit.rotationDegrees
        && annotationSignature(asset.annotations ?? []) === annotationSignature(image.edit.annotations)
        && asset.mimeType === 'image/png');
      if (reusable !== undefined) {
        derivedAssets.push(reusable);
        continue;
      }
      const preview = annotationPreviews.find((candidate) => candidate.assetId === image.assetId && candidate.signature === signature);
      const rendered = preview === undefined
        ? await renderImageAnnotationPreview({
          assetId: image.assetId,
          file: image.file,
          rotationDegrees: image.edit.rotationDegrees,
          annotations: image.edit.annotations,
        })
        : { blob: preview.blob, mimeType: 'image/png' as const };
      derivedAssets.push(createIntakeDerivedAsset({
        operation: 'annotate',
        sourceAssetIds: [image.assetId],
        ...(image.edit.rotationDegrees === 0 ? {} : { rotationDegrees: image.edit.rotationDegrees }),
        annotations: image.edit.annotations.map((annotation) => ({ ...annotation })),
        blob: rendered.blob,
        mimeType: rendered.mimeType,
      }, createId));
      continue;
    }
    if (image.edit.rotationDegrees === 0) continue;
    const reusable = previousAssets.find((asset) => asset.operation === 'rotate'
      && asset.sourceAssetIds.length === 1
      && asset.sourceAssetIds[0] === image.assetId
      && asset.rotationDegrees === image.edit.rotationDegrees
      && asset.mimeType === 'image/png');
    if (reusable !== undefined) {
      derivedAssets.push(reusable);
      continue;
    }
    const rendered = await renderImageRotationPreview({
      assetId: image.assetId,
      file: image.file,
      rotationDegrees: image.edit.rotationDegrees,
    });
    derivedAssets.push(createIntakeDerivedAsset({
      operation: 'rotate',
      sourceAssetIds: [image.assetId],
      rotationDegrees: image.edit.rotationDegrees,
      blob: rendered.blob,
      mimeType: rendered.mimeType,
    }, createId));
  }
  if (stitchPreview !== undefined) {
    const reusable = previousAssets.find((asset) => asset.operation === 'stitch'
      && asset.direction === stitchPreview.direction
      && asset.blob === stitchPreview.blob
      && asset.mimeType === 'image/png'
      && asset.sourceAssetIds.length === stitchPreview.sourceAssetIds.length
      && asset.sourceAssetIds.every((assetId, index) => assetId === stitchPreview.sourceAssetIds[index]));
    if (reusable !== undefined) {
      derivedAssets.push(reusable);
      return derivedAssets;
    }
    derivedAssets.push(createIntakeDerivedAsset({
      operation: 'stitch',
      sourceAssetIds: [...stitchPreview.sourceAssetIds],
      direction: stitchPreview.direction,
      blob: stitchPreview.blob,
      mimeType: 'image/png',
    }, createId));
  }
  return derivedAssets;
}
