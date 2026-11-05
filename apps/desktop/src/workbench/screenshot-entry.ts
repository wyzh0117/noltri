export type IntakeActivation = {
  action: 'openIntake' | 'capture';
  requestId: string;
};

export type ScreenshotCaptureFailureStatus =
  | 'cancelled'
  | 'permission_denied'
  | 'unsupported'
  | 'empty'
  | 'busy'
  | 'failed';

export type ScreenshotIntakeResult =
  | { status: 'captured'; image: File; clipboardCopied: boolean }
  | { status: ScreenshotCaptureFailureStatus; reason?: string };

export type ClipboardSnapshotResult =
  | { status: 'available'; text?: string; image?: File; reason?: string }
  | { status: 'empty' | 'unsupported' | 'denied' | 'busy' | 'failed'; reason?: string };

export interface ScreenshotIntakeAdapter {
  capture(requestId: string): Promise<ScreenshotIntakeResult>;
}

export interface ClipboardIntakeAdapter {
  snapshot(requestId: string): Promise<ClipboardSnapshotResult>;
}

export interface ScreenshotQueueAdmission {
  accepted: boolean;
  reason?: string;
}

export type ScreenshotIntakeOutcome =
  | { status: 'capacity_full' }
  | { status: ScreenshotCaptureFailureStatus; reason?: string }
  | { status: 'queued'; image: File; clipboardCopied: boolean }
  | { status: 'pending'; image: File; clipboardCopied: boolean; reason: string };

/** Called only from an explicit user action; this module installs no listeners. */
export async function captureScreenshotForIntake(
  adapter: ScreenshotIntakeAdapter,
  requestId: string,
): Promise<ScreenshotIntakeResult> {
  return adapter.capture(requestId);
}

/** Runs only after an explicit user action and returns the actual queue admission result. */
export async function captureScreenshotIntoIntake(
  adapter: ScreenshotIntakeAdapter,
  requestId: string,
  hasCapacity: () => boolean,
  enqueue: (image: File) => Promise<ScreenshotQueueAdmission>,
): Promise<ScreenshotIntakeOutcome> {
  if (!hasCapacity()) return { status: 'capacity_full' };

  const result = await captureScreenshotForIntake(adapter, requestId);
  if (result.status !== 'captured') return result;
  const admission = await enqueue(result.image);
  if (admission.accepted) {
    return { status: 'queued', image: result.image, clipboardCopied: result.clipboardCopied };
  }
  return {
    status: 'pending',
    image: result.image,
    clipboardCopied: result.clipboardCopied,
    reason: admission.reason ?? '图片没有加入收集队列。',
  };
}
