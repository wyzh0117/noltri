import { describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURE_ASSET_BYTES } from '@noltri/schema';
import { captureScreenshotIntoIntake } from './screenshot-entry';
import {
  createIntakeSession,
  enqueueIntakeImages,
  remainingIntakeImageSlots,
  updateIntakeText,
  validateCaptureImageFiles,
} from './intake-session';
import type { IntakeSession } from './intake-session';
import type { ScreenshotIntakeAdapter } from './screenshot-entry';

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const createdAt = '2026-10-29T11:00:00.000Z';
let nextId = 0;

function image(name: string, type = 'image/png', bytes = pngBytes): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function emptySession(): IntakeSession {
  let id = 0;
  return createIntakeSession({ createId: () => 'session-' + ++id, now: () => createdAt });
}

function addImages(session: IntakeSession, files: File[]): IntakeSession {
  return enqueueIntakeImages(session, files, {
    createId: () => 'image-' + ++nextId,
    createPreviewUrl: (file) => 'fixture://' + file.name,
  }).session;
}

function syntheticAdapter(result: Awaited<ReturnType<ScreenshotIntakeAdapter['capture']>>): ScreenshotIntakeAdapter {
  return { capture: vi.fn(async () => result) };
}

async function validateAndEnqueue(sessionRef: { current: IntakeSession }, captured: File): Promise<{ accepted: boolean; reason?: string }> {
  const validated = await validateCaptureImageFiles([captured]);
  if (validated.rejected.length > 0) return { accepted: false, reason: validated.rejected[0]!.reason };
  const queued = enqueueIntakeImages(sessionRef.current, validated.accepted, {
    createId: () => 'image-' + ++nextId,
    createPreviewUrl: (file) => 'fixture://' + file.name,
  });
  sessionRef.current = queued.session;
  return queued.rejected.length > 0
    ? { accepted: false, reason: queued.rejected[0]!.reason }
    : { accepted: queued.session.images.some((entry) => entry.file === captured) };
}

describe('explicit native screenshot intake', () => {
  it('does not request a screenshot when the current batch has no image slot', async () => {
    const full = addImages(emptySession(), Array.from({ length: 100 }, (_, index) => image('full-' + index + '.png')));
    const adapter = syntheticAdapter({ status: 'captured', image: image('unused.png'), clipboardCopied: true });
    const enqueue = vi.fn(async () => ({ accepted: true }));

    const result = await captureScreenshotIntoIntake(adapter, 'request-1', () => remainingIntakeImageSlots(full) > 0, enqueue);

    expect(result).toEqual({ status: 'capacity_full' });
    expect(adapter.capture).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('appends only after native capture succeeds and reports clipboard copy status', async () => {
    const sessionRef = { current: emptySession() };
    const captured = image('capture.png');
    const adapter = syntheticAdapter({ status: 'captured', image: captured, clipboardCopied: false });

    const result = await captureScreenshotIntoIntake(
      adapter,
      'request-2',
      () => remainingIntakeImageSlots(sessionRef.current) > 0,
      (file) => validateAndEnqueue(sessionRef, file),
    );

    expect(result).toEqual({ status: 'queued', image: captured, clipboardCopied: false });
    expect(adapter.capture).toHaveBeenCalledWith('request-2');
    expect(sessionRef.current.images.map((entry) => entry.file)).toEqual([captured]);
  });

  it('preserves the current batch for cancellation, permission and unsupported capture results', async () => {
    const session = addImages(emptySession(), [image('existing.png')]);
    for (const status of ['cancelled', 'permission_denied', 'unsupported', 'empty', 'busy', 'failed'] as const) {
      const adapter = syntheticAdapter({ status, reason: 'synthetic native failure' });
      const enqueue = vi.fn(async () => ({ accepted: true }));

      const result = await captureScreenshotIntoIntake(adapter, 'request-' + status, () => remainingIntakeImageSlots(session) > 0, enqueue);

      expect(result).toEqual({ status, reason: 'synthetic native failure' });
      expect(adapter.capture).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      expect(session.images).toHaveLength(1);
    }
  });

  it('keeps a successfully captured original pending when queue admission fails', async () => {
    const session = updateIntakeText(emptySession(), '原文先占一个批次项目；截图失败后仍应保留图片。');
    const sessionRef = { current: addImages(session, Array.from({ length: 98 }, (_, index) => image('near-full-' + index + '.png'))) };
    const captured = image('captured-before-capacity-change.png');
    const adapter: ScreenshotIntakeAdapter = {
      capture: vi.fn(async () => {
        sessionRef.current = addImages(sessionRef.current, [image('fills-last-slot.png')]);
        return { status: 'captured' as const, image: captured, clipboardCopied: true };
      }),
    };

    const result = await captureScreenshotIntoIntake(
      adapter,
      'request-pending',
      () => remainingIntakeImageSlots(sessionRef.current) > 0,
      (file) => validateAndEnqueue(sessionRef, file),
    );

    expect(result).toEqual({
      status: 'pending',
      image: captured,
      clipboardCopied: true,
      reason: '一次最多提交 100 项。',
    });
    expect(adapter.capture).toHaveBeenCalledOnce();
    expect(sessionRef.current.images).toHaveLength(99);
  });

  it('rejects unsupported and oversized originals before they enter the queue', async () => {
    const invalid = [
      image('wrong-mime.jpg', 'image/jpeg'),
      image('oversized.png', 'image/png', new Uint8Array(MAX_CAPTURE_ASSET_BYTES + 1)),
    ];
    for (const file of invalid) {
      const sessionRef = { current: emptySession() };
      const result = await validateAndEnqueue(sessionRef, file);
      expect(result.accepted).toBe(false);
      expect(sessionRef.current.images).toHaveLength(0);
    }
  });
});
