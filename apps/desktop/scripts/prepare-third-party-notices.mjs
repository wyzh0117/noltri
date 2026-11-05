import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The reviewed notice bundle is tied to both dependency locks. Dependency updates
// require refreshing this material; a build must never silently ship stale notices.
export async function prepareThirdPartyNotices({ repo, outDir }) {
  const vendor = path.join(repo, 'apps/desktop/licenses');
  const manifest = JSON.parse(await readFile(path.join(vendor, 'third-party-notices.json'), 'utf8'));
  const locks = ['apps/desktop/src-tauri/Cargo.lock', 'pnpm-lock.yaml'];
  if (manifest.format !== 1 || manifest.archive !== 'third-party-notices.tar.gz'
      || JSON.stringify(Object.keys(manifest.dependencyLocks).sort()) !== JSON.stringify(locks)) throw Error('Invalid notice manifest');
  for (const file of locks) {
    if (sha(await readFile(path.join(repo, file))) !== manifest.dependencyLocks[file]) throw Error('Dependency lock changed: refresh reviewed third-party notices');
  }
  const archive = path.join(vendor, manifest.archive);
  if (sha(await readFile(archive)) !== manifest.archiveSha256) throw Error('Third-party notice archive checksum mismatch');
  const expected = manifest.files.map(row => {
    if (typeof row.path !== 'string' || !row.path || row.path.includes('\\') || row.path.includes('\n')
        || path.posix.isAbsolute(row.path) || row.path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe notice path');
    return 'third-party/' + row.path;
  }).sort();
  if (!expected.length || new Set(expected).size !== expected.length) throw Error('Invalid notice file list');
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (types.some(line => !['-', 'd'].includes(line[0]))) throw Error('Notice links or special entries are forbidden');
  for (const name of names) {
    if (!name.startsWith('third-party/') || name.includes('\\') || name.split('/').some(p => p === '.' || p === '..')) throw Error('Unsafe archive entry');
  }
  if (JSON.stringify(names.filter(n => !n.endsWith('/')).sort()) !== JSON.stringify(expected)) throw Error('Notice archive file list mismatch');
  await mkdir(outDir, { recursive: true });
  const temporary = await mkdtemp(path.join(outDir, '.third-party-'));
  try {
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', temporary]);
    for (const row of manifest.files) {
      const file = path.join(temporary, 'third-party', row.path);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== row.bytes || sha(await readFile(file)) !== row.sha256) throw Error('Extracted third-party notice mismatch');
    }
    const destination = path.join(outDir, 'third-party');
    const previous = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw Error('Unsafe notice output');
    await rm(destination, { recursive: true, force: true });
    await rename(path.join(temporary, 'third-party'), destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { files: manifest.files.length, archiveSha256: manifest.archiveSha256 };
}
