import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPrivateMode,
  createFileConfigReader,
  DEFAULT_CORE_BASE_URL,
  HOST_CONFIG_FILENAME,
  hostConfigPath,
  InsecureConfigFileError,
  parseHostConfig,
  resolveEndpoint,
} from '../src/discovery';

describe('where the host looks', () => {
  it('reads the runtime record out of the user-owned data directory', () => {
    expect(hostConfigPath('/Users/demo')).toBe(path.join('/Users/demo', '.noltri', 'data', HOST_CONFIG_FILENAME));
    expect(HOST_CONFIG_FILENAME).toBe('native-host.json');
  });

  it('parses a full record', () => {
    const record = parseHostConfig({ baseUrl: 'http://127.0.0.1:8787', token: 'runtime-token', instanceId: 'i-1', protocolVersion: '1' });
    expect(record).toEqual({ baseUrl: 'http://127.0.0.1:8787', token: 'runtime-token', instanceId: 'i-1', protocolVersion: '1' });
  });

  it('tolerates a record without a credential but not one without an address', () => {
    expect(parseHostConfig({ baseUrl: 'http://127.0.0.1:9000' })?.token).toBe('');
    expect(parseHostConfig({ token: 'orphan' })).toBeUndefined();
    expect(parseHostConfig({ baseUrl: '' })).toBeUndefined();
    expect(parseHostConfig(null)).toBeUndefined();
    expect(parseHostConfig('http://127.0.0.1:8787')).toBeUndefined();
  });
});

describe('endpoint precedence', () => {
  it('prefers the published runtime record over the environment', () => {
    const endpoint = resolveEndpoint({
      config: { baseUrl: 'http://127.0.0.1:8787', token: 'from-config' },
      env: { NOLTRI_API_BASE_URL: 'http://127.0.0.1:9999', NOLTRI_API_TOKEN: 'from-env' },
    });
    expect(endpoint).toEqual({ baseUrl: 'http://127.0.0.1:8787', token: 'from-config', source: 'config' });
  });

  it('falls back to the environment when no record exists', () => {
    const endpoint = resolveEndpoint({ env: { NOLTRI_API_BASE_URL: 'http://127.0.0.1:9000', NOLTRI_API_TOKEN: 'from-env' } });
    expect(endpoint).toEqual({ baseUrl: 'http://127.0.0.1:9000', token: 'from-env', source: 'env' });
  });

  it('ignores an empty environment value instead of dialling a blank host', () => {
    expect(resolveEndpoint({ env: { NOLTRI_API_BASE_URL: '' } }).source).toBe('default');
    expect(resolveEndpoint({ env: {} }).baseUrl).toBe(DEFAULT_CORE_BASE_URL);
    expect(resolveEndpoint({ env: {} }).source).toBe('default');
  });

  it('defaults to loopback only, never to a routable address', () => {
    expect(DEFAULT_CORE_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(new URL(DEFAULT_CORE_BASE_URL).hostname).toBe('127.0.0.1');
  });

  it('keeps a config record with no token distinct from a token-less default', () => {
    expect(resolveEndpoint({ config: { baseUrl: 'http://127.0.0.1:8787', token: '' }, env: { NOLTRI_API_TOKEN: 'env-only' } }).source).toBe('config');
  });
});

describe('the credential file must be the user’s alone', () => {
  it('accepts owner-only modes', () => {
    expect(() => assertPrivateMode('/x/native-host.json', 0o600)).not.toThrow();
    expect(() => assertPrivateMode('/x/native-host.json', 0o400)).not.toThrow();
  });

  it.each([0o644, 0o604, 0o620, 0o666, 0o777])('rejects mode %o', (mode) => {
    try {
      assertPrivateMode('/x/native-host.json', mode);
      throw new Error('expected assertPrivateMode to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InsecureConfigFileError);
      expect((error as InsecureConfigFileError).message).toContain('native-host.json');
    }
  });

  it('reads a real 0600 file from disk and refuses it the moment it is group readable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noltri-host-config-'));
    const file = path.join(dir, HOST_CONFIG_FILENAME);
    try {
      await writeFile(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', token: 'disk-token' }), { mode: 0o600 });
      const reader = createFileConfigReader();
      await expect(reader.read(file)).resolves.toEqual({ baseUrl: 'http://127.0.0.1:8787', token: 'disk-token' });

      await chmod(file, 0o640);
      await expect(reader.read(file)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades to no config rather than crashing when the file is missing, half-written or wrong', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noltri-host-config-'));
    const reader = createFileConfigReader();
    try {
      await expect(reader.read(path.join(dir, 'absent.json'))).resolves.toBeUndefined();

      const broken = path.join(dir, 'broken.json');
      await writeFile(broken, '{"baseUrl":', { mode: 0o600 });
      await expect(reader.read(broken)).resolves.toBeUndefined();

      const wrong = path.join(dir, 'wrong.json');
      await writeFile(wrong, '{"token":"x"}', { mode: 0o600 });
      await expect(reader.read(wrong)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses injected surfaces so the same rules hold without a filesystem', async () => {
    const reader = createFileConfigReader(
      () => ({ mode: 0o600 }),
      async () => '{"baseUrl":"http://127.0.0.1:8123","token":"t"}',
    );
    await expect(reader.read('/virtual/native-host.json')).resolves.toEqual({ baseUrl: 'http://127.0.0.1:8123', token: 't' });

    const unreadable = createFileConfigReader(
      () => ({ mode: 0o600 }),
      async () => {
        throw new Error('EACCES');
      },
    );
    await expect(unreadable.read('/virtual/native-host.json')).resolves.toBeUndefined();
  });
});
