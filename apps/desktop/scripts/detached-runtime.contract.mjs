import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('exact runtime builder produces a detached Core requiring no ancestor node_modules', { timeout: 90_000 }, async () => {
  assert.equal(process.platform, 'darwin', 'current packaged-runtime contract targets macOS arm64');
  assert.equal(process.arch, 'arm64');
  // Deliberately outside the repository; build-only dependencies are in a sibling tree.
  for (const ancestor of ['/node_modules', '/private/node_modules', '/private/tmp/node_modules']) {
    await assert.rejects(stat(ancestor), { code: 'ENOENT' });
  }
  const root = await mkdtemp('/private/tmp/noltri-detached-runtime-');
  let child;
  let exited;
  let output = '';
  try {
    const buildRoot = join(root, 'build');
    const scripts = join(buildRoot, 'apps/desktop/scripts');
    const binaries = join(buildRoot, 'apps/desktop/src-tauri/binaries');
    const runtime = join(root, 'runtime');
    await Promise.all([mkdir(scripts, { recursive: true }), mkdir(binaries, { recursive: true }), mkdir(runtime)]);
    for (const name of ['services', 'packages', 'node_modules']) await symlink(join(repo, name), join(buildRoot, name), 'dir');
    await symlink(join(repo, 'apps/desktop/node_modules'), join(buildRoot, 'apps/desktop/node_modules'), 'dir');
    for (const name of ['build-runtime.mjs', 'prepare-third-party-notices.mjs']) await copyFile(join(repo, 'apps/desktop/scripts', name), join(scripts, name));
    await mkdir(join(buildRoot, 'apps/desktop/licenses'), { recursive: true });
    for (const name of ['third-party-notices.tar.gz', 'third-party-notices.json']) await copyFile(join(repo, 'apps/desktop/licenses', name), join(buildRoot, 'apps/desktop/licenses', name));
    await copyFile(join(repo, 'pnpm-lock.yaml'), join(buildRoot, 'pnpm-lock.yaml'));
    await copyFile(join(repo, 'apps/desktop/src-tauri/Cargo.lock'), join(buildRoot, 'apps/desktop/src-tauri/Cargo.lock'));
    // Copy the existing verified archive; absence fails instead of fetching a tool.
    const archive = 'node-v24.18.0-darwin-arm64.tar.gz';
    await copyFile(join(repo, 'apps/desktop/src-tauri/binaries', archive), join(binaries, archive));
    const build = spawnSync(process.execPath, [join(scripts, 'build-runtime.mjs')], {
      cwd: buildRoot, timeout: 60_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', NOLTRI_RUNTIME_OUT_DIR: runtime, TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' },
    });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    for (const name of ['core-server.mjs', 'parser-worker.mjs', 'mcp-server.mjs', 'node-LICENSE.txt']) assert.ok((await stat(join(runtime, name))).size > 0);
    assert.ok((await stat(join(runtime, 'third-party/INDEX.json'))).size > 0);
    assert.ok((await stat(join(runtime, 'third-party/CORRESPONDING-SOURCE.txt'))).size > 0);
    await copyFile(join(binaries, 'noltri-runtime-aarch64-apple-darwin'), join(runtime, 'node'));
    // No dependency tree survives into execution, even as a sibling fallback.
    await rm(buildRoot, { recursive: true, force: true });
    const allocator = createServer();
    await new Promise((done, reject) => { allocator.once('error', reject); allocator.listen(0, '127.0.0.1', done); });
    const port = allocator.address().port;
    await new Promise(done => allocator.close(done));
    const data = join(runtime, 'data');
    await mkdir(data);
    child = spawn(join(runtime, 'node'), [join(runtime, 'core-server.mjs')], {
      cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: runtime, PORT: String(port), STORAGE_DRIVER: 'sqlite',
        AI_PROVIDER: 'disabled', AI_EMBEDDINGS_ENABLED: 'false', NOLTRI_DATA_DIR: data,
        NOLTRI_SQLITE_FILE: join(data, 'synthetic.sqlite'), NOLTRI_GRANT_FILE: join(data, 'grants.json'),
        NOLTRI_ENV_FILE: join(runtime, 'intentionally-absent.env'), NOLTRI_DEV_REQUIRE_TOKEN: 'true',
        NOLTRI_DEV_TOKEN: 'synthetic-detached-test', NOLTRI_ACCESS_TOKEN: 'synthetic-detached-test' },
    });
    exited = new Promise(done => child.once('exit', done));
    child.stdout.on('data', bytes => { output = (output + bytes).slice(-16384); });
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-16384); });
    let health;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* Only this owned synthetic child is being awaited. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    assert.equal(health?.productId, 'noltri-knowledge-core', `detached Core failed to start (exit=${child.exitCode}): ${output}`);
    assert.ok((await stat(join(data, 'synthetic.sqlite'))).size > 0);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(kill);
    }
    await rm(root, { recursive: true, force: true });
  }
});
