import path from 'node:path';
import { buildManifest, installManifest, installPreview, manifestPaths, uninstallManifest, type BrowserChannel } from './manifest';
import { createNodeManifestFs } from './main';
import { HOST_NAME } from './protocol';

/**
 * Installing a native host changes what a browser will let an extension do, so the tool never does it
 * quietly: without `--confirm` it prints exactly what it is about to write and stops, and a manifest that
 * is already there is copied aside first. §16: 安装预览必须可读、可撤销，且不包含任何凭据.
 */

export interface CliOutcome {
  readonly code: number;
  readonly output: string;
}

interface ParsedArgs {
  command: 'install' | 'uninstall' | 'paths' | 'help';
  confirm: boolean;
  extensionIds: string[];
  browser: BrowserChannel;
  hostExecutable: string;
  home: string;
}

const BROWSER_CHANNELS: readonly BrowserChannel[] = ['chrome', 'edge', 'brave', 'firefox'];

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  const parsed: ParsedArgs = {
    command: command === 'install' || command === 'uninstall' || command === 'paths' ? command : 'help',
    confirm: false,
    extensionIds: [],
    browser: 'chrome',
    hostExecutable: '',
    home: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
  };
  const ids: string[] = [];
  for (let index = parsed.command === 'help' ? 0 : 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    // `--host /path/to/exe` and `--host=/path/to/exe` both have to work: a half-supported flag form is how
    // a user ends up confirming a preview that was built from values they did not mean to drop.
    let value: string | undefined;
    if (equals >= 0) {
      value = token.slice(equals + 1);
    } else if (flag !== '--confirm') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      }
    }
    switch (flag) {
      case '--confirm':
        parsed.confirm = true;
        break;
      case '--extension-id':
      case '--origin':
        if (value !== undefined && value.length > 0) ids.push(value);
        break;
      case '--browser':
        if (BROWSER_CHANNELS.includes(value as BrowserChannel)) parsed.browser = value as BrowserChannel;
        break;
      case '--host':
        parsed.hostExecutable = value ?? '';
        break;
      case '--home':
        parsed.home = value ?? '';
        break;
      default:
        break;
    }
  }
  parsed.extensionIds = ids;
  return parsed;
}

export const USAGE = [
  '用法：npx tsx services/native-host/src/install-cli.ts install --host <可执行文件> --extension-id <扩展 id，firefox 用 add-on id> [--browser chrome|edge|brave|firefox] [--confirm]',
      '     … install 先打印预览；只有带 --confirm 才写入。',
  '     … uninstall 撤下本机写入的 manifest，必要时恢复安装前的备份。',
  '     … paths 只打印将写入的位置。',
].join('\n');

export async function runCli(argv: readonly string[]): Promise<CliOutcome> {
  const args = parseArgs(argv);
  if (args.command === 'help') return { code: 1, output: USAGE };

  const target = manifestPaths({
    browser: args.browser,
    home: args.home.length > 0 ? args.home : undefined,
  });

  if (args.command === 'paths') {
    return { code: 0, output: `${target.file}\n${target.note}`.trimEnd() };
  }

  const fileSystem = createNodeManifestFs();
  if (args.command === 'uninstall') {
    const result = await uninstallManifest({ fs: fileSystem, target });
    return {
      code: 0,
      output: result.removed
        ? `已移除 ${target.file}${result.restored === undefined ? '' : `，并恢复了安装前的 manifest：${result.restored}`}`
        : `没有找到本机写入的 host manifest：${target.file}`,
    };
  }

  if (args.hostExecutable.length === 0) return { code: 1, output: USAGE };
  let manifest;
  try {
    manifest = buildManifest({
      hostExecutable: path.resolve(args.hostExecutable),
      // Firefox registers add-on ids rather than the 32-character Chrome ids, but the user only needs
      // one flag to remember: --extension-id means "this browser may talk to the host".
      ...(args.browser === 'firefox' ? { firefoxIds: args.extensionIds } : { extensionIds: args.extensionIds }),
      browser: args.browser,
      hostName: HOST_NAME,
    });
  } catch (error) {
    return { code: 1, output: `${error instanceof Error ? error.message : 'manifest 无法生成'}\n${USAGE}` };
  }

  const existing = (await fileSystem.exists(target.file)) ? await fileSystem.readFile(target.file) : undefined;
  const preview = installPreview({ manifest, target, ...(existing === undefined ? {} : { existing }) });
  if (!args.confirm) return { code: 0, output: `${preview}\n\n未写入任何东西。确认无误后加 --confirm 再运行一次。` };

  try {
    const result = await installManifest({ fs: fileSystem, target, manifest });
    return { code: 0, output: `${result.backup === undefined ? '' : `已备份原 manifest：${result.backup}\n`}已写入 ${result.file}` };
  } catch (error) {
    return { code: 1, output: error instanceof Error ? error.message : '写入失败' };
  }
}

// `.mjs` is the packaged name (see apps/desktop/scripts/build-runtime.mjs).
const isDirectRun = process.argv[1] !== undefined && /install-cli\.(?:mjs|mts|ts|js)$/.test(path.resolve(process.argv[1]));

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((outcome) => {
      process.stdout.write(`${outcome.output}\n`);
      process.exit(outcome.code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'native host installer failed'}\n`);
      process.exit(1);
    });
}
