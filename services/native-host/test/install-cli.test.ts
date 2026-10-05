import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, runCli, USAGE } from '../src/install-cli';
import { HOST_NAME } from '../src/protocol';

const VALID_ID = `${'a'.repeat(31)}b`;
const HOST_EXECUTABLE = '/Applications/知序.app/Contents/Resources/noltri-native-host';

let home = '';
let realHome = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'noltri-host-home-'));
  // Belt and braces: even if a `--home` value were dropped by the parser, the run could not reach the
  // account's real browser profile directories.
  realHome = process.env['HOME'] ?? '';
  process.env['HOME'] = home;
});

afterEach(async () => {
  process.env['HOME'] = realHome;
  await rm(home, { recursive: true, force: true });
});

function manifestFile(browser = 'chrome'): string {
  const leaf = browser === 'firefox' ? 'native-messaging-hosts' : 'NativeMessagingHosts';
  const channel = browser === 'chrome' ? ['Google', 'Chrome'] : browser === 'edge' ? ['Microsoft Edge'] : ['Mozilla', 'Firefox'];
  return path.join(home, 'Library', 'Application Support', ...channel, leaf, `${HOST_NAME}.json`);
}

describe('argument parsing', () => {
  it('defaults to the usage text when nothing was asked for', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--confirm']).command).toBe('help');
    expect(parseArgs(['nonsense']).command).toBe('help');
  });

  it('collects ids, the browser channel, the host path and the confirmation', () => {
    const args = parseArgs(['install', `--host=${HOST_EXECUTABLE}`, '--extension-id', VALID_ID, '--browser', 'edge', '--confirm']);
    expect(args).toMatchObject({ command: 'install', confirm: true, browser: 'edge', hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
  });

  it('accepts more than one extension id and an explicit home for tests', () => {
    const args = parseArgs(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--origin', 'c'.repeat(32), '--home', home]);
    expect(args.extensionIds).toEqual([VALID_ID, 'c'.repeat(32)]);
    expect(args.home).toBe(home);
  });

  it.each(['safari', 'IE', '*', 'chrome-extension://x'])('ignores the unsupported browser %s instead of guessing a path', (browser) => {
    expect(parseArgs(['install', '--browser', browser]).browser).toBe('chrome');
  });
});

describe('the installer only writes after an explicit confirmation', () => {
  it('prints usage and writes nothing without a command', async () => {
    const outcome = await runCli([]);
    expect(outcome).toEqual({ code: 1, output: USAGE });
    expect(await stat(manifestFile()).then(() => true).catch(() => false)).toBe(false);
  });

  it('names the exact file it would create', async () => {
    const outcome = await runCli(['paths', '--home', home]);
    expect(outcome.code).toBe(0);
    expect(outcome.output).toBe(manifestFile());
  });

  it('shows a readable preview and stops when --confirm is missing', async () => {
    const outcome = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--home', home]);
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain(manifestFile());
    expect(outcome.output).toContain(`chrome-extension://${VALID_ID}/`);
    expect(outcome.output).toContain('未写入任何东西');
    await expect(readFile(manifestFile(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('writes an owner-only manifest once confirmed', async () => {
    const outcome = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--home', home, '--confirm']);
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain(`已写入 ${manifestFile()}`);

    const contents = JSON.parse(await readFile(manifestFile(), 'utf8')) as Record<string, unknown>;
    expect(contents).toEqual({
      name: HOST_NAME,
      description: '知序 Noltri 本地采集通道',
      path: HOST_EXECUTABLE,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${VALID_ID}/`],
    });
    expect((await stat(manifestFile())).mode & 0o077).toBe(0);
    expect((await stat(path.dirname(manifestFile()))).mode & 0o077).toBe(0);
  });

  it('keeps the previous manifest when it replaces it, and gives it back on uninstall', async () => {
    const first = await runCli(['install', '--host', '/old/build/host', '--extension-id', VALID_ID, '--home', home, '--confirm']);
    expect(first.code).toBe(0);
    const previous = await readFile(manifestFile(), 'utf8');

    const second = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--home', home, '--confirm']);
    expect(second.output).toContain('已备份原 manifest');
    const backup = second.output.match(/已备份原 manifest：(.+)/u)?.[1] as string;
    expect(await readFile(backup, 'utf8')).toBe(previous);

    const undone = await runCli(['uninstall', '--home', home]);
    expect(undone.output).toContain('恢复了安装前的 manifest');
    expect(await readFile(manifestFile(), 'utf8')).toBe(previous);
    await expect(readFile(backup, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('says so when there is nothing to undo', async () => {
    const outcome = await runCli(['uninstall', '--home', home]);
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain('没有找到本机写入的 host manifest');
  });

  it('refuses to install without a host executable or a usable extension id', async () => {
    const noHost = await runCli(['install', '--extension-id', VALID_ID, '--home', home, '--confirm']);
    expect(noHost.code).toBe(1);
    expect(noHost.output).toBe(USAGE);

    const badId = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', '*', '--home', home, '--confirm']);
    expect(badId.code).toBe(1);
    expect(badId.output).toContain('at least one registered extension id');
    await expect(readFile(manifestFile(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('never puts a credential in the preview or in the file', async () => {
    const outcome = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--home', home]);
    expect(outcome.output.toLowerCase()).not.toContain('token');
    expect(outcome.output).not.toContain('Bearer');
  });

  it('writes the Firefox field for a Firefox channel', async () => {
    const outcome = await runCli(['install', '--host', HOST_EXECUTABLE, '--browser', 'firefox', '--extension-id', VALID_ID, '--home', home, '--confirm']);
    expect(outcome.code).toBe(0);
    const contents = JSON.parse(await readFile(manifestFile('firefox'), 'utf8')) as { allowed_extensions?: string[]; allowed_origins?: string[] };
    expect(contents.allowed_extensions).toEqual([VALID_ID]);
    expect(contents.allowed_origins).toBeUndefined();
  });

  it('leaves an untouched file readable for the browser but private for the account', async () => {
    const file = manifestFile('edge');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"name":"someone-else"}', { mode: 0o644 });
    const outcome = await runCli(['install', '--host', HOST_EXECUTABLE, '--extension-id', VALID_ID, '--browser', 'edge', '--home', home, '--confirm']);
    expect(outcome.output).toContain('已备份原 manifest');
    expect(JSON.parse(await readFile(file, 'utf8')).path).toBe(HOST_EXECUTABLE);
  });
});
