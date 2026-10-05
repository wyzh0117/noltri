import { ApiClient, ApiClientError, verifyCoreIdentity } from '@noltri/api-client';
import { type CaptureRequest, type CaptureResult, type HealthResponse } from '@noltri/schema';
import type { CoreEndpoint } from './discovery';
import { HOST_PROTOCOL_VERSION, failure, type CaptureEntryResult, type HostCoreIdentity, type HostFailure, type HostRequest, type HostResponse } from './protocol';

/**
 * The host's whole job: prove the port it is pointed at is really Noltri's Core, then forward a capture
 * and hand the reply back. Nothing else — no file reads, no shell, no browsing.
 */
export interface CoreGateway {
  health(): Promise<HealthResponse>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
}

export function createGateway(endpoint: CoreEndpoint, fetchImpl?: typeof fetch): CoreGateway {
  const client = new ApiClient({
    baseUrl: endpoint.baseUrl,
    token: endpoint.token.length > 0 ? endpoint.token : undefined,
    timeoutMs: 20_000,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return {
    health: () => client.health(),
    capture: (request) => client.capture(request),
  };
}

export interface HostSession {
  readonly gateway: CoreGateway;
  readonly logger?: (message: string, fields?: Readonly<Record<string, string | number | boolean>>) => void;
}

/**
 * One host process re-verifies before it forwards anything. The browser can hold a connection open for a
 * long time and the App behind the port can be replaced underneath it, so the health probe is the gate on
 * every request rather than a startup check that goes stale; a Core that restarted is noticed by its
 * instance id, and a port that stops answering as Noltri stops text from leaving the host.
 */
export function createHostSession(options: HostSession): { handle(request: HostRequest): Promise<HostResponse> } {
  let verified: HostCoreIdentity | undefined;
  const log = options.logger ?? ((_message, _fields) => undefined);

  type Checked =
    | { readonly kind: 'identity'; readonly identity: HostCoreIdentity; readonly health: HealthResponse }
    | { readonly kind: 'failure'; readonly response: HostResponse };

  async function ensureIdentity(): Promise<Checked> {
    let health: HealthResponse;
    try {
      health = await options.gateway.health();
    } catch (error) {
      return { kind: 'failure', response: describeCoreFailure(error) };
    }
    const verdict = verifyCoreIdentity(health, verified?.instanceId);
    if (!verdict.ok) {
      verified = undefined;
      log('core identity refused', { code: verdict.code });
      return { kind: 'failure', response: failure(verdict.code, verdict.message, false) };
    }
    if (verdict.restarted) log('core instance changed, re-verified', { instanceId: verdict.identity.instanceId });
    verified = verdict.identity;
    return { kind: 'identity', identity: verdict.identity, health };
  }

  return {
    handle: async (request) => {
      const checked = await ensureIdentity();
      if (checked.kind === 'failure') return checked.response;
      const identity = checked.identity;

      if (request.type === 'hello') {
        return { ok: true, kind: 'hello', hostProtocol: HOST_PROTOCOL_VERSION, core: identity };
      }
      if (request.type === 'health') {
        return { ok: true, kind: 'health', core: identity, storage: checked.health.storage };
      }
      const requests = request.type === 'capture' ? [request.request] : request.requests;
      const results: CaptureEntryResult[] = [];
      for (const one of requests) {
        try {
          results.push(await options.gateway.capture(one));
        } catch (error) {
          const why = describeCoreFailure(error);
          if (results.length === 0) return why;
          results.push(why);
        }
      }
      return { ok: true, kind: 'capture', results };
    },
  };
}

/** Never forward a server message verbatim: the host's output is read by a page's script. */
function describeCoreFailure(error: unknown): HostFailure {
  if (error instanceof ApiClientError) {
    if (error.status === 0) return failure('core_unreachable', '未找到本地 Noltri Core，请确认知序 App 正在运行', true);
    if (error.code === 'unauthorized') return failure('capture_failed', '本地 Core 拒绝了该扩展的凭据', false);
    if (error.code === 'internal_error') return failure('capture_failed', '本地 Core 的返回不符合契约，这条采集未确认', error.retryable);
    return failure('capture_failed', readableCoreMessage(error), error.retryable);
  }
  return failure('core_unreachable', '未能与本地 Noltri Core 通信', true);
}

/**
 * What an extension is allowed to see: the Core's own short sentence when it is already human text, and a
 * stable Chinese fallback when it looks like a stack, an SQL fragment or a file path. The browser hands
 * this string to a page, so internals stay in the App's logs instead.
 */
export function readableCoreMessage(error: ApiClientError): string {
  const firstLine = (error.message.split('\n')[0] ?? '').trim();
  if (firstLine.length === 0) return '本地 Core 处理这条采集时出错了，原始内容未确认';
  if (/at\s+\S|Error:|\{.*\}|\/[\w./-]+\.(ts|js|sql)\b|select\s|insert\s|update\s|delete\s/i.test(firstLine)) {
    return '本地 Core 处理这条采集时出错了，原始内容未确认';
  }
  return firstLine.slice(0, 160);
}
