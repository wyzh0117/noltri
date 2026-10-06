/**
 * Local development server: node:http hosting the web-standard handler.
 *
 * Runs with zero credentials — `STORAGE_DRIVER=memory AI_PROVIDER=offline` are the defaults of the
 * env loaders, so `tsx src/server.ts` works on a clean machine. 404 / 405 and every failure leave
 * through the router's single error envelope, so a client always parses the same shape.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createLogger } from '@noltri/shared';
import { loadCoreConfig } from './config';
import { buildHandler, type CoreBundle } from './http/index';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loads the repository-root .env without assuming the process started from any particular folder. */
export function loadRootEnv(startFrom: string = here): string | null {
  let cursor = startFrom;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(cursor, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
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

export function toWebRequest(request: IncomingMessage, body: Buffer | undefined, port: number): Request {
  const host = request.headers.host ?? `127.0.0.1:${String(port)}`;
  const url = `http://${host}${request.url ?? '/'}`;
  const method = request.method ?? 'GET';
  const init: RequestInit = { method, headers: headersOf(request) };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }
  return new Request(url, init);
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
        const body = await readBody(request);
        const webRequest = toWebRequest(request, body, port);
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
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(
          JSON.stringify({ error: { code: 'internal_error', message: 'Knowledge Core 未能完成该请求' } }),
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
