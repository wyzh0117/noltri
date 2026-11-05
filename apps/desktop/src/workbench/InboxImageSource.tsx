import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ApiClient } from '@noltri/api-client';
import { captureAssetBytesMatchMime, captureAssetRefSchema, captureImageProvenanceSchema, MAX_CAPTURE_ASSET_BYTES } from '@noltri/schema';
import type { CaptureAssetRef, CaptureBatchStatus, CaptureBatchStatusItem, CaptureProcessingReason, CaptureRecognitionResponse, RawSource } from '@noltri/schema';
import { describeError } from './api';
import { validateImageFileForPreview } from './image-composition';

export type InboxImageApi = Pick<ApiClient, 'captureRecognition' | 'processCaptureBatch' | 'readCaptureAsset' | 'getCaptureBatchStatus' | 'listCaptureBatches'>;
export type ImageActivity = (key: string, state: 'running' | 'processing' | 'uncertain' | 'checking' | 'pending' | 'checked' | 'settled' | 'observed') => void;
interface Actions { api: InboxImageApi; disabled: boolean; onProcessed: () => Promise<void>; onActivity: ImageActivity }
const REASON: Record<CaptureProcessingReason, string> = {
  offline: '当前离线，原图已保存，识别待处理。',
  unsupported: '当前服务不支持图片识别，原图已保留。',
  input_selection_required: '需要人工选择识别输入；当前接口尚不能提交选图，未自动处理。',
  uncertain_recognition: '识别包含不确定内容，需要人工核对。',
  insufficient_text: '识别文字不足，原图仍可查看。',
  recognition_too_long: '识别结果过长，需要人工核对，不会截断原件。',
};
const keyFor = (batchId: string, requestId: string): string => `${batchId}/${requestId}`;
const eligible = (item: CaptureBatchStatusItem): boolean => item.kind !== 'text' && (item.status === 'assets_saved' || (item.status === 'failed' && item.retryable));

export function isImageSource(source: RawSource): boolean {
  const capture = source.metadata.capture;
  return source.metadata.entryPoint === 'capture-image' || (typeof capture === 'object' && capture !== null && 'kind' in capture && (capture.kind === 'image' || capture.kind === 'composite'));
}

function useProcessImage({ api, disabled, onProcessed, onActivity }: Actions) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(batchId: string, requestId: string): Promise<CaptureBatchStatus | null> {
    if (locked.current || disabled) return null;
    locked.current = true;
    setRunning(true);
    setError(null);
    const key = keyFor(batchId, requestId);
    onActivity(key, 'running');
    try {
      // The immutable batch/request pair is reused for a retry; no image or source is resubmitted.
      const result = await api.processCaptureBatch(batchId, { requestIds: [requestId] });
      await onProcessed();
      const selected = result.batchId === batchId ? result.items.find(item => item.requestId === requestId) : undefined;
      // HTTP completion can be a replay of an item whose durable processing claim is still held.
      onActivity(key, !selected || selected.status === 'processing' || selected.status === 'queued' ? 'processing' : 'settled');
      return result;
    } catch (cause) {
      const status = typeof cause === 'object' && cause !== null && 'status' in cause ? cause.status : undefined;
      onActivity(key, typeof status !== 'number' || status >= 500 ? 'uncertain' : 'settled');
      if (mounted.current) setError(describeError(cause));
      return null;
    } finally {
      locked.current = false;
      if (mounted.current) setRunning(false);
    }
  }
  return { running, error, run };
}

async function originalFile(api: InboxImageApi, batchId: string, expected: CaptureAssetRef): Promise<{ file: File; width: number; height: number }> {
  const result = await api.readCaptureAsset(batchId, expected.assetId);
  const asset = captureAssetRefSchema.safeParse(result.asset);
  if (!asset.success || JSON.stringify(asset.data) !== JSON.stringify(expected)
    || result.bytes.byteLength !== expected.byteLength || result.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES
    || !captureAssetBytesMatchMime(result.bytes, expected.mimeType)) throw new Error('图片元数据或内容校验失败。原件仍保留。');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes));
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== expected.sha256) throw new Error('图片校验和不匹配。原件仍保留。');
  const file = new File([new Uint8Array(result.bytes).buffer], expected.assetId, { type: expected.mimeType });
  return { file, ...await validateImageFileForPreview(file) };
}

export function InboxImageSource({ api, source, active, disabled, onProcessed, onActivity }: Actions & { source: RawSource; active: boolean }): ReactElement {
  const parsed = useMemo(() => captureImageProvenanceSchema.safeParse(source.metadata.capture), [source.metadata.capture]);
  const provenance = parsed.success ? parsed.data : null;
  const signature = JSON.stringify(provenance);
  const originals = provenance?.assetRefs.filter(asset => !provenance.derivedAssets.some(derived => derived.assetId === asset.assetId)) ?? [];
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const selected = originals.find(asset => asset.assetId === selectedAssetId) ?? originals[0];
  const [preview, setPreview] = useState<{ assetId: string; url: string; width: number; height: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [recognition, setRecognition] = useState<CaptureRecognitionResponse | null>(null);
  const [batch, setBatch] = useState<CaptureBatchStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const process = useProcessImage({ api, disabled, onProcessed, onActivity });

  const reload = useCallback(async (explicit = false): Promise<void> => {
    if (!provenance) return;
    const request = ++generation.current;
    setReading(true);
    const key = keyFor(provenance.batchId, provenance.requestId);
    onActivity(key, 'checking');
    const [snapshot, batchResult] = await Promise.allSettled([api.captureRecognition(source.id), api.getCaptureBatchStatus(provenance.batchId)]);
    if (!mounted.current || request !== generation.current) return;
    const errors: string[] = [];
    if (snapshot.status === 'fulfilled' && snapshot.value.rawSourceId === source.id && JSON.stringify(snapshot.value.provenance) === signature) setRecognition(snapshot.value);
    else errors.push(snapshot.status === 'rejected' ? describeError(snapshot.reason) : '识别快照与当前原件不匹配。');
    if (batchResult.status === 'fulfilled' && batchResult.value.batchId === provenance.batchId && batchResult.value.sessionId === provenance.sessionId) {
      setBatch(batchResult.value);
      const item = batchResult.value.items.find(item => item.requestId === provenance.requestId && item.rawSourceId === source.id);
      if (item) onActivity(key, item.status === 'processing' || item.status === 'queued' ? 'pending' : explicit ? 'observed' : 'checked');
    } else errors.push(batchResult.status === 'rejected' ? describeError(batchResult.reason) : '图片批次与当前原件不匹配。');
    setReadError(errors.length ? errors.join(' ') : null);
    setReading(false);
  }, [api, source, signature, onActivity]);

  useEffect(() => {
    mounted.current = true;
    if (active) void reload();
    return () => { mounted.current = false; generation.current++; };
  }, [active, reload]);

  useEffect(() => {
    if (!provenance || !selected) return;
    let cancelled = false;
    let url: string | null = null;
    setPreview(null);
    setPreviewError(null);
    void originalFile(api, provenance.batchId, selected).then(result => {
      if (cancelled) return;
      url = URL.createObjectURL(result.file);
      setPreview({ assetId: selected.assetId, url, width: result.width, height: result.height });
    }).catch(cause => { if (!cancelled) setPreviewError(describeError(cause)); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, source.id, signature, selected?.assetId, previewVersion]);

  if (!provenance) return <p role="alert">图片来源信息无效，无法安全读取原图；原件未修改。</p>;
  const item = batch?.items.find(item => item.requestId === provenance.requestId && item.rawSourceId === source.id);
  const snapshot = recognition?.snapshot;
  return <section className="inbox-image-source" aria-label="图片原件与识别结果">
    <figure className="inbox-image-original">
      <h3>已保存原图（只读）</h3>
      {originals.length > 1 ? <label>图片原件<select aria-label="图片原件" value={selected?.assetId ?? ''} onChange={event => setSelectedAssetId(event.target.value)}>{originals.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.assetId}</option>)}</select></label> : null}
      {preview && preview.assetId === selected?.assetId ? <img src={preview.url} alt={`已保存原图：${preview.assetId}`} onError={() => setPreviewError('原图预览解码失败；已保存字节未修改。')} /> : null}
      {selected ? <figcaption>{selected.assetId} · {selected.mimeType} · {selected.byteLength} 字节{preview ? ` · ${preview.width} × ${preview.height}` : ''}<br />SHA-256：{selected.sha256}</figcaption> : <p>未找到可核对的原始图片。</p>}
      {previewError ? <div role="alert">{previewError} <button type="button" onClick={() => setPreviewVersion(value => value + 1)}>重试读取原图</button></div> : null}
    </figure>
    <div className="inbox-image-recognition" aria-label="派生图片识别结果" aria-busy={reading || process.running}>
      <h3>图片识别结果（派生，非原文）</h3><p>请对照原图核对文字、区域和不确定内容；识别结果不会写入原始附文。</p>
      {reading ? <p role="status">正在读取图片识别状态…</p> : null}
      {item?.processingReason ? <p role="status">{REASON[item.processingReason]}</p> : null}
      {item?.status === 'processing' ? <p role="status">图片处理中，原件已保存。</p> : null}
      {item?.status === 'queued' ? <p role="status">图片等待处理，原件已保存。</p> : null}
      {item?.status === 'failed' ? <p role="alert">图片处理失败：{item.errorReason || '请稍后重试。'}</p> : null}
      {!snapshot && !readError && !reading ? <p>尚无识别快照，原图和原始附文已保留。</p> : null}
      {snapshot ? <>
        <p>已保存识别结果 {snapshot.results.length} / {snapshot.inputs.length}</p>
        {snapshot.results.map(entry => <section key={entry.assetId} className="inbox-recognition-entry">
          <header><strong>识别输入：{entry.assetId}</strong><small>{entry.providerId}{entry.modelId ? ` · ${entry.modelId}` : ''} · 模型自报置信度 {Math.round(entry.result.confidence * 100)}%</small></header>
          <pre>{entry.result.text || '（未识别出文字）'}</pre>
          {entry.result.blocks.map((block, index) => <div key={index}><strong>{({ paragraph: '段落', table: '表格', code: '代码', formula: '公式', image: '图片' })[block.kind]}</strong><pre>{block.text}</pre>{block.region ? <small>区域：{JSON.stringify(block.region)}</small> : null}</div>)}
          {entry.result.uncertainRegions.length ? <aside aria-label="识别不确定区域"><h4>不确定区域</h4>{entry.result.uncertainRegions.map((region, index) => <div key={index}><p>{region.reason}</p>{region.text ? <pre>{region.text}</pre> : null}{region.region ? <small>区域：{JSON.stringify(region.region)}</small> : null}</div>)}</aside> : null}
        </section>)}
        {recognition?.processingText ? <details><summary>整理使用的派生文本</summary><pre>{recognition.processingText}</pre></details> : null}
      </> : null}
      {provenance.derivedAssets.length ? <details><summary>派生图片与原图关系</summary>{provenance.derivedAssets.map(asset => <p key={asset.assetId}>{asset.assetId} · {asset.operation} · 来源 {asset.sourceAssetIds.join('、')}</p>)}</details> : null}
      {readError ? <p role="alert">{readError} 原图仍可独立查看。</p> : null}
      {process.error ? <p role="alert">{process.error} 原图已保留；重试沿用同一批次项目。</p> : null}
      <div className="inbox-image-actions"><button type="button" disabled={reading || process.running} onClick={() => void reload(true)}>刷新图片识别状态</button>
        {item && eligible(item) && source.reviewStatus === 'needs_review' ? <button type="button" disabled={disabled || process.running} onClick={() => void process.run(provenance.batchId, provenance.requestId).then(result => { if (result && mounted.current) { setBatch(result); void reload(); } })}>{item.status === 'failed' ? '重试图片处理' : '处理图片'}</button> : null}
      </div>
      {item && eligible(item) ? <p>点击处理后，会将该批次已存图片交给当前配置的识别和整理服务；原图和原始附文不修改。</p> : null}
    </div>
  </section>;
}

export function InboxSavedImages({ api, active, disabled, onProcessed, onActivity }: Actions & { active: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [batches, setBatches] = useState<CaptureBatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const process = useProcessImage({ api, disabled, onProcessed, onActivity });
  const reload = useCallback(async (explicit = false): Promise<void> => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const response = await api.listCaptureBatches({ limit: 20 });
      if (request !== generation.current) return;
      setBatches(response.batches);
      setError(null);
      if (explicit) for (const batch of response.batches) for (const item of batch.items) if (item.status !== 'processing' && item.status !== 'queued') onActivity(keyFor(batch.batchId, item.requestId), 'observed');
    } catch (cause) { if (request === generation.current) setError(describeError(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [api, onActivity]);
  useEffect(() => { if (open && active) void reload(); return () => { generation.current++; }; }, [open, active, reload]);
  const rows = batches.flatMap(batch => batch.items.filter(item => item.kind !== 'text' && !item.rawSourceId).map(item => ({ batch, item }))).slice(0, 50);
  return <details className="inbox-saved-images" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label="已存图片批次">已存图片批次</summary>
    <p>历史图片可能尚未建立原件资料。仅点击所选项目才会识别处理，不会重新上传。</p>
    {loading ? <p role="status">正在读取已存图片…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {process.error ? <p role="alert">{process.error} 可用同一项目重试。</p> : null}
    {!loading && !rows.length ? <p>最近批次没有尚未建立原件资料的图片。</p> : null}
    {rows.map(({ batch, item }) => <div key={keyFor(batch.batchId, item.requestId)} className="inbox-saved-image-row"><span>图片 {item.userOrder + 1} · {batch.createdAt} · {item.requestId}</span>
      {item.processingReason ? <p>{REASON[item.processingReason]}</p> : null}
      {eligible(item) ? <button type="button" aria-label={`处理已存图片 ${item.requestId}`} disabled={disabled || process.running} onClick={() => void process.run(batch.batchId, item.requestId).then(result => { if (result) void reload(); })}>处理已存图片 {item.requestId}</button> : <span>当前项目需在原件资料中核对。</span>}
    </div>)}
    <button type="button" disabled={loading || process.running} onClick={() => void reload(true)}>刷新已存图片</button>
  </details>;
}
