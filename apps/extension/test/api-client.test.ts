import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@noltri/api-client';
import type { CaptureRequest } from '@noltri/schema';
import { DEFAULT_SETTINGS } from '../src/settings/storage';
import {
  OFFLINE_MESSAGE,
  captureIntent,
  createExtensionApiClient,
  describeError,
  parseCaptureResult,
  probeConnection,
} from '../src/api/client';
import { TOAST_SUCCESS_HEADLINE, toastContentFromOutcome } from '../src/overlay/toast-content';

const SETTINGS = { ...DEFAULT_SETTINGS, apiBaseUrl: 'http://localhost:8787', accessToken: 'device-token' };

const REQUEST: CaptureRequest = {
  requestId: 'req-extension-test-0001',
  text: '元组是不可变序列，因此可以作为字典的键。',
  source: { type: 'web', platform: 'docs.example.com', title: 'Python Tuple', url: 'https://docs.example.com/tuple' },
  capture: { capturedAt: '2026-10-03T09:30:00.000Z', client: 'extension', deviceId: 'device-01' },
};

const RESULT = {
  rawSourceId: 'rs-1',
  requestId: 'req-extension-test-0001',
  stage: 'completed',
  duplicate: false,
  items: [
    {
      knowledgeItemId: 'ki-1',
      text: '元组不可变',
      nodeId: 'n-3',
      nodePath: ['编程', 'Python', '数据结构'],
      action: 'attached',
      confidence: 0.86,
      confidenceTier: 'high',
    },
  ],
  processingStatus: 'done',
};

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: string | undefined;
}

function stubFetch(build: () => Response, calls: Call[]): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return build();
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('capture through the shared ApiClient', () => {
  it('turns a 200 into toast data, sending the token and the capture route', async () => {
    const calls: Call[] = [];
    const outcome = await captureIntent(SETTINGS, REQUEST, { fetchImpl: stubFetch(() => json(RESULT), calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:8787/api/capture');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer device-token');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(REQUEST);

    expect(outcome.ok).toBe(true);
    const toast = toastContentFromOutcome(outcome);
    expect(toast.headline).toBe(TOAST_SUCCESS_HEADLINE);
    expect(toast.lines).toEqual(['编程', '└── Python', '    └── 数据结构']);
  });

  it('reports a 500 as a friendly Chinese message and never throws', async () => {
    const calls: Call[] = [];
    const outcome = await captureIntent(
      SETTINGS,
      REQUEST,
      { fetchImpl: stubFetch(() => new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } }), calls) },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toBe('Knowledge Core 暂时不可用（500），内容未保存');
    expect(outcome.message).not.toMatch(/Error|at |\{.*\}/);
  });

  it('surfaces the invalid_request contract code as a user message, before hitting the network', async () => {
    const calls: Call[] = [];
    const outcome = await captureIntent(SETTINGS, { ...REQUEST, text: '太短' }, { fetchImpl: stubFetch(() => json(RESULT), calls) });

    expect(calls).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toBe(describeError(new ApiClientError(400, 'invalid_request', 'Capture payload is not sendable')));
    expect(outcome.message.length).toBeGreaterThan(4);
  });

  it('maps a shaped provider error to the BYOK explanation', async () => {
    const outcome = await captureIntent(
      SETTINGS,
      REQUEST,
      { fetchImpl: stubFetch(() => json({ error: { code: 'provider_error', message: 'upstream exploded', retryable: true } }, 502), []) },
    );
    expect(outcome.ok ? '' : outcome.message).toBe('AI 服务暂时不可用，原始内容已保存');
  });

  it('degrades offline instead of crashing the page', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const outcome = await captureIntent(SETTINGS, REQUEST, { fetchImpl: failing });
    expect(outcome).toEqual({ ok: false, message: OFFLINE_MESSAGE });
    expect(describeError(new ApiClientError(0, 'internal_error', 'Failed to fetch'))).toBe(OFFLINE_MESSAGE);
  });

  it('builds an ApiClient that omits the bearer header when no token is stored', async () => {
    const calls: Call[] = [];
    const client = createExtensionApiClient({ settings: { apiBaseUrl: 'http://localhost:8787', accessToken: '' }, fetchImpl: stubFetch(() => json(RESULT), calls) });
    await client.capture(REQUEST);
    expect(calls[0]?.authorization).toBeUndefined();
  });
});

describe('connection state for the popup', () => {
  it('reports connected with the Core identity', async () => {
    const health = {
      status: 'ok',
      productId: 'noltri-knowledge-core',
      instanceId: 'instance-abc',
      protocolVersion: '1',
      version: '0.1.0',
      storageDriver: 'supabase',
      storage: { driver: 'supabase', ok: true, detail: { host: 'db.example.supabase.co', embeddingDim: 1536 } },
      aiProvider: 'openai',
      embeddingDim: 1536,
      requiresAiKey: true,
    };
    const state = await probeConnection(SETTINGS, { fetchImpl: stubFetch(() => json(health), []) });
    expect(state.connected).toBe(true);
    expect(state.detail).toContain('已连接');
  });

  it('reports not connected with a readable reason', async () => {
    const state = await probeConnection(SETTINGS, {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(state.connected).toBe(false);
    expect(state.detail).toBe(OFFLINE_MESSAGE);
  });
});

describe('broadcast result parsing', () => {
  it('accepts a well-formed result message', () => {
    const outcome = parseCaptureResult({ type: 'noltri/capture-result', ok: true, result: RESULT });
    expect(outcome?.ok).toBe(true);
  });

  it('refuses a malformed result instead of inventing one', () => {
    const outcome = parseCaptureResult({ type: 'noltri/capture-result', ok: true, result: { nope: true } });
    expect(outcome).toEqual({ ok: false, message: 'Knowledge Core 的返回不符合契约，未能确认收纳结果' });
    expect(parseCaptureResult({ type: 'other' })).toBeUndefined();
    expect(parseCaptureResult(null)).toBeUndefined();
  });
});
