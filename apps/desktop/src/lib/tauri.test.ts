import { describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURE_ASSET_BYTES } from '@noltri/schema';
import { createIntakeNativeAdapters, recordCaptureStage } from './tauri';
import type { CaptureTraceEntry, IntakeNativeCommands, NativeCaptureResult, NativeClipboardSnapshot } from './tauri';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const pngBuffer = (): ArrayBuffer => png.slice().buffer as ArrayBuffer;

function nativeCommands(overrides: Partial<IntakeNativeCommands> = {}): IntakeNativeCommands {
  return {
    beginScreenCapture: vi.fn(async () => ({
      status: 'captured' as const,
      captureId: 'capture-token',
      mimeType: 'image/png' as const,
      byteLength: png.byteLength,
      capturedAt: '2026-11-01T08:00:00.000Z',
      clipboardCopied: true,
      source: null,
    })),
    takeScreenCaptureBytes: vi.fn(async () => pngBuffer()),
    snapshotSystemClipboard: vi.fn(async () => ({
      status: 'available' as const,
      snapshotId: 'clipboard-token',
      imageMimeType: 'image/png' as const,
      capturedAt: '2026-11-01T08:01:00.000Z',
      source: null,
    })),
    takeClipboardSnapshot: vi.fn(async () => pngBuffer()),
    ...overrides,
  };
}

describe('native intake adapters', () => {
  it('records only the request ID and whitelisted stage/error with bounded elapsed time', () => {
    const traceCaptureStage = vi.fn(async (_entry: CaptureTraceEntry) => undefined);
    const native = nativeCommands({ traceCaptureStage });

    recordCaptureStage('intake-test-1', 'state_check', 700_000, 'busy', native);
    recordCaptureStage('contains unsafe characters 🧪', 'native_call', 1, undefined, native);

    expect(traceCaptureStage).toHaveBeenCalledOnce();
    expect(traceCaptureStage).toHaveBeenCalledWith({ requestId: 'intake-test-1', stage: 'state_check', elapsedMs: 600_000, errorCode: 'busy' });
  });

  it('keeps request IDs aligned across native call/result stage records', async () => {
    const traceCaptureStage = vi.fn(async (_entry: CaptureTraceEntry) => undefined);
    const native = nativeCommands({ traceCaptureStage });

    await createIntakeNativeAdapters(native).screenshot.capture('ui-request-aligned');

    expect(traceCaptureStage.mock.calls.map(([entry]) => [entry.requestId, entry.stage])).toEqual([
      ['ui-request-aligned', 'native_call'],
      ['ui-request-aligned', 'native_result'],
    ]);
  });

  it('uses the native one-shot screenshot payload and preserves a failed clipboard copy as captured image', async () => {
    const native = nativeCommands({
      beginScreenCapture: vi.fn(async () => ({
        status: 'captured' as const,
        captureId: 'capture-token',
        mimeType: 'image/png' as const,
        byteLength: png.byteLength,
        capturedAt: '2026-11-01T08:00:00.000Z',
        clipboardCopied: false,
        source: null,
      })),
    });
    const adapters = createIntakeNativeAdapters(native);

    const result = await adapters.screenshot.capture('request-screen');

    expect(native.beginScreenCapture).toHaveBeenCalledWith('request-screen');
    expect(native.takeScreenCaptureBytes).toHaveBeenCalledWith('capture-token');
    expect(result.status).toBe('captured');
    expect(result.status === 'captured' && result.clipboardCopied).toBe(false);
    expect(result.status === 'captured' && result.image.type).toBe('image/png');
    expect(result.status === 'captured' && result.image.size).toBe(png.byteLength);
  });

  it('snapshots the system clipboard once and then consumes the frozen image bytes once', async () => {
    const native = nativeCommands({
      snapshotSystemClipboard: vi.fn(async () => ({
        status: 'available' as const,
        snapshotId: 'clipboard-token',
        text: 'synthetic clipboard text',
        imageMimeType: 'image/png' as const,
        capturedAt: '2026-11-01T08:01:00.000Z',
        source: null,
      })),
    });
    const adapters = createIntakeNativeAdapters(native);

    const result = await adapters.clipboard.snapshot('request-open');

    expect(native.snapshotSystemClipboard).toHaveBeenCalledOnce();
    expect(native.snapshotSystemClipboard).toHaveBeenCalledWith('request-open');
    expect(native.takeClipboardSnapshot).toHaveBeenCalledOnce();
    expect(native.takeClipboardSnapshot).toHaveBeenCalledWith('clipboard-token');
    expect(result).toMatchObject({ status: 'available', text: 'synthetic clipboard text' });
    expect(result.status === 'available' && result.image?.type).toBe('image/png');
  });

  it('normalizes macOS raw Response arrays and byte views for both capture and clipboard', async () => {
    const padded = new Uint8Array(png.byteLength + 4);
    padded.set(png, 2);
    const clipboardView = padded.subarray(2, 2 + png.byteLength);
    const native = nativeCommands({
      takeScreenCaptureBytes: vi.fn(async () => Array.from(png)),
      takeClipboardSnapshot: vi.fn(async () => clipboardView),
    });
    const adapters = createIntakeNativeAdapters(native);

    const screenshot = await adapters.screenshot.capture('request-array-response');
    const clipboard = await adapters.clipboard.snapshot('request-view-response');

    expect(screenshot.status).toBe('captured');
    if (screenshot.status === 'captured') {
      expect(new Uint8Array(await screenshot.image.arrayBuffer())).toEqual(png);
    }
    expect(clipboard.status).toBe('available');
    if (clipboard.status === 'available' && clipboard.image !== undefined) {
      expect(new Uint8Array(await clipboard.image.arrayBuffer())).toEqual(png);
    }
  });

  it('preserves readable clipboard text when the companion image handoff fails', async () => {
    const native = nativeCommands({
      snapshotSystemClipboard: async () => ({
        status: 'available',
        snapshotId: 'synthetic-expired-image',
        text: '  Synthetic readable text survives an unavailable companion image.\n',
        imageMimeType: 'image/png',
        capturedAt: '2026-11-01T08:01:00.000Z',
        source: null,
      }),
      takeClipboardSnapshot: async () => { throw new Error('synthetic image handoff unavailable'); },
    });

    await expect(createIntakeNativeAdapters(native).clipboard.snapshot('synthetic-mixed-read'))
      .resolves.toMatchObject({
        status: 'available',
        text: '  Synthetic readable text survives an unavailable companion image.\n',
        reason: '剪贴板图片读取失败，已保留可读文字。',
      });
  });

  it.each([undefined, ' \n\t'])('does not report success when the image handoff fails with unreadable text %j', async (text) => {
    const failure = new Error('synthetic image handoff unavailable');
    const native = nativeCommands({
      snapshotSystemClipboard: async () => ({
        status: 'available',
        snapshotId: 'synthetic-unreadable-image',
        ...(text === undefined ? {} : { text }),
        imageMimeType: 'image/png',
        capturedAt: '2026-11-01T08:01:00.000Z',
        source: null,
      }),
      takeClipboardSnapshot: async () => { throw failure; },
    });

    await expect(createIntakeNativeAdapters(native).clipboard.snapshot('synthetic-image-only-read'))
      .resolves.toEqual({ status: 'failed', reason: '剪贴板图片读取失败。' });
  });

  it('rejects non-byte, sparse, and oversized raw responses before copying their data', async () => {
    const invalidBytes = Array.from(png);
    invalidBytes[8] = 256;
    const sparseBytes = Array.from(png);
    delete sparseBytes[8];
    const sparsePrototype = Object.create(Array.prototype) as number[];
    Object.defineProperty(sparsePrototype, '8', { value: png[8] });
    Object.setPrototypeOf(sparseBytes, sparsePrototype);
    let oversizedElementReads = 0;
    const oversized = new Proxy([] as number[], {
      get(target, property, receiver) {
        if (property === 'length') return MAX_CAPTURE_ASSET_BYTES + 1;
        if (typeof property === 'string' && /^[0-9]+$/.test(property)) oversizedElementReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const nonByteNative = nativeCommands({
      takeScreenCaptureBytes: vi.fn(async () => invalidBytes),
    });
    const sparseNative = nativeCommands({
      takeScreenCaptureBytes: vi.fn(async () => sparseBytes),
    });
    const oversizedNative = nativeCommands({
      takeClipboardSnapshot: vi.fn(async () => oversized),
    });

    await expect(createIntakeNativeAdapters(nonByteNative).screenshot.capture('request-non-byte-array')).resolves.toMatchObject({ status: 'unsupported' });
    await expect(createIntakeNativeAdapters(sparseNative).screenshot.capture('request-sparse-array')).resolves.toMatchObject({ status: 'unsupported' });
    await expect(createIntakeNativeAdapters(oversizedNative).clipboard.snapshot('request-oversized-array')).resolves.toMatchObject({ status: 'unsupported' });

    expect(oversizedElementReads).toBe(0);
  });

  it('rejects unknown binary response shapes on both native image paths', async () => {
    const native = nativeCommands({
      takeScreenCaptureBytes: vi.fn(async () => 'base64 is not an IPC byte response'),
      takeClipboardSnapshot: vi.fn(async () => ({ bytes: Array.from(png) })),
    });
    const adapters = createIntakeNativeAdapters(native);

    await expect(adapters.screenshot.capture('request-wrong-shape')).resolves.toMatchObject({ status: 'unsupported' });
    await expect(adapters.clipboard.snapshot('request-wrong-shape')).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('keeps native capture metadata byteLength bound to the consumed payload', async () => {
    const native = nativeCommands({
      beginScreenCapture: vi.fn(async () => ({
        status: 'captured' as const,
        captureId: 'mismatched-length',
        mimeType: 'image/png' as const,
        byteLength: png.byteLength + 1,
        capturedAt: '2026-11-01T08:03:30.000Z',
        clipboardCopied: true,
        source: null,
      })),
      takeScreenCaptureBytes: vi.fn(async () => Array.from(png)),
    });
    const adapters = createIntakeNativeAdapters(native);

    await expect(adapters.screenshot.capture('request-mismatched-length')).resolves.toMatchObject({ status: 'unsupported' });
    expect(native.takeScreenCaptureBytes).toHaveBeenCalledOnce();
  });

  it('does not consume an oversized screenshot payload or alter the screenshot failure tag', async () => {
    const native = nativeCommands({
      beginScreenCapture: vi.fn(async () => ({
        status: 'captured' as const,
        captureId: 'oversized-token',
        mimeType: 'image/png' as const,
        byteLength: MAX_CAPTURE_ASSET_BYTES + 1,
        capturedAt: '2026-11-01T08:02:00.000Z',
        clipboardCopied: true,
        source: null,
      })),
      snapshotSystemClipboard: vi.fn(async () => ({ status: 'denied' as const, reason: 'synthetic denial' })),
    });
    const adapters = createIntakeNativeAdapters(native);

    const screenshot = await adapters.screenshot.capture('request-large');
    const clipboard = await adapters.clipboard.snapshot('request-denied');

    expect(screenshot).toMatchObject({ status: 'unsupported' });
    expect(native.takeScreenCaptureBytes).not.toHaveBeenCalled();
    expect(clipboard).toEqual({ status: 'denied', reason: 'synthetic denial' });
    expect(native.takeClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed for invalid bytes and unknown native result tags', async () => {
    const native = nativeCommands({
      beginScreenCapture: vi.fn(async () => ({
        status: 'captured' as const,
        captureId: 'bad-bytes',
        mimeType: 'image/png' as const,
        byteLength: png.byteLength,
        capturedAt: '2026-11-01T08:03:00.000Z',
        clipboardCopied: true,
        source: null,
      })),
      takeScreenCaptureBytes: vi.fn(async () => new Uint8Array([0, 1, 2, 3]).buffer),
      snapshotSystemClipboard: vi.fn(async () => ({ status: 'surprise' }) as unknown as NativeClipboardSnapshot),
    });
    const adapters = createIntakeNativeAdapters(native);

    await expect(adapters.screenshot.capture('request-bad-bytes')).resolves.toMatchObject({ status: 'unsupported' });
    await expect(adapters.clipboard.snapshot('request-bad-tag')).resolves.toMatchObject({ status: 'failed' });

    expect(native.takeScreenCaptureBytes).toHaveBeenCalledOnce();
    expect(native.takeClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('does not consume tokens for malformed captured result structures', async () => {
    const native = nativeCommands({
      beginScreenCapture: vi.fn(async () => ({ status: 'captured', captureId: '', mimeType: 'image/png' }) as unknown as NativeCaptureResult),
      snapshotSystemClipboard: vi.fn(async () => ({
        status: 'available',
        snapshotId: 'bad-text',
        text: { private: 'not text' },
        imageMimeType: 'image/png',
        capturedAt: '2026-11-01T08:04:00.000Z',
        source: null,
      }) as unknown as NativeClipboardSnapshot),
    });
    const adapters = createIntakeNativeAdapters(native);

    await expect(adapters.screenshot.capture('request-malformed-capture')).resolves.toMatchObject({ status: 'failed' });
    await expect(adapters.clipboard.snapshot('request-malformed-clipboard')).resolves.toMatchObject({ status: 'failed' });
    expect(native.takeScreenCaptureBytes).not.toHaveBeenCalled();
    expect(native.takeClipboardSnapshot).not.toHaveBeenCalled();
  });
});
