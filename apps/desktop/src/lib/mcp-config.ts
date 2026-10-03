/**
 * Pure merge of an MCP client's `mcpServers` document (V1 §12.2 step 3-4, PROJECT_MASTER §2.7).
 *
 * Setup Manager may prepare config but must never lose another server's entry, so the merge is a
 * pure, unit-tested function; the Rust side only performs the already-merged atomic write and
 * re-validates that other servers survive (see `write_mcp_config`).
 */
export interface MergeOk {
  readonly ok: true;
  readonly document: Record<string, unknown>;
}

export interface MergeRejected {
  readonly ok: false;
  readonly reason: string;
}

export type MergeOutcome = MergeOk | MergeRejected;

/** The HTTP entry advertised to Streamable-HTTP capable clients. */
export function buildServerEntry(endpoint: string, token: string): Record<string, unknown> {
  const trimmed = endpoint.trim();
  return {
    type: 'http',
    url: trimmed,
    ...(token.trim() === '' ? {} : { headers: { Authorization: `Bearer ${token.trim()}` } }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replaces only `mcpServers[serverName]`, keeping every other top-level key and every other
 * server untouched. Rejects documents that would silently drop existing state.
 */
export function mergeServerEntry(
  rawDocument: unknown,
  serverName: string,
  entry: unknown,
): MergeOutcome {
  if (!isPlainObject(rawDocument)) return { ok: false, reason: '配置文件不是 JSON 对象' };
  const servers = rawDocument['mcpServers'];
  if (servers !== undefined && !isPlainObject(servers)) {
    return { ok: false, reason: 'mcpServers 不是对象，无法安全合并' };
  }
  const nextServers: Record<string, unknown> = { ...(servers ?? {}), [serverName]: entry };
  return { ok: true, document: { ...rawDocument, mcpServers: nextServers } };
}

/** Reads a config file's text into the merge, tolerating an empty/new file. */
export function parseExistingConfig(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  return isPlainObject(parsed) ? parsed : {};
}

/** Stable serialization: the exact bytes shown in the confirmation dialog are what gets written. */
export function serializeDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Convenience for the confirm dialog: what will change, in one readable line. */
export function summarizeMerge(raw: string | null, serverName: string): string {
  const document = parseExistingConfig(raw);
  const servers = isPlainObject(document['mcpServers']) ? (document['mcpServers'] as Record<string, unknown>) : {};
  const others = Object.keys(servers).filter((name) => name !== serverName);
  const replacing = serverName in servers;
  return replacing
    ? `将更新「${serverName}」条目；同时保留：${others.length > 0 ? others.join('、') : '（无其他服务器）'}`
    : `将新增「${serverName}」条目；同时保留：${others.length > 0 ? others.join('、') : '（无其他服务器）'}`;
}
