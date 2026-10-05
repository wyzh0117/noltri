import { describe, expect, it } from 'vitest';
import {
  buildServerEntry,
  buildStdioEntry,
  describeStdioEntry,
  mergeServerEntry,
  parseExistingConfig,
  serializeDocument,
  stdioInvocation,
  summarizeMerge,
} from '../src/lib/mcp-config';

const ENTRY = buildServerEntry('http://127.0.0.1:8790/mcp', 'device-token');

describe('mcp config merge (pure)', () => {
  it('builds a streamable-http entry with a bearer header only when a token exists', () => {
    expect(ENTRY).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8790/mcp',
      headers: { Authorization: 'Bearer device-token' },
    });
    expect(buildServerEntry('http://127.0.0.1:8790/mcp', '  ')).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8790/mcp',
    });
  });

  it('adds noltri and keeps every other server untouched', () => {
    const existing = parseExistingConfig(
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'fs'] } }, other: 1 }),
    );
    const merged = mergeServerEntry(existing, 'noltri', ENTRY);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const servers = merged.document['mcpServers'] as Record<string, unknown>;
    expect(servers['filesystem']).toEqual({ command: 'npx', args: ['-y', 'fs'] });
    expect(servers['noltri']).toEqual(ENTRY);
    expect(merged.document['other']).toBe(1);
  });

  it('updates an existing noltri entry without touching siblings', () => {
    const existing = parseExistingConfig(
      JSON.stringify({ mcpServers: { noltri: { type: 'http', url: 'http://old' }, other: { command: 'x' } } }),
    );
    const merged = mergeServerEntry(existing, 'noltri', ENTRY);
    expect(merged.ok).toBe(true);
    const servers = (merged as { ok: true; document: Record<string, unknown> }).document['mcpServers'] as Record<
      string,
      unknown
    >;
    expect(servers['noltri']).toEqual(ENTRY);
    expect(servers['other']).toEqual({ command: 'x' });
  });

  it('accepts an empty or new file and rejects malformed documents', () => {
    const fresh = mergeServerEntry(parseExistingConfig(null), 'noltri', ENTRY);
    expect(fresh.ok).toBe(true);

    expect(mergeServerEntry([1, 2], 'noltri', ENTRY).ok).toBe(false);
    expect(mergeServerEntry({ mcpServers: [] }, 'noltri', ENTRY).ok).toBe(false);
    expect(mergeServerEntry('not-json-object', 'noltri', ENTRY).ok).toBe(false);
  });

  it('round-trips through the serializer: what the dialog shows is what gets written', () => {
    const merged = mergeServerEntry({ mcpServers: { keep: { command: 'keep-cmd' } } }, 'noltri', ENTRY);
    if (!merged.ok) throw new Error('merge failed');
    const text = serializeDocument(merged.document);
    const reparsed = JSON.parse(text) as { mcpServers: Record<string, unknown> };
    expect(reparsed.mcpServers['keep']).toEqual({ command: 'keep-cmd' });
    expect(reparsed.mcpServers['noltri']).toEqual(ENTRY);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('summarizeMerge tells the user exactly what happens to other servers', () => {
    const raw = JSON.stringify({ mcpServers: { a: {}, b: {} } });
    expect(summarizeMerge(raw, 'noltri')).toContain('将新增');
    expect(summarizeMerge(raw, 'noltri')).toContain('a、b');
    expect(summarizeMerge(JSON.stringify({ mcpServers: { noltri: {} } }), 'noltri')).toContain('将更新');
    expect(summarizeMerge(null, 'noltri')).toContain('（无其他服务器）');
  });
});

describe('stdio entry (§11: 默认 stdio transport，参数数组而非 shell 字符串)', () => {
  const INPUT = {
    nodePath: '/usr/local/bin/node',
    scriptPath: '/Users/dev/noltri/services/mcp-server/src/stdio.ts',
    coreBaseUrl: 'http://127.0.0.1:8787/',
  };
  const params = stdioInvocation(INPUT);

  it('carries the Core address in env and never joins the arguments into one string', () => {
    expect(params.command).toBe('/usr/local/bin/node');
    expect(params.args).toEqual(['--import', 'tsx', '/Users/dev/noltri/services/mcp-server/src/stdio.ts']);
    expect(params.env).toEqual({ KNOWLEDGE_API_URL: 'http://127.0.0.1:8787' });
    expect(params.args.some((arg) => arg.includes(' '))).toBe(false);
  });

  it('adds the bearer token to env only when this install actually uses one', () => {
    expect(stdioInvocation({ ...INPUT, token: '  ' }).env).toEqual({ KNOWLEDGE_API_URL: 'http://127.0.0.1:8787' });
    expect(stdioInvocation({ ...INPUT, token: 'sekret-stdio-token' }).env).toEqual({
      KNOWLEDGE_API_URL: 'http://127.0.0.1:8787',
      NOLTRI_ACCESS_TOKEN: 'sekret-stdio-token',
    });
  });

  it('refuses a relative script path, a missing node, or a missing Core address', () => {
    const base = { nodePath: 'node', scriptPath: '/abs/stdio.ts', coreBaseUrl: 'http://127.0.0.1:8787' };
    expect(() => stdioInvocation({ ...base, scriptPath: 'src/stdio.ts' })).toThrow(/绝对路径/);
    expect(() => stdioInvocation({ ...base, nodePath: '  ' })).toThrow(/node 可执行文件/);
    expect(() => stdioInvocation({ ...base, coreBaseUrl: '  ' })).toThrow(/Core 地址/);
  });

  it('builds a config entry whose args survive serialization as an array', () => {
    const merged = mergeServerEntry(
      parseExistingConfig(JSON.stringify({ mcpServers: { keep: { command: 'keep-cmd' } } })),
      'noltri',
      buildStdioEntry(params),
    );
    if (!merged.ok) throw new Error('merge failed');
    const text = serializeDocument(merged.document);
    const servers = (JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers['keep']).toEqual({ command: 'keep-cmd' });
    expect(servers['noltri']).toEqual({ type: 'stdio', command: '/usr/local/bin/node', args: params.args, env: params.env });
    expect(Array.isArray((servers['noltri'] as { args: unknown }).args)).toBe(true);
  });

  it('names the secret in the preview without ever printing it (§16)', () => {
    const withToken = stdioInvocation({ ...INPUT, token: 'sekret-stdio-token' });
    const preview = describeStdioEntry(withToken);
    expect(preview).toContain('NOLTRI_ACCESS_TOKEN=<已隐藏>');
    expect(preview).toContain('KNOWLEDGE_API_URL');
    expect(preview).not.toContain('sekret-stdio-token');
    expect(describeStdioEntry({ command: 'node', args: ['x.js'], env: {} })).toContain('环境变量：（无）');
  });
});
