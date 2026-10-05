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

/**
 * A stdio server registration: an executable plus an argument *array*. §11 forbids assembling a shell
 * string from a path and a username, so nothing here ever joins `args`, and the script path has to be
 * absolute — a relative one would resolve against whatever directory the Agent happens to launch from.
 */
export interface StdioParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The local Core address always travels; the token only when this install actually uses one. */
export function stdioInvocation(input: {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly coreBaseUrl: string;
  readonly token?: string;
}): StdioParams {
  const script = input.scriptPath.trim();
  const node = input.nodePath.trim();
  if (node === '') throw new Error('stdio 入口需要明确的 node 可执行文件');
  if (!script.startsWith('/')) throw new Error(`stdio 入口的脚本路径必须是绝对路径，收到 ${script}`);
  const core = input.coreBaseUrl.trim().replace(/\/+$/, '');
  if (core === '') throw new Error('stdio 入口需要本地 Core 地址');
  return {
    command: node,
    args: ['--import', 'tsx', script],
    env: {
      KNOWLEDGE_API_URL: core,
      ...(input.token === undefined || input.token.trim() === ''
        ? {}
        : { NOLTRI_ACCESS_TOKEN: input.token.trim() }),
    },
  };
}

export function buildStdioEntry(params: StdioParams): Record<string, unknown> {
  return { type: 'stdio', command: params.command, args: [...params.args], env: { ...params.env } };
}

/**
 * What the confirmation dialog shows. The secret is named but never printed, because the dialog is a
 * screenshot-able surface and §16 keeps credentials out of previews, logs and exports.
 */
export function describeStdioEntry(params: StdioParams): string {
  const secretKeys = Object.keys(params.env).filter((key) => /token|secret|key/i.test(key));
  const plainKeys = Object.keys(params.env).filter((key) => !/token|secret|key/i.test(key));
  const shown = [...plainKeys, ...secretKeys.map((key) => `${key}=<已隐藏>`)];
  return [`命令：${params.command}`, `参数：${params.args.join(' ')}`, `环境变量：${shown.length > 0 ? shown.join('、') : '（无）'}`].join('\n');
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

export interface RemovalOk {
  readonly ok: true;
  readonly document: Record<string, unknown>;
  /** False when the file never carried our entry — the caller must then write nothing at all. */
  readonly removed: boolean;
  /** The entry that was taken out, so the confirmation dialog can show what is about to disappear. */
  readonly previous: unknown;
}

export type RemovalOutcome = RemovalOk | MergeRejected;

/**
 * Uninstall (M02: 卸载只删除自己管理的项). Drops `mcpServers[serverName]` and nothing else: every
 * sibling server, every unknown top-level key, and the `mcpServers` key itself stay in place even when
 * it ends up empty — a client that expects the object must not find it gone.
 */
export function removeServerEntry(rawDocument: unknown, serverName: string): RemovalOutcome {
  if (!isPlainObject(rawDocument)) return { ok: false, reason: '配置文件不是 JSON 对象' };
  const servers = rawDocument['mcpServers'];
  if (servers !== undefined && !isPlainObject(servers)) {
    return { ok: false, reason: 'mcpServers 不是对象，无法安全合并' };
  }
  if (servers === undefined || !(serverName in servers)) {
    return { ok: true, document: rawDocument, removed: false, previous: undefined };
  }
  const rest: Record<string, unknown> = { ...servers };
  const previous = rest[serverName];
  delete rest[serverName];
  return { ok: true, document: { ...rawDocument, mcpServers: rest }, removed: true, previous };
}

const SECRET_KEY = /token|secret|key|authorization|password|cookie|bearer/i;

function hideSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideSecrets);
  if (!isPlainObject(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(value)) {
    next[name] = SECRET_KEY.test(name) ? '<已隐藏>' : hideSecrets(inner);
  }
  return next;
}

/**
 * One-line, secret-free rendering of a server entry for a dialog that can be screenshotted (§16).
 */
export function describeEntry(entry: unknown): string {
  const text = JSON.stringify(hideSecrets(entry) ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** What the confirmation dialog shows before an uninstall write. */
export function describeRemoval(raw: string | null, serverName: string): string {
  const outcome = removeServerEntry(parseExistingConfig(raw), serverName);
  if (!outcome.ok) return `无法安全卸载：${outcome.reason}`;
  if (!outcome.removed) return `配置中没有「${serverName}」条目，不会修改这个文件`;
  const servers = (outcome.document['mcpServers'] ?? {}) as Record<string, unknown>;
  const kept = Object.keys(servers);
  return [
    `将删除「${serverName}」条目：${describeEntry(outcome.previous)}`,
    `保留其他服务器：${kept.length > 0 ? kept.join('、') : '（无其他服务器，但保留 mcpServers 对象本身）'}`,
  ].join('\n');
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
