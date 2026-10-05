import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the host learns which Knowledge Core to talk to.
 *
 * The browser gives a native host almost nothing: no port, no token, no idea which profile launched it.
 * The desktop app therefore publishes a small runtime file the host can read, and the host refuses to
 * trust it if any other user could have written it (§16: 短期运行凭据放在仅本人可读的文件里，与端口/PID 发现信息分开).
 */

export const HOST_CONFIG_FILENAME = 'native-host.json';
export const DEFAULT_CORE_BASE_URL = 'http://127.0.0.1:8787';
/** Group or other access is a hard no: a world-readable credential file is a leaked credential. */
const PRIVATE_FILE_MODE = 0o600;

export interface CoreEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  readonly source: 'config' | 'env' | 'default';
}

export interface HostConfigRecord {
  readonly baseUrl: string;
  readonly token: string;
  readonly instanceId?: string;
  readonly protocolVersion?: string;
}

export function hostConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.noltri', 'data', HOST_CONFIG_FILENAME);
}

/** Tolerant by design: a half-written file must degrade to env/default, not crash a browser process. */
export function parseHostConfig(raw: unknown): HostConfigRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.baseUrl !== 'string' || record.baseUrl.length === 0) return undefined;
  return {
    baseUrl: record.baseUrl,
    token: typeof record.token === 'string' ? record.token : '',
    ...(typeof record.instanceId === 'string' ? { instanceId: record.instanceId } : {}),
    ...(typeof record.protocolVersion === 'string' ? { protocolVersion: record.protocolVersion } : {}),
  };
}

export function resolveEndpoint(input: {
  readonly config?: HostConfigRecord;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): CoreEndpoint {
  const config = input.config;
  if (config !== undefined) return { baseUrl: config.baseUrl, token: config.token, source: 'config' };
  const env = input.env ?? process.env;
  const fromEnv = env['NOLTRI_API_BASE_URL'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { baseUrl: fromEnv, token: env['NOLTRI_API_TOKEN'] ?? '', source: 'env' };
  }
  return { baseUrl: DEFAULT_CORE_BASE_URL, token: '', source: 'default' };
}

export class InsecureConfigFileError extends Error {
  constructor(filePath: string, mode: number) {
    super(`native host config ${filePath} is mode ${mode.toString(8)}, expected ${PRIVATE_FILE_MODE.toString(8)} or stricter`);
    this.name = 'InsecureConfigFileError';
  }
}

export function assertPrivateMode(filePath: string, mode: number): void {
  if ((mode & 0o077) !== 0) throw new InsecureConfigFileError(filePath, mode);
}

export interface ConfigReader {
  read(filePath: string): Promise<HostConfigRecord | undefined>;
}

/**
 * The real reader. A file the user dropped there by hand with loose permissions is ignored rather than
 * used, because reading a credential from a file another account could have edited is the whole attack.
 */
export function createFileConfigReader(
  stat: (filePath: string) => { mode: number } = (filePath) => ({ mode: statSync(filePath).mode }),
  slurp: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
): ConfigReader {
  return {
    read: async (filePath) => {
      let mode: number;
      try {
        mode = stat(filePath).mode;
      } catch {
        return undefined;
      }
      try {
        assertPrivateMode(filePath, mode);
      } catch {
        return undefined;
      }
      let text: string;
      try {
        text = await slurp(filePath);
      } catch {
        return undefined;
      }
      try {
        return parseHostConfig(JSON.parse(text) as unknown);
      } catch {
        return undefined;
      }
    },
  };
}
