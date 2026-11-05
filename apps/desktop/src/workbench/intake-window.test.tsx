import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildSavedBatchAssetRows,
  IntakeWindow,
  listSavedCaptureBatches,
  loadSavedCaptureAssetPreview,
  replaceSavedPreviewUrl,
  revokeSavedPreviewUrl,
} from './IntakeWindow';
import { IntakeImageAnnotationEditor } from './IntakeImageAnnotationEditor';
import { createIntakeSession, enqueueIntakeImages } from './intake-session';
import type { IntakeApi } from './intake-session';
import type { CaptureBatchStatus } from '@noltri/schema';

function savedPng(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function savedBatch(): CaptureBatchStatus {
  const now = '2026-11-01T08:00:00.000Z';
  return {
    batchId: 'batch-1',
    sessionId: 'session-1',
    createdAt: now,
    updatedAt: now,
    items: [
      { requestId: 'later', kind: 'image', userOrder: 2, assetIds: ['original-c', 'stitch-c', 'rotate-c'], derivedAssets: [
        { assetId: 'stitch-c', operation: 'stitch', sourceAssetIds: ['original-a', 'original-b'], direction: 'horizontal' },
        { assetId: 'rotate-c', operation: 'rotate', sourceAssetIds: ['original-c'], rotationDegrees: 90 },
      ], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: now },
      { requestId: 'text', kind: 'text', userOrder: 1, assetIds: [], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: now },
      { requestId: 'first', kind: 'image', userOrder: 0, assetIds: ['original-a', 'original-b'], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: now },
    ],
  };
}

describe('IntakeWindow preview UI', () => {
  it('presents one explicit-submit text and multi-image intake form without implicit capture controls', () => {
    const api = {} as IntakeApi;
    const html = renderToStaticMarkup(
      <IntakeWindow api={api} paths={[]} onClose={() => undefined} onPersisted={() => undefined} />,
    );

    expect(html).toContain('aria-label="收集资料表单"');
    expect(html).toContain('id="intake-original-text"');
    expect(html).toContain('aria-label="添加图片文件"');
    expect(html).toContain('提交到知序');
    expect(html).toContain('来源信息未知时可以留空');
    expect(html).toContain('⌃⌥⌘V');
    expect(html).toContain('打开并读取剪贴板');
    expect(html).not.toContain('屏幕截图');
    expect(html).not.toContain('保存为');
  });

  it('shows a rejected global activation inside the open intake window', () => {
    const html = renderToStaticMarkup(
      <IntakeWindow
        api={{} as IntakeApi}
        paths={[]}
        onClose={() => undefined}
        onPersisted={() => undefined}
        activationError={{ requestId: 'intake-busy-test', message: '收集窗口正在处理上一项操作；本次截图未启动。' }}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('收集窗口正在处理上一项操作；本次截图未启动。');
  });

  it('shows conflicting or unavailable global shortcuts with the window action as fallback', () => {
    const html = renderToStaticMarkup(
      <IntakeWindow
        api={{} as IntakeApi}
        paths={[]}
        onClose={() => undefined}
        onPersisted={() => undefined}
        shortcutStatus={{ screenshot: 'conflict', openIntake: 'unavailable' }}
      />,
    );

    expect(html).toContain('与其它快捷键冲突，请使用窗口按钮');
    expect(html).toContain('不可用，请使用窗口按钮');
  });

  it('shows active configured bindings rather than the historical defaults', () => {
    const html = renderToStaticMarkup(<IntakeWindow api={{} as IntakeApi} paths={[]} onClose={() => undefined} onPersisted={() => undefined}
      shortcutStatus={{ screenshot: 'registered', openIntake: 'registered', bindings: {
        screenshot: { key: 'Q', control: true, alt: false, shift: true, meta: false },
        openIntake: { key: 'W', control: false, alt: true, shift: false, meta: true },
      } }} />);
    expect(html).toContain('⌃⇧Q'); expect(html).toContain('⌥⌘W');
    expect(html).not.toContain('⌃⌥⌘S'); expect(html).not.toContain('⌃⌥⌘V');
  });

  it('orders saved originals by userOrder and keeps each derivative linked to its source originals', () => {
    const rows = buildSavedBatchAssetRows(savedBatch());

    expect(rows.map((row) => [row.itemRequestId, row.assetId, row.role, row.role === 'original' ? row.originalOrder : undefined, row.role === 'derived' ? row.sourceOrders : []])).toEqual([
      ['first', 'original-a', 'original', 1, []],
      ['first', 'original-b', 'original', 2, []],
      ['later', 'original-c', 'original', 3, []],
      ['later', 'stitch-c', 'derived', undefined, [1, 2]],
      ['later', 'rotate-c', 'derived', undefined, [3]],
    ]);
    expect(rows[3]).toMatchObject({ operation: 'stitch', direction: 'horizontal', itemOrder: 3 });
    expect(rows[4]).toMatchObject({ operation: 'rotate', rotationDegrees: 90, itemOrder: 3 });
  });

  it('uses bounded batch and asset reads and leaves successful saved assets out of resubmission', async () => {
    const batches = { batches: [savedBatch()] };
    const bytes = savedPng();
    const api = {
      listCaptureBatches: async (input?: { limit?: number }) => { expect(input).toEqual({ limit: 20 }); return batches; },
      readCaptureAsset: async (_batchId: string, assetId: string) => ({
        asset: { assetId, sessionId: 'session-1', mimeType: 'image/png' as const, byteLength: bytes.byteLength, sha256: await sha256(bytes), createdAt: '2026-11-01T08:00:00.000Z' },
        bytes,
      }),
      createCaptureBatch: async () => { throw new Error('read-only viewer must not submit'); },
    } as unknown as IntakeApi;

    await expect(listSavedCaptureBatches(api)).resolves.toEqual(batches);
    await expect(loadSavedCaptureAssetPreview(api, 'batch-1', 'original-a', 'session-1', () => true))
      .resolves.toMatchObject({ width: 2, height: 3, mimeType: 'image/png', file: { type: 'image/png' } });
  });

  it('handles rejected list/read requests and ignores binary data that arrives after selection changes', async () => {
    const listErrorApi = {
      listCaptureBatches: async () => { throw new Error('synthetic list denial'); },
    } as unknown as IntakeApi;
    await expect(listSavedCaptureBatches(listErrorApi)).rejects.toThrow('synthetic list denial');

    const readErrorApi = {
      readCaptureAsset: async () => { throw new Error('synthetic asset denial'); },
    } as unknown as IntakeApi;
    await expect(loadSavedCaptureAssetPreview(readErrorApi, 'batch-1', 'original-a', 'session-1', () => true))
      .rejects.toThrow('synthetic asset denial');

    let resolveRead!: (result: Awaited<ReturnType<NonNullable<IntakeApi['readCaptureAsset']>>>) => void;
    const lateApi = {
      readCaptureAsset: () => new Promise<Awaited<ReturnType<NonNullable<IntakeApi['readCaptureAsset']>>>>((resolve) => { resolveRead = resolve; }),
    } as unknown as IntakeApi;
    let isCurrent = true;
    const late = loadSavedCaptureAssetPreview(lateApi, 'batch-1', 'original-a', 'session-1', () => isCurrent);
    isCurrent = false;
    const bytes = savedPng();
    resolveRead({
      asset: { assetId: 'original-a', sessionId: 'session-1', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: await sha256(bytes), createdAt: '2026-11-01T08:00:00.000Z' },
      bytes,
    });
    await expect(late).resolves.toBeNull();
  });

  it('revokes the previous and final preview object URLs', () => {
    const slot = { current: 'blob:old' as string | null };
    const urls = { createObjectURL: vi.fn(() => 'blob:new'), revokeObjectURL: vi.fn() };

    expect(replaceSavedPreviewUrl(slot, new File(['x'], 'image.png'), urls)).toBe('blob:new');
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:old');
    revokeSavedPreviewUrl(slot, urls);
    revokeSavedPreviewUrl(slot, urls);

    expect(slot.current).toBeNull();
    expect(urls.revokeObjectURL.mock.calls).toEqual([['blob:old'], ['blob:new']]);
  });

  it('keeps the screenshot adapter and optional derivative preview inside the same explicit-submit window', () => {
    const adapter = {
      capture: async () => ({
        status: 'captured' as const,
        image: new File([new Uint8Array([1])], 'synthetic.png', { type: 'image/png' }),
        clipboardCopied: true,
      }),
    };
    const api = {
      listCaptureBatches: async () => ({ batches: [] }),
      readCaptureAsset: async () => { throw new Error('not used in static markup'); },
    } as unknown as IntakeApi;
    const html = renderToStaticMarkup(
      <IntakeWindow api={api} paths={[]} onClose={() => undefined} onPersisted={() => undefined} screenshotAdapter={adapter} />,
    );

    expect(html).toContain('截图并放入当前窗口');
    expect(html).toContain('⌃⌥⌘S');
    expect(html).toContain('最近已保存批次');
    expect(html).toContain('拼接预览');
    expect(html).toContain('纵向');
    expect(html).toContain('横向');
    expect(html).toContain('不缩放，纵向左对齐、横向顶对齐，空白透明。');
    expect(html).toContain('旋转、标注与拼接结果在提交时作为派生图单独保存');
    expect(html).toContain('原图和来源顺序都会保留');
    expect(html.match(/aria-label="收集资料表单"/g)).toHaveLength(1);
  });

  it('renders only the clearly identified toolbar subset inside the existing image editor section', () => {
    const session = createIntakeSession({ createId: () => 'session' });
    const queued = enqueueIntakeImages(session, [new File(['synthetic'], 'synthetic.png', { type: 'image/png' })], {
      createId: (() => { let next = 0; return () => `image-${++next}`; })(),
      createPreviewUrl: () => 'fixture://image',
    }).session;
    const html = renderToStaticMarkup(<IntakeImageAnnotationEditor
      image={queued.images[0]!}
      disabled={false}
      onAdd={() => undefined}
      onUndo={() => false}
      onPreviewState={() => undefined}
    />);

    expect(html).toContain('aria-label="图片标注工具"');
    expect(html).toContain('aria-label="矩形框"');
    expect(html).toContain('aria-label="箭头"');
    expect(html).toContain('aria-label="文字"');
    expect(html).toContain('aria-label="像素化遮盖"');
    expect(html).toContain('aria-label="撤销最后一个标注"');
    expect(html).toContain('Esc 取消当前绘制');
    expect(html).not.toContain('保存为');
  });
});
