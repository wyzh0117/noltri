import type { CaptureRequest, CaptureResult, HealthResponse } from '@noltri/schema';
import type { FrameError, ParseEvent } from '../src/framing';
import { CORE_PRODUCT_ID, CORE_PROTOCOL_VERSION } from '@noltri/schema';

export function captureRequest(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    requestId: 'req-native-host-test-01',
    text: '切片返回列表时仍然是浅拷贝，嵌套元素依旧共享。',
    source: { type: 'web', platform: 'docs.example.com', title: 'Python Slice', url: 'https://docs.example.com/slice' },
    capture: { capturedAt: '2026-10-05T09:30:00.000Z', client: 'extension', deviceId: 'device-native-01' },
    ...overrides,
  };
}

export function captureResult(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    rawSourceId: 'rs-native-1',
    requestId: 'req-native-host-test-01',
    stage: 'saved',
    duplicate: false,
    items: [],
    processingStatus: 'pending',
    ...overrides,
  };
}

export function coreHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    productId: CORE_PRODUCT_ID,
    instanceId: 'instance-native-0001',
    protocolVersion: CORE_PROTOCOL_VERSION,
    version: '0.1.0',
    storageDriver: 'sqlite',
    storage: { driver: 'sqlite', ok: true, detail: { file: 'noltri.sqlite', sources: 3 } },
    aiProvider: 'openai-compatible',
    embeddingDim: 1024,
    requiresAiKey: false,
    ...overrides,
  };
}

export const SECRET_TEXT = '只有本机可见的选中文本，绝不该出现在日志里。';

export function frameValues(events: readonly ParseEvent[]): unknown[] {
  return events.flatMap((event) => (event.kind === 'frame' ? [event.value] : []));
}

export function frameErrors(events: readonly ParseEvent[]): FrameError[] {
  return events.flatMap((event) => (event.kind === 'error' ? [event.error] : []));
}
