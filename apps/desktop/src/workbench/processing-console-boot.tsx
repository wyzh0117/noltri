import { ApiClient } from '@noltri/api-client';
import { commands, createProcessingConsoleCommands, type ProcessingConsoleBootstrap } from '../lib/tauri';
import { ProcessingConsole, RuntimeDiagnosticsPanel, type ProcessingConsoleApi } from './ProcessingConsole';

export type DesktopSession = { role: 'main' } | { role: 'processing-console'; api: ProcessingConsoleApi | null };
function createConsoleApi(endpoint: ProcessingConsoleBootstrap): ProcessingConsoleApi {
  const client = new ApiClient({ baseUrl: endpoint.apiBaseUrl, token: endpoint.apiToken, clientHint: 'desktop' });
  return {
    processingRules: () => client.processingRules(),
    saveProcessingRulesDraft: request => client.saveProcessingRulesDraft(request),
    applyProcessingRules: request => client.applyProcessingRules(request),
    rollbackProcessingRules: request => client.rollbackProcessingRules(request),
    processingRecords: () => client.processingRecords(),
  };
}
export async function loadDesktopSession(
  native: boolean,
  ipc = createProcessingConsoleCommands(),
  makeApi: (endpoint: ProcessingConsoleBootstrap) => ProcessingConsoleApi = createConsoleApi,
): Promise<DesktopSession> {
  if (!native) return { role: 'main' };
  // URL/search parameters are not consulted: only native identity selects the window role.
  const role = await ipc.role();
  if (role === 'main') return { role };
  if (role !== 'processing-console') throw Error('unsupported_window');
  let endpoint: ProcessingConsoleBootstrap;
  try { endpoint = await ipc.bootstrap(); }
  catch { return { role, api: null }; }
  return { role, api: makeApi(endpoint) };
}
export function ConsoleBootView({ api }: { api: ProcessingConsoleApi | null }) {
  if (api === null) return <main className="processing-console" aria-label="本机运行状态"><h1>本机运行状态</h1><p role="status">Core 服务尚未就绪，规则与处理记录暂不可用。</p><RuntimeDiagnosticsPanel getRuntimeDiagnostics={commands.getRuntimeDiagnostics}/></main>;
  return <ProcessingConsole api={api} getRuntimeDiagnostics={commands.getRuntimeDiagnostics}/>;
}
