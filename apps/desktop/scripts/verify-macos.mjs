/** Verify both the build and the app users actually receive inside the DMG.
 * Add --require-notarization to make Apple distribution approval mandatory.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'macOS verification requires macOS');
assert.equal(process.arch, 'arm64', 'This release supports Apple Silicon only');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
const bundle = path.join(desktop, 'src-tauri/target/release/bundle');
const appName = `${config.productName}.app`;
const app = path.join(bundle, 'macos', appName);
const dmg = path.join(bundle, 'dmg', `${config.productName}_${config.version}_aarch64.dmg`);
const requireNotarization = process.argv.includes('--require-notarization');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', timeout: 120_000 });

function verifyApp(appPath) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('codesign', ['--verify', '--strict', '--verbose=2', path.join(appPath, 'Contents/MacOS/noltri-runtime')]);
  // Exercise V8/JIT and the exact SQLite API used by Core after re-signing Node.
  run(path.join(appPath, 'Contents/MacOS/noltri-runtime'), ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(':memory:');
    assert.equal(db.prepare('select 42 as result').get().result, 42);
    let n = 0; for (let i = 0; i < 100000; i++) n += i;
    assert.equal(n, 4999950000); db.close();
    console.log('Bundled Node / SQLite / JIT check passed');
  `]);
}

verifyApp(app);
run('hdiutil', ['verify', dmg]);
const mount = mkdtempSync(path.join(tmpdir(), 'noltri-dmg-check-'));
let attached = false;
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  attached = true;
  verifyApp(path.join(mount, appName));
} finally {
  if (attached) run('hdiutil', ['detach', mount]);
  rmSync(mount, { recursive: true, force: true });
}
const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { encoding: 'utf8', timeout: 60_000 });
if (assessment.error) throw assessment.error;
console.log(assessment.stdout + assessment.stderr);
if (requireNotarization) {
  assert.equal(assessment.status, 0, 'Gatekeeper rejected the app: Developer ID signing and Apple notarization are required');
  run('xcrun', ['stapler', 'validate', app]);
  console.log('Apple notarization / Gatekeeper check passed');
} else {
  console.log(`Signature integrity passed. Gatekeeper ${assessment.status === 0 ? 'accepted' : 'did not accept'} this build. Ad-hoc signing is not Apple notarization.`);
}
