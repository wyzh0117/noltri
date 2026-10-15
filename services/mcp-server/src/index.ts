import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiClient } from '@noltri/api-client';
import {
  createLogger,
  currentEnv,
  envBoolean,
  envInt,
  envString,
  knowledgeError,
  type EnvSource,
  type Logger,
} from '@noltri/shared';
import dotenv from 'dotenv';
import { buildServer, MCP_SERVER_NAME } from './server';

export interface McpHttpConfig {
  readonly version: string;
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly authRequired: boolean;
  readonly corsOrigin: string;
  readonly port: number;
  readonly host: string;
}

/** Loads local config for repo, packaged, and stdio runs; actual process env always wins. */
export function loadMcpRootEnv(startFrom: string = path.dirname(fileURLToPath(import.meta.url))): void {
  const findUp = (name: string): string | undefined => {
    let cursor = startFrom;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(cursor, name);
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return undefined;
  };
  const data = process.env.NOLTRI_DATA_DIR?.trim();
  const candidates = [
    process.env.NOLTRI_ENV_FILE?.trim(),
    findUp('.env.local'),
    path.join(os.homedir(), '.noltri', '.env.local'),
    ...(data ? [path.join(data, '.env.local')] : []),
    findUp('.env'),
    path.join(os.homedir(), '.noltri', '.env'),
    ...(data ? [path.join(data, '.env')] : []),
  ].filter((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
  for (const candidate of new Set(candidates)) dotenv.config({ path: candidate, quiet: true });
}

export function loadMcpConfig(env: EnvSource = currentEnv()): McpHttpConfig {
  const accessToken = envString(env, 'NOLTRI_ACCESS_TOKEN');
  const authRequired = envBoolean(env, 'AUTH_REQUIRED', false);
  if (authRequired && accessToken === '') {
    throw new Error(
      'AUTH_REQUIRED=true 但未配置 NOLTRI_ACCESS_TOKEN，MCP 无法校验调用方身份。Set NOLTRI_ACCESS_TOKEN before starting the MCP server.',
    );
  }
  return {
    version: envString(env, 'MCP_VERSION', '0.1.1'),
    apiBaseUrl: envString(env, 'KNOWLEDGE_API_URL').trim() || 'http://127.0.0.1:8787',
    accessToken,
    authRequired,
    corsOrigin: envString(env, 'CORS_ORIGIN', '*'),
    port: envInt(env, 'MCP_PORT', 8790),
    host: envString(env, 'MCP_HOST', '127.0.0.1'),
  };
}

function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, ...rest] = header.trim().split(' ');
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token === '' ? undefined : token;
}

/** Constant-time comparison over digests, so neither length nor content leaks through timing. */
function tokenMatches(presented: string, configured: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(configured));
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload, 'utf8')),
    ...headers,
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolveBody, rejectBody) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function healthBody(config: McpHttpConfig): Record<string, unknown> {
  // Reports configuration only — the token value is never serialized here.
  return {
    status: config.apiBaseUrl === '' ? 'degraded' : 'ok',
    server: MCP_SERVER_NAME,
    version: config.version,
    transport: 'streamable-http',
    sessionMode: 'stateless',
    endpoint: '/mcp',
    knowledgeApiConfigured: config.apiBaseUrl !== '',
    accessTokenConfigured: config.accessToken !== '',
    authRequired: config.authRequired,
  };
}

/**
 * V1 serves MCP over stateless Streamable HTTP: a fresh Server + transport per POST /mcp request,
 * so no mcp-session-id and no SSE GET stream are needed — one POST carries a whole request.
 */
async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  config: McpHttpConfig,
  callerToken: string | undefined,
): Promise<void> {
  const raw = await readRawBody(req);
  if (raw === '') {
    writeJson(res, 400, knowledgeError('invalid_request', '请求体为空：请 POST 一个 JSON-RPC 消息。').toJSON());
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw) as unknown;
  } catch {
    writeJson(res, 400, knowledgeError('invalid_request', '请求体不是合法 JSON，无法解析 JSON-RPC 消息。').toJSON());
    return;
  }

  // The caller's bearer token is forwarded to Knowledge Core, which resolves the user identity.
  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    ...(callerToken === undefined ? {} : { token: callerToken }),
  });
  const server = buildServer({ apiClient, config: { version: config.version } });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: McpHttpConfig,
  log: Logger,
): Promise<void> {
  res.setHeader('access-control-allow-origin', config.corsOrigin);
  res.setHeader('vary', 'origin');

  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
    res.setHeader('access-control-max-age', '600');
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    writeJson(res, 200, healthBody(config));
    return;
  }

  if (pathname !== '/mcp') {
    const issue = knowledgeError('not_found', `未知路径 ${pathname}。MCP endpoint 是 POST /mcp，健康检查是 GET /healthz。`);
    writeJson(res, 404, issue.toJSON());
    return;
  }

  if (req.method !== 'POST') {
    const issue = knowledgeError(
      'invalid_request',
      `${String(req.method)} /mcp 不支持：本 V1 endpoint 为 stateless Streamable HTTP，请用 POST /mcp 发送 JSON-RPC（initialize → tools/list → tools/call），并在 Authorization 头带上 Bearer token。GET 仅用于支持 SSE 的客户端，可安全忽略 405。`,
    );
    writeJson(res, 405, issue.toJSON(), { allow: 'POST, OPTIONS' });
    return;
  }

  const callerToken = bearerFrom(req.headers.authorization);
  if (config.accessToken !== '' && (callerToken === undefined || !tokenMatches(callerToken, config.accessToken))) {
    const issue = knowledgeError(
      'unauthorized',
      '缺少或错误的 Bearer token：请在 MCP 客户端配置 Authorization: Bearer <NOLTRI_ACCESS_TOKEN>。Token 会被转发给 Knowledge Core 以识别用户。',
    );
    writeJson(res, issue.status, issue.toJSON(), { 'www-authenticate': `Bearer realm="${MCP_SERVER_NAME}"` });
    log.warn('MCP 认证失败', { path: pathname, hasToken: callerToken !== undefined });
    return;
  }

  await handleMcpPost(req, res, config, callerToken);
}

export function createMcpApp(config: McpHttpConfig, log: Logger = createLogger('noltri-mcp')): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, config, log).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      log.error('MCP 请求处理异常', { message });
      if (!res.headersSent) {
        writeJson(res, 500, knowledgeError('internal_error', `MCP 服务处理失败（${message}）`).toJSON());
      } else {
        res.destroy();
      }
    });
  });
}

function main(): void {
  loadMcpRootEnv();
  const log = createLogger('noltri-mcp');
  let config: McpHttpConfig;
  try {
    config = loadMcpConfig();
  } catch (error) {
    log.error('MCP 启动被拒绝', { message: error instanceof Error ? error.message : 'unknown config error' });
    process.exitCode = 1;
    return;
  }
  if (config.apiBaseUrl === '') {
    log.warn('KNOWLEDGE_API_URL 未配置：工具调用会返回 internal_error，/healthz 报告 knowledgeApiConfigured=false');
  }
  const app = createMcpApp(config, log);
  app.on('error', (error: Error) => log.error('MCP HTTP 服务错误', { message: error.message }));
  app.listen(config.port, config.host, () => {
    log.info('知序 Noltri MCP endpoint 已启动', {
      url: `http://${config.host}:${String(config.port)}/mcp`,
      knowledgeApiUrl: config.apiBaseUrl,
      version: config.version,
      authMode: config.accessToken === '' ? 'open (dev)' : 'bearer',
    });
  });
}

const entryPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main();
}
