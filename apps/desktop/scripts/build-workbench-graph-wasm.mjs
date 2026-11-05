import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateRoot = resolve(desktopRoot, 'src/workbench/graph-force-wasm');
const manifestPath = resolve(crateRoot, 'Cargo.toml');
const targetPath = resolve(crateRoot, 'target/wasm32-unknown-unknown/release/noltri_graph_force.wasm');
const outputPath = resolve(desktopRoot, 'src/workbench/workbench-graph-force.wasm');
const buildArgs = [
  'build',
  '--manifest-path', manifestPath,
  '--target', 'wasm32-unknown-unknown',
  '--release',
];
execFileSync('cargo', buildArgs, { cwd: desktopRoot, stdio: 'inherit' });
await mkdir(dirname(outputPath), { recursive: true });
await copyFile(targetPath, outputPath);
console.log(`Built ${outputPath}`);
