/**
 * Bundles the Core and HTTP MCP server into ESM scripts under `src-tauri/resources/`
 * so the packaged app can start its local services without tsx. Run via:
 *   pnpm --filter @noltri/desktop run build:runtime
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const outDir = path.resolve(here, '../src-tauri/resources');

const entries = [
  // The Core server uses the `server.mjs` suffix to recognise direct execution.
  ['services/knowledge-core/src/server.ts', 'core-server.mjs'],
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
