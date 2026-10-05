import { describe, expect, it } from 'vitest';
import {
  buildServerEntry,
  buildStdioEntry,
  describeEntry,
  describeRemoval,
  describeStdioEntry,
  mergeServerEntry,
  parseExistingConfig,
  removeServerEntry,
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

describe('mcp config uninstall and idempotency (M02)', () => {
  const MULTI = JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
      noltri: { type: 'http', url: 'http://127.0.0.1:8790/mcp' },
      postgres: { command: 'mcp-postgres', env: { DATABASE_URL: 'postgres://localhost' } },
    },
    preferences: { theme: 'dark' },
    unknownFutureKey: { nested: [1, 2, 3] },
  });

  it('removes only the entry it manages and keeps every sibling verbatim', () => {
    const outcome = removeServerEntry(parseExistingConfig(MULTI), 'noltri');
    if (!outcome.ok) throw new Error(outcome.reason);
    const servers = outcome.document['mcpServers'] as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['filesystem', 'postgres']);
    expect(servers['filesystem']).toEqual({ command: 'npx', args: ['-y', 'fs-server'] });
    expect(servers['postgres']).toEqual({ command: 'mcp-postgres', env: { DATABASE_URL: 'postgres://localhost' } });
    expect(outcome.document['preferences']).toEqual({ theme: 'dark' });
    expect(outcome.document['unknownFutureKey']).toEqual({ nested: [1, 2, 3] });
    expect(outcome.removed).toBe(true);
    expect(outcome.previous).toEqual({ type: 'http', url: 'http://127.0.0.1:8790/mcp' });
  });

  it('keeps the mcpServers object even when the last server leaves', () => {
    const outcome = removeServerEntry(parseExistingConfig(JSON.stringify({ mcpServers: { noltri: ENTRY } })), 'noltri');
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.document['mcpServers']).toEqual({});
  });

  it('touches nothing when the file never carried our entry', () => {
    const raw = JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } });
    const outcome = removeServerEntry(parseExistingConfig(raw), 'noltri');
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.removed).toBe(false);
    expect(serializeDocument(outcome.document)).toBe(
      serializeDocument({ mcpServers: { filesystem: { command: 'npx' } } }),
    );
    expect(describeRemoval(raw, 'noltri')).toContain('不会修改这个文件');
  });

  it('refuses to uninstall from a document it cannot merge safely', () => {
    expect(removeServerEntry([1, 2], 'noltri').ok).toBe(false);
    expect(removeServerEntry({ mcpServers: 'not-an-object' }, 'noltri').ok).toBe(false);
    expect(describeRemoval(JSON.stringify({ mcpServers: 'not-an-object' }), 'noltri')).toContain('无法安全卸载');
  });

  it('installing the same entry twice produces byte-identical output', () => {
    const once = mergeServerEntry(parseExistingConfig(MULTI), 'noltri', ENTRY);
    if (!once.ok) throw new Error(once.reason);
    const twice = mergeServerEntry(once.document, 'noltri', ENTRY);
    if (!twice.ok) throw new Error(twice.reason);
    expect(serializeDocument(twice.document)).toBe(serializeDocument(once.document));

    const thrice = mergeServerEntry(twice.document, 'noltri', ENTRY);
    if (!thrice.ok) throw new Error(thrice.reason);
    expect(serializeDocument(thrice.document)).toBe(serializeDocument(once.document));
  });

  it('uninstall then reinstall restores the other servers exactly', () => {
    const removed = removeServerEntry(parseExistingConfig(MULTI), 'noltri');
    if (!removed.ok) throw new Error(removed.reason);
    const reinstalled = mergeServerEntry(removed.document, 'noltri', ENTRY);
    if (!reinstalled.ok) throw new Error(reinstalled.reason);
    expect(reinstalled.document['mcpServers']).toEqual({
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
      postgres: { command: 'mcp-postgres', env: { DATABASE_URL: 'postgres://localhost' } },
      noltri: ENTRY,
    });
  });

  it('describes the removal without printing a secret', () => {
    const raw = JSON.stringify({ mcpServers: { keep: { command: 'x' }, noltri: ENTRY } });
    const preview = describeRemoval(raw, 'noltri');
    expect(preview).toContain('将删除「noltri」条目');
    expect(preview).toContain('保留其他服务器：keep');
    expect(preview).not.toContain('device-token');
    expect(preview).toContain('"Authorization":"<已隐藏>"');
    expect(describeEntry({ headers: { Authorization: 'Bearer device-token' }, url: 'http://a' })).toBe(
      '{"headers":{"Authorization":"<已隐藏>"},"url":"http://a"}',
    );
    expect(describeEntry({ args: ['x'] })).toBe('{"args":["x"]}');
  });
});
