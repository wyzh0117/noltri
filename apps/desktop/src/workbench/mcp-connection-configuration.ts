/** Build only on an explicit user gesture; callers must keep this credential-bearing result private. */
export function buildMcpConnectionConfiguration(endpoint: string, token: string): string {
  const invalid = (): never => { throw new Error('本机 MCP 连接设置无效。'); };
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048
    || /[\u0000-\u0020\u007f-\u009f\\?#]/u.test(endpoint) || /[\ud800-\udfff]/u.test(endpoint)
    || typeof token !== 'string' || token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) invalid();

  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { return invalid(); }
  const authority = /^https?:\/\/([^/]+)(?:\/|$)/i.exec(endpoint)?.[1];
  if (!authority) return invalid();
  if (authority.includes('@') || parsed.username || parsed.password
    || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search || parsed.hash) invalid();
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  const host = parsed.hostname;
  // Reject URL-parser shorthand/numeric aliases; allow only explicit loopback hosts.
  if (rawHost.toLowerCase() !== host || !(host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host))) invalid();

  // JSON's quoted-string escapes are valid TOML basic-string escapes for the validated scalar inputs.
  return `[mcp_servers.noltri]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
}
