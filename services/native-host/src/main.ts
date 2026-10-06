import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LogLevel, Logger } from '@noltri/shared';
import { createFileConfigReader, hostConfigPath, resolveEndpoint, type CoreEndpoint } from './discovery';
import { encodeFrame, FrameParser } from './framing';
import { createGateway, createHostSession, type CoreGateway } from './host';
import { failure, parseHostRequest, type HostResponse } from './protocol';
import type { ManifestFs } from './manifest';

/**
 * The process Chrome starts. stdin carries length-prefixed requests, stdout carries length-prefixed
 * replies, and every diagnostic goes to stderr — a stray `console.log` here would corrupt the stream and
 * the browser would kill the host without telling the user what went wrong.
 */

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * `@noltri/shared`'s logger prints with `console.info`, i.e. to stdout, which on this process is a binary
 * protocol channel rather than a log. Same line format, different stream.
 */
export function createStderrLogger(scope: string, minLevel: LogLevel = 'info'): Logger {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const suffix = fields === undefined || Object.keys(fields).length === 0 ? '' : ` ${JSON.stringify(fields)}`;
    process.stderr.write(`[${scope}] ${level.toUpperCase()}: ${message}${suffix}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (nested) => createStderrLogger(`${scope}:${nested}`, minLevel),
  };
}

export interface HostStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export interface RunHostOptions {
  readonly streams: HostStreams;
  readonly endpoint?: CoreEndpoint;
  readonly gateway?: CoreGateway;
  readonly logger?: Logger;
}

export async function runHost(options: RunHostOptions): Promise<void> {
  const logger = options.logger ?? createStderrLogger('native-host', 'info');
  const endpoint = options.endpoint ?? resolveEndpoint({ config: await createFileConfigReader().read(hostConfigPath()) });
  const gateway = options.gateway ?? createGateway(endpoint);
  logger.info('host started', {
    source: endpoint.source,
    baseUrl: endpoint.baseUrl,
    hasToken: endpoint.token.length > 0,
  });

  const session = createHostSession({
    gateway,
    logger: (message, fields) => logger.info(message, fields as Readonly<Record<string, unknown>>),
  });
  const parser = new FrameParser();

  // Strictly one request in flight, answered, then the next: Chrome matches replies to requests by order,
  // and two concurrent writes would also interleave bytes inside a frame and get this process killed.
  let queue: Promise<void> = Promise.resolve();
  const respond = (make: () => Promise<HostResponse>): void => {
    queue = queue
      .then(async () => {
        options.streams.output.write(encodeFrame(await make()));
      })
      // A failed reply must not poison the chain, or every later capture on this connection goes silent.
      .catch((error: unknown) => {
        logger.error('native host reply failed', { reason: error instanceof Error ? error.message : 'unknown' });
      });
  };

  await new Promise<void>((resolve) => {
    const input = options.streams.input;
    input.on('data', (chunk: unknown) => {
      const raw = chunk as string | Uint8Array;
      const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
      for (const event of parser.push(bytes)) {
        if (event.kind === 'error') {
          logger.error('invalid native frame', { code: event.error.code });
          const message = event.error.message;
          respond(() => Promise.resolve(failure('invalid_frame', message, false)));
          continue;
        }
        const decision = parseHostRequest(event.value);
        if ('refusal' in decision) {
          const refusal = decision.refusal;
          respond(() => Promise.resolve(refusal));
        } else {
          const request = decision.request;
          respond(() => session.handle(request));
        }
      }
    });
    input.on('end', () => {
      void queue.then(() => resolve());
    });
  });
}

export function createNodeManifestFs(): ManifestFs {
  return {
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeFile: async (filePath, contents) => {
      await writeFile(filePath, contents, { mode: 0o600 });
    },
    exists: async (filePath) => {
      try {
        await readFile(filePath);
        return true;
      } catch {
        return false;
      }
    },
    ensureDir: (dirPath) =>
      mkdir(dirPath, { recursive: true, mode: 0o700 }).then(() => undefined),
    remove: (filePath) => rm(filePath, { force: true }).then(() => undefined),
    findBackup: async (filePath) => {
      const dir = path.dirname(filePath);
      const prefix = `${path.basename(filePath)}.before-`;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return undefined;
      }
      const backups = names.filter((name) => name.startsWith(prefix) && name.endsWith('.bak')).sort().reverse();
      const newest = backups[0];
      return newest === undefined ? undefined : path.join(dir, newest);
    },
  };
}

const isDirectRun = process.argv[1] !== undefined && /(?:^|\/)(?:main|host)\.(?:mjs|ts|mts|js)$/.test(path.resolve(process.argv[1]));

if (isDirectRun) {
  const onFatal = (reason: string) => (error: unknown): void => {
    process.stderr.write(`${reason}: ${error instanceof Error ? error.message : 'unknown'}\n`);
  };
  process.on('uncaughtException', onFatal('native host crashed'));
  process.on('unhandledRejection', onFatal('native host promise rejected'));

  runHost({ streams: { input: process.stdin, output: process.stdout } })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      onFatal('native host failed')(error);
      process.exit(1);
    });
}
