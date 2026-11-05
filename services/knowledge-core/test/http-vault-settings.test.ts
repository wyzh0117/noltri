import { describe, expect, it } from 'vitest';
import { createRequestHandler } from '../src/http/router';
import type { VaultService } from '../src/notes/vault';
import { makeHarness } from './fakes';

describe('Vault settings root context', () => {
  it('passes the requested vault root through GET instead of returning active-root settings', async () => {
    const harness = makeHarness();
    const roots: Array<string | undefined> = [];
    const vault = {
      getSettings: async (rootPath?: string) => {
        roots.push(rootPath);
        return { newLinkFormat: 'relative', propertyTypes: { priority: 'number' } };
      },
    } as unknown as VaultService;
    const handle = createRequestHandler({ core: harness.core, config: harness.config, vault });
    const rootPath = '/tmp/知序 My Vault';
    const response = await handle(new Request('http://core.local/api/vault/settings', {
      headers: { 'x-noltri-vault-root': encodeURIComponent(rootPath) },
    }));

    expect(response.status).toBe(200);
    expect(roots).toEqual([rootPath]);
    expect(await response.json()).toEqual({ newLinkFormat: 'relative', propertyTypes: { priority: 'number' } });
  });
});
