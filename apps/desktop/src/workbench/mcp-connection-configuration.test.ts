import { describe, expect, it } from 'vitest';
import { buildMcpConnectionConfiguration } from './mcp-connection-configuration';

describe('explicit local MCP connection configuration', () => {
  it('builds a static authorization map for the exact local endpoint', () => {
    expect(buildMcpConnectionConfiguration('http://127.0.0.1:18890/mcp', 'generated-device-token'))
      .toBe('[mcp_servers.noltri]\nurl = "http://127.0.0.1:18890/mcp"\nhttp_headers = { Authorization = "Bearer generated-device-token" }\n');
    for (const endpoint of ['https://localhost:18890/mcp', 'http://[::1]:18890/mcp', 'http://127.2.3.4:18890/mcp']) {
      expect(buildMcpConnectionConfiguration(endpoint, 'synthetic')).toContain(`url = "${endpoint}"`);
    }
  });
  it('escapes TOML quotes and backslashes instead of creating another setting', () => {
    expect(buildMcpConnectionConfiguration('http://127.0.0.1:18890/mcp', 'generated-"quote"\\slash'))
      .toBe('[mcp_servers.noltri]\nurl = "http://127.0.0.1:18890/mcp"\nhttp_headers = { Authorization = "Bearer generated-\\"quote\\"\\\\slash" }\n');
  });
  it('rejects nonlocal, ambiguous, credentialed or decorated endpoint inputs without echoing them', () => {
    for (const endpoint of ['', 'https://example.invalid/mcp', 'http://localhost.example.invalid/mcp', 'file:///tmp/mcp', 'ftp://127.0.0.1/mcp', 'http://127.0.0.1:18890/mcp?token=synthetic', 'http://127.0.0.1/mcp?', 'http://127.0.0.1/mcp#synthetic', 'http://127.0.0.1/mcp#', 'http://user:synthetic@127.0.0.1/mcp', 'http://@127.0.0.1/mcp', 'http://2130706433/mcp', 'http://127.1/mcp', 'http://localhost./mcp', 'http://127.0.0.1/\nsynthetic', 'http://127.0.0.1/\u007f', 'http://127.0.0.1/\ud800', 'http://127.0.0.1/' + 'x'.repeat(2048)]) {
      expect(() => buildMcpConnectionConfiguration(endpoint, 'synthetic')).toThrow('本机 MCP 连接设置无效。');
    }
  });
  it('fails closed on missing, excessive or header-control credentials with a generic error', () => {
    for (const token of ['', ' ', ' leading', 'trailing ', 'synthetic\nInjected: value', 'synthetic\rvalue', 'synthetic\tvalue', 'synthetic\u0000value', 'synthetic\u007fvalue', 'synthetic\u0085value', 'x'.repeat(4097)]) {
      expect(() => buildMcpConnectionConfiguration('http://127.0.0.1:18890/mcp', token)).toThrow('本机 MCP 连接设置无效。');
    }
    expect(() => buildMcpConnectionConfiguration(undefined as unknown as string, 'synthetic')).toThrow('本机 MCP 连接设置无效。');
    expect(() => buildMcpConnectionConfiguration('http://127.0.0.1:18890/mcp', null as unknown as string)).toThrow('本机 MCP 连接设置无效。');
  });
});
