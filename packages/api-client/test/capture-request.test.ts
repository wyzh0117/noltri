/**
 * The unified capture request every entry point shares (V1_Local_Desktop §7.4, §10.3).
 *
 * A queued capture must be replayable with the *same* key, so the builder generates a requestId only when
 * the caller did not state one, and the reply has to carry the stage the server reached plus the retryable
 * hint a queue needs before it decides to resend.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRequest } from '@noltri/schema';
import { ApiClient, ApiClientError, apiRoutes, buildCaptureRequest } from '../src/client';

interface Recorded {
  url: string;
  method: string;
  body: string | undefined;
}

function stub(response: { status: number; payload: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(response.payload), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const TEXT = '元组一旦创建就不能修改，因此可以作为字典的键使用。';
const SOURCE = { type: 'web' as const, platform: 'chrome', appName: '浏览器' };
const CAPTURED_AT = '2026-10-05T02:00:00.000Z';

function clientFor(fetchImpl: typeof fetch) {
  return new ApiClient({ baseUrl: 'http://127.0.0.1:8787', token: 'device-token', clientHint: 'extension', fetchImpl });
}

const RESULT = {
  rawSourceId: 'src-1',
  requestId: 'req-queue-000001',
  stage: 'completed',
  duplicate: false,
  processingStatus: 'done',
  items: [],
} as const;

describe('buildCaptureRequest', () => {
  it('generates a request id when the caller states none', () => {
    const first = buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension' });
    const second = buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension' });

    expect(first.requestId.length).toBeGreaterThanOrEqual(8);
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('keeps the request id a queue handed back, so a replay stays idempotent', () => {
    const queued = buildCaptureRequest({
      text: TEXT,
      source: SOURCE,
      client: 'extension',
      requestId: 'req-queue-000001',
      capturedAt: CAPTURED_AT,
      deviceId: 'device-01',
    });
    const replay = buildCaptureRequest({
      text: TEXT,
      source: SOURCE,
      client: 'extension',
      requestId: queued.requestId,
      capturedAt: queued.capture.capturedAt,
      deviceId: 'device-01',
    });

    expect(queued.requestId).toBe('req-queue-000001');
    expect(replay).toEqual(queued);
    expect(queued.capture).toEqual({ capturedAt: CAPTURED_AT, client: 'extension', deviceId: 'device-01' });
  });

  it('still omits the optional fields a caller did not supply', () => {
    const request = buildCaptureRequest({ text: TEXT, source: { type: 'manual' }, client: 'web_app' });
    expect('deviceId' in request.capture).toBe(false);
    expect('surroundingContext' in request).toBe(false);
  });
});

describe('ApiClient capture', () => {
  it('sends the key and reads the stage the server reached', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: RESULT });
    const request = buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension', requestId: 'req-queue-000001' });

    const result = await clientFor(fetchImpl).capture(request);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.capture}`);
    expect(calls[0]?.body).toContain('"requestId":"req-queue-000001"');
    expect(result.stage).toBe('completed');
    expect(result.duplicate).toBe(false);
    expect(result.requestId).toBe('req-queue-000001');
  });

  it('refuses to send a capture whose request id is not usable, before the network', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: RESULT });
    const unsigned = { ...buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension' }), requestId: '' };

    // Validation runs while the call is being built, so the refusal is synchronous — and that is the
    // point: an unusable key never reaches the wire and never becomes a second capture.
    expect(() => clientFor(fetchImpl).capture(unsigned as CaptureRequest)).toThrowError(ApiClientError);
    expect(calls).toEqual([]);
  });

  it('carries retryable and traceId onto the error a queue has to act on', async () => {
    const { fetchImpl } = stub({
      status: 502,
      payload: { error: { code: 'provider_error', message: '模型超时', retryable: true, traceId: 'trace-77' } },
    });

    const error = await clientFor(fetchImpl)
      .capture(buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension' }))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    const failure = error as ApiClientError;
    expect(failure.code).toBe('provider_error');
    expect(failure.retryable).toBe(true);
    expect(failure.traceId).toBe('trace-77');
    // A transport failure the server never answered has no envelope: the code still says it may be resent.
    expect(new ApiClientError(0, 'internal_error', 'Request timed out').retryable).toBe(true);
    expect(new ApiClientError(400, 'invalid_request', '正文太短').retryable).toBe(false);
  });

  it('refuses a reply that does not state a stage', async () => {
    const { fetchImpl } = stub({
      status: 200,
      payload: { rawSourceId: 'src-1', processingStatus: 'done', items: [] },
    });
    await expect(
      clientFor(fetchImpl).capture(buildCaptureRequest({ text: TEXT, source: SOURCE, client: 'extension' })),
    ).rejects.toBeInstanceOf(ApiClientError);
  });
});
