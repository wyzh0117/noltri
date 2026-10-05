import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient, verifyCoreIdentity } from '@noltri/api-client';
import type { HealthResponse } from '@noltri/schema';
import { loadMcpConfig } from './index';
import { buildServer, MCP_SERVER_NAME } from './server';

/**
 * The stdio MCP server (§11: 默认 stdio transport；其进程仅代理本地 Core，不另建数据库).
 *
 * Stdout is the JSON-RPC channel, so every word this process says for a human goes to stderr — the same
 * rule the native host learned the expensive way in P3. The process also refuses to serve until the port
 * it was pointed at has answered as the Noltri Core: a stdio client that reports "connected" to a foreign
 * local service would tell the user their Agent is wired to their knowledge base when it is not.
 */

export type StdioLog = (line: string) => void;

export const stderrLog: StdioLog = (line) => {
  process.stderr.write(`[noltri-mcp ${MCP_SERVER_NAME}] ${line}\n`);
};

export type StdioRefusal = 'missing_api_url' | 'core_unreachable' | 'not_noltri_core' | 'protocol_mismatch';

export type StdioOutcome =
  | { readonly served: true; readonly core: { version: string; instanceId: string } }
  | { readonly served: false; readonly reason: StdioRefusal; readonly detail: string };

export interface StdioStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface StdioOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: StdioLog;
  readonly streams?: StdioStreams;
  /** Test seam: answers the identity probe instead of the real Core. */
  readonly probeHealth?: (client: ApiClient) => Promise<HealthResponse>;
  /** Test seam: called instead of attaching a transport to real stdin/stdout. */
  readonly attach?: (server: ReturnType<typeof buildServer>) => Promise<void>;
}

export type StdioRefused = Extract<StdioOutcome, { readonly served: false }>;

export interface StdioServer {
  serve(): Promise<StdioOutcome>;
  close(): Promise<void>;
}

export function createStdioServer(options: StdioOptions = {}): StdioServer {
  const log = options.log ?? stderrLog;
  const config = loadMcpConfig(options.env === undefined ? process.env : ({ ...options.env } as Record<string, string>));
  const client = new ApiClient({
    baseUrl: config.apiBaseUrl,
    ...(config.accessToken === '' ? {} : { token: config.accessToken }),
    timeoutMs: 15_000,
  });
  let transport: StdioServerTransport | undefined;

  async function probeHealth(): Promise<{ readonly health: HealthResponse } | { readonly failure: StdioRefused }> {
    try {
      const health = options.probeHealth === undefined ? await client.health() : await options.probeHealth(client);
      return { health };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return {
        failure: { served: false, reason: 'core_unreachable', detail: `GET ${config.apiBaseUrl}/api/health 失败：${message}` },
      };
    }
  }

  async function serve(): Promise<StdioOutcome> {
    if (config.apiBaseUrl.trim() === '') {
      return {
        served: false,
        reason: 'missing_api_url',
        detail: 'KNOWLEDGE_API_URL 未配置：stdio 入口不知道该把工具调用转给谁，因此不开始服务。',
      };
    }

    const probed = await probeHealth();
    if ('failure' in probed) {
      log(`startup probe failed — refusing to serve: ${probed.failure.detail}`);
      return probed.failure;
    }
    const verdict = verifyCoreIdentity(probed.health);
    if (!verdict.ok) {
      log(`startup probe refused — refusing to serve: ${verdict.message}`);
      return { served: false, reason: verdict.code === 'protocol_mismatch' ? 'protocol_mismatch' : 'not_noltri_core', detail: verdict.message };
    }

    const server = buildServer({ apiClient: client, config: { version: config.version } });
    if (options.attach === undefined) {
      const streams = options.streams;
      transport =
        streams === undefined
          ? new StdioServerTransport()
          : new StdioServerTransport(streams.stdin as never, streams.stdout as never);
      await server.connect(transport);
    } else {
      await options.attach(server);
    }
    log(`serving over stdio, core ${verdict.identity.version} (instance ${verdict.identity.instanceId})`);
    return { served: true, core: { version: verdict.identity.version, instanceId: verdict.identity.instanceId } };
  }

  async function close(): Promise<void> {
    if (transport === undefined) return;
    const stopping = transport;
    transport = undefined;
    await stopping.close().catch(() => undefined);
    await delay(0);
  }

  return { serve, close };
}

async function main(): Promise<void> {
  const entry = createStdioServer();
  const outcome = await entry.serve();
  if (!outcome.served) process.exitCode = 1;
}

const entryPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
