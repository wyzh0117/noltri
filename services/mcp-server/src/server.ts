import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '@noltri/api-client';
import { registerKnowledgeTools } from './tools';

export const MCP_SERVER_NAME = 'noltri-knowledge';

export interface KnowledgeMcpConfig {
  readonly version: string;
}

export interface BuildServerOptions {
  readonly apiClient: ApiClient;
  readonly config: KnowledgeMcpConfig;
}

/**
 * The MCP layer is an interface, not a data warehouse: all knowledge logic stays in
 * Knowledge Core and is reached over HTTP through the ApiClient it is given here.
 */
export function buildServer({ apiClient, config }: BuildServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: config.version },
    { capabilities: { tools: {} } },
  );
  registerKnowledgeTools(server, { api: apiClient });
  return server;
}

