import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError } from '../src/client';

describe('ApiClient library search', () => {
  it('trims and sends the server-side query with pagination and rejects an oversized query', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ items: [], limit: 20, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl });

    await client.listItems({
      query: '  older research note  ', kind: 'paper_excerpt', state: 'archive',
      limit: 20, offset: 0, nodeId: 'node-1',
    });
    const sent = new URL(urls[0] ?? '');
    expect(sent.pathname).toBe('/api/items');
    expect(sent.searchParams.get('query')).toBe('older research note');
    expect(sent.searchParams.get('offset')).toBe('0');
    expect(sent.searchParams.get('nodeId')).toBe('node-1');
    expect(sent.searchParams.get('kind')).toBe('paper_excerpt');
    expect(sent.searchParams.get('state')).toBe('archive');

    expect(() => client.listItems({ query: 'x'.repeat(201) })).toThrow(ApiClientError);
    expect(urls).toHaveLength(1);
  });
});
