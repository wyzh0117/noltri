import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError } from '../src/client';
function setup(payload: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const client = new ApiClient({ baseUrl: 'http://core.local', fetchImpl: (async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
  return { client, calls };
}
describe('review client wire contract', () => {
  it('sends the revision and idempotent intent with an encoded source id', async () => {
    const { client, calls } = setup({ reviewStatus: 'deferred', reviewRevision: 1, duplicate: false });
    const request = { actionId: 'one', expectedRevision: 0, action: 'defer' as const };
    expect(await client.reviewSource('source /1', request)).toEqual({ reviewStatus: 'deferred', reviewRevision: 1, duplicate: false });
    expect(calls).toEqual([{ url: 'http://core.local/api/inbox/source%20%2F1/review', body: request }]);
  });
  it('rejects invalid action payloads before sending anything', () => {
    const { client, calls } = setup({});
    expect(() => client.reviewSource('id', { actionId: 'one', expectedRevision: 0, action: 'confirm' } as never)).toThrow(ApiClientError);
    expect(() => client.reviewSource('id', { actionId: 'one', expectedRevision: 0, action: 'defer', nodeId: 'hidden' } as never)).toThrow(ApiClientError);
    expect(calls).toEqual([]);
  });
  it('combines review and processing filters without losing counts', async () => {
    const payload = { entries: [], counts: { pending: 0, processing: 0, done: 3, failed: 0 }, reviewCounts: { needs_review: 2, confirmed: 1, deferred: 0, rejected: 0 }, limit: 2, offset: 1 };
    const { client, calls } = setup(payload);
    expect(await client.inbox({ status: 'done', reviewStatus: 'needs_review', limit: 2, offset: 1 })).toEqual(payload);
    expect(calls[0]?.url).toBe('http://core.local/api/inbox?status=done&reviewStatus=needs_review&limit=2&offset=1');
  });
});
