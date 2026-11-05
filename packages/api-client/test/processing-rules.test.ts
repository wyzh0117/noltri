import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@noltri/schema';
import { ApiClient, ApiClientError } from '../src/client';
const rules = { thresholds: DEFAULT_THRESHOLDS, extractionInstructions: '', classificationInstructions: '' };
const draft = { revision: 0, rules };
const applied = { versionId: 'rules-1-0123456789ab', contentHash: 'a'.repeat(64), createdAt: '2026-11-02T00:00:00Z', rules };
function fixture(payload: unknown) { const calls: any[] = []; const client = new ApiClient({ baseUrl: 'http://core.local', token: 'synthetic-device', clientHint: 'desktop', fetchImpl: (async (url, init) => { calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers }); return new Response(JSON.stringify(payload), { status: 200 }); }) as typeof fetch }); return { client, calls }; }
describe('rules management client wire contracts', () => {
 it('uses the five fixed routes/methods with strict shared bodies and device headers', async () => {
  const cases = [
   ['processingRules', undefined, '/api/admin/processing-rules', 'GET', { draft, applied, versions: [applied] }],
   ['saveProcessingRulesDraft', { rules, expectedRevision: 0 }, '/api/admin/processing-rules/draft', 'PUT', draft],
   ['applyProcessingRules', { expectedRevision: 0 }, '/api/admin/processing-rules/apply', 'POST', { draft, applied }],
   ['rollbackProcessingRules', { versionId: applied.versionId, expectedRevision: 0 }, '/api/admin/processing-rules/rollback', 'POST', { draft, applied }],
   ['processingRecords', undefined, '/api/admin/processing-records', 'GET', { records: [] }],
  ] as const;
  for (const [method, body, path, verb, payload] of cases) {
   const { client, calls } = fixture(payload);
   const response = await (client[method] as (body?: any) => Promise<unknown>)(body);
   expect(response).toEqual(payload); expect(calls[0]).toMatchObject({ url: 'http://core.local' + path, method: verb, body: body ?? null, headers: { authorization: 'Bearer synthetic-device', 'x-noltri-client': 'desktop' } });
  }
 });
 it('rejects spoofed fields and invalid revisions before any fetch', () => {
  const { client, calls } = fixture({});
  expect(() => client.saveProcessingRulesDraft({ rules, expectedRevision: 0, root: '/outside' } as never)).toThrow(ApiClientError);
  expect(() => client.applyProcessingRules({ expectedRevision: -1 })).toThrow(ApiClientError);
  expect(() => client.rollbackProcessingRules({ versionId: '../outside', expectedRevision: 0 })).toThrow(ApiClientError);
  expect(calls).toEqual([]);
 });
 it('rejects a response carrying arbitrary sensitive fields', async () => {
  const { client } = fixture({ draft, applied, versions: [applied], token: 'must-not-pass' });
  await expect(client.processingRules()).rejects.toBeInstanceOf(ApiClientError);
 });
});
