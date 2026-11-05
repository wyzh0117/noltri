import { describe, expect, it } from 'vitest';
import type { VaultService } from '../src/notes/vault';
import { createRequestHandler } from '../src/http/router';
import { makeHarness } from './fakes';

describe('Vault backlinks HTTP response', () => {
  it('returns the index revision alongside the backlinks', async () => {
    const harness = makeHarness();
    const vault = {
      getBacklinks: async (_path: string) => ({
        revision: 9,
        backlinks: [],
      }),
    } as unknown as VaultService;
    const handle = createRequestHandler({ core: harness.core, config: harness.config, vault });
    const response = await handle(new Request('http://core.local/api/vault/backlinks?path=Target.md'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 9, backlinks: [] });
  });
});
