import { expect, it } from 'vitest';
import { readDevelopmentEndpoints } from './development-endpoints';
it('defaults browser development to the isolated Notes Core and MCP ports', () => {
  expect(readDevelopmentEndpoints({})).toEqual({ apiBaseUrl: 'http://localhost:18887', mcpEndpoint: 'http://127.0.0.1:18890/mcp' });
});
it('retains explicit endpoint overrides without rewriting their ports', () => {
  expect(readDevelopmentEndpoints({ VITE_NOLTRI_CORE_URL: 'http://localhost:8787', VITE_NOLTRI_MCP_URL: 'http://127.0.0.1:8790/mcp' })).toEqual({ apiBaseUrl: 'http://localhost:8787', mcpEndpoint: 'http://127.0.0.1:8790/mcp' });
});
it('does not make an explicit Core address change the MCP fallback', () => {
  expect(readDevelopmentEndpoints({ VITE_NOLTRI_CORE_URL: 'https://synthetic.invalid/core' })).toEqual({ apiBaseUrl: 'https://synthetic.invalid/core', mcpEndpoint: 'http://127.0.0.1:18890/mcp' });
});
