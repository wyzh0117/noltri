#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const REQUIRED_PERMISSIONS = ['contextMenus', 'storage', 'activeTab'];

/**
 * Pure manifest assertions: returns every problem instead of the first one, so `pnpm build` output is
 * actionable. `fileExists` is injected so the rules can be unit-checked without a build.
 */
export function validateManifest(manifest, fileExists) {
  const errors = [];
  const isMatchPattern = (value) => typeof value === 'string' && /^[a-zA-Z][\w-+]*:\/\/[^/|\s]+\/.*$/.test(value);

  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3 (Manifest V3)');
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) errors.push('name is required');
  if (manifest.name !== '知序 Noltri') errors.push(`unexpected extension name: ${String(manifest.name)}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version ?? ''))) errors.push('version must be x.y.z');
  if (typeof manifest.description !== 'string' || manifest.description.length === 0) errors.push('description is required');

  if (manifest.content_security_policy !== undefined) errors.push('content_security_policy must stay default in MV3');
  if (manifest.permissions === undefined || !Array.isArray(manifest.permissions)) errors.push('permissions must be an array');
  else for (const required of REQUIRED_PERMISSIONS) if (!manifest.permissions.includes(required)) errors.push(`permissions must include "${required}"`);

  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length === 0) {
    errors.push('host_permissions must list at least the configurable API origin');
  } else {
    for (const pattern of manifest.host_permissions) if (!isMatchPattern(pattern)) errors.push(`invalid host_permissions pattern: ${pattern}`);
  }

  if (!isMatchPattern(String(manifest.optional_host_permissions?.[0] ?? ''))) {
    errors.push('optional_host_permissions must allow granting a self-hosted API origin');
  }

  const popup = manifest.action?.default_popup;
  if (typeof popup !== 'string' || popup.length === 0) errors.push('action.default_popup is required');
  else if (!fileExists(popup)) errors.push(`action.default_popup missing from build output: ${popup}`);

  const worker = manifest.background?.service_worker;
  if (typeof worker !== 'string' || worker.length === 0) errors.push('background.service_worker is required');
  else if (!fileExists(worker)) errors.push(`background.service_worker missing from build output: ${worker}`);
  if (manifest.background?.type === 'module') errors.push('service worker must stay a classic (iife) worker: no "type": "module"');

  const scripts = manifest.content_scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) errors.push('content_scripts must declare at least one script');
  else {
    scripts.forEach((entry, index) => {
      if (!Array.isArray(entry.matches) || entry.matches.length === 0) errors.push(`content_scripts[${index}].matches is required`);
      if (!Array.isArray(entry.js) || entry.js.length === 0) errors.push(`content_scripts[${index}].js is required`);
      for (const file of [...(entry.js ?? []), ...(entry.css ?? [])]) {
        if (!fileExists(file)) errors.push(`content_scripts[${index}] references a missing file: ${file}`);
      }
    });
  }

  const optionsPage = manifest.options_ui?.page;
  if (typeof optionsPage !== 'string' || optionsPage.length === 0) errors.push('options_ui.page is required');
  else if (!fileExists(optionsPage)) errors.push(`options_ui.page missing from build output: ${optionsPage}`);

  for (const [key, value] of Object.entries(manifest.icons ?? {})) {
    if (!fileExists(String(value))) errors.push(`icons[${key}] missing from build output: ${value}`);
  }

  return errors;
}

/**
 * Chrome loads the content script and the MV3 service worker as *classic* scripts, so a leftover
 * `import`/`export` statement would fail at load time with no useful error. Assert the bundles are safe.
 */
export function assertClassicScriptsSafe(files, readFile) {
  const errors = [];
  for (const [label, name] of [
    ['content script', files.content],
    ['service worker', files.worker],
  ]) {
    const source = readFile(name);
    if (/^\s*(import|export)\s/m.test(source)) errors.push(`${label} "${name}" contains ESM syntax and cannot load as a classic script`);
  }
  return errors;
}

export async function validateBuildOutput(options) {
  const outdir = resolve(options.outdir);
  const raw = await readFile(join(outdir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  const exists = (file) => existsSync(join(outdir, file));
  const read = (file) => readFile(join(outdir, file), 'utf8');
  const errors = validateManifest(manifest, exists);
  const contentScript = manifest.content_scripts?.[0]?.js?.[0] ?? 'content.js';
  const worker = manifest.background?.service_worker ?? 'background.js';
  if (exists(contentScript) && exists(worker)) {
    errors.push(...assertClassicScriptsSafe({ content: contentScript, worker }, read));
  }
  return { manifest, errors };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const outdir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.output'));
  try {
    const { errors } = await validateBuildOutput({ outdir });
    if (errors.length > 0) {
      console.error(`manifest validation failed for ${outdir}:`);
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`manifest validation passed: ${join(outdir, 'manifest.json')}`);
  } catch (error) {
    console.error(`manifest validation could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
