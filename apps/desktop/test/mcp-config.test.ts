import { describe, expect, it } from 'vitest';
import { buildServerEntry, mergeServerEntry, parseExistingConfig, serializeDocument, summarizeMerge } from '../src/lib/mcp-config';

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
