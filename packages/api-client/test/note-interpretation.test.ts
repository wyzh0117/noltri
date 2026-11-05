import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError, apiRoutes } from '../src/client';

function stub(payload: unknown) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('ApiClient note interpretation', () => {
  it('sends only the explicitly submitted source snapshot to the non-persisting endpoint', async () => {
    const sourceText = 'A tuple is immutable.\n\n| Kind | Mutable |\n| --- | --- |\n| tuple | no |\n\n```ts\nconst x = 1;\n```\n\n$$x^2$$\n\n![diagram](assets/graph.png)';
    const { calls, fetchImpl } = stub({ text: '元组不可变。', model: 'synthetic-model' });
    const client = new ApiClient({ baseUrl: 'http://core.local', fetchImpl });
    const result = await client.interpretNote({ mode: 'translation', sourceText, targetLanguage: '简体中文' });

    expect(result).toEqual({ text: '元组不可变。', model: 'synthetic-model' });
    expect(calls[0]).toEqual({
      url: `http://core.local${apiRoutes.noteInterpretation}`,
      method: 'POST',
      body: JSON.stringify({ mode: 'translation', sourceText, targetLanguage: '简体中文' }),
    });
  });

  it('rejects empty, whitespace-only, and oversized source before sending it', () => {
    const { calls, fetchImpl } = stub({ text: 'should not be reached' });
    const client = new ApiClient({ baseUrl: 'http://core.local', fetchImpl });

    const whitespaceOnly = String.fromCharCode(32, 9, 13, 10, 32);
    for (const sourceText of ['', whitespaceOnly, 'x'.repeat(20_001)]) {
      expect(() => client.interpretNote({ mode: 'translation', sourceText })).toThrow(ApiClientError);
    }
    expect(calls).toEqual([]);
  });
});
