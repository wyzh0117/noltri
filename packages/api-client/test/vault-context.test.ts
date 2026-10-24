import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError } from '../src/client';

describe('Vault mutation context', () => {
  it('encodes the captured Unicode root on writes and leaves openVault unscoped', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      const payload = String(input).endsWith('/api/vault/open')
        ? { rootPath: '/tmp/知序 My Vault', files: [], revision: 1 }
        : { path: 'Home.md', content: '# Home', mtime: 1, size: 6, etag: 'etag-1' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });
    const rootPath = '/tmp/知序 My Vault';

    await client.saveVaultFile({ path: 'Home.md', content: '# Home' }, rootPath);
    await client.openVault({ rootPath });

    expect(calls[0]?.headers.get('x-noltri-vault-root')).toBe(encodeURIComponent(rootPath));
    expect(calls[0]?.headers.get('x-noltri-vault-root')).toMatch(/^[\x00-\x7F]+$/);
    expect(calls[1]?.headers.has('x-noltri-vault-root')).toBe(false);
  });

  it('rejects a mutation without a captured root before calling fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await expect(client.saveVaultFile({ path: 'Home.md', content: '# Home' }, '')).rejects.toBeInstanceOf(ApiClientError);
    expect(called).toBe(false);
  });
});
