import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@noltri/api-client';
import { CORE_PRODUCT_ID, CORE_PROTOCOL_VERSION, type CaptureRequest, type CaptureResult, type HealthResponse } from '@noltri/schema';
import { createGateway, createHostSession, readableCoreMessage, verifyIdentity, type CoreGateway } from '../src/host';
import { captureRequest, coreHealth, captureResult, SECRET_TEXT } from './fixtures';
import type { HostRequest, HostResponse } from '../src/protocol';

interface Recorded {
  readonly calls: { health: number; capture: CaptureRequest[] };
  readonly gateway: CoreGateway;
  readonly logs: string[];
}

function stubGateway(health: () => Promise<HealthResponse>, capture: (request: CaptureRequest) => Promise<CaptureResult>): Recorded {
  const calls = { health: 0, capture: [] as CaptureRequest[] };
  const logs: string[] = [];
  const gateway: CoreGateway = {
    health: async () => {
      calls.health += 1;
      return health();
    },
    capture: async (request) => {
      calls.capture.push(request);
      return capture(request);
    },
  };
  return { calls, gateway, logs };
}

const UNREACHABLE = new ApiClientError(0, 'internal_error', 'Failed to fetch');

function loggedSession(recorded: Recorded) {
  return createHostSession({
    gateway: recorded.gateway,
    logger: (message, fields) => recorded.logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  });
}

function sequencedGateway(replies: readonly HealthResponse[], capture?: (request: CaptureRequest) => Promise<CaptureResult>) {
  const captured: CaptureRequest[] = [];
  let probe = 0;
  const gateway: CoreGateway = {
    health: async () => {
      const reply = replies[Math.min(probe, replies.length - 1)] as HealthResponse;
      probe += 1;
      return reply;
    },
    capture: async (request) => {
      captured.push(request);
      return capture === undefined ? captureResult() : capture(request);
    },
  };
  return { gateway, captured, probes: () => probe };
}

async function handle(gateway: CoreGateway, request: HostRequest): Promise<HostResponse> {
  return createHostSession({ gateway }).handle(request);
}

describe('the port must prove it is Noltri before text leaves the host (§7.6)', () => {
  it('accepts a Core that names the product, the protocol and its instance', () => {
    const verdict = verifyIdentity(coreHealth());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.identity).toEqual({
      productId: CORE_PRODUCT_ID,
      instanceId: 'instance-native-0001',
      protocolVersion: CORE_PROTOCOL_VERSION,
      version: '0.1.0',
    });
    expect(verdict.restarted).toBe(false);
  });

  it('refuses a different service answering on the same port', () => {
    const verdict = verifyIdentity(coreHealth({ productId: 'some-other-local-server' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('core_identity_mismatch');
    expect(verdict.message).toBe('这个端口上运行的不是知序 Noltri Core，内容没有发送');
  });

  it('refuses a Core speaking a protocol this host does not understand', () => {
    const verdict = verifyIdentity(coreHealth({ protocolVersion: '2' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('protocol_mismatch');
    expect(verdict.message).toContain('协议版本');
  });

  it('notices the App restarted underneath an open connection', () => {
    const verdict = verifyIdentity(coreHealth({ instanceId: 'instance-native-0002' }), 'instance-native-0001');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.restarted).toBe(true);
  });

  it('never forwards a capture when the identity check fails, not even one', async () => {
    const recorded = stubGateway(
      async () => coreHealth({ productId: 'im-postgres-not-noltri' }),
      async () => captureResult(),
    );
    const response = await handle(recorded.gateway, { type: 'capture', request: captureRequest({ text: SECRET_TEXT }) });

    expect(response).toEqual({
      ok: false,
      code: 'core_identity_mismatch',
      message: '这个端口上运行的不是知序 Noltri Core，内容没有发送',
      retryable: false,
    });
    expect(recorded.calls.capture).toHaveLength(0);
    expect(JSON.stringify(recorded.logs)).not.toContain(SECRET_TEXT);
  });

  it('re-verifies on every request, so a service swapped onto the port mid-session is caught', async () => {
    const sequenced = sequencedGateway([coreHealth(), coreHealth({ productId: 'attacker-on-8787' })]);
    const session = createHostSession({ gateway: sequenced.gateway });

    expect((await session.handle({ type: 'capture', request: captureRequest() })).ok).toBe(true);
    const second = await session.handle({ type: 'capture', request: captureRequest({ requestId: 'req-native-host-test-02' }) });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('core_identity_mismatch');
    expect(sequenced.captured).toHaveLength(1);
    expect(sequenced.probes()).toBe(2);
  });

  it('recovers when the port stops lying, because a refusal does not latch', async () => {
    const sequenced = sequencedGateway([coreHealth({ productId: 'not-noltri' }), coreHealth()]);
    const session = createHostSession({ gateway: sequenced.gateway });

    expect((await session.handle({ type: 'health' })).ok).toBe(false);
    const second = await session.handle({ type: 'capture', request: captureRequest() });
    expect(second.ok).toBe(true);
    expect(sequenced.captured).toHaveLength(1);
  });
});

describe('hello and health replies', () => {
  it('reports the Core identity and the host protocol version', async () => {
    const recorded = stubGateway(async () => coreHealth(), async () => captureResult());
    const response = await handle(recorded.gateway, { type: 'hello' });
    expect(response).toEqual({
      ok: true,
      kind: 'hello',
      hostProtocol: CORE_PROTOCOL_VERSION,
      core: { productId: CORE_PRODUCT_ID, instanceId: 'instance-native-0001', protocolVersion: CORE_PROTOCOL_VERSION, version: '0.1.0' },
    });
  });

  it('carries the real storage state, not just an ok flag', async () => {
    const recorded = stubGateway(async () => coreHealth({ status: 'degraded', storage: { driver: 'sqlite', ok: false, detail: { reason: 'disk full' } } }), async () => captureResult());
    const response = await handle(recorded.gateway, { type: 'health' });
    expect(response.ok).toBe(true);
    if (!response.ok || response.kind !== 'health') throw new Error('unreachable');
    expect(response.storage).toEqual({ driver: 'sqlite', ok: false, detail: { reason: 'disk full' } });
    expect(response.core.instanceId).toBe('instance-native-0001');
  });

  it('answers an unreachable Core as retryable, and says the App is what to check', async () => {
    const recorded = stubGateway(
      async () => {
        throw UNREACHABLE;
      },
      async () => captureResult(),
    );
    const response = await handle(recorded.gateway, { type: 'capture', request: captureRequest({ text: SECRET_TEXT }) });
    expect(response).toEqual({
      ok: false,
      code: 'core_unreachable',
      message: '未找到本地 Noltri Core，请确认知序 App 正在运行',
      retryable: true,
    });
    expect(recorded.calls.capture).toHaveLength(0);
  });
});

describe('capture forwarding', () => {
  it('passes the request through untouched and returns the Core stage reply', async () => {
    const request = captureRequest({ requestId: 'req-native-host-keepme' });
    const recorded = stubGateway(
      async () => coreHealth(),
      async () => captureResult({ requestId: request.requestId, stage: 'needs_review', duplicate: true, processingStatus: 'done' }),
    );
    const response = await handle(recorded.gateway, { type: 'capture', request });

    expect(recorded.calls.capture).toEqual([request]);
    expect(response.ok).toBe(true);
    if (!response.ok || response.kind !== 'capture') throw new Error('unreachable');
    expect(response.results).toHaveLength(1);
    const [first] = response.results;
    if (first === undefined || !('stage' in first)) throw new Error('unreachable');
    expect(first.stage).toBe('needs_review');
    expect(first.duplicate).toBe(true);
  });

  it('sends a batch in order and keeps a half-failure inside the batch', async () => {
    const first = captureRequest({ requestId: 'req-native-host-batch-a' });
    const second = captureRequest({ requestId: 'req-native-host-batch-b' });
    const recorded = stubGateway(
      async () => coreHealth(),
      async (request) => {
        if (request.requestId === second.requestId) throw new ApiClientError(503, 'storage_error', 'Knowledge Core 存储写入失败');
        return captureResult({ requestId: request.requestId });
      },
    );
    const response = await handle(recorded.gateway, { type: 'capture_batch', requests: [first, second] });

    expect(recorded.calls.capture.map((one) => one.requestId)).toEqual([first.requestId, second.requestId]);
    expect(response.ok).toBe(true);
    if (!response.ok || response.kind !== 'capture') throw new Error('unreachable');
    expect(response.results[0]).toMatchObject({ requestId: first.requestId });
    expect(response.results[1]).toMatchObject({ ok: false, code: 'capture_failed', retryable: true });
  });

  it('reports a batch as a whole failure when the very first entry never landed', async () => {
    const recorded = stubGateway(
      async () => coreHealth(),
      async () => {
        throw new ApiClientError(503, 'storage_error', 'Knowledge Core 存储写入失败');
      },
    );
    const response = await handle(recorded.gateway, { type: 'capture_batch', requests: [captureRequest(), captureRequest({ requestId: 'req-native-host-test-02' })] });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('unreachable');
    expect(response.code).toBe('capture_failed');
    expect(response.retryable).toBe(true);
  });

  it('answers a Core that breaks its own contract in Chinese, not with an internal sentence', async () => {
    const recorded = stubGateway(
      async () => coreHealth(),
      async () => {
        throw new ApiClientError(502, 'internal_error', 'Knowledge Core response did not match the shared contract for POST /api/capture');
      },
    );
    const response = await handle(recorded.gateway, { type: 'capture', request: captureRequest() });
    expect(response).toEqual({
      ok: false,
      code: 'capture_failed',
      message: '本地 Core 的返回不符合契约，这条采集未确认',
      retryable: true,
    });
    expect(JSON.stringify(response)).not.toMatch(/contract|\/api\//);
  });

  it('treats a rejected credential as permanent, so the queue stops retrying it forever', async () => {
    const recorded = stubGateway(
      async () => coreHealth(),
      async () => {
        throw new ApiClientError(401, 'unauthorized', 'bad token');
      },
    );
    const response = await handle(recorded.gateway, { type: 'capture', request: captureRequest() });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('unreachable');
    expect(response).toEqual({ ok: false, code: 'capture_failed', message: '本地 Core 拒绝了该扩展的凭据', retryable: false });
  });

  it('logs the refusal reason without logging the user text', async () => {
    const recorded = stubGateway(
      async () => coreHealth({ productId: 'other' }),
      async () => captureResult(),
    );
    const session = loggedSession(recorded);
    await session.handle({ type: 'capture', request: captureRequest({ text: SECRET_TEXT, surroundingContext: SECRET_TEXT }) });

    expect(recorded.logs).toContain('core identity refused {"code":"core_identity_mismatch"}');
    expect(recorded.logs.join('\n')).not.toContain(SECRET_TEXT);
  });
});

describe('readableCoreMessage', () => {
  it('keeps a sentence the Core wrote for a human', () => {
    expect(readableCoreMessage(new ApiClientError(409, 'conflict', '这条知识与已有知识冲突'))).toBe('这条知识与已有知识冲突');
  });

  it.each([
    'TypeError: Cannot read properties of undefined\n    at classify (core.js:12:3)',
    'SqliteError: no such table: raw_sources',
    'Error: EACCES: permission denied, open /Users/youngi/.noltri/data/noltri.sqlite',
    '{"sql":"select * from knowledge_items","code":"storage_error"}',
  ])('replaces internals with a stable Chinese line: %s', (message) => {
    const out = readableCoreMessage(new ApiClientError(500, 'storage_error', message));
    expect(out).toBe('本地 Core 处理这条采集时出错了，原始内容未确认');
    expect(out).not.toMatch(/at |Error|select|Users|sql/);
  });

  it('caps what it will forward to a page', () => {
    const long = '本'.repeat(500);
    expect(readableCoreMessage(new ApiClientError(500, 'internal_error', long)).length).toBeLessThanOrEqual(160);
  });
});

describe('createGateway', () => {
  it('omits the bearer header when the runtime record carries no token', async () => {
    const headers: (Record<string, string> | undefined)[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      headers.push(init?.headers as Record<string, string> | undefined);
      return new Response(JSON.stringify(coreHealth()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const gateway = createGateway({ baseUrl: 'http://127.0.0.1:8787', token: '', source: 'default' }, fetchImpl);
    await gateway.health();
    expect(JSON.stringify(headers)).not.toContain('authorization');

    const withToken = createGateway({ baseUrl: 'http://127.0.0.1:8787', token: 'runtime-token', source: 'config' }, fetchImpl);
    await withToken.health();
    expect(JSON.stringify(headers)).toContain('Bearer runtime-token');
  });
});
