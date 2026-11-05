import type {
  CaptureAssetRef,
  CaptureAssetMime,
  CaptureDerivedAsset,
  CaptureBatchRequest,
  CaptureBatchStatus,
  CaptureBatchStatusItem,
  CaptureBatchSubmitResult,
  CaptureAssetUploadResult,
  LibraryItemKind,
  SourceType,
} from '@noltri/schema';
import { captureAssetBytesMatchMime, captureBatchRequestSchema, MAX_CAPTURE_ASSET_BYTES, MAX_CAPTURE_BATCH_BODY_BYTES, MAX_CAPTURE_BATCH_ITEMS, MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import { IDENTITY_IMAGE_EDIT, nextImageRotation, rotateAnnotationClockwise } from './image-edit-model';
import type { ImageAnnotation, IntakeImageEdit } from './image-edit-model';

export { buildImageStitchLayout } from './image-edit-model';
export { captureScreenshotForIntake } from './screenshot-entry';
export type { ScreenshotIntakeAdapter, ScreenshotIntakeResult } from './screenshot-entry';

const IMAGE_MIME_TYPES = new Set<CaptureAssetMime>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type IntakeImageUploadStatus = 'pending' | 'saved' | 'failed' | 'uncertain';
export type IntakeDerivedAssetUploadStatus = IntakeImageUploadStatus;
export type IntakePhase = 'editing' | 'upload_failed' | 'submit_failed' | 'submitted';

export interface IntakeImage {
  assetId: string;
  requestId: string;
  file: File;
  edit: IntakeImageEdit;
  name: string;
  mimeType: CaptureAssetMime;
  previewUrl: string;
  sha256?: string;
  uploadStatus: IntakeImageUploadStatus;
  error?: string;
}

export function selectedIntakeImageChanged(
  previousImages: readonly IntakeImage[],
  nextImages: readonly IntakeImage[],
  selectedAssetId: string | null,
): boolean {
  const previousSelected = previousImages.find((image) => image.assetId === selectedAssetId) ?? previousImages[0];
  const nextSelected = nextImages.find((image) => image.assetId === selectedAssetId) ?? nextImages[0];
  return previousSelected?.assetId !== nextSelected?.assetId;
}

export interface IntakeDerivedAsset extends CaptureDerivedAsset {
  blob: Blob;
  mimeType: 'image/png';
  sha256?: string;
  uploadStatus: IntakeDerivedAssetUploadStatus;
  error?: string;
}

export interface IntakeSession {
  sessionId: string;
  batchId: string;
  textRequestId: string;
  capturedAt: string;
  text: string;
  sourceType: SourceType;
  sourceTitle: string;
  sourceUrl: string;
  kind: LibraryItemKind;
  subjectPath: string[];
  researchPoint: string;
  tags: string[];
  author: string;
  citation: string;
  doi: string;
  page: string;
  images: IntakeImage[];
  derivedAssets: IntakeDerivedAsset[];
  phase: IntakePhase;
  request?: CaptureBatchRequest;
  batchStatus?: CaptureBatchStatus;
  error?: string;
}

export interface IntakeSessionOptions {
  createId?: () => string;
  now?: () => string;
}

export interface EnqueueIntakeImagesOptions {
  createId?: () => string;
  createPreviewUrl?: (file: File) => string;
}

export interface EnqueueIntakeImagesResult {
  session: IntakeSession;
  rejected: Array<{ file: File; reason: string }>;
}

export interface IntakeApi {
  uploadCaptureAsset(input: {
    assetId: string;
    sessionId: string;
    mimeType: CaptureAssetMime;
    sha256: string;
    bytes: Uint8Array;
  }): Promise<CaptureAssetUploadResult>;
  createCaptureBatch(input: CaptureBatchRequest): Promise<CaptureBatchSubmitResult>;
  getCaptureBatchStatus(batchId: string): Promise<CaptureBatchStatus>;
  retryCaptureBatchItem(batchId: string, requestId: string): Promise<CaptureBatchStatus>;
  listCaptureBatches?(input?: { limit?: number }): Promise<{ batches: CaptureBatchStatus[] }>;
  readCaptureAsset?(batchId: string, assetId: string): Promise<{ asset: CaptureAssetRef; bytes: Uint8Array }>;
}

export interface IntakeOutcome {
  session: IntakeSession;
  error?: string;
}

function createSecureId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('当前环境无法生成稳定的采集 ID。');
  }
  return `capture-${crypto.randomUUID()}`;
}

export function createIntakeDerivedAsset(
  input: Omit<IntakeDerivedAsset, 'assetId' | 'uploadStatus' | 'sha256' | 'error'>,
  createId: () => string = createSecureId,
): IntakeDerivedAsset {
  return { ...input, assetId: createId(), uploadStatus: 'pending' };
}

export function createIntakeSession(options: IntakeSessionOptions = {}): IntakeSession {
  const createId = options.createId ?? createSecureId;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    sessionId: createId(),
    batchId: createId(),
    textRequestId: createId(),
    capturedAt: now(),
    text: '',
    sourceType: 'manual',
    sourceTitle: '',
    sourceUrl: '',
    kind: 'knowledge',
    subjectPath: [],
    researchPoint: '',
    tags: [],
    author: '',
    citation: '',
    doi: '',
    page: '',
    images: [],
    derivedAssets: [],
    phase: 'editing',
  };
}

function isEditable(session: IntakeSession): boolean {
  return session.phase === 'editing' && session.request === undefined;
}

export async function validateCaptureImageFiles(files: File[]): Promise<{ accepted: File[]; rejected: Array<{ file: File; reason: string }> }> {
  const results = await Promise.all(files.map(async (file): Promise<{ file: File; reason?: string }> => {
    if (!IMAGE_MIME_TYPES.has(file.type as CaptureAssetMime)) return { file, reason: '仅支持 PNG、JPEG、WebP 或 GIF 图片。' };
    if (file.size <= 0 || file.size > MAX_CAPTURE_ASSET_BYTES) return { file, reason: '图片大小必须在 1 字节至 20 MiB 之间。' };
    try {
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (!captureAssetBytesMatchMime(header, file.type as CaptureAssetMime)) return { file, reason: '图片内容与文件格式不匹配，未加入队列。' };
    } catch {
      return { file, reason: '无法读取图片内容，未加入队列。' };
    }
    return { file };
  }));
  return {
    accepted: results.filter((result) => result.reason === undefined).map(({ file }) => file),
    rejected: results.filter((result): result is { file: File; reason: string } => result.reason !== undefined),
  };
}

function isDefinitiveUploadRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500;
}

export function updateIntakeText(session: IntakeSession, text: string): IntakeSession {
  return isEditable(session) ? { ...session, text } : session;
}

export function updateIntakeMetadata(
  session: IntakeSession,
  update: Partial<Pick<IntakeSession, 'sourceType' | 'sourceTitle' | 'sourceUrl' | 'kind' | 'subjectPath' | 'researchPoint' | 'tags' | 'author' | 'citation' | 'doi' | 'page'>>,
): IntakeSession {
  return isEditable(session) ? { ...session, ...update } : session;
}

export function enqueueIntakeImages(
  session: IntakeSession,
  files: File[],
  options: EnqueueIntakeImagesOptions = {},
): EnqueueIntakeImagesResult {
  if (!isEditable(session)) return { session, rejected: files.map((file) => ({ file, reason: '提交中的队列已锁定。' })) };
  const createId = options.createId ?? createSecureId;
  const createPreviewUrl = options.createPreviewUrl ?? ((file: File) => URL.createObjectURL(file));
  const images = [...session.images];
  const rejected: EnqueueIntakeImagesResult['rejected'] = [];
  const maxImages = MAX_CAPTURE_BATCH_ITEMS - (session.text.trim().length >= MIN_CAPTURE_TEXT_LENGTH ? 1 : 0);

  for (const file of files) {
    if (images.length >= maxImages) {
      rejected.push({ file, reason: `一次最多提交 ${MAX_CAPTURE_BATCH_ITEMS} 项。` });
      continue;
    }
    if (!IMAGE_MIME_TYPES.has(file.type as CaptureAssetMime)) {
      rejected.push({ file, reason: '仅支持 PNG、JPEG、WebP 或 GIF 图片。' });
      continue;
    }
    if (file.size <= 0 || file.size > MAX_CAPTURE_ASSET_BYTES) {
      rejected.push({ file, reason: '图片大小必须在 1 字节至 20 MiB 之间。' });
      continue;
    }
    images.push({
      assetId: createId(),
      requestId: createId(),
      file,
      edit: IDENTITY_IMAGE_EDIT,
      name: file.name,
      mimeType: file.type as CaptureAssetMime,
      previewUrl: createPreviewUrl(file),
      uploadStatus: 'pending',
    });
  }

  return { session: { ...session, images }, rejected };
}

export function remainingIntakeImageSlots(session: Pick<IntakeSession, 'text' | 'images'>): number {
  const textItemCount = session.text.trim().length >= MIN_CAPTURE_TEXT_LENGTH ? 1 : 0;
  return Math.max(0, MAX_CAPTURE_BATCH_ITEMS - textItemCount - session.images.length);
}

export function moveIntakeImage(session: IntakeSession, assetId: string, beforeAssetId: string): IntakeSession {
  if (!isEditable(session) || assetId === beforeAssetId) return session;
  const from = session.images.findIndex((image) => image.assetId === assetId);
  const to = session.images.findIndex((image) => image.assetId === beforeAssetId);
  if (from < 0 || to < 0) return session;
  const images = [...session.images];
  const [image] = images.splice(from, 1);
  if (image === undefined) return session;
  images.splice(images.findIndex((entry) => entry.assetId === beforeAssetId), 0, image);
  return { ...session, images, derivedAssets: [] };
}

export function rotateIntakeImage(session: IntakeSession, assetId: string): IntakeSession {
  if (!isEditable(session)) return session;
  const image = session.images.find((entry) => entry.assetId === assetId);
  if (image === undefined) return session;
  return {
    ...session,
    derivedAssets: [],
    images: session.images.map((entry) => entry.assetId === assetId
      ? { ...entry, edit: { rotationDegrees: nextImageRotation(entry.edit.rotationDegrees), annotations: entry.edit.annotations.map(rotateAnnotationClockwise) } }
      : entry),
  };
}

export function addImageAnnotation(session: IntakeSession, assetId: string, annotation: ImageAnnotation): IntakeSession {
  if (!isEditable(session)) return session;
  if (!session.images.some((image) => image.assetId === assetId)) return session;
  return {
    ...session,
    derivedAssets: [],
    images: session.images.map((image) => image.assetId === assetId
      ? { ...image, edit: { ...image.edit, annotations: [...image.edit.annotations, annotation] } }
      : image),
  };
}

export function undoImageAnnotation(session: IntakeSession, assetId: string): IntakeSession {
  if (!isEditable(session)) return session;
  const image = session.images.find((entry) => entry.assetId === assetId);
  if (image === undefined || image.edit.annotations.length === 0) return session;
  return {
    ...session,
    derivedAssets: [],
    images: session.images.map((entry) => entry.assetId === assetId
      ? { ...entry, edit: { ...entry.edit, annotations: entry.edit.annotations.slice(0, -1) } }
      : entry),
  };
}

export function removeIntakeImage(session: IntakeSession, assetId: string): IntakeSession {
  if (!isEditable(session)) return session;
  const images = session.images.filter((image) => image.assetId !== assetId);
  return images.length === session.images.length ? session : { ...session, images, derivedAssets: [] };
}

function captureSource(session: IntakeSession) {
  const title = session.sourceTitle.trim();
  const url = session.sourceUrl.trim();
  return {
    type: session.sourceType,
    ...(title.length === 0 ? {} : { title }),
    ...(url.length === 0 ? {} : { url }),
  };
}

function captureLibrary(session: IntakeSession) {
  return {
    kind: session.kind,
    ...(session.subjectPath.length === 0 ? {} : { subjectPath: [...session.subjectPath] }),
    ...(session.researchPoint.trim().length === 0 ? {} : { researchPoint: session.researchPoint.trim() }),
    ...(session.tags.length === 0 ? {} : { tags: [...session.tags] }),
    ...(session.author.trim().length === 0 ? {} : { author: session.author.trim() }),
    ...(session.citation.trim().length === 0 ? {} : { citation: session.citation.trim() }),
    ...(session.doi.trim().length === 0 ? {} : { doi: session.doi.trim() }),
    ...(session.page.trim().length === 0 ? {} : { page: session.page.trim() }),
  };
}

export function buildCaptureBatchRequest(session: IntakeSession): CaptureBatchRequest {
  if (session.request !== undefined) return session.request;
  const trimmedTextLength = session.text.trim().length;
  if (session.text.length > 0 && trimmedTextLength < MIN_CAPTURE_TEXT_LENGTH) {
    throw new Error(`文字至少需要 ${MIN_CAPTURE_TEXT_LENGTH} 个有效字符；已粘贴的原文不会被静默丢弃。`);
  }
  const hasText = trimmedTextLength >= MIN_CAPTURE_TEXT_LENGTH;
  if (!hasText && session.images.length === 0) throw new Error('请粘贴至少 8 个字符，或添加图片。');

  const source = captureSource(session);
  const capture = { capturedAt: session.capturedAt, client: 'desktop' as const };
  const library = captureLibrary(session);
  const items: CaptureBatchRequest['items'] = [];
  let userOrder = 0;

  if (hasText) {
    items.push({
      requestId: session.textRequestId,
      kind: 'text',
      userOrder: userOrder++,
      text: session.text,
      assetIds: [],
      source,
      capture,
      library,
    });
  }
  for (const image of session.images) {
    const derivedAssets = (session.derivedAssets ?? [])
      .filter((asset) => asset.sourceAssetIds[0] === image.assetId)
      .map(({ assetId, operation, sourceAssetIds, rotationDegrees, direction, annotations }) => ({
        assetId,
        operation,
        sourceAssetIds,
        ...(rotationDegrees === undefined ? {} : { rotationDegrees }),
        ...(direction === undefined ? {} : { direction }),
        ...(annotations === undefined ? {} : { annotations }),
      }));
    items.push({
      requestId: image.requestId,
      kind: 'image',
      userOrder: userOrder++,
      assetIds: [image.assetId, ...derivedAssets.map((asset) => asset.assetId)],
      ...(derivedAssets.length === 0 ? {} : { derivedAssets }),
      source,
      capture,
      library: { ...library, kind: 'image' },
    });
  }
  const candidate = { batchId: session.batchId, sessionId: session.sessionId, items };
  const parsed = captureBatchRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length === 0 ? '' : ` (${issue?.path.join('.')})`;
    throw new Error(`采集内容校验失败${path}：${issue?.message ?? '请求不符合服务端格式。'}`);
  }
  const requestBytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
  if (requestBytes > MAX_CAPTURE_BATCH_BODY_BYTES) {
    throw new Error(`本批次请求为 ${requestBytes.toLocaleString()} 字节，超过服务端单次上限 ${MAX_CAPTURE_BATCH_BODY_BYTES.toLocaleString()} 字节。请减少本次图片数量或缩短来源信息后再提交；当前窗口中的原文与图片仍保留。`);
  }
  return parsed.data;
}

export function cancelIntakeWindow(onClose: () => void): void {
  onClose();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) throw new Error('当前环境不支持图片校验。');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function updateImage(session: IntakeSession, assetId: string, patch: Partial<IntakeImage>): IntakeSession {
  return {
    ...session,
    images: session.images.map((image) => image.assetId === assetId ? { ...image, ...patch } : image),
  };
}

function updateDerivedAsset(session: IntakeSession, assetId: string, patch: Partial<IntakeDerivedAsset>): IntakeSession {
  return {
    ...session,
    derivedAssets: session.derivedAssets.map((asset) => asset.assetId === assetId ? { ...asset, ...patch } : asset),
  };
}

const inFlightSubmits = new Map<string, Promise<IntakeOutcome>>();
const inFlightRetries = new Map<string, Promise<IntakeOutcome>>();

export function submitIntakeSession(session: IntakeSession, api: IntakeApi): Promise<IntakeOutcome> {
  const inFlight = inFlightSubmits.get(session.sessionId);
  if (inFlight !== undefined) return inFlight;
  if (session.phase === 'submitted') return Promise.resolve({ session });

  const operation = performSubmit(session, api).finally(() => {
    if (inFlightSubmits.get(session.sessionId) === operation) inFlightSubmits.delete(session.sessionId);
  });
  inFlightSubmits.set(session.sessionId, operation);
  return operation;
}

async function performSubmit(session: IntakeSession, api: IntakeApi): Promise<IntakeOutcome> {
  let current: IntakeSession = { ...session, derivedAssets: session.derivedAssets ?? [], request: session.request ?? buildCaptureBatchRequest(session), phase: 'upload_failed', error: undefined };
  for (const original of current.images) {
    const image = current.images.find((candidate) => candidate.assetId === original.assetId)!;
    if (image.uploadStatus === 'saved') continue;
    let uploadStarted = false;
    try {
      const bytes = new Uint8Array(await image.file.arrayBuffer());
      const sha256 = image.sha256 ?? await sha256Hex(bytes);
      current = updateImage(current, image.assetId, { sha256, uploadStatus: 'pending', error: undefined });
      uploadStarted = true;
      await api.uploadCaptureAsset({
        assetId: image.assetId,
        sessionId: current.sessionId,
        mimeType: image.mimeType,
        sha256,
        bytes,
      });
      current = updateImage(current, image.assetId, { sha256, uploadStatus: 'saved', error: undefined });
    } catch (error) {
      const rawMessage = error instanceof Error && error.message.trim().length > 0 ? error.message : '上传失败。';
      const uncertain = uploadStarted && !isDefinitiveUploadRejection(error);
      const message = uncertain ? `${rawMessage}；上传结果未确认，服务端可能已收到该原件。重试会复用相同原件编号。` : rawMessage;
      current = updateImage(current, image.assetId, { uploadStatus: uncertain ? 'uncertain' : 'failed', error: message });
      if (!uncertain) {
        return { session: { ...current, phase: 'editing', request: undefined, error: message }, error: message };
      }
      return { session: { ...current, phase: 'upload_failed', error: message }, error: message };
    }
  }

  for (const original of current.derivedAssets) {
    const asset = current.derivedAssets.find((candidate) => candidate.assetId === original.assetId)!;
    if (asset.uploadStatus === 'saved') continue;
    let uploadStarted = false;
    try {
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_ASSET_BYTES || !captureAssetBytesMatchMime(bytes, asset.mimeType)) {
        throw new Error('派生图片无法读取、大小超限或 PNG 内容无效；原图仍保留，请重新生成预览。');
      }
      const sha256 = asset.sha256 ?? await sha256Hex(bytes);
      current = updateDerivedAsset(current, asset.assetId, { sha256, uploadStatus: 'pending', error: undefined });
      uploadStarted = true;
      await api.uploadCaptureAsset({
        assetId: asset.assetId,
        sessionId: current.sessionId,
        mimeType: asset.mimeType,
        sha256,
        bytes,
      });
      current = updateDerivedAsset(current, asset.assetId, { sha256, uploadStatus: 'saved', error: undefined });
    } catch (error) {
      const rawMessage = error instanceof Error && error.message.trim().length > 0 ? error.message : '上传派生图片失败。';
      const uncertain = uploadStarted && !isDefinitiveUploadRejection(error);
      const message = uncertain ? `${rawMessage}；派生图上传结果未确认，服务端可能已收到该素材。重试会复用相同派生编号。` : rawMessage;
      current = updateDerivedAsset(current, asset.assetId, { uploadStatus: uncertain ? 'uncertain' : 'failed', error: message });
      if (!uncertain) return { session: { ...current, phase: 'editing', request: undefined, error: message }, error: message };
      return { session: { ...current, phase: 'upload_failed', error: message }, error: message };
    }
  }

  try {
    const request = current.request;
    if (request === undefined) throw new Error('采集批次请求未冻结。');
    const created = await api.createCaptureBatch(request);
    let batchStatus = created.batch;
    let error: string | undefined;
    try {
      batchStatus = await api.getCaptureBatchStatus(current.batchId);
    } catch (statusError) {
      error = statusError instanceof Error && statusError.message.trim().length > 0
        ? `已提交，状态刷新失败：${statusError.message}`
        : '已提交，但状态刷新失败。';
    }
    return { session: { ...current, phase: 'submitted', batchStatus, error }, ...(error === undefined ? {} : { error }) };
  } catch (error) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : '提交批次失败。';
    return { session: { ...current, phase: 'submit_failed', error: message }, error: message };
  }
}

export function retryIntakeItem(session: IntakeSession, api: IntakeApi, requestId: string): Promise<IntakeOutcome> {
  const operationId = `${session.batchId}:${requestId}`;
  const inFlight = inFlightRetries.get(operationId);
  if (inFlight !== undefined) return inFlight;
  const item = session.batchStatus?.items.find((entry) => entry.requestId === requestId);
  if (session.phase !== 'submitted' || item?.kind !== 'text' || item.retryable !== true) {
    return Promise.resolve({ session, error: '只有可重试的失败文本项可以单独重试。' });
  }
  const operation = performRetry(session, api, requestId).finally(() => {
    if (inFlightRetries.get(operationId) === operation) inFlightRetries.delete(operationId);
  });
  inFlightRetries.set(operationId, operation);
  return operation;
}

async function performRetry(session: IntakeSession, api: IntakeApi, requestId: string): Promise<IntakeOutcome> {
  try {
    const batchStatus = await api.retryCaptureBatchItem(session.batchId, requestId);
    return { session: { ...session, batchStatus, error: undefined } };
  } catch (error) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : '重试失败。';
    return { session: { ...session, error: message }, error: message };
  }
}

export function getIntakeItemStatus(session: IntakeSession, requestId: string): CaptureBatchStatusItem | undefined {
  return session.batchStatus?.items.find((item) => item.requestId === requestId);
}
