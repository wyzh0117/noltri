/**
 * Connection test for the Setup Manager's 「AI 连接」 section (V1 §12.2 step 2).
 *
 * The two network legs run here in the webview, not in Rust: GET {core}/api/health and a JSON-RPC
 * `tools/list` against the MCP endpoint. Knowledge Core answers CORS with the configured origin and
 * the native layer deliberately carries no HTTP/TLS stack in V1 (`ConnectionProbeOut::network_from`
 * documents this split).
 */

export type ConnectionPhase = 'idle' | 'checking' | 'reachable' | 'degraded' | 'unreachable';

export interface ConnectionVerdict {
  readonly phase: Exclude<ConnectionPhase, 'idle' | 'checking'>;
  /** Honest one-line reason; never includes the token value. */
  readonly detail: string;
}

export interface ProbeInput {
  readonly coreOk: boolean;
  readonly mcpOk: boolean;
  readonly coreStatus?: number;
  readonly mcpDetail?: string;
}

/** Pure classification, so the tests pin the verdict table without any network. */
export function classifyProbe(input: ProbeInput): ConnectionVerdict {
  if (!input.coreOk) {
    return {
      phase: 'unreachable',
      detail: `Knowledge Core 不可达（GET /api/health${input.coreStatus === undefined ? '' : ` 返回 ${String(input.coreStatus)}`}）。`,
    };
  }
  if (!input.mcpOk) {
    return {
      phase: 'degraded',
      detail: `Core 在线，但 MCP endpoint 未通过 tools/list 验证：${input.mcpDetail ?? '未知原因'}`,
    };
  }
  return { phase: 'reachable', detail: 'Core 在线，MCP tools/list 通过。' };
}

function authHeaders(token: string): Record<string, string> {
  return token.trim() === '' ? {} : { Authorization: `Bearer ${token.trim()}` };
}

/** Leg 1: the core's public health endpoint. */
export async function probeCore(baseUrl: string): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, { method: 'GET' });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Leg 2: a real MCP client handshake — initialize is stateless per POST, then tools/list. */
export async function probeMcpTools(endpoint: string, token: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...authHeaders(token),
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${String(response.status)}` };
    const payload: unknown = await response.json();
    const result = (payload as { result?: unknown }).result;
    const tools = (result as { tools?: unknown }).tools;
    if (Array.isArray(tools) && tools.length > 0) return { ok: true };
    return { ok: false, detail: 'tools/list 返回为空' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : '网络错误' };
  }
}

export interface ProbeResult extends ConnectionVerdict {
  readonly checkedAt: string;
}

export async function runConnectionProbe(
  coreBaseUrl: string,
  mcpEndpoint: string,
  token: string,
): Promise<ProbeResult> {
  const core = await probeCore(coreBaseUrl);
  const mcp = core.ok ? await probeMcpTools(mcpEndpoint, token) : { ok: false, detail: '未执行：Core 不可达' };
  const verdict = classifyProbe({ coreOk: core.ok, coreStatus: core.status, mcpOk: mcp.ok, mcpDetail: mcp.detail });
  return { ...verdict, checkedAt: new Date().toISOString() };
}
