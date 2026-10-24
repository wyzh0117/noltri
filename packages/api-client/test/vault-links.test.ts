import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/client';

describe('ApiClient vault link resolution', () => {
  it('sends the link kind and defaults legacy callers to wikilinks', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ path: 'Target.md' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await client.resolveVaultLink('Target.md', 'Nested/Source.md', 'markdown');
    await client.resolveVaultLink('Target', 'Nested/Source.md');

    expect(bodies).toEqual([
      { linkpath: 'Target.md', sourcePath: 'Nested/Source.md', kind: 'markdown' },
      { linkpath: 'Target', sourcePath: 'Nested/Source.md', kind: 'wikilink' },
    ]);
  });
});
