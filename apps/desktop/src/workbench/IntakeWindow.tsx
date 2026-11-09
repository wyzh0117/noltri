import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactElement, FormEvent } from 'react';
import type { CaptureAssetRef, CaptureBatchStatus, CaptureBatchStatusItem, LibraryItemKind } from '@noltri/schema';
import { captureAssetBytesMatchMime, MAX_CAPTURE_ASSET_BYTES, MAX_CAPTURE_TEXT_LENGTH, MIN_CAPTURE_TEXT_LENGTH } from '@noltri/schema';
import type { IntakeShortcutStatus } from '../lib/tauri';
import { DEFAULT_SHORTCUT_BINDINGS, formatShortcutBinding } from './shortcut-bindings';
import { describeError } from './api';
import {
  buildCaptureBatchRequest,
  cancelIntakeWindow,
  applySelectedTextActivation,
  createIntakeSession,
  enqueueIntakeImages,
  remainingIntakeImageSlots,
  moveIntakeImage,
  addImageAnnotation,
  removeIntakeImage,
  rotateIntakeImage,
  retryIntakeItem,
  selectedIntakeImageChanged,
  submitIntakeSession,
  updateIntakeMetadata,
  updateIntakeText,
  undoImageAnnotation,
  validateCaptureImageFiles,
} from './intake-session';
import type { IntakeImage, IntakeSession } from './intake-session';
import type { IntakeApi } from './intake-session';
import { prepareIntakeDerivedAssets } from './intake-derived-assets';
import type { AnnotationPreviewCacheEntry } from './IntakeImageAnnotationEditor';
import { IntakeImageAnnotationEditor } from './IntakeImageAnnotationEditor';
import { imageEditSignature } from './image-edit-model';
import { recordCaptureStage } from '../lib/tauri';
import type { ImageAnnotation } from './image-edit-model';
import { renderImageStitchPreview } from './image-composition';
import type { ImageStitchDirection } from './image-edit-model';
import { captureScreenshotIntoIntake } from './screenshot-entry';
import type {
  ClipboardIntakeAdapter,
  IntakeActivation,
  ScreenshotCaptureFailureStatus,
  ScreenshotIntakeAdapter,
  ScreenshotQueueAdmission,
} from './screenshot-entry';
import { validateImageFileForPreview } from './image-composition';
import './intake-window.css';

interface IntakePath {
  id: string;
  labels: string[];
  title: string;
}

export interface IntakeWindowProps {
  api: IntakeApi;
  paths: IntakePath[];
  onClose: () => void;
  onPersisted: () => void;
  onBusyChange?: (busy: boolean) => void;
  screenshotAdapter?: ScreenshotIntakeAdapter;
  clipboardAdapter?: ClipboardIntakeAdapter;
  activation?: IntakeActivation | null;
  activationError?: { requestId: string; message: string } | null;
  shortcutStatus?: IntakeShortcutStatus;
  onRequestActivation?: (activation: IntakeActivation) => void;
  onActivationComplete?: (requestId: string) => void;
}

interface StitchPreviewView {
  direction: ImageStitchDirection;
  blob: Blob;
  height: number;
  previewUrl: string;
  signature: string;
  sourceAssetIds: string[];
  width: number;
}

interface PendingScreenshotView {
  source: 'screenshot' | 'clipboard';
  image: File;
  clipboardCopied: boolean;
  reason: string;
}

interface QueueImageFilesOutcome {
  accepted: File[];
  rejected: Array<{ file: File; reason: string }>;
}

function imageStitchSignature(images: IntakeImage[], direction: ImageStitchDirection | null): string {
  return JSON.stringify({ direction, images: images.map((image) => [image.assetId, imageEditSignature(image.edit)]) });
}

const KIND_LABELS: Record<LibraryItemKind, string> = {
  knowledge: '知识卡片',
  paper_excerpt: '论文摘录',
  web_page: '网页',
  image: '图片',
};

const STATUS_LABELS: Record<CaptureBatchStatusItem['status'], string> = {
  queued: '排队中',
  assets_saved: '原件已保存，待后续整理',
  processing: '整理中',
  needs_review: '待确认',
  done: '已完成',
  failed: '失败，可重试',
};

function parsePath(input: string): string[] {
  return input.split('/').map((part) => part.trim()).filter((part) => part.length > 0);
}

function isSafeSourceUrl(value: string): boolean {
  if (value.trim() === '') return true;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function statusForImage(session: IntakeSession, image: IntakeImage): string {
  if (session.phase !== 'submitted') {
    if (image.uploadStatus === 'saved') return '原图已保存，等待本批次提交';
    if (image.uploadStatus === 'uncertain') return '上传结果未确认；重试复用原件编号';
    if (image.uploadStatus === 'failed') return '上传失败，可重试';
    return '尚未提交';
  }
  const status = session.batchStatus?.items.find((item) => item.requestId === image.requestId)?.status;
  return status === undefined ? '已提交，等待状态' : STATUS_LABELS[status];
}

function DialogHeading({ onClose, closeDisabled }: { onClose: () => void; closeDisabled: boolean }): ReactElement {
  return (
    <header className="dialog-header intake-heading">
      <div><div className="section-eyebrow">放进知识库</div><h2 id="intake-title">收集资料</h2></div>
      <button type="button" className="dialog-close" aria-label="关闭收集窗口" disabled={closeDisabled} onClick={onClose}>×</button>
    </header>
  );
}

function savedBatchStatus(status: CaptureBatchStatusItem['status']): string {
  return status === 'assets_saved' ? '原件/派生图已保存，待后续整理' : STATUS_LABELS[status];
}

function savedBatchDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function captureAssetSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function derivativeLabel(operation: NonNullable<CaptureBatchStatusItem['derivedAssets']>[number]['operation']): string {
  if (operation === 'stitch') return '拼接派生图';
  if (operation === 'annotate') return '标注派生图';
  return '旋转派生图';
}

function screenshotFailureMessage(status: ScreenshotCaptureFailureStatus, reason?: string): string {
  if (reason !== undefined && reason.trim() !== '') return reason + ' ';
  if (status === 'cancelled') return '已取消截图；';
  if (status === 'permission_denied') return 'macOS 未允许屏幕截图；';
  if (status === 'unsupported') return '截图格式或大小不受支持；';
  if (status === 'empty') return '截图没有图像内容；';
  if (status === 'busy') return '另一次截图仍在进行；';
  return '系统截图失败；';
}

function clipboardFailureMessage(status: 'empty' | 'unsupported' | 'denied' | 'busy' | 'failed', reason?: string): string {
  if (reason !== undefined && reason.trim() !== '') return reason + ' ';
  if (status === 'empty') return '剪贴板为空；';
  if (status === 'unsupported') return '剪贴板内容暂不支持；';
  if (status === 'denied') return 'macOS 未允许读取剪贴板；';
  if (status === 'busy') return '另一次剪贴板快照仍在进行；';
  return '剪贴板读取失败；';
}

function shortcutText(status: IntakeShortcutStatus['screenshot'] | undefined): string {
  if (status === undefined) return '状态检查中';
  if (status === 'registered') return '已启用';
  if (status === 'conflict') return '与其它快捷键冲突，请使用窗口按钮';
  return '不可用，请使用窗口按钮';
}

interface SavedAssetPreview {
  key: string;
  url: string;
  width: number;
  height: number;
  mimeType: CaptureAssetRef['mimeType'];
}

export type SavedBatchAssetRow =
  | { itemRequestId: string; itemOrder: number; assetId: string; role: 'original'; originalOrder?: number }
  | {
    itemRequestId: string;
    itemOrder: number;
    assetId: string;
    role: 'derived';
    operation: NonNullable<CaptureBatchStatusItem['derivedAssets']>[number]['operation'];
    sourceOrders: Array<number | null>;
    direction?: NonNullable<CaptureBatchStatusItem['derivedAssets']>[number]['direction'];
    rotationDegrees?: NonNullable<CaptureBatchStatusItem['derivedAssets']>[number]['rotationDegrees'];
  };

export function listSavedCaptureBatches(api: IntakeApi): Promise<{ batches: CaptureBatchStatus[] }> {
  if (api.listCaptureBatches === undefined) return Promise.reject(new Error('当前连接没有提供已保存批次读取。'));
  return api.listCaptureBatches({ limit: 20 });
}

export function buildSavedBatchAssetRows(batch: CaptureBatchStatus): SavedBatchAssetRow[] {
  const items = [...batch.items].sort((left, right) => left.userOrder - right.userOrder);
  const originalOrders = new Map<string, number>();
  let nextOriginalOrder = 0;
  for (const item of items) {
    if (item.kind === 'text') continue;
    const derivedIds = new Set((item.derivedAssets ?? []).map((asset) => asset.assetId));
    for (const assetId of item.assetIds) {
      if (!derivedIds.has(assetId) && !originalOrders.has(assetId)) originalOrders.set(assetId, ++nextOriginalOrder);
    }
  }
  return items.flatMap((item, itemIndex) => {
    if (item.kind === 'text') return [];
    const derivedById = new Map((item.derivedAssets ?? []).map((asset) => [asset.assetId, asset]));
    return item.assetIds.map((assetId): SavedBatchAssetRow => {
      const derivative = derivedById.get(assetId);
      if (derivative === undefined) return {
        itemRequestId: item.requestId,
        itemOrder: itemIndex + 1,
        assetId,
        role: 'original',
        originalOrder: originalOrders.get(assetId),
      };
      return {
        itemRequestId: item.requestId,
        itemOrder: itemIndex + 1,
        assetId,
        role: 'derived',
        operation: derivative.operation,
        sourceOrders: derivative.sourceAssetIds.map((sourceId) => originalOrders.get(sourceId) ?? null),
        ...(derivative.direction === undefined ? {} : { direction: derivative.direction }),
        ...(derivative.rotationDegrees === undefined ? {} : { rotationDegrees: derivative.rotationDegrees }),
      };
    });
  });
}

export async function loadSavedCaptureAssetPreview(
  api: IntakeApi,
  batchId: string,
  assetId: string,
  expectedSessionId: string,
  isCurrent: () => boolean,
): Promise<{ file: File; width: number; height: number; mimeType: CaptureAssetRef['mimeType'] } | null> {
  if (api.readCaptureAsset === undefined) throw new Error('当前连接没有提供已保存图片读取。');
  if (!isCurrent()) return null;
  const result = await api.readCaptureAsset(batchId, assetId);
  if (!isCurrent()) return null;
  if (result.asset.assetId !== assetId
    || result.asset.sessionId !== expectedSessionId
    || result.bytes.byteLength !== result.asset.byteLength
    || result.bytes.byteLength === 0
    || result.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES
    || !captureAssetBytesMatchMime(result.bytes.subarray(0, Math.min(12, result.bytes.byteLength)), result.asset.mimeType)) {
    throw new Error('图片元数据或内容校验失败。');
  }
  if (await captureAssetSha256(result.bytes) !== result.asset.sha256) throw new Error('图片校验和不匹配。');
  if (!isCurrent()) return null;
  const bytes = result.bytes.slice().buffer as ArrayBuffer;
  const file = new File([bytes], assetId, { type: result.asset.mimeType });
  const dimensions = await validateImageFileForPreview(file);
  return isCurrent() ? { file, ...dimensions, mimeType: result.asset.mimeType } : null;
}

export function replaceSavedPreviewUrl(
  slot: { current: string | null },
  file: File,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): string {
  if (slot.current !== null) urls.revokeObjectURL(slot.current);
  slot.current = urls.createObjectURL(file);
  return slot.current;
}

export function revokeSavedPreviewUrl(
  slot: { current: string | null },
  urls: Pick<typeof URL, 'revokeObjectURL'> = URL,
): void {
  if (slot.current === null) return;
  urls.revokeObjectURL(slot.current);
  slot.current = null;
}

function SavedBatchesViewer({ api, onBack }: { api: IntakeApi; onBack: () => void }): ReactElement {
  const [batches, setBatches] = useState<CaptureBatchStatus[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingAssetId, setLoadingAssetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SavedAssetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const assetRequest = useRef(0);
  const previewUrl = useRef<string | null>(null);
  const canRead = api.listCaptureBatches !== undefined && api.readCaptureAsset !== undefined;
  const selectedBatch = batches.find((batch) => batch.batchId === selectedBatchId);

  function clearPreview(): void {
    assetRequest.current += 1;
    setLoadingAssetId(null);
    revokeSavedPreviewUrl(previewUrl);
    setPreview(null);
  }

  async function refresh(): Promise<void> {
    if (!canRead) return;
    const request = ++listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listSavedCaptureBatches(api);
      if (request !== listRequest.current) return;
      setBatches(result.batches);
      if (selectedBatchId !== null && !result.batches.some((batch) => batch.batchId === selectedBatchId)) {
        setSelectedBatchId(null);
        clearPreview();
      }
    } catch (failure) {
      if (request === listRequest.current) setError('最近批次读取失败：' + describeError(failure));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      listRequest.current += 1;
      assetRequest.current += 1;
      revokeSavedPreviewUrl(previewUrl);
    };
  }, [api]);

  function selectBatch(batchId: string): void {
    if (batchId === selectedBatchId) return;
    clearPreview();
    setError(null);
    setSelectedBatchId(batchId);
  }

  async function showAsset(batchId: string, assetId: string): Promise<void> {
    if (api.readCaptureAsset === undefined) return;
    const key = batchId + ':' + assetId;
    if (preview?.key === key) {
      clearPreview();
      return;
    }
    const request = ++assetRequest.current;
    setLoadingAssetId(assetId);
    setError(null);
    try {
      const loaded = await loadSavedCaptureAssetPreview(api, batchId, assetId, selectedBatchId === batchId ? selectedBatch?.sessionId ?? '' : '',
        () => request === assetRequest.current && selectedBatchId === batchId);
      if (loaded === null || request !== assetRequest.current || selectedBatchId !== batchId) return;
      const url = replaceSavedPreviewUrl(previewUrl, loaded.file);
      setPreview({ key, url, width: loaded.width, height: loaded.height, mimeType: loaded.mimeType });
    } catch (failure) {
      if (request === assetRequest.current) setError('图片读取失败：' + describeError(failure));
    } finally {
      if (request === assetRequest.current) setLoadingAssetId(null);
    }
  }

  if (!canRead) {
    return (
      <section className="intake-saved-batches" aria-label="最近已保存批次">
        <p className="intake-empty-images">当前连接没有提供已保存批次回看。</p>
        <button type="button" className="button-soft" onClick={onBack}>返回收集</button>
      </section>
    );
  }

  const savedAssetRows = selectedBatch === undefined ? [] : buildSavedBatchAssetRows(selectedBatch);
  const savedAssetRowsByItem = new Map<string, SavedBatchAssetRow[]>();
  for (const row of savedAssetRows) {
    const rows = savedAssetRowsByItem.get(row.itemRequestId) ?? [];
    rows.push(row);
    savedAssetRowsByItem.set(row.itemRequestId, rows);
  }

  return (
    <section className="intake-saved-batches" aria-label="最近已保存批次">
      <div className="intake-saved-heading">
        <div><h3>最近已保存批次</h3><p>只读回看原件与派生图；已保存素材待后续整理。</p></div>
        <div>
          <button type="button" className="button-soft" disabled={loading} onClick={() => void refresh()}>{loading ? '正在读取…' : '刷新'}</button>
          <button type="button" className="button-soft" onClick={onBack}>返回收集</button>
        </div>
      </div>
      {error !== null ? <p className="intake-error" role="alert">{error}</p> : null}
      {batches.length === 0 && !loading ? <p className="intake-empty-images">还没有已保存批次。</p> : (
        <ol className="intake-saved-batch-list" aria-label="已保存批次列表">
          {batches.map((batch) => (
            <li key={batch.batchId}>
              <button type="button" aria-pressed={selectedBatchId === batch.batchId} onClick={() => selectBatch(batch.batchId)}>
                <strong>{savedBatchDate(batch.updatedAt)}</strong>
                <span>{batch.items.length} 项 · {batch.items.filter((item) => item.kind !== 'text').length} 项图片素材</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {selectedBatch !== undefined ? (
        <section className="intake-saved-batch-detail" aria-label="已保存批次内容">
          <h4>{savedBatchDate(selectedBatch.createdAt)} · {selectedBatch.items.length} 项</h4>
          <p className="intake-saved-limit">图片状态为“原件/派生图已保存，待后续整理”；此处不会重新提交。</p>
          <ol className="intake-saved-item-list">
            {[...selectedBatch.items].sort((left, right) => left.userOrder - right.userOrder).map((item, itemIndex) => {
              return (
                <li key={item.requestId}>
                  <div className="intake-saved-item-heading">
                    <strong>第 {itemIndex + 1} 项 · {item.kind === 'text' ? '文字' : '图片'}</strong>
                    <span>{savedBatchStatus(item.status)}</span>
                  </div>
                  {item.kind === 'text' ? <p>文字原件已保存；本回看只显示图片文件。</p> : (
                    <ul className="intake-saved-assets">
                      {(savedAssetRowsByItem.get(item.requestId) ?? []).map((row) => {
                        const assetId = row.assetId;
                        const previewKey = selectedBatch.batchId + ':' + assetId;
                        const sourceText = row.role === 'original'
                          ? (row.originalOrder === undefined ? '来源顺序未记录' : '原图顺序：第 ' + row.originalOrder + ' 张')
                          : '来源：' + row.sourceOrders.map((order) => order === null ? '未知原图' : '第 ' + order + ' 张').join(' → ');
                        const transformText = row.role === 'derived'
                          ? [
                            row.direction === undefined ? '' : (row.direction === 'horizontal' ? '横向' : '纵向'),
                            row.rotationDegrees === undefined ? '' : '旋转 ' + row.rotationDegrees + '°',
                          ].filter(Boolean).join(' · ')
                          : '';
                        return (
                          <li key={assetId}>
                            <div className="intake-saved-asset-heading">
                          <span>{row.role === 'original'
                                ? (row.originalOrder === undefined ? '原图' : '原图 ' + row.originalOrder)
                                : derivativeLabel(row.operation)}</span>
                              <small>{sourceText}{transformText === '' ? '' : ' · ' + transformText}</small>
                            </div>
                            <button type="button" className="button-soft" disabled={loadingAssetId !== null} onClick={() => void showAsset(selectedBatch.batchId, assetId)}>
                              {loadingAssetId === assetId ? '正在读取图片…' : preview?.key === previewKey ? '隐藏预览' : row.role === 'original' ? '预览原图' : '预览派生图'}
                            </button>
                            {preview?.key === previewKey ? <div className="intake-saved-preview"><img src={preview.url} alt={row.role === 'original' ? '已保存原图' : '已保存派生图'} /><small>{preview.width} × {preview.height} · {preview.mimeType}</small></div> : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

export function IntakeWindow({
  api,
  paths,
  onClose,
  onPersisted,
  onBusyChange = () => undefined,
  screenshotAdapter,
  clipboardAdapter,
  activation = null,
  activationError = null,
  shortcutStatus,
  onRequestActivation,
  onActivationComplete,
}: IntakeWindowProps): ReactElement {
  const [session, setSession] = useState<IntakeSession>(() => createIntakeSession());
  const [panelView, setPanelView] = useState<'compose' | 'saved'>('compose');
  const [busy, setBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [stitchBusy, setStitchBusy] = useState(false);
  const [annotationRenderBusy, setAnnotationRenderBusy] = useState(false);
  const [validatingFiles, setValidatingFiles] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [pendingScreenshot, setPendingScreenshot] = useState<PendingScreenshotView | null>(null);
  const [stitchError, setStitchError] = useState<string | null>(null);
  const [stitchDirection, setStitchDirection] = useState<ImageStitchDirection | null>(null);
  const [stitchPreview, setStitchPreview] = useState<StitchPreviewView | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [subjectPathText, setSubjectPathText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [draggedAssetId, setDraggedAssetId] = useState<string | null>(null);
  const handledActivationIds = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(session);
  const busyRef = useRef(false);
  const pendingFileValidationsRef = useRef(0);
  const validationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const stitchPreviewUrlRef = useRef<string | null>(null);
  const annotationPreviewsRef = useRef<Map<string, AnnotationPreviewCacheEntry>>(new Map());
  sessionRef.current = session;

  function changeSession(update: (current: IntakeSession) => IntakeSession): void {
    const next = update(sessionRef.current);
    sessionRef.current = next;
    setSession(next);
  }

  useEffect(() => () => {
    for (const image of sessionRef.current.images) {
      if (image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
    }
    if (stitchPreviewUrlRef.current !== null) URL.revokeObjectURL(stitchPreviewUrlRef.current);
  }, []);

  useEffect(() => {
    if (activation === null || handledActivationIds.current.has(activation.requestId)) return;
    handledActivationIds.current.add(activation.requestId);
    if (handledActivationIds.current.size > 128) {
      const oldest = handledActivationIds.current.values().next().value as string | undefined;
      if (oldest !== undefined) handledActivationIds.current.delete(oldest);
    }
    setPanelView('compose');
    const work = activation.action === 'capture'
      ? captureScreenshot(activation.requestId)
      : activation.action === 'selectedText'
        ? Promise.resolve().then(() => {
          const result = applySelectedTextActivation(sessionRef.current, activation);
          if (!result.accepted) {
            setCaptureNotice(result.reason === 'draft_exists'
              ? '当前收集草稿已有内容，已保留原草稿；请先完成或取消后再收集选区。'
              : '当前收集窗口无法接收此选区，请重试。');
            return;
          }
          if (!result.duplicate) changeSession(() => result.session);
          setCaptureNotice(result.duplicate ? '这段选区已加入当前收集窗口。' : `已将来自 ${activation.sourceApp} 的原文放入收集窗口。`);
        })
        : clipboardAdapter === undefined
          ? Promise.resolve()
          : readClipboardSnapshot(activation.requestId);
    void work
      .catch((error: unknown) => setCaptureNotice('收集操作失败；现有收集内容保留：' + describeError(error)))
      .then(() => onActivationComplete?.(activation.requestId));
  }, [activation?.action, activation?.requestId, clipboardAdapter, onActivationComplete]);

  const locked = busy || captureBusy || stitchBusy || annotationRenderBusy || validatingFiles || session.phase !== 'editing';
  const canSubmit = (session.text.trim().length >= MIN_CAPTURE_TEXT_LENGTH || session.images.length > 0) && pendingScreenshot === null;
  const canClose = !busy && !captureBusy && !stitchBusy && pendingFileValidationsRef.current === 0;

  function setOperationBusy(next: boolean): void {
    busyRef.current = next;
    setBusy(next);
    onBusyChange(next || pendingFileValidationsRef.current > 0);
  }

  function updateMetadata(patch: Parameters<typeof updateIntakeMetadata>[1]): void {
    changeSession((current) => updateIntakeMetadata(current, patch));
  }

  const updateAnnotationPreview = useCallback((preview: AnnotationPreviewCacheEntry | null, _busy: boolean) => {
    setAnnotationRenderBusy(_busy);
    if (preview === null) return;
    annotationPreviewsRef.current.clear();
    annotationPreviewsRef.current.set(preview.assetId, preview);
  }, []);

  function close(): void {
    if (busyRef.current || pendingFileValidationsRef.current > 0) return;
    cancelIntakeWindow(onClose);
  }

  function queueImageFiles(files: File[]): Promise<QueueImageFilesOutcome> {
    if (files.length === 0) return Promise.resolve({ accepted: [], rejected: [] });
    setFormError(null);
    pendingFileValidationsRef.current += 1;
    setValidatingFiles(true);
    onBusyChange(true);
    const validation = validationQueueRef.current.then(async (): Promise<QueueImageFilesOutcome> => {
      const result = await validateCaptureImageFiles(files);
      const currentImages = sessionRef.current.images;
      const queued = enqueueIntakeImages(sessionRef.current, result.accepted);
      if (selectedIntakeImageChanged(currentImages, queued.session.images, selectedImageId)) setAnnotationRenderBusy(true);
      changeSession(() => queued.session);
      const rejected = [...result.rejected, ...queued.rejected];
      if (rejected.length > 0) setFormError(rejected.map(({ file, reason }) => `${file.name}：${reason}`).join('；'));
      const accepted = result.accepted.filter((file) => !queued.rejected.some((entry) => entry.file === file));
      return { accepted, rejected };
    }).catch((error: unknown): QueueImageFilesOutcome => {
      const reason = describeError(error);
      setFormError(reason);
      return { accepted: [], rejected: files.map((file) => ({ file, reason })) };
    }).finally(() => {
      pendingFileValidationsRef.current = Math.max(0, pendingFileValidationsRef.current - 1);
      const stillValidating = pendingFileValidationsRef.current > 0;
      setValidatingFiles(stillValidating);
      onBusyChange(busyRef.current || stillValidating);
    });
    validationQueueRef.current = validation.then(() => undefined);
    return validation;
  }

  function addImages(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    queueImageFiles(files);
  }

  async function captureScreenshot(requestId = 'ui-' + crypto.randomUUID()): Promise<void> {
    const captureStartedAt = performance.now();
    if (screenshotAdapter === undefined) {
      setCaptureNotice('当前版本没有可用的系统截图入口；现有收集内容保留。');
      return;
    }
    if (busyRef.current || pendingFileValidationsRef.current > 0 || pendingScreenshot !== null) {
      setCaptureNotice('当前收集窗口正在处理内容，未启动新截图；现有队列保留。');
      return;
    }
    setFormError(null);
    setCaptureNotice(null);
    setOperationBusy(true);
    setCaptureBusy(true);
    try {
      const outcome = await captureScreenshotIntoIntake(
        screenshotAdapter,
        requestId,
        () => remainingIntakeImageSlots(sessionRef.current) > 0,
        async (image): Promise<ScreenshotQueueAdmission> => {
          const queued = await queueImageFiles([image]);
          const rejection = queued.rejected.find((entry) => entry.file === image);
          const accepted = queued.accepted.includes(image);
          recordCaptureStage(requestId, 'queue_enqueue', performance.now() - captureStartedAt, accepted ? undefined : 'queue_rejected');
          return accepted
            ? { accepted: true }
            : { accepted: false, reason: rejection?.reason ?? '图片未能加入队列。' };
        },
      );
      if (outcome.status === 'capacity_full') {
        recordCaptureStage(requestId, 'queue_enqueue', performance.now() - captureStartedAt, 'queue_rejected');
        setCaptureNotice('当前批次已满，尚未截图或写入剪贴板。请先移除队列中的图片。');
        return;
      }

      if (outcome.status === 'cancelled' || outcome.status === 'permission_denied'
        || outcome.status === 'unsupported' || outcome.status === 'empty'
        || outcome.status === 'busy' || outcome.status === 'failed') {
        setCaptureNotice(screenshotFailureMessage(outcome.status, outcome.reason) + '现有收集内容保留。');
        return;
      }
      if (outcome.status === 'queued') {
        setFormError(null);
        setCaptureNotice(outcome.clipboardCopied
          ? '截图已复制到剪贴板，并加入当前收集窗口的图片队列。'
          : '截图已加入当前收集窗口的图片队列；复制到剪贴板失败。');
        return;
      }

      if (outcome.status !== 'pending') return;
      setFormError(null);
      setPendingScreenshot({ source: 'screenshot', image: outcome.image, clipboardCopied: outcome.clipboardCopied, reason: outcome.reason });
      setCaptureNotice(outcome.clipboardCopied
        ? '截图未加入图片队列；原图已保留在此窗口，可修正后重试。'
        : '截图未加入图片队列，复制到剪贴板也失败；原图已保留在此窗口，可修正后重试。');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
        setCaptureNotice('已取消截图；没有图片加入队列。');
      } else {
        setFormError(`截图未能加入收集窗口：${describeError(error)}`);
      }
    } finally {
      setCaptureBusy(false);
      setOperationBusy(false);
      recordCaptureStage(requestId, 'busy_release', performance.now() - captureStartedAt);
    }
  }

  async function readClipboardSnapshot(requestId: string): Promise<void> {
    if (clipboardAdapter === undefined) return;
    if (busyRef.current || pendingFileValidationsRef.current > 0) {
      setCaptureNotice('收集窗口正在处理内容，未读取剪贴板；请稍后重新打开。');
      return;
    }
    if (pendingScreenshot !== null) {
      setCaptureNotice('待处理图片已保留，请先重试或移除，再读取剪贴板；当前收集内容未变更。');
      return;
    }
    setFormError(null);
    setCaptureNotice(null);
    setOperationBusy(true);
    try {
      const snapshot = await clipboardAdapter.snapshot(requestId);
      if (snapshot.status !== 'available') {
        setCaptureNotice(clipboardFailureMessage(snapshot.status, snapshot.reason) + '现有收集内容保留。');
        return;
      }

      let addedText = false;
      let keptExistingText = false;
      if (snapshot.text !== undefined && snapshot.text.trim().length > 0) {
        if (sessionRef.current.text.length === 0) {
          changeSession((current) => updateIntakeText(current, snapshot.text!));
          addedText = true;
        } else {
          keptExistingText = true;
        }
      }
      let addedImage = false;
      if (snapshot.image !== undefined) {
        const queued = await queueImageFiles([snapshot.image]);
        if (queued.accepted.includes(snapshot.image)) {
          addedImage = true;
        } else {
          const reason = queued.rejected.find((entry) => entry.file === snapshot.image)?.reason ?? '剪贴板图片没有加入当前队列。';
          setPendingScreenshot({ source: 'clipboard', image: snapshot.image, clipboardCopied: true, reason });
        }
      }
      const messages = [
        addedText ? '剪贴板文字已放入原文。' : '',
        keptExistingText ? '已有原文已保留，剪贴板文字未覆盖。' : '',
        addedImage ? '剪贴板图片已加入当前队列。' : '',
        snapshot.image !== undefined && !addedImage ? '剪贴板图片已保留在此窗口，可修正队列后重试。' : '',
        snapshot.reason ?? '',
        !addedText && !keptExistingText && !addedImage && snapshot.image === undefined ? '剪贴板没有可加入的文字或图片。' : '',
      ].filter(Boolean);
      setCaptureNotice(messages.join(' '));
    } catch (error) {
      setCaptureNotice('剪贴板读取失败；现有收集内容保留：' + describeError(error));
    } finally {
      setOperationBusy(false);
    }
  }

  async function retryPendingScreenshot(): Promise<void> {
    const pending = pendingScreenshot;
    if (pending === null || busyRef.current || pendingFileValidationsRef.current > 0) return;
    if (remainingIntakeImageSlots(sessionRef.current) <= 0) {
      setPendingScreenshot({ ...pending, reason: `一次最多提交 100 项。请先移除队列中的图片再重试。` });
      return;
    }
    setOperationBusy(true);
    try {
      const outcome = await queueImageFiles([pending.image]);
      const rejection = outcome.rejected.find((entry) => entry.file === pending.image);
      if (outcome.accepted.includes(pending.image)) {
        setPendingScreenshot(null);
        setFormError(null);
        const source = pending.source === 'screenshot' ? '保留的截图' : '保留的剪贴板图片';
        setCaptureNotice(pending.clipboardCopied
          ? source + '已加入当前图片队列。'
          : source + '已加入当前图片队列；此前复制到剪贴板失败。');
      } else {
        const reason = rejection?.reason ?? '图片仍未加入队列。';
        setFormError(null);
        setPendingScreenshot({ ...pending, reason });
        setCaptureNotice((pending.source === 'screenshot' ? '截图' : '剪贴板图片') + '仍未加入队列；原图继续保留在此窗口。');
      }
    } finally {
      setOperationBusy(false);
    }
  }

  function discardPendingScreenshot(): void {
    const source = pendingScreenshot?.source;
    setPendingScreenshot(null);
    setCaptureNotice(source === 'clipboard' ? '已移除待处理剪贴板图片。' : '已移除待处理截图。');
  }

  function requestScreenshotCapture(): void {
    const request = { action: 'capture' as const, requestId: 'ui-' + crypto.randomUUID() };
    if (onRequestActivation !== undefined) onRequestActivation(request);
    else void captureScreenshot(request.requestId);
  }

  function rotateImage(image: IntakeImage): void {
    if (selectedImage?.assetId === image.assetId) setAnnotationRenderBusy(true);
    changeSession((current) => rotateIntakeImage(current, image.assetId));
  }

  function addAnnotation(annotation: ImageAnnotation): void {
    const assetId = selectedImage?.assetId;
    if (assetId === undefined) return;
    setAnnotationRenderBusy(true);
    changeSession((current) => addImageAnnotation(current, assetId, annotation));
  }

  function undoAnnotation(): boolean {
    const current = sessionRef.current;
    const assetId = selectedImage?.assetId;
    if (assetId === undefined || locked || busyRef.current || pendingFileValidationsRef.current > 0 || current.phase !== 'editing') return false;
    const image = current.images.find((entry) => entry.assetId === assetId);
    if (image === undefined || image.edit.annotations.length === 0) return false;
    const next = undoImageAnnotation(current, assetId);
    if (next === current) return false;
    setAnnotationRenderBusy(true);
    changeSession(() => next);
    return true;
  }

  async function createStitchPreview(): Promise<void> {
    if (stitchDirection === null || sessionRef.current.images.length < 2 || busyRef.current || pendingFileValidationsRef.current > 0) return;
    setStitchError(null);
    setOperationBusy(true);
    setStitchBusy(true);
    const direction = stitchDirection;
    const images = sessionRef.current.images.map((image) => ({
      assetId: image.assetId,
      file: image.file,
      rotationDegrees: image.edit.rotationDegrees,
      annotations: image.edit.annotations,
    }));
    const signature = imageStitchSignature(sessionRef.current.images, direction);
    try {
      const rendered = await renderImageStitchPreview(images, direction);
      const previewUrl = URL.createObjectURL(rendered.blob);
      if (signature !== imageStitchSignature(sessionRef.current.images, direction)) {
        URL.revokeObjectURL(previewUrl);
        setStitchError('图片顺序、旋转或标注已变化，请重新生成预览。');
        return;
      }
      if (stitchPreviewUrlRef.current !== null) URL.revokeObjectURL(stitchPreviewUrlRef.current);
      stitchPreviewUrlRef.current = previewUrl;
      setStitchPreview({
        blob: rendered.blob,
        direction,
        height: rendered.height,
        previewUrl,
        signature,
        sourceAssetIds: rendered.sourceAssetIds,
        width: rendered.width,
      });
    } catch (error) {
      setStitchError(describeError(error));
    } finally {
      setStitchBusy(false);
      setOperationBusy(false);
    }
  }

  function removeImage(image: IntakeImage): void {
    if (image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
    changeSession((current) => removeIntakeImage(current, image.assetId));
  }

  function reorderOnDrop(event: DragEvent<HTMLLIElement>, targetAssetId: string): void {
    event.preventDefault();
    if (draggedAssetId === null || draggedAssetId === targetAssetId) return;
    changeSession((current) => moveIntakeImage(current, draggedAssetId, targetAssetId));
    setDraggedAssetId(null);
  }

  function moveByKeyboard(assetId: string, direction: -1 | 1): void {
    changeSession((current) => {
      const index = current.images.findIndex((image) => image.assetId === assetId);
      const targetIndex = index + direction;
      const target = current.images[targetIndex];
      const next = current.images[targetIndex + 1];
      if (index < 0 || targetIndex < 0 || targetIndex >= current.images.length) return current;
      if (direction < 0 && target !== undefined) return moveIntakeImage(current, assetId, target.assetId);
      if (direction > 0 && target !== undefined) {
        return next === undefined ? moveIntakeImage(current, target.assetId, assetId) : moveIntakeImage(current, assetId, next.assetId);
      }
      return current;
    });
  }

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (busyRef.current || annotationRenderBusy || session.phase === 'submitted') return;
    if (pendingFileValidationsRef.current > 0) {
      setFormError('正在检查所选图片；检查完成后再提交，当前文字和图片都会保留。');
      return;
    }
    setFormError(null);
    if (!canSubmit) {
      setFormError('请粘贴至少 8 个字符，或添加图片。');
      return;
    }
    if (!isSafeSourceUrl(session.sourceUrl)) {
      setFormError('来源地址请使用不含账号信息的 http 或 https 链接。');
      return;
    }

    setOperationBusy(true);
    try {
      const snapshot = sessionRef.current;
      let submission = snapshot;
      if (snapshot.request === undefined) {
        const stitchIsCurrent = stitchPreview !== null
          && stitchPreview.signature === imageStitchSignature(snapshot.images, stitchDirection);
        const stitchInput = stitchPreview !== null && stitchIsCurrent
          ? { blob: stitchPreview.blob, direction: stitchPreview.direction, sourceAssetIds: stitchPreview.sourceAssetIds }
          : undefined;
        const derivedAssets = await prepareIntakeDerivedAssets(
          snapshot.images,
          stitchInput,
          undefined,
          snapshot.derivedAssets,
          [...annotationPreviewsRef.current.values()],
        );
        submission = { ...snapshot, derivedAssets };
        buildCaptureBatchRequest(submission);
      }
      const outcome = await submitIntakeSession(submission, api);
      changeSession(() => outcome.session);
      if (outcome.session.phase === 'submitted') onPersisted();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setOperationBusy(false);
    }
  }

  async function retryText(requestId: string): Promise<void> {
    if (busyRef.current || pendingFileValidationsRef.current > 0) return;
    setFormError(null);
    setOperationBusy(true);
    try {
      const outcome = await retryIntakeItem(sessionRef.current, api, requestId);
      changeSession(() => outcome.session);
      if (outcome.error !== undefined) setFormError(outcome.error);
      else onPersisted();
    } finally {
      setOperationBusy(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    if (busyRef.current || pendingFileValidationsRef.current > 0 || session.phase !== 'submitted') return;
    setFormError(null);
    setOperationBusy(true);
    try {
      const batchStatus = await api.getCaptureBatchStatus(sessionRef.current.batchId);
      changeSession((current) => ({ ...current, batchStatus, error: undefined }));
    } catch (error) {
      changeSession((current) => ({ ...current, error: `状态刷新失败：${describeError(error)}` }));
    } finally {
      setOperationBusy(false);
    }
  }

  const savedOriginalCount = session.phase !== 'submitted'
    ? session.images.filter((image) => image.uploadStatus === 'saved').length
    : 0;
  const uncertainOriginalCount = session.phase !== 'submitted'
    ? session.images.filter((image) => image.uploadStatus === 'uncertain').length
    : 0;
  const savedDerivedCount = session.phase !== 'submitted'
    ? session.derivedAssets.filter((asset) => asset.uploadStatus === 'saved').length
    : 0;
  const uncertainDerivedCount = session.phase !== 'submitted'
    ? session.derivedAssets.filter((asset) => asset.uploadStatus === 'uncertain').length
    : 0;
  const stitchPreviewIsCurrent = stitchPreview !== null
    && stitchPreview.signature === imageStitchSignature(session.images, stitchDirection);
  const selectedImage = session.images.find((image) => image.assetId === selectedImageId) ?? session.images[0];
  const failedTextItem = session.batchStatus?.items.find((item) => item.kind === 'text' && item.status === 'failed' && item.retryable);
  const textStatus = session.batchStatus?.items.find((item) => item.kind === 'text');

  return (
    <section className="dialog-content capture-dialog intake-window" aria-labelledby="intake-title">
      <DialogHeading onClose={close} closeDisabled={!canClose} />
      <div className="intake-toolbar">
        <div className="intake-shortcut-status" aria-label="全局快捷键状态">
          <span><kbd>{shortcutStatus?.configurationError && !shortcutStatus.bindings ? '未确认' : formatShortcutBinding(shortcutStatus?.bindings?.screenshot ?? DEFAULT_SHORTCUT_BINDINGS.screenshot)}</kbd> 截图 · {shortcutText(shortcutStatus?.screenshot)}</span>
          <span><kbd>{shortcutStatus?.configurationError && !shortcutStatus.bindings ? '未确认' : formatShortcutBinding(shortcutStatus?.bindings?.openIntake ?? DEFAULT_SHORTCUT_BINDINGS.openIntake)}</kbd> 打开并读取剪贴板 · {shortcutText(shortcutStatus?.openIntake)}</span>
        </div>
        {api.listCaptureBatches !== undefined && api.readCaptureAsset !== undefined
          ? <button type="button" className="button-soft intake-history-button" onClick={() => setPanelView(panelView === 'saved' ? 'compose' : 'saved')}>{panelView === 'saved' ? '返回收集' : '最近已保存批次'}</button>
          : null}
      </div>
      {panelView === 'saved'
        ? <SavedBatchesViewer api={api} onBack={() => setPanelView('compose')} />
        : <>
      <p className="dialog-intro">在此预览并整理图片顺序；旋转、标注与拼接结果在提交时作为派生图单独保存，原图和来源顺序都会保留。</p>
      <form className="capture-form intake-form" aria-label="收集资料表单" onSubmit={(event) => void submit(event)}>
        <div className="intake-main-grid">
          <div className="form-field intake-text-field">
            <label htmlFor="intake-original-text">原文</label>
            <textarea
              id="intake-original-text"
              value={session.text}
              onChange={(event) => changeSession((current) => updateIntakeText(current, event.target.value))}
              maxLength={MAX_CAPTURE_TEXT_LENGTH}
              rows={8}
              placeholder="在此粘贴文字；系统不会替你改写原文。来源信息未知时可以留空。"
              disabled={locked}
            />
            <span className="intake-character-count">{session.text.length.toLocaleString()} / {MAX_CAPTURE_TEXT_LENGTH.toLocaleString()}</span>
          </div>
          <section className="intake-images" aria-labelledby="intake-images-title">
            <div className="intake-section-heading"><div><h3 id="intake-images-title">图片队列</h3><span>单张原图保留；可拖动或使用顺序按钮。</span></div><span>{session.images.length} 张</span></div>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={addImages} disabled={locked} aria-label="添加图片文件" />
            <button type="button" className="button-soft intake-add-images" disabled={locked} onClick={() => fileInputRef.current?.click()}>{validatingFiles ? '正在检查图片…' : '添加图片'}</button>
            {screenshotAdapter !== undefined ? <button type="button" className="button-soft intake-capture-screen" disabled={locked || pendingScreenshot !== null} onClick={requestScreenshotCapture}>{captureBusy ? '正在截图…' : '截图并放入当前窗口'}</button> : null}
            {activationError !== null ? <p className="intake-capture-notice" role="status">{activationError.message}</p> : captureNotice !== null ? <p className="intake-capture-notice" role="status">{captureNotice}</p> : null}
            {pendingScreenshot !== null ? (
              <section className="intake-pending-screenshot" aria-label="待处理图片">
                <strong>{pendingScreenshot.image.name}</strong>
                <span>{pendingScreenshot.source === 'screenshot' ? '截图' : '剪贴板图片'} · {Math.max(1, Math.ceil(pendingScreenshot.image.size / 1024))} KB · 原图保留在此窗口</span>
                <p>{pendingScreenshot.reason}</p>
                <div>
                  <button type="button" className="button-soft" disabled={locked} onClick={() => void retryPendingScreenshot()}>重试加入队列</button>
                  <button type="button" className="button-soft" disabled={locked} onClick={discardPendingScreenshot}>移除待处理图片</button>
                </div>
              </section>
            ) : null}
            {session.images.length === 0 ? <p className="intake-empty-images">尚未添加图片。</p> : (
              <ol className="intake-image-list" aria-label="待收图片队列">
                {session.images.map((image, index) => (
                  <li
                    className={`intake-image-row${draggedAssetId === image.assetId ? ' intake-image-row-dragging' : ''}${selectedImage?.assetId === image.assetId ? ' intake-image-row-selected' : ''}`}
                    key={image.assetId}
                    draggable={!locked}
                    onDragStart={(event) => { event.dataTransfer.setData('text/plain', image.assetId); event.dataTransfer.effectAllowed = 'move'; setDraggedAssetId(image.assetId); }}
                    onDragEnd={() => setDraggedAssetId(null)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(event) => reorderOnDrop(event, image.assetId)}
                  >
                    <span className="intake-image-number" aria-label={`第 ${index + 1} 张`}>{index + 1}</span>
                    <img src={image.previewUrl} alt="" className="intake-image-preview" draggable={false} style={{ transform: `rotate(${image.edit.rotationDegrees}deg)` }} />
                    <div className="intake-image-copy"><strong title={image.name}>{image.name}</strong><span>{Math.max(1, Math.ceil(image.file.size / 1024))} KB · {statusForImage(session, image)}</span></div>
                    <div className="intake-image-actions">
                      <button type="button" aria-label={`编辑标注 ${image.name}`} title="在此窗口编辑标注" disabled={locked} onClick={() => { if (selectedImage?.assetId !== image.assetId) setAnnotationRenderBusy(true); setSelectedImageId(image.assetId); }}>标注</button>
                      <button type="button" aria-label={`旋转 ${image.name} 90 度`} title="顺时针旋转 90°" disabled={locked} onClick={() => rotateImage(image)}>旋转 90°</button>
                      <button type="button" aria-label={`上移 ${image.name}`} title="上移" disabled={locked || index === 0} onClick={() => moveByKeyboard(image.assetId, -1)}>↑</button>
                      <button type="button" aria-label={`下移 ${image.name}`} title="下移" disabled={locked || index === session.images.length - 1} onClick={() => moveByKeyboard(image.assetId, 1)}>↓</button>
                      <button type="button" aria-label={`移除 ${image.name}`} title="移除" disabled={locked} onClick={() => removeImage(image)}>×</button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {selectedImage !== undefined ? <IntakeImageAnnotationEditor
              key={selectedImage.assetId}
              image={selectedImage}
              disabled={locked}
              onAdd={addAnnotation}
              onUndo={undoAnnotation}
              onPreviewState={updateAnnotationPreview}
            /> : null}
            <section className="intake-stitch" aria-labelledby="intake-stitch-title">
              <div className="intake-section-heading"><div><h3 id="intake-stitch-title">拼接预览</h3><span>可选派生预览；不缩放，纵向左对齐、横向顶对齐，空白透明。</span></div></div>
              <div className="intake-stitch-controls" role="group" aria-label="拼接方向">
                <button type="button" className={stitchDirection === 'vertical' ? 'button-soft intake-stitch-direction-active' : 'button-soft'} aria-pressed={stitchDirection === 'vertical'} disabled={locked} onClick={() => setStitchDirection('vertical')}>纵向</button>
                <button type="button" className={stitchDirection === 'horizontal' ? 'button-soft intake-stitch-direction-active' : 'button-soft'} aria-pressed={stitchDirection === 'horizontal'} disabled={locked} onClick={() => setStitchDirection('horizontal')}>横向</button>
                <button type="button" className="button-soft" disabled={locked || stitchDirection === null || session.images.length < 2} onClick={() => void createStitchPreview()}>{stitchBusy ? '正在生成…' : '生成预览'}</button>
              </div>
              {stitchError !== null ? <p className="intake-error" role="alert">{stitchError}</p> : null}
              {stitchPreview !== null && stitchPreviewIsCurrent ? (
                <div className="intake-stitch-result">
                  <img src={stitchPreview.previewUrl} alt={`${stitchPreview.direction === 'vertical' ? '纵向' : '横向'}拼接预览`} />
                  <span>{stitchPreview.width} × {stitchPreview.height} · PNG · 来源 {stitchPreview.sourceAssetIds.length} 张</span>
                  <small>提交会保存这份拼接预览作为派生图，并保留各张原图。</small>
                </div>
              ) : null}
              {stitchPreview !== null && !stitchPreviewIsCurrent ? <p className="intake-preview-stale" role="status">队列顺序、旋转或标注已变化，请重新生成预览。</p> : null}
            </section>
          </section>
        </div>

        <div className="form-field">
          <label>资料类型</label>
          <div className="kind-picker" role="group" aria-label="选择资料类型">
            {(['knowledge', 'paper_excerpt', 'web_page', 'image'] as const).map((kind) => (
              <button key={kind} type="button" className={session.kind === kind ? 'kind-option kind-option-active' : 'kind-option'} aria-pressed={session.kind === kind} disabled={locked} onClick={() => updateMetadata({ kind })}>{KIND_LABELS[kind]}</button>
            ))}
          </div>
        </div>
        <div className="form-two-column">
          <div className="form-field"><label htmlFor="intake-source-type">来源类型</label>
            <select id="intake-source-type" value={session.sourceType} disabled={locked} onChange={(event) => updateMetadata({ sourceType: event.target.value as IntakeSession['sourceType'] })}>
              <option value="manual">手动摘录</option><option value="web">网页</option><option value="agent">Agent 对话</option><option value="desktop_app">桌面应用</option>
            </select>
          </div>
          <div className="form-field"><label htmlFor="intake-source-title">标题 <span>可留空</span></label><input id="intake-source-title" value={session.sourceTitle} maxLength={600} disabled={locked} onChange={(event) => updateMetadata({ sourceTitle: event.target.value })} placeholder="仅在已知时填写" /></div>
        </div>
        <div className="form-two-column">
          <div className="form-field"><label htmlFor="intake-source-app">来源应用 <span>可留空</span></label><input id="intake-source-app" value={session.sourceApp} maxLength={120} disabled={locked} onChange={(event) => updateMetadata({ sourceApp: event.target.value })} placeholder="由桌面选区填入" /></div>
          <div className="form-field"><label htmlFor="intake-source-url">来源链接 <span>可留空</span></label><input id="intake-source-url" type="url" value={session.sourceUrl} disabled={locked} onChange={(event) => updateMetadata({ sourceUrl: event.target.value })} placeholder="https://…" /></div>
          <div className="form-field"><label htmlFor="intake-subject-path">学科与研究方向 <span>可留空</span></label><input id="intake-subject-path" list="intake-path-options" value={subjectPathText} disabled={locked} onChange={(event) => { setSubjectPathText(event.target.value); updateMetadata({ subjectPath: parsePath(event.target.value) }); }} placeholder="例如：社会科学 / 经济学" /><datalist id="intake-path-options">{paths.map((path) => <option key={path.id} value={path.labels.join(' / ')} />)}</datalist></div>
        </div>
        {session.kind === 'paper_excerpt' ? (
          <>
            <div className="form-field"><label htmlFor="intake-research-point">研究点 <span>可留空</span></label><input id="intake-research-point" value={session.researchPoint} maxLength={1000} disabled={locked} onChange={(event) => updateMetadata({ researchPoint: event.target.value })} placeholder="这段摘录说明了什么？" /></div>
            <details className="citation-fields"><summary>补充论文出处</summary><div className="form-two-column">
              <div className="form-field"><label htmlFor="intake-author">作者</label><input id="intake-author" value={session.author} disabled={locked} onChange={(event) => updateMetadata({ author: event.target.value })} /></div>
              <div className="form-field"><label htmlFor="intake-page">页码</label><input id="intake-page" value={session.page} disabled={locked} onChange={(event) => updateMetadata({ page: event.target.value })} /></div>
              <div className="form-field"><label htmlFor="intake-doi">DOI</label><input id="intake-doi" value={session.doi} disabled={locked} onChange={(event) => updateMetadata({ doi: event.target.value })} /></div>
              <div className="form-field"><label htmlFor="intake-citation">完整引用</label><input id="intake-citation" value={session.citation} disabled={locked} onChange={(event) => updateMetadata({ citation: event.target.value })} /></div>
            </div></details>
          </>
        ) : null}
        <div className="form-field"><label htmlFor="intake-tags">标签 <span>可留空</span></label><input id="intake-tags" value={tagsText} disabled={locked} onChange={(event) => { setTagsText(event.target.value); updateMetadata({ tags: event.target.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean) }); }} placeholder="用逗号分隔" /></div>

        {textStatus !== undefined ? <div className="intake-status-row" role="status"><strong>文字</strong><span>{STATUS_LABELS[textStatus.status]}</span>{textStatus.errorReason ? <small>{textStatus.errorReason}</small> : null}</div> : null}
        {savedOriginalCount + uncertainOriginalCount + savedDerivedCount + uncertainDerivedCount > 0 ? <p className="intake-orphan-notice" role="note">{savedOriginalCount + savedDerivedCount > 0 ? `已确认保存 ${savedOriginalCount} 张原图和 ${savedDerivedCount} 张派生图。` : ''}{uncertainOriginalCount + uncertainDerivedCount > 0 ? `${uncertainOriginalCount} 张原图和 ${uncertainDerivedCount} 张派生图的上传结果未确认，服务端可能已收到。` : ''}批次尚未提交；关闭窗口会丢失本地重试队列，已保存或可能已保存的素材可能未关联批次。</p> : null}
        {session.phase === 'submit_failed' ? <p className="intake-orphan-notice" role="note">批次提交结果未确认。保留此窗口并重试会复用相同 ID，避免重复记录。</p> : null}
        {session.error !== undefined ? <p className="intake-error" role="alert">{session.error}</p> : null}
        {formError !== null ? <p className="intake-error" role="alert">{formError}</p> : null}

        <div className="dialog-actions intake-actions">
          <button type="button" className="button-soft" disabled={!canClose} onClick={close}>取消</button>
          {session.phase === 'submitted' ? <button type="button" className="button-soft" disabled={busy} onClick={() => void refreshStatus()}>刷新状态</button> : null}
          {failedTextItem !== undefined ? <button type="button" className="button-soft" disabled={busy} onClick={() => void retryText(failedTextItem.requestId)}>重试文字整理</button> : null}
          <button type="submit" className="button-primary" disabled={busy || annotationRenderBusy || validatingFiles || session.phase === 'submitted' || !canSubmit}>
            {busy ? '正在提交…' : session.phase === 'submitted' ? '已提交' : session.phase === 'upload_failed' ? '重试未完成上传' : session.phase === 'submit_failed' ? '重试同一批次' : '提交到知序'}
          </button>
        </div>
      </form>
      </>}
    </section>
  );
}
