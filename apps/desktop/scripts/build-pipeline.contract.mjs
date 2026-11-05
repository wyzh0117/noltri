import './third-party-notices.contract.mjs';
import './detached-runtime.contract.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');
const desktopPackage = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'));

test('desktop build generates graph WASM before Vite', () => {
  const scripts = desktopPackage.scripts;
  assert.equal(scripts['build:graph-wasm'], 'node scripts/build-workbench-graph-wasm.mjs');
  assert.equal(scripts.build, 'pnpm run build:graph-wasm && vite build');
  assert.equal(
    tauriConfig.build.beforeBuildCommand,
    'pnpm run build:runtime && pnpm run build',
    'Tauri must invoke the package build that generates WASM before Vite',
  );
});

test('desktop test command includes the dependency-free build contract', () => {
  assert.match(desktopPackage.scripts.test, /node --test scripts\/build-pipeline\.contract\.mjs/);
});

test('Tauri package inputs exclude documentation and private files', () => {
  assert.equal(tauriConfig.build.frontendDist, '../dist');
  assert.deepEqual(tauriConfig.bundle.resources, [
    'resources/core-server.mjs',
    'resources/parser-worker.mjs',
    'resources/mcp-server.mjs',
    'resources/node-LICENSE.txt',
    'resources/third-party',
  ]);
  assert.ok(!JSON.stringify(tauriConfig.bundle).includes('docs/'));
  assert.ok(!JSON.stringify(tauriConfig.bundle).includes('private'));
});

test('generated WASM is a build output and remains ignored by Git', () => {
  const result = spawnSync(
    'git',
    ['check-ignore', '-q', 'apps/desktop/src/workbench/workbench-graph-force.wasm'],
    { cwd: repositoryRoot },
  );
  assert.equal(result.status, 0, 'generated graph WASM must not be staged as a source asset');
});

test('runtime resource generation preserves the pinned Node distribution license', () => {
  const builder = readFileSync(resolve(desktopRoot, 'scripts/build-runtime.mjs'), 'utf8');
  assert.ok(builder.includes('`${name}/LICENSE`'), 'extract the license from the exact verified archive');
  assert.ok(builder.includes("path.join(outDir, 'node-LICENSE.txt')"), 'retain the license alongside packaged resources');
});

test('runtime builder prepares the locked complete third-party notices', () => {
  const builder = readFileSync(resolve(desktopRoot, 'scripts/build-runtime.mjs'), 'utf8');
  assert.match(builder, /prepareThirdPartyNotices/);
});
