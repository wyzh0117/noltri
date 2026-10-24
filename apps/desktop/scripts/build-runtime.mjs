/**
 * Bundles the Core and HTTP MCP server into ESM scripts under `src-tauri/resources/`
 * so the packaged app can start its local services without tsx. Run via:
 *   pnpm --filter @noltri/desktop run build:runtime
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.resolve(here, '../src-tauri/resources');

// Pin the sidecar too: Node 24 supplies node:sqlite in the packaged Core.
// Checksums are from https://nodejs.org/dist/v24.18.0/SHASUMS256.txt.
if (process.platform === 'darwin') {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : process.arch);
  if (target !== 'aarch64-apple-darwin') throw new Error(`This release supports Apple Silicon only: ${target}`);
  const checksum = 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1';
  const name = 'node-v24.18.0-darwin-arm64';
  const binDir = path.resolve(here, '../src-tauri/binaries');
  const archive = path.join(binDir, `${name}.tar.gz`);
  await mkdir(binDir, { recursive: true });
  let bytes = await readFile(archive).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!bytes) {
    const response = await fetch(`https://nodejs.org/dist/v24.18.0/${name}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
    throw new Error(`Node checksum mismatch; remove ${archive} and retry`);
  }
  await writeFile(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', binDir, `${name}/bin/node`]);
  await rename(path.join(binDir, name, 'bin/node'), path.join(binDir, `noltri-runtime-${target}`));
  await rm(path.join(binDir, name), { recursive: true });
  console.log('verified Node 24.18.0 sidecar (arm64)');
}

const entries = [
  // The Core server uses the `server.mjs` suffix to recognise direct execution.
  ['services/knowledge-core/src/server.ts', 'core-server.mjs'],
  ['services/knowledge-core/src/notes/parser-worker.ts', 'parser-worker.mjs'],
  ['services/mcp-server/src/index.ts', 'mcp-server.mjs'],
];

for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [path.join(repo, entry)],
    outfile: path.join(outDir, outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // Workspace packages are TypeScript sources; esbuild resolves them through
    // their package "main" fields and bundles everything except node: builtins.
    // dotenv (CJS) does a dynamic `require('fs')`; without a real `require` in
    // scope esbuild's shim throws at startup, so give ESM one via createRequire.
    banner: {
      js: "import { createRequire as __noltriCreateRequire } from 'node:module';\nconst require = __noltriCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  console.log(`bundled ${entry} -> src-tauri/resources/${outfile}`);
}
