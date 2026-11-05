import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, processingRulesStateSchema } from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { ProcessingRulesStore } from '../src/services/processing-rules';
import { createRequestHandler } from '../src/http/router';
import { buildHandler, type CoreBundle } from '../src/http';
import type { Identity } from '../src/auth';
import { makeHarness, testConfig } from './fakes';
const roots: string[] = []; const bundles: CoreBundle[] = [];
const defaults = { thresholds: { ...DEFAULT_THRESHOLDS }, extractionInstructions: '', classificationInstructions: '' };
const device: Identity = { userId: 'synthetic-user', actor: 'desktop', via: 'dev-token' };
afterEach(async () => { for (const bundle of bundles.splice(0)) await bundle.close(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(await realpath(tmpdir()), 'rules-host-')); roots.push(dir); return dir; }
async function fixture(identity = device) {
 const dir = await root(); const store = await ProcessingRulesStore.open({ root: join(dir, 'processing-rules'), defaults }); const h = makeHarness();
 const handle = createRequestHandler({ core: h.core, config: h.config, processingRules: store, identityResolver: async () => identity });
 return { dir, store, handle };
}
async function send(handle: ReturnType<typeof createRequestHandler>, path = '/api/admin/processing-rules', method = 'GET', body?: unknown) {
 const response = await handle(new Request('http://core.local' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-device' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })); return { status: response.status, body: await response.json() as any };
}
describe('rules routes preserve the resolved device boundary', () => {
 it('serves draft/apply/rollback/records with revisions, history and safe response envelopes', async () => {
  const f = await fixture(); const initial = await send(f.handle); expect(initial.status).toBe(200); const before = processingRulesStateSchema.parse(initial.body);
  const rules = { ...defaults, extractionInstructions: 'synthetic extraction instructions' };
  expect((await send(f.handle, '/api/admin/processing-rules/draft', 'PUT', { rules, expectedRevision: 0 })).body).toEqual({ revision: 1, rules });
  const applied = await send(f.handle, '/api/admin/processing-rules/apply', 'POST', { expectedRevision: 1 }); expect(applied.status).toBe(200); expect(applied.body.applied.rules).toEqual(rules);
  const rolled = await send(f.handle, '/api/admin/processing-rules/rollback', 'POST', { versionId: before.applied.versionId, expectedRevision: 2 }); expect(rolled.status).toBe(200); expect(rolled.body.applied.rules).toEqual(defaults);
  expect((await send(f.handle, '/api/admin/processing-rules/apply', 'POST', { expectedRevision: 0 })).status).toBe(409);
  const record = { recordId: 'host-record', taskId: 'host-task', ruleVersionId: rolled.body.applied.versionId, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', phase: 'completed' as const, status: 'succeeded' as const };
  await f.store.appendRecord(record); expect((await send(f.handle, '/api/admin/processing-records')).body).toEqual({ records: [record] });
 });
 it.each<Identity>([{ ...device, via: 'dev-open' }, { ...device, via: 'grant', grant: { id: 'g', label: 'g', client: 'api', scopes: ['read', 'mutate', 'capture'], secretHash: 'unused', nodeIds: null, snippetChars: null, createdAt: '2026', revokedAt: null } }])('denies $via even for reads without changing any rules state', async identity => {
  const f = await fixture(identity); const path = join(f.dir, 'processing-rules', 'processing-rules.json'); const before = await readFile(path, 'utf8');
  for (const [route, method, body] of [['/api/admin/processing-rules','GET',undefined],['/api/admin/processing-records','GET',undefined],['/api/admin/processing-rules/draft','PUT',{}],['/api/admin/processing-rules/apply','POST',{}],['/api/admin/processing-rules/rollback','POST',{}]] as const) expect((await send(f.handle, route, method, body)).status).toBe(401);
  expect(await readFile(path,'utf8')).toBe(before);
 });
 it('uses the service sanitizer when persisted rule storage becomes corrupt', async () => {
  const f=await fixture();await writeFile(join(f.dir,'processing-rules','processing-rules.json'),'{private-instruction-sentinel');
  const response=await send(f.handle,'/api/admin/processing-rules/draft','PUT',{rules:defaults,expectedRevision:0});expect(response.status).toBe(500);
  expect(JSON.stringify(response.body)).not.toContain('private-instruction-sentinel');expect(JSON.stringify(response.body)).not.toContain(f.dir);
 });
 it('rejects arbitrary fields and roots, and sanitizes unavailable storage', async () => {
  const f = await fixture(); const before = f.store.readDraft();
  for (const extra of [{ root: '/outside' }, { userId: 'other' }, { token: 'secret' }]) expect((await send(f.handle, '/api/admin/processing-rules/draft','PUT',{rules:defaults,expectedRevision:0,...extra})).status).toBe(400);
  expect((await send(f.handle, '/api/admin/processing-rules?root=/outside')).status).toBe(400); expect(f.store.readDraft()).toEqual(before);
  const h=makeHarness();const missing=createRequestHandler({core:h.core,config:h.config,identityResolver:async()=>device});const failure=await send(missing);expect(failure.status).toBe(500);expect(JSON.stringify(failure.body)).not.toContain(f.dir);
 });
});
describe('one canonical rules store per profile host', () => {
 it('injects the exact same store into Core and routes and persists in the fixed profile child', async () => {
  const dir=await root(); const config=testConfig({ storage:{driver:'memory'},sqliteFile:':memory:',dataDir:dir,vaultDir:join(dir,'vault'),grantFile:'',devUser:'synthetic-user',devTokenRequired:true,devToken:'synthetic-device', thresholds:{...DEFAULT_THRESHOLDS,highConfidence:0.9} });
  const bundle=await buildHandler(config,{logger:silentLogger,vaultRootPath:join(dir,'vault'),vaultDataDir:dir});bundles.push(bundle);
  expect(bundle.processingRules).toBeInstanceOf(ProcessingRulesStore);expect(bundle.core.deps.processingRules).toBe(bundle.processingRules); const initial=await send(bundle.handle);expect(initial.status).toBe(200);expect(initial.body.applied.rules).toEqual({...defaults,thresholds:config.thresholds});
  for (const headers of [{}, { authorization: 'Bearer wrong-synthetic' }] as Record<string,string>[]) {
   expect((await bundle.handle(new Request('http://core.local/api/admin/processing-rules',{headers}))).status).toBe(401);
   expect((await bundle.handle(new Request('http://core.local/api/admin/processing-rules/apply',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{malformed'}))).status).toBe(401);
  }
  expect(bundle.processingRules.readDraft().revision).toBe(0);
  const rules={...defaults,classificationInstructions:'host shared snapshot'};
  expect((await send(bundle.handle,'/api/admin/processing-rules/draft','PUT',{rules,expectedRevision:0})).status).toBe(200);const applied=await send(bundle.handle,'/api/admin/processing-rules/apply','POST',{expectedRevision:1});
  expect(bundle.core.deps.processingRules?.getAppliedSnapshot().versionId).toBe(applied.body.applied.versionId);expect(await readFile(join(dir,'processing-rules','processing-rules.json'),'utf8')).toContain('host shared snapshot');
 });
 it('uses and removes the existing ephemeral memory profile instead of the configured data directory', async () => {
  const dir=await root();const config=testConfig({storage:{driver:'memory'},sqliteFile:join(dir,'unused-default.sqlite'),dataDir:dir,grantFile:'',devTokenRequired:true,devToken:'synthetic-device'});const bundle=await buildHandler(config,{logger:silentLogger});
  let profile: string;
  try { expect((await send(bundle.handle)).status).toBe(200);expect(await readdir(dir)).toEqual([]);profile=dirname(await bundle.vault.captureRootForMutation());expect(await readFile(join(profile,'processing-rules','processing-rules.json'),'utf8')).toContain('extractionInstructions'); }
  finally { await bundle.close(); }
  await expect(lstat(profile!)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('fails closed on corrupt rules before returning a provider-backed host', async () => {
  const dir=await root();await mkdir(join(dir,'processing-rules'));await writeFile(join(dir,'processing-rules','processing-rules.json'),'{synthetic-sensitive');const config=testConfig({storage:{driver:'memory'},sqliteFile:':memory:',dataDir:dir,grantFile:''});
  const attempt=buildHandler(config,{logger:silentLogger,vaultRootPath:join(dir,'vault'),vaultDataDir:dir});await expect(attempt).rejects.toMatchObject({code:'storage_error',message:'Processing rules storage unavailable'});
 });
});
