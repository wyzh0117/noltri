#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import esbuild from 'esbuild';
import { validateBuildOutput } from './validate-manifest.mjs';

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(packageRoot, '.output');
const zipPath = join(packageRoot, 'dist', 'noltri-extension.zip');

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const release = argv.includes('--zip');

const bundleOptions = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  minify: release,
  legalComments: 'none',
  sourcemap: !release,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': release ? '"production"' : '"development"' },
};

const entries = [
  { input: 'src/content.tsx', output: 'content.js', format: 'esm' },
  // MV3 service workers are registered as classic workers. `import` statements inside a worker only
  // work when the manifest declares "background": { "type": "module" }, which behaves inconsistently
  // across Chrome releases and breaks `chrome.contextMenus.onClicked` registration order, so the
  // worker is bundled as a self-contained IIFE and needs no module support at all.
  { input: 'src/background/background.ts', output: 'background.js', format: 'iife' },
  { input: 'src/popup/popup.tsx', output: 'popup.js', format: 'esm' },
  { input: 'src/options/options.tsx', output: 'options.js', format: 'esm' },
];

const staticAssets = ['manifest.json', 'styles.css', 'popup.html', 'options.html'];

async function copyAssets() {
  for (const asset of staticAssets) {
    await cp(join(packageRoot, 'src', asset), join(outdir, asset));
  }
}

async function buildOne(entry) {
  const options = {
    ...bundleOptions,
    absWorkingDir: packageRoot,
    entryPoints: [resolve(packageRoot, entry.input)],
    outfile: resolve(outdir, entry.output),
    format: entry.format,
  };
  if (!watch) {
    await esbuild.build(options);
    return undefined;
  }
  const context = await esbuild.context(options);
  await context.watch();
  return context;
}

async function watchAssets() {
  let timer;
  const { watch } = await import('node:fs');
  watch(join(packageRoot, 'src'), { recursive: false }, (_event, filename) => {
    if (filename === undefined || !staticAssets.includes(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void copyAssets().catch((error) => console.error(error)), 120);
  });
}

async function packageZip() {
  try {
    await run('zip', ['-r', '-q', zipPath, '.'], { cwd: outdir });
    console.log(`packed ${zipPath}`);
  } catch (error) {
    console.warn(`could not create the zip (${error instanceof Error ? error.message : 'zip unavailable'}); the loadable folder is ${outdir}`);
  }
}

async function assertManifest() {
  const { errors } = await validateBuildOutput({ outdir });
  if (errors.length > 0) {
    for (const error of errors) console.error(`  - ${error}`);
    throw new Error('manifest validation failed');
  }
  console.log(`manifest validation passed: ${join(outdir, 'manifest.json')}`);
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await Promise.all(entries.map(buildOne));
  await copyAssets();
  await assertManifest();
  if (release) {
    await mkdir(dirname(zipPath), { recursive: true });
    await packageZip();
  }
  if (watch) {
    await watchAssets();
    console.log('watching apps/extension/src — press Ctrl+C to stop');
    return;
  }
  console.log(`built loadable extension in ${outdir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
