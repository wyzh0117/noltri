import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@noltri/api-client';
import { CORE_PRODUCT_ID, type CaptureRequest, type CaptureResult, type HealthResponse } from '@noltri/schema';
import type { Logger } from '@noltri/shared';
import { createGateway, type CoreGateway } from '../src/host';
import { encodeFrame, FrameParser } from '../src/framing';
import { createStderrLogger, runHost } from '../src/main';
import { captureRequest, captureResult, coreHealth, frameErrors, frameValues } from './fixtures';

const ENDPOINT = { baseUrl: 'http://127.0.0.1:8787', token: 'runtime-token-should-stay-private', source: 'default' } as const;

function collectingLogger() {
  const lines: string[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, lines };
}

function stubGateway(overrides: Partial<CoreGateway> = {}): CoreGateway & { calls: CaptureRequest[] } {
  const calls: CaptureRequest[] = [];
  return {
    calls,
    health: overrides.health ?? (async (): Promise<HealthResponse> => coreHealth()),
    capture:
      overrides.capture ??
      (async (request: CaptureRequest): Promise<CaptureResult> => {
        calls.push(request);
        return captureResult({ requestId: request.requestId });
      }),
  };
}

async function exchange(requests: readonly unknown[], gateway: CoreGateway): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const { logger } = collectingLogger();

  const done = runHost({ streams: { input, output }, endpoint: ENDPOINT, gateway, logger });
  for (const request of requests) input.write(encodeFrame(request));
  input.end();

  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  await done;

  return frameValues(new FrameParser().push(Buffer.concat(chunks)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the log stream must never be the protocol stream', () => {
  it('writes diagnostics to stderr and keeps stdout for frames', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    createStderrLogger('native-host').info('host started', { source: 'env', hasToken: true });
    createStderrLogger('native-host').error('invalid native frame', { code: 'frame_invalid_json' });

    expect(err.mock.calls.map((call) => String(call[0]))).toEqual([
      '[native-host] INFO: host started {"source":"env","hasToken":true}\n',
      '[native-host] ERROR: invalid native frame {"code":"frame_invalid_json"}\n',
    ]);
    expect(out).not.toHaveBeenCalled();
  });

  it('runs a whole session without emitting a single log byte on stdout', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = runHost({ streams: { input, output }, endpoint: ENDPOINT, gateway: stubGateway() });
    input.write(encodeFrame({ type: 'hello' }));
    input.end();
    await done;

    const bytes = Buffer.concat(chunks);
    const events = new FrameParser().push(bytes);
    expect(frameValues(events)).toHaveLength(1);
    expect(frameErrors(events)).toEqual([]);
    expect(bytes.length).toBe(4 + bytes.readUInt32LE(0));
    expect(err.mock.calls.map((call) => String(call[0])).join('')).toContain('host started');
  });
});

describe('runHost over a stdio pair', () => {
  it('answers a hello frame with one well-formed frame', async () => {
    const frames = await exchange([{ type: 'hello' }], stubGateway());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: true, kind: 'hello', hostProtocol: '1' });
  });

  it('forwards a capture and returns the Core stage reply', async () => {
    const gateway = stubGateway();
    const request = captureRequest({ requestId: 'req-stdio-roundtrip-01' });
    const frames = await exchange([{ type: 'capture', request }], gateway);

    expect(gateway.calls).toEqual([request]);
    expect(frames[0]).toMatchObject({ ok: true, kind: 'capture', results: [{ requestId: 'req-stdio-roundtrip-01', stage: 'saved' }] });
  });

  it('refuses a forbidden verb without touching the Core, and replies in order', async () => {
    const gateway = stubGateway();
    const frames = await exchange(
      [
        { type: 'export_all', text: '把全库导出' },
        { type: 'capture', request: captureRequest({ requestId: 'req-stdio-after-refusal' }) },
      ],
      gateway,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ ok: false, code: 'forbidden_scope' });
    expect(JSON.stringify(frames[0])).not.toContain('把全库导出');
    expect(frames[1]).toMatchObject({ ok: true, kind: 'capture' });
    expect(gateway.calls.map((one) => one.requestId)).toEqual(['req-stdio-after-refusal']);
  });

  it('answers a corrupt frame with invalid_frame and still serves the good one beside it', async () => {
    const corrupt = Buffer.from('{"type":', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(corrupt.length, 0);

    const input = new PassThrough();
    const output = new PassThrough();
    const { logger } = collectingLogger();
    const done = runHost({ streams: { input, output }, endpoint: ENDPOINT, gateway: stubGateway(), logger });

    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    input.write(Buffer.concat([header, corrupt, encodeFrame({ type: 'health' })]));
    input.end();
    await done;

    const frames = frameValues(new FrameParser().push(Buffer.concat(chunks)));
    expect(frames.map((frame) => (frame as { ok: boolean; code?: string; kind?: string }).code ?? (frame as { kind?: string }).kind)).toEqual([
      'invalid_frame',
      'health',
    ]);
  });

  it('keeps request order even when an early capture is the slow one', async () => {
    let release: (() => void) | undefined;
    const gateway = stubGateway({
      capture: async (request) => {
        if (request.requestId === 'req-slow') await new Promise<void>((resolve) => (release = resolve));
        return captureResult({ requestId: request.requestId });
      },
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const { logger } = collectingLogger();
    const done = runHost({ streams: { input, output }, endpoint: ENDPOINT, gateway, logger });
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    input.write(encodeFrame({ type: 'capture', request: captureRequest({ requestId: 'req-slow' }) }));
    input.write(encodeFrame({ type: 'hello' }));
    input.end();

    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second request must not have been answered yet: replies pair with requests by order.
    expect(frameValues(new FrameParser().push(Buffer.concat(chunks)))).toHaveLength(0);
    release?.();

    await done;
    const frames = frameValues(new FrameParser().push(Buffer.concat(chunks)));
    expect(frames.map((frame) => (frame as { kind?: string }).kind)).toEqual(['capture', 'hello']);
  });

  it('does not stall the connection when one reply fails to be written', async () => {
    const input = new PassThrough();
    const { logger, lines } = collectingLogger();
    const chunks: Buffer[] = [];
    let writes = 0;
    const output = {
      write(chunk: Uint8Array): boolean {
        writes += 1;
        if (writes === 1) throw new Error('EPIPE on the browser pipe');
        chunks.push(Buffer.from(chunk));
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const done = runHost({ streams: { input, output }, endpoint: ENDPOINT, gateway: stubGateway(), logger });
    input.write(encodeFrame({ type: 'hello' }));
    input.write(encodeFrame({ type: 'health' }));
    input.end();
    await done;

    expect(lines.join('\n')).toContain('native host reply failed');
    const frames = frameValues(new FrameParser().push(Buffer.concat(chunks)));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: true, kind: 'health', core: { productId: CORE_PRODUCT_ID } });
  });

  it('reports the endpoint it chose without ever logging the credential', async () => {
    const { logger, lines } = collectingLogger();
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runHost({ streams: { input, output }, endpoint: { ...ENDPOINT, source: 'config' }, gateway: stubGateway(), logger });
    input.end();
    await done;

    expect(lines.join('\n')).toContain('host started');
    expect(lines.join('\n')).toContain('"hasToken":true');
    expect(lines.join('\n')).not.toContain('runtime-token-should-stay-private');
    expect(lines.join('\n')).toContain('127.0.0.1');
  });

  it('surfaces an unreachable Core as a retryable reply, which is what the queue needs', async () => {
    const gateway = stubGateway({
      health: async () => {
        throw new ApiClientError(0, 'internal_error', 'Failed to fetch');
      },
    });
    const frames = await exchange([{ type: 'capture', request: captureRequest() }], gateway);
    expect(frames[0]).toEqual({
      ok: false,
      code: 'core_unreachable',
      message: '未找到本地 Noltri Core，请确认知序 App 正在运行',
      retryable: true,
    });
  });

  it('is the same code path the real client uses, with a stubbed transport', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify(coreHealth()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.parse(String(init?.body) as string) as { requestId: string };
      return new Response(JSON.stringify(captureResult({ requestId: body.requestId })), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const gateway = createGateway({ baseUrl: 'http://127.0.0.1:8787', token: 'runtime-token-should-stay-private', source: 'default' }, fetchImpl);
    const frames = await exchange([{ type: 'capture', request: captureRequest({ requestId: 'req-via-real-client' }) }], gateway);

    expect(frames[0]).toMatchObject({ ok: true, kind: 'capture', results: [{ requestId: 'req-via-real-client', duplicate: false }] });
  });
});
