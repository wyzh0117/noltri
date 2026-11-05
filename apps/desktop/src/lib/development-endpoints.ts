export interface DevelopmentEndpointEnvironment {
  readonly VITE_NOLTRI_CORE_URL?: string;
  readonly VITE_NOLTRI_MCP_URL?: string;
}

/** Browser-only development defaults; packaged endpoints come from native settings. */
export function readDevelopmentEndpoints(env: DevelopmentEndpointEnvironment): { apiBaseUrl: string; mcpEndpoint: string } {
  return {
    apiBaseUrl: env.VITE_NOLTRI_CORE_URL ?? 'http://localhost:18887',
    mcpEndpoint: env.VITE_NOLTRI_MCP_URL ?? 'http://127.0.0.1:18890/mcp',
  };
}
