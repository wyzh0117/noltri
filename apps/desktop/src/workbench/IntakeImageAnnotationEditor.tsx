import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';
import { describeError } from './api';
import { renderImageAnnotationPreview } from './image-composition';
import type { ImageAnnotationPreview } from './image-composition';
import { createImageAnnotation, imageEditSignature } from './image-edit-model';
import type { AnnotationPoint, ImageAnnotation, ImageAnnotationTool } from './image-edit-model';
import type { IntakeImage } from './intake-session';

export interface AnnotationPreviewCacheEntry {
  assetId: string;
  signature: string;
  blob: Blob;
}

interface IntakeImageAnnotationEditorProps {
  image: IntakeImage;
  disabled: boolean;
  onAdd: (annotation: ImageAnnotation) => void;
  onUndo: () => boolean;
  onPreviewState: (preview: AnnotationPreviewCacheEntry | null, busy: boolean) => void;
}

type ToolbarTool = 'pointer' | ImageAnnotationTool;
interface DraftAnnotation {
  type: Exclude<ImageAnnotationTool, 'text'>;
  start: AnnotationPoint;
  end: AnnotationPoint;
}

const TOOL_LABELS: Record<ToolbarTool, string> = {
  pointer: '选择标注',
  rectangle: '矩形框',
  arrow: '箭头',
  text: '文字',
  pixelate: '像素化遮盖',
};

function pointFromEvent(event: PointerEvent<SVGSVGElement>): AnnotationPoint {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: bounds.width === 0 ? 0 : Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: bounds.height === 0 ? 0 : Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function annotationHit(annotation: ImageAnnotation, point: AnnotationPoint): boolean {
  const left = Math.min(annotation.x1, annotation.x2) - 0.025;
  const right = Math.max(annotation.x1, annotation.x2) + 0.025;
  const top = Math.min(annotation.y1, annotation.y2) - 0.025;
  const bottom = Math.max(annotation.y1, annotation.y2) + (annotation.type === 'text' ? 0.12 : 0.025);
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function annotationBounds(annotation: ImageAnnotation): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(annotation.x1, annotation.x2);
  const minY = Math.min(annotation.y1, annotation.y2);
  const width = Math.max(0.025, Math.abs(annotation.x2 - annotation.x1));
  const height = Math.max(0.025, Math.abs(annotation.y2 - annotation.y1));
  return { x: Math.max(0, minX - 0.012), y: Math.max(0, minY - 0.012), width: Math.min(width + 0.024, 1 - minX), height: Math.min(height + 0.024, 1 - minY) };
}

export function IntakeImageAnnotationEditor({ image, disabled, onAdd, onUndo, onPreviewState }: IntakeImageAnnotationEditorProps): ReactElement {
  const [tool, setTool] = useState<ToolbarTool>('pointer');
  const [color, setColor] = useState('#d64a3b');
  const [strokeWidth, setStrokeWidth] = useState<2 | 4 | 6>(4);
  const [fontSize, setFontSize] = useState<18 | 24 | 32>(24);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<(ImageAnnotationPreview & { url: string; signature: string }) | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const signature = useMemo(() => imageEditSignature(image.edit), [image.edit]);
  const svgRef = useRef<SVGSVGElement>(null);
  const editorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const abortController = new AbortController();
    setPreview(null);
    setPreviewError(null);
    onPreviewState(null, true);
    void renderImageAnnotationPreview({
      assetId: image.assetId,
      file: image.file,
      rotationDegrees: image.edit.rotationDegrees,
      annotations: image.edit.annotations,
    }, abortController.signal).then((rendered) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(rendered.blob);
      setPreview({ ...rendered, url: objectUrl, signature });
      onPreviewState({ assetId: image.assetId, signature, blob: rendered.blob }, false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setPreviewError(describeError(error));
      onPreviewState(null, false);
    });
    return () => {
      cancelled = true;
      abortController.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      onPreviewState(null, false);
    };
  }, [image.assetId, image.file, image.edit.rotationDegrees, signature, onPreviewState]);

  function addDraft(end: AnnotationPoint): void {
    if (draft === null) return;
    if (image.edit.annotations.length >= 200) {
      setPreviewError('一张图片最多添加 200 个标注。');
      setDraft(null);
      return;
    }
    const width = Math.abs(draft.start.x - end.x);
    const height = Math.abs(draft.start.y - end.y);
    if (width < 0.003 && height < 0.003) {
      setDraft(null);
      return;
    }
    onAdd(createImageAnnotation(draft.type, draft.start, end, { color, strokeWidth }));
    setSelectedIndex(image.edit.annotations.length);
    setDraft(null);
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (disabled) return;
    editorRef.current?.focus();
    const point = pointFromEvent(event);
    if (tool === 'pointer') {
      const index = [...image.edit.annotations.keys()].reverse().find((candidate) => annotationHit(image.edit.annotations[candidate]!, point));
      setSelectedIndex(index ?? null);
      return;
    }
    if (tool === 'text') {
      if (text.trim().length === 0) {
        setPreviewError('先输入标注文字，再点选位置。');
        return;
      }
      if (image.edit.annotations.length >= 200) {
        setPreviewError('一张图片最多添加 200 个标注。');
        return;
      }
      onAdd(createImageAnnotation('text', point, point, { color, strokeWidth, text, fontSize }));
      setSelectedIndex(image.edit.annotations.length);
      setText('');
      return;
    }
    setDraft({ type: tool, start: point, end: point });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (disabled) return;
    if (event.key === 'Escape' && draft !== null) {
      event.preventDefault();
      setDraft(null);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      if (onUndo()) setSelectedIndex(null);
    }
  }

  const activePreview = preview?.signature === signature ? preview : null;
  const stageWidth = activePreview === null ? 0 : Math.min(720, 360 * activePreview.width / Math.max(1, activePreview.height));
  const selected = selectedIndex === null ? undefined : image.edit.annotations[selectedIndex];
  const selectedBounds = selected === undefined ? undefined : annotationBounds(selected);

  return (
    <section ref={editorRef} className="intake-annotation-editor" aria-label="图片标注编辑器" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="intake-annotation-heading">
        <div><h3>标注图片</h3><span>{image.name} · 原图保留，标注结果单独保存</span></div>
      </div>
      {previewError !== null ? <p className="intake-error" role="alert">{previewError}</p> : null}
      <div className="intake-annotation-stage-wrap">
        <div className="intake-annotation-toolbar" role="toolbar" aria-label="图片标注工具">
          <div className="intake-annotation-toolbar-group" role="group" aria-label="标注工具">
            {(['pointer', 'rectangle', 'arrow', 'text', 'pixelate'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={tool === candidate ? 'intake-annotation-tool intake-annotation-tool-active' : 'intake-annotation-tool'}
                aria-label={TOOL_LABELS[candidate]}
                title={TOOL_LABELS[candidate]}
                aria-pressed={tool === candidate}
                disabled={disabled}
                onClick={() => setTool(candidate)}
              >{candidate === 'pointer' ? '↖' : candidate === 'rectangle' ? '□' : candidate === 'arrow' ? '↗' : candidate === 'text' ? 'T' : '▦'}</button>
            ))}
          </div>
          {tool === 'text' ? <div className="intake-annotation-toolbar-group" role="group" aria-label="文字标注设置">
            <label className="intake-annotation-text">文字<input aria-label="标注文字" value={text} maxLength={200} disabled={disabled} onChange={(event) => setText(event.target.value)} placeholder="输入后点选位置" /></label>
            <label className="intake-annotation-width">字号<select aria-label="文字字号" value={fontSize} disabled={disabled} onChange={(event) => setFontSize(Number(event.target.value) as 18 | 24 | 32)}><option value={18}>小</option><option value={24}>中</option><option value={32}>大</option></select></label>
          </div> : null}
          <span className="intake-annotation-toolbar-divider" aria-hidden="true" />
          <div className="intake-annotation-toolbar-group intake-annotation-style-group" role="group" aria-label="标注样式与操作">
            <label className="intake-annotation-color" title="标注颜色">颜色<input aria-label="标注颜色" type="color" value={color} disabled={disabled} onChange={(event) => setColor(event.target.value)} /></label>
            <label className="intake-annotation-width">线宽<select aria-label="线宽" value={strokeWidth} disabled={disabled} onChange={(event) => setStrokeWidth(Number(event.target.value) as 2 | 4 | 6)}><option value={2}>细</option><option value={4}>中</option><option value={6}>粗</option></select></label>
            <button type="button" className="intake-annotation-tool intake-annotation-undo" aria-label="撤销最后一个标注" title="撤销最后一个标注" disabled={disabled || image.edit.annotations.length === 0} onClick={() => { if (onUndo()) setSelectedIndex(null); }}>↶</button>
          </div>
          {draft !== null ? <button type="button" className="intake-annotation-cancel" disabled={disabled} onClick={() => setDraft(null)}>取消本次</button> : null}
        </div>
        {activePreview === null ? <div className="intake-annotation-loading" role="status">正在生成与提交相同的标注预览…</div> : (
          <div className="intake-annotation-stage" style={{ width: `min(100%, ${stageWidth}px)`, aspectRatio: `${activePreview.width} / ${activePreview.height}` }}>
            <img src={activePreview.url} alt="当前标注预览" draggable={false} />
            <svg
              ref={svgRef}
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              role="group"
              aria-label="在图片上绘制或选择标注"
              tabIndex={0}
              aria-keyshortcuts="Escape Control+Z Meta+Z"
              onPointerDown={onPointerDown}
              onPointerMove={(event) => { if (draft !== null) setDraft({ ...draft, end: pointFromEvent(event) }); }}
              onPointerUp={(event) => { if (draft !== null) addDraft(pointFromEvent(event)); }}
              onPointerCancel={() => setDraft(null)}
            >
              <defs><marker id="intake-annotation-arrow-head" markerWidth="0.035" markerHeight="0.035" refX="0.03" refY="0.0175" orient="auto"><path d="M 0 0 L 0.035 0.0175 L 0 0.035 z" fill={color} /></marker></defs>
              {selectedBounds !== undefined ? <rect className="intake-annotation-selection" x={selectedBounds.x} y={selectedBounds.y} width={selectedBounds.width} height={selectedBounds.height} /> : null}
              {draft !== null ? draft.type === 'arrow'
                ? <line x1={draft.start.x} y1={draft.start.y} x2={draft.end.x} y2={draft.end.y} stroke={color} strokeWidth={strokeWidth / Math.max(activePreview.width, activePreview.height)} markerEnd="url(#intake-annotation-arrow-head)" />
                : <rect className={draft.type === 'pixelate' ? 'intake-annotation-draft-pixelate' : 'intake-annotation-draft'} x={Math.min(draft.start.x, draft.end.x)} y={Math.min(draft.start.y, draft.end.y)} width={Math.abs(draft.end.x - draft.start.x)} height={Math.abs(draft.end.y - draft.start.y)} stroke={color} strokeWidth={strokeWidth / Math.max(activePreview.width, activePreview.height)} /> : null}
            </svg>
          </div>
        )}
      </div>
      <p className="intake-annotation-help">矩形、箭头、文字与像素化会生成独立派生图。Esc 取消当前绘制，⌘/Ctrl+Z 撤销最后一步。</p>
    </section>
  );
}
