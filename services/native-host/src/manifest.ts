import os from 'node:os';
import path from 'node:path';
import { HOST_NAME } from './protocol';

/**
 * Registering a native host is a file the *browser* reads, and §16 requires it to accept only an
 * extension the user registered. So the manifest carries an explicit allowed_origins list, the installer
 * shows what it will write before writing it, and an existing manifest is copied aside rather than
 * overwritten — a user who already installed another build of this host must not lose it silently.
 */

export type BrowserChannel = 'chrome' | 'edge' | 'brave' | 'firefox';
export type HostPlatform = 'darwin' | 'linux' | 'win32';

export interface ManifestPaths {
  readonly directory: string;
  readonly file: string;
  readonly note: string;
}

const CHANNEL_DIR: Readonly<Record<BrowserChannel, readonly string[]>> = {
  chrome: ['Google', 'Chrome'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware', 'Brave-Browser'],
  firefox: ['Mozilla', 'Firefox'],
};

export function manifestPaths(options: {
  readonly platform?: HostPlatform;
  readonly browser?: BrowserChannel;
  readonly home?: string;
  readonly hostName?: string;
}): ManifestPaths {
  const platform = options.platform ?? (os.platform() as HostPlatform);
  const browser = options.browser ?? 'chrome';
  const home = options.home ?? os.homedir();
  const hostName = options.hostName ?? HOST_NAME;

  if (platform === 'win32') {
    // A Windows host is registered in the registry, not a file. Writing registry keys from a build tool
    // is exactly the silent browser change §16 forbids, so the installer stops and says what is needed.
    return {
      directory: `HKCU\\Software\\${browser === 'firefox' ? 'Mozilla\\NativeMessagingHosts' : `${browser[0] === undefined ? '' : browser[0].toUpperCase()}${browser.slice(1)}\\NativeMessagingHosts`}`,
      file: `${path.sep}${hostName}.json`,
      note: 'Windows 需要在注册表写入 host 位置，安装器不会代你改注册表；请按文档手动导入 .reg 后再继续。',
    };
  }

  const leaf = browser === 'firefox' ? 'native-messaging-hosts' : 'NativeMessagingHosts';
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', ...CHANNEL_DIR[browser], leaf)
      : path.join(home, '.config', ...CHANNEL_DIR[browser], leaf);
  return { directory: base, file: path.join(base, `${hostName}.json`), note: '' };
}

export interface NativeManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: 'stdio';
  readonly allowed_origins?: readonly string[];
  readonly allowed_extensions?: readonly string[];
}

/**
 * `chrome-extension://<id>/` is the only origin a Chrome host will accept, so an id that is missing,
 * blank or not an id at all is dropped instead of becoming a wildcard. An empty list is refused: a host
 * with no allowed origins is a host any extension on the machine can talk to.
 */
export function buildManifest(options: {
  readonly hostExecutable: string;
  readonly extensionIds?: readonly string[];
  readonly firefoxIds?: readonly string[];
  readonly hostName?: string;
  readonly browser?: BrowserChannel;
}): NativeManifest {
  const origins = (options.extensionIds ?? [])
    .map((id) => id.trim())
    .filter((id) => /^[a-p]{32}$/.test(id))
    .map((id) => `chrome-extension://${id}/`);
  const firefoxIds = (options.firefoxIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  const browser = options.browser ?? 'chrome';
  if (browser !== 'firefox' && origins.length === 0) {
    throw new Error('Native Host manifest needs at least one registered extension id');
  }
  if (browser === 'firefox' && firefoxIds.length === 0) {
    throw new Error('Native Host manifest needs at least one registered extension id');
  }
  return {
    name: options.hostName ?? HOST_NAME,
    description: '知序 Noltri 本地采集通道',
    path: options.hostExecutable,
    type: 'stdio',
    ...(browser === 'firefox' ? { allowed_extensions: firefoxIds } : { allowed_origins: origins }),
  };
}

/**
 * What the user sees before anything is written. The token never appears here, and neither does the
 * Core URL's credentials — the preview only has to be readable enough to spot a wrong extension id.
 */
export function installPreview(options: {
  readonly manifest: NativeManifest;
  readonly target: ManifestPaths;
  readonly existing?: string;
}): string {
  const lines = [
    `将写入：${options.target.file}`,
    `host 程序：${options.manifest.path}`,
    `允许的扩展：${(options.manifest.allowed_origins ?? options.manifest.allowed_extensions ?? []).join(', ') || '（无）'}`,
  ];
  if (options.target.note.length > 0) lines.push(`注意：${options.target.note}`);
  lines.push(options.existing === undefined ? '当前位置：没有已安装的 host' : '当前位置：已有 manifest，将先备份再覆盖');
  return lines.join('\n');
}

export interface ManifestFs {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  ensureDir(dirPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  /** The most recent backup this installer wrote for `file`, newest first; undefined when there is none. */
  findBackup(filePath: string): Promise<string | undefined>;
}

export interface InstallResult {
  readonly file: string;
  readonly backup?: string;
}

/** The write is deliberately separate from the preview so a caller can show one and then do the other. */
export async function installManifest(options: {
  readonly fs: ManifestFs;
  readonly target: ManifestPaths;
  readonly manifest: NativeManifest;
  readonly nowIso?: () => string;
}): Promise<InstallResult> {
  if (options.target.note.length > 0) throw new Error(options.target.note);
  const contents = `${JSON.stringify(options.manifest, null, 2)}\n`;
  await options.fs.ensureDir(options.target.directory);
  const exists = await options.fs.exists(options.target.file);
  let backup: string | undefined;
  if (exists) {
    const stamp = (options.nowIso?.() ?? new Date().toISOString()).replace(/[:.]/g, '-');
    backup = `${options.target.file}.before-${stamp}.bak`;
    await options.fs.writeFile(backup, await options.fs.readFile(options.target.file));
  }
  await options.fs.writeFile(options.target.file, contents);
  return { file: options.target.file, ...(backup === undefined ? {} : { backup }) };
}

export interface UninstallResult {
  readonly removed: boolean;
  readonly restored?: string;
}

/**
 * Removing the host puts back the manifest that was there before ours, because a backup exists precisely
 * so that an earlier install is not lost. With no backup the file is simply removed — the host program
 * itself is never deleted here, so the user can still inspect what was installed.
 */
export async function uninstallManifest(options: {
  readonly fs: ManifestFs;
  readonly target: ManifestPaths;
}): Promise<UninstallResult> {
  if (!(await options.fs.exists(options.target.file))) return { removed: false };
  const backup = await options.fs.findBackup(options.target.file);
  if (backup !== undefined) {
    await options.fs.writeFile(options.target.file, await options.fs.readFile(backup));
    await options.fs.remove(backup);
    return { removed: true, restored: backup };
  }
  await options.fs.remove(options.target.file);
  return { removed: true };
}
