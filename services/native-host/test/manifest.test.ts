import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  installManifest,
  installPreview,
  manifestPaths,
  uninstallManifest,
  type ManifestFs,
} from '../src/manifest';
import { HOST_NAME } from '../src/protocol';

const VALID_ID = 'a'.repeat(32);
const HOST_EXECUTABLE = '/Applications/知序.app/Contents/Resources/noltri-native-host';

function memoryFs(initial: Readonly<Record<string, string>> = {}): ManifestFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: async (filePath) => {
      const contents = files.get(filePath);
      if (contents === undefined) throw new Error(`ENOENT ${filePath}`);
      return contents;
    },
    writeFile: async (filePath, contents) => {
      files.set(filePath, contents);
    },
    exists: async (filePath) => files.has(filePath),
    ensureDir: async (dirPath) => {
      dirs.add(dirPath);
    },
    remove: async (filePath) => {
      files.delete(filePath);
    },
    findBackup: async (filePath) => {
      // Mirrors the real reader: readdir hands back basenames inside one directory, not whole paths.
      const dir = path.dirname(filePath);
      const prefix = `${path.basename(filePath)}.before-`;
      const found = [...files.keys()]
        .filter((key) => path.dirname(key) === dir)
        .map((key) => path.basename(key))
        .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
        .sort()
        .reverse();
      const newest = found[0];
      return newest === undefined ? undefined : path.join(dir, newest);
    },
  };
}

const target = manifestPaths({ platform: 'darwin', browser: 'chrome', home: '/Users/demo' });

describe('where each browser looks for a host', () => {
  it('uses the per-browser Application Support directory on macOS', () => {
    expect(target.directory).toBe(path.join('/Users/demo', 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'));
    expect(target.file).toBe(path.join(target.directory, `${HOST_NAME}.json`));
    expect(target.note).toBe('');
  });

  it('uses .config on Linux and the Firefox directory spelling', () => {
    expect(manifestPaths({ platform: 'linux', browser: 'chrome', home: '/home/demo' }).directory).toBe(
      path.join('/home/demo', '.config', 'Google', 'Chrome', 'NativeMessagingHosts'),
    );
    expect(manifestPaths({ platform: 'linux', browser: 'brave', home: '/home/demo' }).directory).toBe(
      path.join('/home/demo', '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    );
    expect(manifestPaths({ platform: 'darwin', browser: 'firefox', home: '/Users/demo' }).file).toBe(
      path.join('/Users/demo', 'Library', 'Application Support', 'Mozilla', 'Firefox', 'native-messaging-hosts', `${HOST_NAME}.json`),
    );
    expect(manifestPaths({ platform: 'darwin', browser: 'edge', home: '/Users/demo' }).directory).toContain('Microsoft Edge');
  });

  it('refuses to touch the Windows registry on the user’s behalf (§16: no silent browser changes)', async () => {
    const windows = manifestPaths({ platform: 'win32', browser: 'chrome', home: 'C:\\Users\\demo' });
    expect(windows.note).toContain('注册表');
    const fileSystem = memoryFs();
    const attempt = installManifest({
      fs: fileSystem,
      target: windows,
      manifest: buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] }),
    });
    await expect(attempt).rejects.toThrow(/注册表/);
    expect(fileSystem.files.size).toBe(0);
  });
});

describe('the manifest only names extensions the user registered', () => {
  it('builds chrome-extension origins from 32-character ids', () => {
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID, ` ${'b'.repeat(32)} `] });
    expect(manifest).toEqual({
      name: HOST_NAME,
      description: '知序 Noltri 本地采集通道',
      path: HOST_EXECUTABLE,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${VALID_ID}/`, `chrome-extension://${'b'.repeat(32)}/`],
    });
  });

  it.each([
    '*',
    'chrome-extension://abcdefghij1234567890abcdefghij/',
    'short',
    'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP1234',
    'javascript:alert(1)',
    '',
  ])('drops %s, which is not an extension id', (candidate) => {
    expect(() => buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [candidate] })).toThrow(/at least one registered extension id/);
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [candidate, VALID_ID] });
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${VALID_ID}/`]);
  });

  it('never writes a wildcard origin', () => {
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID, '*', 'mm.bing.baidu.com'] });
    expect(JSON.stringify(manifest)).not.toContain('*');
  });

  it('uses the Firefox field for a Firefox install', () => {
    const manifest = buildManifest({
      hostExecutable: HOST_EXECUTABLE,
      browser: 'firefox',
      firefoxIds: ['noltri@example.org'],
    });
    expect(manifest.allowed_extensions).toEqual(['noltri@example.org']);
    expect(manifest.allowed_origins).toBeUndefined();
    expect(() => buildManifest({ hostExecutable: HOST_EXECUTABLE, browser: 'firefox', firefoxIds: [] })).toThrow(/extension id/);
  });
});

describe('the install preview', () => {
  it('says exactly what will be written, and holds no credential', () => {
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
    const preview = installPreview({ manifest, target });
    expect(preview).toContain(target.file);
    expect(preview).toContain(HOST_EXECUTABLE);
    expect(preview).toContain(`chrome-extension://${VALID_ID}/`);
    expect(preview).toContain('没有已安装的 host');
    expect(preview.toLowerCase()).not.toContain('token');
    expect(preview).not.toMatch(/sk-|Bearer|password|secret/);
  });

  it('warns that an existing manifest is backed up rather than lost', () => {
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
    const preview = installPreview({ manifest, target, existing: '{"name":"older-build"}' });
    expect(preview).toContain('将先备份再覆盖');
    expect(preview).not.toContain('older-build');
  });

  it('surfaces the registry note instead of hiding it', () => {
    const windows = manifestPaths({ platform: 'win32', browser: 'chrome', home: 'C:\\Users\\demo' });
    const preview = installPreview({ manifest: buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] }), target: windows });
    expect(preview).toContain('注意：');
  });
});

describe('installing and undoing', () => {
  it('writes the manifest once, into a directory it created', async () => {
    const fileSystem = memoryFs();
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
    const result = await installManifest({ fs: fileSystem, target, manifest, nowIso: () => '2026-10-05T09:30:00.000Z' });

    expect(result).toEqual({ file: target.file });
    expect(fileSystem.dirs.has(target.directory)).toBe(true);
    expect(fileSystem.files.get(target.file)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(fileSystem.files.size).toBe(1);
  });

  it('backs up a manifest that was already there, so an earlier build is recoverable', async () => {
    const previous = '{"name":"com.noltri.knowledge_host","path":"/old/host"}\n';
    const fileSystem = memoryFs({ [target.file]: previous });
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
    const result = await installManifest({ fs: fileSystem, target, manifest, nowIso: () => '2026-10-05T09:30:00.000Z' });

    expect(result.backup).toBe(`${target.file}.before-2026-10-05T09-30-00-000Z.bak`);
    expect(fileSystem.files.get(result.backup as string)).toBe(previous);
    expect(JSON.parse(fileSystem.files.get(target.file) as string)).toEqual(manifest);
  });

  it('removes only what it installed, and puts back what it replaced', async () => {
    const previous = '{"name":"com.noltri.knowledge_host","path":"/old/host"}\n';
    const fileSystem = memoryFs({ [target.file]: previous });
    const manifest = buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] });
    const installed = await installManifest({ fs: fileSystem, target, manifest, nowIso: () => '2026-10-05T09:30:00.000Z' });

    const undone = await uninstallManifest({ fs: fileSystem, target });
    expect(undone).toEqual({ removed: true, restored: installed.backup });
    expect(fileSystem.files.get(target.file)).toBe(previous);
    expect(fileSystem.files.has(installed.backup as string)).toBe(false);
  });

  it('just deletes the file when nothing preceded it', async () => {
    const fileSystem = memoryFs();
    await installManifest({ fs: fileSystem, target, manifest: buildManifest({ hostExecutable: HOST_EXECUTABLE, extensionIds: [VALID_ID] }) });
    expect(await uninstallManifest({ fs: fileSystem, target })).toEqual({ removed: true });
    expect(fileSystem.files.size).toBe(0);
  });

  it('says nothing was removed when the host was never installed here', async () => {
    expect(await uninstallManifest({ fs: memoryFs(), target })).toEqual({ removed: false });
  });
});
