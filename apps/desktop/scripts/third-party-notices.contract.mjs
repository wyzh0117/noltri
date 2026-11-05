import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareThirdPartyNotices } from './prepare-third-party-notices.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, link = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'noltri-notice-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendor = path.join(root, 'apps/desktop/licenses');
  await mkdir(vendor, { recursive: true });
  await mkdir(path.join(root, 'apps/desktop/src-tauri'), { recursive: true });
  const locks = { 'pnpm-lock.yaml': 'synthetic npm lock', 'apps/desktop/src-tauri/Cargo.lock': 'synthetic Rust lock' };
  for (const [file, text] of Object.entries(locks)) await writeFile(path.join(root, file), text);
  const source = path.join(root, 'source/third-party');
  await mkdir(source, { recursive: true });
  const text = 'Synthetic license fixture';
  await writeFile(path.join(source, 'LICENSE'), text);
  if (link) await symlink('LICENSE', path.join(source, 'LINK'));
  const archive = path.join(vendor, 'third-party-notices.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(source), 'third-party']);
  const manifest = { format: 1, archive: 'third-party-notices.tar.gz', archiveSha256: sha(await readFile(archive)), dependencyLocks: Object.fromEntries(Object.entries(locks).map(([p, text]) => [p, sha(text)])), files: [{ path: 'LICENSE', bytes: Buffer.byteLength(text), sha256: sha(text) }] };
  await writeFile(path.join(vendor, 'third-party-notices.json'), JSON.stringify(manifest));
  return { root, vendor, archive, manifest, outDir: path.join(root, 'generated'), text };
}

test('materializes verified notices from the locked public bundle', async t => {
  const f = await fixture(t);
  assert.equal((await prepareThirdPartyNotices({ repo: f.root, outDir: f.outDir })).files, 1);
  assert.equal(await readFile(path.join(f.outDir, 'third-party/LICENSE'), 'utf8'), f.text);
});
test('refuses stale notices after a dependency lock changes', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'changed');
  await assert.rejects(prepareThirdPartyNotices({ repo: f.root, outDir: f.outDir }), /Dependency lock changed/);
});
test('refuses corrupted bundles without extracting', async t => {
  const f = await fixture(t); await writeFile(f.archive, 'corrupted');
  await assert.rejects(prepareThirdPartyNotices({ repo: f.root, outDir: f.outDir }), /checksum mismatch/);
});
test('refuses archive links and manifest traversal', async t => {
  const f = await fixture(t, true);
  await assert.rejects(prepareThirdPartyNotices({ repo: f.root, outDir: f.outDir }), /links or special/);
  f.manifest.files[0].path = '../escape';
  await writeFile(path.join(f.vendor, 'third-party-notices.json'), JSON.stringify(f.manifest));
  await assert.rejects(prepareThirdPartyNotices({ repo: f.root, outDir: f.outDir }), /Unsafe notice path/);
});
