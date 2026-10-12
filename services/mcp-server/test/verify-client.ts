/**
 * Live proof that a real MCP client can talk to this server over HTTP:
 * start the MCP app (pointing at a running Knowledge Core), connect with the SDK's
 * StreamableHTTPClientTransport, then initialize → tools/list → tools/call.
 *
 * Usage: KNOWLEDGE_API_URL=http://127.0.0.1:8787 [NOLTRI_ACCESS_TOKEN=...] pnpm verify
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { silentLogger, type Logger } from '@noltri/shared';
import { createMcpApp, loadMcpConfig, type McpHttpConfig } from '../src/index';

const CAPTURE_TEXT = 'Qoder 会话中验证 MCP 通道：艾宾浩斯遗忘曲线表明，间隔重复比集中复习更能巩固长期记忆。';

function step(label: string): void {
  process.stdout.write(`\n== ${label} ==\n`);
}

async function main(): Promise<void> {
  const log: Logger = silentLogger;
  const env: Record<string, string> = {};
  for (const key of ['KNOWLEDGE_API_URL', 'NOLTRI_ACCESS_TOKEN', 'AUTH_REQUIRED', 'MCP_VERSION']) {
    if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  }
  if (env['KNOWLEDGE_API_URL'] === undefined) {
    env['KNOWLEDGE_API_URL'] = 'http://127.0.0.1:8787';
  }
  const config: McpHttpConfig = loadMcpConfig(env);
  const app = createMcpApp(config, log);
  await new Promise<void>((resolveListen) => app.listen(0, '127.0.0.1', resolveListen));
  const port = String((app.address() as AddressInfo).port);

  try {
    step('1. connect (Streamable HTTP)');
    const headers: Record<string, string> =
      config.accessToken === '' ? {} : { authorization: `Bearer ${config.accessToken}` };
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers },
    });
    const client = new Client({ name: 'noltri-verify-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    console.log('initialize completed over POST /mcp');

    step('2. tools/list');
    const listed = await client.listTools();
    console.log(listed.tools.map((tool) => tool.name).join(', '));
    if (listed.tools.length !== 6) throw new Error(`expected 6 tools, got ${String(listed.tools.length)}`);

    step('3. tools/call save_knowledge');
    const capture = await client.callTool({
      name: 'save_knowledge',
      arguments: {
        content: CAPTURE_TEXT,
        kind: 'knowledge',
        source: { type: 'agent', appName: 'verify-client', title: 'MCP 通道验证' },
      },
    });
    if (capture.isError === true) {
      throw new Error(`save_knowledge failed: ${JSON.stringify(capture.content)}`);
    }
    console.log(JSON.stringify(capture.structuredContent, null, 2));

    step('4. tools/call get_knowledge_tree');
    const tree = await client.callTool({ name: 'get_knowledge_tree', arguments: {} });
    if (tree.isError === true) throw new Error(`get_knowledge_tree failed: ${JSON.stringify(tree.content)}`);
    const structured = tree.structuredContent as { totalNodes?: number } | undefined;
    console.log(`knowledge tree totalNodes=${String(structured?.totalNodes ?? '?')}`);

    await client.close();
    step('RESULT');
    console.log('OK: initialize → tools/list → tools/call(save_knowledge, get_knowledge_tree) over Streamable HTTP');
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolveClose) => app.close(() => resolveClose()));
  }
}

main().catch((error: unknown) => {
  console.error('VERIFY FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
