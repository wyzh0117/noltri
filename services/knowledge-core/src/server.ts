/**
 * Local development server: node:http hosting the web-standard handler.
 *
 * Runs with zero credentials — `STORAGE_DRIVER=memory AI_PROVIDER=offline` are the defaults of the
 * env loaders, so `tsx src/server.ts` works on a clean machine. 404 / 405 and every failure leave
 * through the router's single error envelope, so a client always parses the same shape.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createLogger } from '@noltri/shared';
import { loadCoreConfig } from './config';
import { buildHandler, type CoreBundle } from './http/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_HTTP_BODY_BYTES = 16_000_000;

class BodyTooLargeError extends Error {}

/** Loads local credentials without assuming cwd; process env always has priority over dotenv files. */
export function loadRootEnv(startFrom: string = here): string | null {
  const explicit = process.env.NOLTRI_ENV_FILE?.trim();
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
  const home = path.join(os.homedir(), '.noltri');
  const data = process.env.NOLTRI_DATA_DIR?.trim();
  const candidates = [
    explicit,
    findUp('.env.local'),
    path.join(home, '.env.local'),
    ...(data ? [path.join(data, '.env.local')] : []),
    findUp('.env'),
    path.join(home, '.env'),
    ...(data ? [path.join(data, '.env')] : []),
  ].filter((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
  for (const candidate of new Set(candidates)) loadDotenv({ path: candidate, quiet: true });
  return candidates[0] ?? null;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return body.length === 0 ? undefined : body;
}

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

const SKIP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'content-encoding']);

export function toWebRequest(request: IncomingMessage, body: Buffer | undefined, port: number, encodedVaultRoot?: string): Request {
  const host = request.headers.host ?? `127.0.0.1:${String(port)}`;
  const url = `http://${host}${request.url ?? '/'}`;
  const method = request.method ?? 'GET';
  const headers = headersOf(request);
  if (encodedVaultRoot !== undefined) headers.set('x-noltri-vault-root', encodedVaultRoot);
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }
  return new Request(url, init);
}

function needsVaultMutationRoot(method: string, pathname: string): boolean {
  const route = pathname.replace(/\/+$/, '') || '/';
  return method === 'PUT' && (
    route === '/api/vault/settings' || route === '/api/vault/file' || /^\/api\/notes\/[^/]+$/.test(route)
  ) || method === 'DELETE' && route === '/api/vault/file' || method === 'POST' && [
    '/api/vault/folder', '/api/vault/rename', '/api/vault/rename-block',
    '/api/vault/history/restore', '/api/vault/legacy-note/restore',
  ].includes(route);
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (!SKIP_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  const body = response.body === null ? null : Buffer.from(await response.arrayBuffer());
  target.writeHead(response.status, response.statusText, headers);
  if (body === null) target.end();
  else target.end(body);
}

export interface RunningServer {
  server: Server;
  bundle: CoreBundle;
  port: number;
  stop: () => Promise<void>;
}

export async function startServer(options: { port?: number } = {}): Promise<RunningServer> {
  const envFile = loadRootEnv();
  const config = loadCoreConfig();
  const logger = createLogger('knowledge-core', 'info');
  if (envFile !== null) logger.info('loaded environment file', { envFile });

  const bundle = await buildHandler(config, { logger });
  const port = options.port ?? config.port;

  const server = createServer((request, response) => {
    const startedAt = Date.now();
    void (async () => {
      const method = request.method ?? 'GET';
      const pathname = (request.url ?? '/').split('?')[0];
      try {
        const incomingVaultRoot = request.headers['x-noltri-vault-root'];
        const encodedVaultRoot = needsVaultMutationRoot(method, pathname)
          ? incomingVaultRoot === undefined
            ? encodeURIComponent(await bundle.vault.captureRootForMutation())
            : Array.isArray(incomingVaultRoot) ? incomingVaultRoot.join(',') : incomingVaultRoot
          : undefined;
        const body = await readBody(request);
        const webRequest = toWebRequest(request, body, port, encodedVaultRoot);
        const webResponse = await bundle.handle(webRequest);
        await writeWebResponse(webResponse, response);
        logger.info('http', {
          method,
          path: pathname,
          status: webResponse.status,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        // Last line of defence: still a JSON envelope, never a stack trace.
        logger.error('unhandled request failure', {
          method,
          path: pathname,
          reason: error instanceof Error ? error.message : 'unknown',
        });
        if (!response.headersSent) {
          const tooLarge = error instanceof BodyTooLargeError;
          response.writeHead(tooLarge ? 413 : 500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(
          JSON.stringify({ error: error instanceof BodyTooLargeError
            ? { code: 'invalid_request', message: `请求正文超过 ${MAX_HTTP_BODY_BYTES} 字节` }
            : { code: 'internal_error', message: 'Knowledge Core 未能完成该请求' } }),
        );
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  logger.info('knowledge core listening', {
    url: `http://127.0.0.1:${String(port)}/api/health`,
    storageDriver: bundle.repository.driver,
    aiProvider: bundle.provider.id,
  });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeIdleConnections?.();
    });
    await bundle.close();
  };

  return { server, bundle, port, stop };
}

const isDirectRun =
  process.argv[1] !== undefined && /server\.(?:mjs|ts|js)$/.test(path.resolve(process.argv[1]));

if (isDirectRun) {
  const running = await startServer();

  const shutdown = (signal: string): void => {
    running.bundle.logger.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(0), 5_000);
    force.unref();
    void running
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    running.bundle.logger.error('uncaught exception', { reason: error.message });
  });
}
