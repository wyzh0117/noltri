import { describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURE_BATCH_BODY_BYTES, MAX_CAPTURE_TEXT_LENGTH, captureBatchRequestSchema } from '@noltri/schema';
import type { CaptureBatchRequest, CaptureBatchStatus, CaptureBatchStatusItem } from '@noltri/schema';
import * as intakeModule from './intake-session';
import {
  buildCaptureBatchRequest,
  cancelIntakeWindow,
  createIntakeSession,
  enqueueIntakeImages,
  moveIntakeImage,
  removeIntakeImage,
  retryIntakeItem,
  submitIntakeSession,
  selectedIntakeImageChanged,
  updateIntakeMetadata,
  updateIntakeText,
  validateCaptureImageFiles,
} from './intake-session';
import type { IntakeApi, IntakeImage, IntakeSession } from './intake-session';

const capturedAt = '2026-10-29T11:00:00.000Z';
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function file(name: string, bytes = pngBytes, type = 'image/png'): File {
  return new File([new Uint8Array(bytes).buffer as ArrayBuffer], name, { type });
}

function freshSession() {
  let nextId = 0;
  return createIntakeSession({
    createId: () => `capture-id-${String(++nextId).padStart(4, '0')}`,
    now: () => capturedAt,
  });
}

function enqueue(session = freshSession(), files: File[] = [file('one.png'), file('two.png')]) {
  let nextId = 10;
  return enqueueIntakeImages(session, files, {
    createId: () => `capture-id-${String(++nextId).padStart(4, '0')}`,
    createPreviewUrl: (entry) => `fixture://${entry.name}`,
  }).session;
}

describe('selected intake image preview', () => {
  it('does not re-enter render-busy when a non-selected image is appended', () => {
    let nextId = 10;
    const append = (session: IntakeSession, name: string) => enqueueIntakeImages(session, [file(name)], {
      createId: () => `append-image-${++nextId}`,
      createPreviewUrl: (entry) => `fixture://${entry.name}`,
    }).session;
    const first = append(freshSession(), 'one.png');
    const second = append(first, 'two.png');

    expect(second.images).toHaveLength(2);
    expect(second.images[0]?.assetId).not.toBe(second.images[1]?.assetId);
    expect(selectedIntakeImageChanged(first.images, second.images, null)).toBe(false);
  });

  it('refreshes when the selected image is removed or the first image is added', () => {
    const empty = freshSession();
    let nextId = 20;
    const append = (session: IntakeSession, name: string) => enqueueIntakeImages(session, [file(name)], {
      createId: () => `selected-image-${++nextId}`,
      createPreviewUrl: (entry) => `fixture://${entry.name}`,
    }).session;
    const first = append(empty, 'one.png');
    const second = append(first, 'two.png');
    const withoutSelected = { ...second, images: second.images.slice(0, 1) };

    expect(selectedIntakeImageChanged(empty.images, first.images, null)).toBe(true);
    expect(selectedIntakeImageChanged(second.images, withoutSelected.images, second.images[1]!.assetId)).toBe(true);
  });
});

function statusFor(request: CaptureBatchRequest, overrides: Record<string, CaptureBatchStatusItem['status']> = {}): CaptureBatchStatus {
  return {
    batchId: request.batchId,
    sessionId: request.sessionId,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    items: request.items.map((item) => ({
      requestId: item.requestId,
      kind: item.kind,
      userOrder: item.userOrder,
      assetIds: item.assetIds,
      status: overrides[item.requestId] ?? (item.kind === 'image' ? 'assets_saved' : 'done'),
      duplicate: false,
      retryable: overrides[item.requestId] === 'failed',
      ...(overrides[item.requestId] === 'failed' ? { errorReason: 'fixture failure' } : {}),
      updatedAt: capturedAt,
    })),
  };
}

function apiStub(overrides: Partial<IntakeApi> = {}) {
  const calls: string[] = [];
  const api: IntakeApi = {
    uploadCaptureAsset: vi.fn(async (input) => {
      calls.push(`asset:${input.assetId}`);
      return { duplicate: false, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
    }),
    createCaptureBatch: vi.fn(async (request) => {
      calls.push(`batch:${request.batchId}`);
      return { duplicate: false, batch: statusFor(request) };
    }),
    getCaptureBatchStatus: vi.fn(async (batchId) => {
      calls.push(`status:${batchId}`);
      return { batchId, sessionId: 'fixture-session', createdAt: capturedAt, updatedAt: capturedAt, items: [] };
    }),
    retryCaptureBatchItem: vi.fn(async (batchId, requestId) => {
      calls.push(`retry:${batchId}:${requestId}`);
      return { batchId, sessionId: 'fixture-session', createdAt: capturedAt, updatedAt: capturedAt, items: [] };
    }),
    ...overrides,
  };
  return { api, calls };
}

describe('IntakeWindow session', () => {
  it('keeps the original text and exact image files while drag order becomes userOrder', () => {
    const one = file('one.png', Uint8Array.from([...pngBytes, 0x01]));
    const two = file('two.png', Uint8Array.from([...pngBytes, 0x02]));
    let session = updateIntakeText(freshSession(), '原始第一行\n原始第二行，不能改写。');
    session = enqueue(session, [one, two]);
    const first = session.images[0]!;
    const second = session.images[1]!;
    session = moveIntakeImage(session, second.assetId, first.assetId);

    const request = buildCaptureBatchRequest(session);

    expect(request.items.map((item) => item.userOrder)).toEqual([0, 1, 2]);
    expect(request.items[0]?.text).toBe('原始第一行\n原始第二行，不能改写。');
    expect(request.items.slice(1).map((item) => item.assetIds[0])).toEqual([second.assetId, first.assetId]);
    expect(session.images.map((item) => item.file.name)).toEqual(['two.png', 'one.png']);
    expect(session.images[0]?.file).toBe(two);
    expect(session.images[1]?.file).toBe(one);
    expect(session.images.map((item) => item.file.size)).toEqual([pngBytes.length + 1, pngBytes.length + 1]);
  });

  it('stores non-destructive quarter-turn edits separately from each original file', () => {
    const original = file('original.png');
    const session = enqueue(freshSession(), [original, file('second.png')]);
    const edit = (intakeModule as unknown as { rotateIntakeImage?: (value: typeof session, assetId: string) => typeof session }).rotateIntakeImage;
    const rotated = edit === undefined ? session : edit(session, session.images[0]!.assetId);
    const image = rotated.images[0] as (typeof rotated.images)[number] & { edit?: { rotationDegrees: number } };

    expect(image.edit).toEqual({ rotationDegrees: 90, annotations: [] });
    expect(image.file).toBe(original);
    expect(session.images[0]?.file).toBe(original);
    expect(session.images.map((entry) => entry.assetId)).toEqual(rotated.images.map((entry) => entry.assetId));
    expect(buildCaptureBatchRequest(rotated).items.filter((item) => item.kind === 'image').map((item) => item.assetIds[0])).toEqual(rotated.images.map((entry) => entry.assetId));
  });

  it('lays out an explicitly selected stitch in current queue order and keeps source provenance', () => {
    const session = enqueue(freshSession(), [file('first.png'), file('second.png')]);
    const reordered = moveIntakeImage(session, session.images[1]!.assetId, session.images[0]!.assetId);
    const layoutBuilder = (intakeModule as unknown as {
      buildImageStitchLayout?: (items: Array<{ assetId: string; width: number; height: number; rotationDegrees: number }>, direction: 'vertical' | 'horizontal') => unknown;
    }).buildImageStitchLayout;
    const layout = layoutBuilder?.([
      { assetId: reordered.images[0]!.assetId, width: 3, height: 5, rotationDegrees: 0 },
      { assetId: reordered.images[1]!.assetId, width: 4, height: 2, rotationDegrees: 90 },
    ], 'vertical') ?? null;

    expect(layout).toEqual({
      direction: 'vertical',
      width: 3,
      height: 9,
      sourceAssetIds: [reordered.images[0]!.assetId, reordered.images[1]!.assetId],
      placements: [
        { assetId: reordered.images[0]!.assetId, x: 0, y: 0, width: 3, height: 5 },
        { assetId: reordered.images[1]!.assetId, x: 0, y: 5, width: 2, height: 4 },
      ],
    });
    expect(reordered.images.map((entry) => entry.file.name)).toEqual(['second.png', 'first.png']);
  });

  it('uploads rotated and stitched derivatives on explicit submit while preserving originals and ordered provenance', async () => {
    const originals = [file('first.png'), file('second.png')];
    const session = enqueue(freshSession(), originals);
    const rotatedBlob = new Blob([Uint8Array.from([...pngBytes, 0x31])], { type: 'image/png' });
    const stitchBlob = new Blob([Uint8Array.from([...pngBytes, 0x32])], { type: 'image/png' });
    const derivedSession = {
      ...session,
      derivedAssets: [
        {
          assetId: 'derived-rotation', operation: 'rotate', sourceAssetIds: [session.images[0]!.assetId],
          rotationDegrees: 90, mimeType: 'image/png', blob: rotatedBlob, uploadStatus: 'pending',
        },
        {
          assetId: 'derived-stitch', operation: 'stitch', sourceAssetIds: session.images.map((image) => image.assetId),
          direction: 'horizontal', mimeType: 'image/png', blob: stitchBlob, uploadStatus: 'pending',
        },
      ],
    } as unknown as IntakeSession;
    const uploaded: Array<{ assetId: string; bytes: number[] }> = [];
    const { api } = apiStub({
      uploadCaptureAsset: vi.fn(async (input) => {
        uploaded.push({ assetId: input.assetId, bytes: [...input.bytes] });
        return { duplicate: false, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
      }),
    });

    const outcome = await submitIntakeSession(derivedSession, api);
    const request = outcome.session.request!;
    const first = request.items.find((item) => item.requestId === session.images[0]!.requestId)!;
    const second = request.items.find((item) => item.requestId === session.images[1]!.requestId)!;

    expect(first.assetIds).toEqual([session.images[0]!.assetId, 'derived-rotation', 'derived-stitch']);
    expect(first.derivedAssets).toEqual([
      { assetId: 'derived-rotation', operation: 'rotate', sourceAssetIds: [session.images[0]!.assetId], rotationDegrees: 90 },
      { assetId: 'derived-stitch', operation: 'stitch', sourceAssetIds: session.images.map((image) => image.assetId), direction: 'horizontal' },
    ]);
    expect(second.assetIds).toEqual([session.images[1]!.assetId]);
    expect(uploaded.map((entry) => entry.assetId)).toEqual([
      session.images[0]!.assetId, session.images[1]!.assetId, 'derived-rotation', 'derived-stitch',
    ]);
    expect(uploaded.find((entry) => entry.assetId === 'derived-rotation')?.bytes).toEqual([...new Uint8Array(await rotatedBlob.arrayBuffer())]);
    expect(uploaded.find((entry) => entry.assetId === 'derived-stitch')?.bytes).toEqual([...new Uint8Array(await stitchBlob.arrayBuffer())]);
    const originalBytes = await Promise.all(originals.map(async (image) => [...new Uint8Array(await image.arrayBuffer())]));
    expect(originalBytes).toEqual(originals.map(() => [...pngBytes]));
    expect(outcome.session.phase).toBe('submitted');
  });

  it('replays uncertain derivative uploads with the same IDs, bytes, and frozen request', async () => {
    const session = enqueue(freshSession(), [file('source.png')]);
    const blob = new Blob([Uint8Array.from([...pngBytes, 0x44])], { type: 'image/png' });
    const prepared = {
      ...session,
      derivedAssets: [{
        assetId: 'derived-uncertain', operation: 'rotate', sourceAssetIds: [session.images[0]!.assetId],
        rotationDegrees: 90, mimeType: 'image/png', blob, uploadStatus: 'pending',
      }],
    } as unknown as IntakeSession;
    const attempts = new Map<string, number>();
    const observed: Array<{ assetId: string; bytes: number[] }> = [];
    const requests: CaptureBatchRequest[] = [];
    const { api } = apiStub({
      uploadCaptureAsset: vi.fn(async (input) => {
        observed.push({ assetId: input.assetId, bytes: [...input.bytes] });
        const count = (attempts.get(input.assetId) ?? 0) + 1;
        attempts.set(input.assetId, count);
        if (input.assetId === 'derived-uncertain' && count === 1) throw new Error('response lost after upload');
        return { duplicate: count > 1, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
      }),
      createCaptureBatch: vi.fn(async (request) => {
        requests.push(request);
        return { duplicate: false, batch: statusFor(request) };
      }),
    });

    const uncertain = await submitIntakeSession(prepared, api);
    expect(uncertain.session.phase).toBe('upload_failed');
    expect(uncertain.session.derivedAssets?.[0]?.uploadStatus).toBe('uncertain');
    expect(uncertain.session.request?.items[0]?.assetIds).toContain('derived-uncertain');
    const recovered = await submitIntakeSession(uncertain.session, api);

    expect(recovered.session.phase).toBe('submitted');
    expect(observed.filter((entry) => entry.assetId === 'derived-uncertain')).toHaveLength(2);
    expect(observed.filter((entry) => entry.assetId === 'derived-uncertain')[0]).toEqual(observed.filter((entry) => entry.assetId === 'derived-uncertain')[1]);
    expect(attempts.get(session.images[0]!.assetId)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe(uncertain.session.request);
    expect(api.createCaptureBatch).toHaveBeenCalledOnce();
  });

  it('lays out a horizontal stitch without changing the selected source order', () => {
    const layoutBuilder = (intakeModule as unknown as {
      buildImageStitchLayout?: (items: Array<{ assetId: string; width: number; height: number; rotationDegrees: number }>, direction: 'vertical' | 'horizontal') => unknown;
    }).buildImageStitchLayout;

    const layout = layoutBuilder?.([
      { assetId: 'a', width: 3, height: 5, rotationDegrees: 0 },
      { assetId: 'b', width: 4, height: 2, rotationDegrees: 90 },
    ], 'horizontal') ?? null;

    expect(layout).toEqual({
      direction: 'horizontal',
      width: 5,
      height: 5,
      sourceAssetIds: ['a', 'b'],
      placements: [
        { assetId: 'a', x: 0, y: 0, width: 3, height: 5 },
        { assetId: 'b', x: 3, y: 0, width: 2, height: 4 },
      ],
    });
  });

  it('rejects an oversized stitch layout before allocating a canvas', () => {
    const layoutBuilder = (intakeModule as unknown as {
      buildImageStitchLayout?: (items: Array<{ assetId: string; width: number; height: number; rotationDegrees: number }>, direction: 'vertical' | 'horizontal') => unknown;
    }).buildImageStitchLayout;

    expect(() => layoutBuilder?.([
      { assetId: 'a', width: 16_000, height: 4_000, rotationDegrees: 0 },
      { assetId: 'b', width: 16_000, height: 4_000, rotationDegrees: 0 },
    ], 'vertical')).toThrow('拼接预览尺寸过大');
  });

  it('uses one explicit native capture result as both the clipboard write outcome and intake image', async () => {
    const screenshot = file('synthetic-screen.png');
    const capture = (intakeModule as unknown as {
      captureScreenshotForIntake?: (adapter: { capture: (requestId: string) => Promise<{ status: 'captured'; image: File; clipboardCopied: boolean }> }, requestId: string) => Promise<{ status: 'captured'; image: File; clipboardCopied: boolean }>;
    }).captureScreenshotForIntake;
    const adapter = {
      capture: vi.fn(async () => ({ status: 'captured' as const, image: screenshot, clipboardCopied: true })),
    };

    expect(adapter.capture).not.toHaveBeenCalled();
    const result = capture === undefined ? null : await capture(adapter, 'synthetic-request');

    expect(adapter.capture).toHaveBeenCalledOnce();
    expect(adapter.capture).toHaveBeenCalledWith('synthetic-request');
    expect(result).toEqual({ status: 'captured', image: screenshot, clipboardCopied: true });
  });

  it('keeps the captured image available to intake when native clipboard writing fails', async () => {
    const screenshot = file('clipboard-failure.png');
    const capture = (intakeModule as unknown as {
      captureScreenshotForIntake?: (adapter: { capture: () => Promise<{ status: 'captured'; image: File; clipboardCopied: boolean }> }, requestId: string) => Promise<{ status: 'captured'; image: File; clipboardCopied: boolean }>;
    }).captureScreenshotForIntake;
    const adapter = {
      capture: async () => ({ status: 'captured' as const, image: screenshot, clipboardCopied: false }),
    };
    const result = capture === undefined ? null : await capture(adapter, 'clipboard-write-failed');

    expect(result).toEqual({ status: 'captured', image: screenshot, clipboardCopied: false });
  });

  it('cancels a draft without making any persistence calls', () => {
    const { api, calls } = apiStub();
    const onClose = vi.fn();

    cancelIntakeWindow(onClose);

    expect(onClose).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(api.uploadCaptureAsset).not.toHaveBeenCalled();
    expect(api.createCaptureBatch).not.toHaveBeenCalled();
  });

  it('keeps unknown source metadata empty and removes a queue entry without changing the original File', () => {
    const session = enqueue(freshSession(), [file('kept.png'), file('removed.png')]);
    const original = session.images[1]!.file;
    const afterRemoval = removeIntakeImage(session, session.images[1]!.assetId);
    const request = buildCaptureBatchRequest(afterRemoval);

    expect(request.items).toHaveLength(1);
    expect(request.items[0]?.source).toEqual({ type: 'manual' });
    expect(afterRemoval.images[0]?.file).toBe(session.images[0]?.file);
    expect(original.name).toBe('removed.png');
    expect(original.size).toBe(pngBytes.length);
  });

  it('does not silently omit a short pasted text when an image is also queued', () => {
    const session = enqueue(updateIntakeText(freshSession(), '短文'));
    const { api } = apiStub();

    expect(() => buildCaptureBatchRequest(session)).toThrow('不会被静默丢弃');
    expect(() => buildCaptureBatchRequest(updateIntakeText(freshSession(), '    '))).toThrow('不会被静默丢弃');
    expect(session.text).toBe('短文');
    expect(api.uploadCaptureAsset).not.toHaveBeenCalled();
    expect(api.createCaptureBatch).not.toHaveBeenCalled();
  });

  it('coalesces repeated submits into one batch request and then displays the persisted status', async () => {
    const session = enqueue(updateIntakeText(freshSession(), '这段合成原文足够长，能够形成一个文本采集项目。'), [file('one.png')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = apiStub({
      createCaptureBatch: vi.fn(async (request) => {
        await gate;
        return { duplicate: false, batch: statusFor(request) };
      }),
      getCaptureBatchStatus: vi.fn(async (batchId): Promise<CaptureBatchStatus> => ({
        batchId,
        sessionId: session.sessionId,
        createdAt: capturedAt,
        updatedAt: capturedAt,
        items: [{ requestId: session.textRequestId, kind: 'text', userOrder: 0, assetIds: [], status: 'needs_review', duplicate: false, retryable: false, updatedAt: capturedAt }],
      })),
    });

    const first = submitIntakeSession(session, api);
    const second = submitIntakeSession(session, api);
    expect(second).toBe(first);
    release();
    const outcome = await first;

    expect(api.createCaptureBatch).toHaveBeenCalledOnce();
    expect(api.uploadCaptureAsset).toHaveBeenCalledOnce();
    expect(api.getCaptureBatchStatus).toHaveBeenCalledWith(session.batchId);
    expect(outcome.session.batchStatus?.items[0]?.status).toBe('needs_review');
    expect(outcome.session.phase).toBe('submitted');
  });

  it('retries an uncertain batch submission with the frozen batch and request IDs', async () => {
    const session = updateIntakeText(freshSession(), '网络中断后重试时应复用同一批次与请求标识。');
    const requests: CaptureBatchRequest[] = [];
    const { api } = apiStub({
      createCaptureBatch: vi.fn(async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error('connection lost after submit');
        return { duplicate: true, batch: statusFor(request) };
      }),
      getCaptureBatchStatus: vi.fn(async (_batchId): Promise<CaptureBatchStatus> => statusFor(requests.at(-1)!)),
    });

    const first = await submitIntakeSession(session, api);
    expect(first.session.phase).toBe('submit_failed');
    const second = await submitIntakeSession(first.session, api);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(second.session.phase).toBe('submitted');
    expect(second.session.batchStatus?.items[0]?.requestId).toBe(session.textRequestId);
  });

  it('retries only failed asset uploads with the same identity and preserves partial batch status', async () => {
    const session = enqueue(updateIntakeText(freshSession(), '正文会留在表单与同一批次里，等待原件补传。'));
    const assets = new Map<string, number>();
    const observed: Array<{ assetId: string; sha256: string; bytes: number[] }> = [];
    const { api } = apiStub({
      uploadCaptureAsset: vi.fn(async (input) => {
        observed.push({ assetId: input.assetId, sha256: input.sha256, bytes: [...input.bytes] });
        const attempts = (assets.get(input.assetId) ?? 0) + 1;
        assets.set(input.assetId, attempts);
        if (input.assetId === session.images[1]?.assetId && attempts === 1) throw new Error('temporary upload failure');
        return { duplicate: attempts > 1, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
      }),
      createCaptureBatch: vi.fn(async (request) => ({ duplicate: false, batch: statusFor(request, { [request.items[0]!.requestId]: 'failed' }) })),
      getCaptureBatchStatus: vi.fn(async (batchId): Promise<CaptureBatchStatus> => ({
        batchId,
        sessionId: session.sessionId,
        createdAt: capturedAt,
        updatedAt: capturedAt,
        items: [
          { requestId: session.textRequestId, kind: 'text', userOrder: 0, assetIds: [], status: 'failed', duplicate: false, retryable: true, errorReason: 'temporary processor failure', updatedAt: capturedAt },
          ...session.images.map((entry, index) => ({ requestId: entry.requestId, kind: 'image' as const, userOrder: index + 1, assetIds: [entry.assetId], status: 'assets_saved' as const, duplicate: false, retryable: false, updatedAt: capturedAt })),
        ],
      })),
    });

    const failed = await submitIntakeSession(session, api);
    expect(failed.session.phase).toBe('upload_failed');
    expect(failed.session.text).toBe(session.text);
    expect(failed.session.images.map((entry) => entry.uploadStatus)).toEqual(['saved', 'uncertain']);
    expect(api.createCaptureBatch).not.toHaveBeenCalled();

    const completed = await submitIntakeSession(failed.session, api);

    expect(api.uploadCaptureAsset).toHaveBeenCalledTimes(3);
    expect(assets.get(session.images[0]!.assetId)).toBe(1);
    expect(assets.get(session.images[1]!.assetId)).toBe(2);
    expect(observed[1]?.assetId).toBe(observed[2]?.assetId);
    expect(observed[1]?.sha256).toBe(observed[2]?.sha256);
    expect(observed[1]?.bytes).toEqual([...pngBytes]);
    expect(api.createCaptureBatch).toHaveBeenCalledOnce();
    expect(completed.session.phase).toBe('submitted');
    expect(completed.session.batchStatus?.items[0]?.status).toBe('failed');
    expect(completed.session.batchStatus?.items.slice(1).every((item) => item.status === 'assets_saved')).toBe(true);
  });

  it('retries one failed text item and uses the status returned by persistence', async () => {
    let session = updateIntakeText(freshSession(), '这是一段足够长的测试文本，会在批次中保持原样。');
    const initialRequest = buildCaptureBatchRequest(session);
    let status = statusFor(initialRequest, { [session.textRequestId]: 'failed' });
    const { api, calls } = apiStub({
      retryCaptureBatchItem: vi.fn(async (batchId, requestId): Promise<CaptureBatchStatus> => {
        calls.push(`retry:${batchId}:${requestId}`);
        status = { ...status, updatedAt: capturedAt, items: status.items.map((item) => item.requestId === requestId ? { ...item, status: 'done', retryable: false } : item) };
        return status;
      }),
    });
    session = { ...session, request: initialRequest, phase: 'submitted', batchStatus: status };

    const retried = await retryIntakeItem(session, api, session.textRequestId);

    expect(calls).toContain(`retry:${session.batchId}:${session.textRequestId}`);
    expect(retried.session.batchStatus?.items[0]?.status).toBe('done');
    expect(retried.session.batchStatus?.items[0]?.retryable).toBe(false);
  });

  it('coalesces repeated retry clicks for the same batch item', async () => {
    const draft = updateIntakeText(freshSession(), '同一失败条目连续点击也只应触发一次重试请求。');
    const request = buildCaptureBatchRequest(draft);
    const status = statusFor(request, { [draft.textRequestId]: 'failed' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = apiStub({
      retryCaptureBatchItem: vi.fn(async (batchId: string, requestId: string): Promise<CaptureBatchStatus> => {
        await gate;
        return { ...status, batchId, items: status.items.map((item) => item.requestId === requestId ? { ...item, status: 'done' as const, retryable: false } : item) };
      }),
    });
    const session = { ...draft, request, phase: 'submitted' as const, batchStatus: status };

    const first = retryIntakeItem(session, api, draft.textRequestId);
    const second = retryIntakeItem(session, api, draft.textRequestId);
    expect(second).toBe(first);
    release();
    const outcome = await first;

    expect(api.retryCaptureBatchItem).toHaveBeenCalledOnce();
    expect(outcome.session.batchStatus?.items[0]?.status).toBe('done');
  });

  it('does not accept queue edits after submission has frozen the request', () => {
    const session = updateIntakeText(freshSession(), '提交后这一段原文保持不变。');
    const request = buildCaptureBatchRequest(session);
    const locked = { ...session, request, phase: 'upload_failed' as const };
    const changed = updateIntakeText(locked, 'attempt to replace the original');

    expect(changed).toBe(locked);
  });
  it('rejects a schema-valid oversized multibyte batch before uploading and preserves its draft', async () => {
    const longText = '知'.repeat(MAX_CAPTURE_TEXT_LENGTH);
    const longTitle = '来源'.repeat(300);
    let session = updateIntakeText(freshSession(), longText);
    session = updateIntakeMetadata(session, { sourceTitle: longTitle });
    session = enqueue(session, Array.from({ length: 99 }, (_, index) => file(`image-${index}.png`)));
    const schemaValidRequest = captureBatchRequestSchema.parse({
      batchId: session.batchId,
      sessionId: session.sessionId,
      items: [
        { requestId: session.textRequestId, kind: 'text', userOrder: 0, text: session.text, assetIds: [], source: { type: session.sourceType, title: longTitle }, capture: { capturedAt: session.capturedAt, client: 'desktop' }, library: { kind: 'knowledge' } },
        ...session.images.map((image, index) => ({ requestId: image.requestId, kind: 'image' as const, userOrder: index + 1, assetIds: [image.assetId], source: { type: session.sourceType, title: longTitle }, capture: { capturedAt: session.capturedAt, client: 'desktop' as const }, library: { kind: 'image' as const } })),
      ],
    });
    const bodyBytes = new TextEncoder().encode(JSON.stringify(schemaValidRequest)).byteLength;
    expect(schemaValidRequest.items).toHaveLength(100);
    expect(bodyBytes).toBeGreaterThan(MAX_CAPTURE_BATCH_BODY_BYTES);

    const { api } = apiStub();
    await expect(submitIntakeSession(session, api)).rejects.toThrow(/超过.*字节/);

    expect(api.uploadCaptureAsset).not.toHaveBeenCalled();
    expect(api.createCaptureBatch).not.toHaveBeenCalled();
    expect(session.text).toBe(longText);
    expect(session.sourceTitle).toBe(longTitle);
    expect(session.images).toHaveLength(99);
    expect(session.phase).toBe('editing');
  });

  it('keeps good images and original text when filtering a MIME-mismatched image before queueing', async () => {
    const text = '这一段合成原文要留在可修正的收集窗口。';
    const badJpeg = file('png-disguised-as-jpeg.jpg', pngBytes, 'image/jpeg');
    const goodPng = file('valid-synthetic.png');
    const initial = updateIntakeText(freshSession(), text);

    const validation = await validateCaptureImageFiles([badJpeg, goodPng]);
    const queued = enqueue(initial, validation.accepted);
    const request = buildCaptureBatchRequest(queued);

    expect(validation.accepted).toEqual([goodPng]);
    expect(validation.rejected).toEqual([{ file: badJpeg, reason: expect.stringContaining('不匹配') }]);
    expect(queued.images.map((image) => image.file)).toEqual([goodPng]);
    expect(queued.text).toBe(text);
    expect(request.items[0]?.text).toBe(text);
    expect(request.items.slice(1).map((item) => item.assetIds)).toEqual([[queued.images[0]?.assetId]]);
  });

  it('marks a lost upload response as uncertain and retries with the same asset and request IDs', async () => {
    const session = enqueue(updateIntakeText(freshSession(), '网络回包丢失后，原件重试应继续复用同一标识。'), [file('one.png')]);
    const observed: Array<{ assetId: string; sha256: string }> = [];
    const { api } = apiStub({
      uploadCaptureAsset: vi.fn(async (input) => {
        observed.push({ assetId: input.assetId, sha256: input.sha256 });
        if (observed.length === 1) throw new Error('connection lost after request delivery');
        return { duplicate: true, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
      }),
    });

    const uncertain = await submitIntakeSession(session, api);
    expect(uncertain.session.images[0]?.uploadStatus).toBe('uncertain');
    expect(uncertain.session.phase).toBe('upload_failed');
    expect(uncertain.session.request?.batchId).toBe(session.batchId);
    expect(api.createCaptureBatch).not.toHaveBeenCalled();

    const recovered = await submitIntakeSession(uncertain.session, api);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(recovered.session.phase).toBe('submitted');
    expect(recovered.session.request?.batchId).toBe(session.batchId);
  });

  it('keeps a draft editable after a definitive asset rejection and preserves confirmed assets', async () => {
    const session = enqueue(updateIntakeText(freshSession(), '确定拒绝后仍应能够修正本次收集。'), [file('saved.png'), file('rejected.png')]);
    const rejectedAssetId = session.images[1]!.assetId;
    const { api } = apiStub({
      uploadCaptureAsset: vi.fn(async (input) => {
        if (input.assetId === rejectedAssetId) throw Object.assign(new Error('invalid image'), { status: 422 });
        return { duplicate: false, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: capturedAt } };
      }),
    });

    const rejected = await submitIntakeSession(session, api);
    expect(rejected.session.phase).toBe('editing');
    expect(rejected.session.request).toBeUndefined();
    expect(rejected.session.images.map((image) => image.uploadStatus)).toEqual(['saved', 'failed']);
    expect(rejected.session.images[0]?.assetId).toBe(session.images[0]?.assetId);
    expect(api.createCaptureBatch).not.toHaveBeenCalled();

    const edited = removeIntakeImage(updateIntakeText(rejected.session, '修正后的原文继续保留。'), rejectedAssetId);
    expect(edited.phase).toBe('editing');
    expect(edited.text).toBe('修正后的原文继续保留。');
    expect(edited.images).toHaveLength(1);
    expect(edited.images[0]?.uploadStatus).toBe('saved');
    expect(edited.images[0]?.assetId).toBe(session.images[0]?.assetId);
    const completed = await submitIntakeSession(edited, api);
    expect(completed.session.phase).toBe('submitted');
    expect(api.uploadCaptureAsset).toHaveBeenCalledTimes(2);
    expect(api.createCaptureBatch).toHaveBeenCalledOnce();
  });

  it('keeps an unreadable local file editable without making an API request', async () => {
    const unreadable = file('locally-unreadable.png');
    Object.defineProperty(unreadable, 'arrayBuffer', { value: vi.fn(async () => { throw new Error('local read failed'); }) });
    const validated = await validateCaptureImageFiles([unreadable]);
    expect(validated.accepted).toEqual([unreadable]);
    const session = enqueue(updateIntakeText(freshSession(), '本地读取失败不能冻结或丢掉草稿。'), validated.accepted);
    const { api } = apiStub();

    const outcome = await submitIntakeSession(session, api);

    expect(outcome.session.phase).toBe('editing');
    expect(outcome.session.request).toBeUndefined();
    expect(outcome.session.images[0]?.uploadStatus).toBe('failed');
    expect(removeIntakeImage(outcome.session, session.images[0]!.assetId).images).toHaveLength(0);
    expect(api.uploadCaptureAsset).not.toHaveBeenCalled();
    expect(api.createCaptureBatch).not.toHaveBeenCalled();
  });


});
