import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CORE_PROTOCOL_VERSION, type HealthResponse } from '@noltri/schema';
import { fixtureHealth, startFakeKnowledgeCore, type FakeCore } from './fake-core';
import { createStdioServer, type StdioOutcome } from '../src/stdio';
import { loadMcpConfig } from '../src';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const STIO_ENTRY = resolve(PACKAGE_ROOT, 'src', 'stdio.ts');

function servedWith(health: HealthResponse): Promise<{ outcome: StdioOutcome; lines: string[] }> {
  const lines: string[] = [];
  return createStdioServer({
    env: { KNOWLEDGE_API_URL: 'http://127.0.0.1:9', MCP_VERSION: '0.1.0' },
    log: (line) => lines.push(line),
    probeHealth: async () => health,
    attach: async () => undefined,
  })
    .serve()
    .then((outcome) => ({ outcome, lines }));
}

describe('the stdio entry refuses before it advertises tools (§7.6, §11)', () => {
  it('uses the local Core default when the configured address is empty', async () => {
    const lines: string[] = [];
    let probed = 0;
    const outcome = await createStdioServer({
      env: { KNOWLEDGE_API_URL: '' },
      log: (line) => lines.push(line),
      probeHealth: async () => {
        probed += 1;
        return fixtureHealth;
      },
      attach: async () => undefined,
    }).serve();
    expect(outcome).toMatchObject({ served: true });
    expect(probed).toBe(1);
    expect(lines.join('\n')).toContain('serving over stdio');
    expect(loadMcpConfig({ KNOWLEDGE_API_URL: ' ' }).apiBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('retries a cold Core briefly before serving', async () => {
    let probed = 0;
    const outcome = await createStdioServer({
      env: { KNOWLEDGE_API_URL: 'http://127.0.0.1:8787' },
      startupRetryMs: 300,
      probeHealth: async () => {
        probed += 1;
        if (probed === 1) throw new Error('ECONNREFUSED');
        return fixtureHealth;
      },
      attach: async () => undefined,
    }).serve();
    expect(outcome).toMatchObject({ served: true });
    expect(probed).toBe(2);
  });

  it('refuses when the port does not answer as a Core at all', async () => {
    const lines: string[] = [];
    const outcome = await createStdioServer({
      env: { KNOWLEDGE_API_URL: 'http://127.0.0.1:9' },
      log: (line) => lines.push(line),
      probeHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
      attach: async () => undefined,
    }).serve();
    expect(outcome).toMatchObject({ served: false, reason: 'core_unreachable' });
    expect(lines.join('\n')).toContain('refusing to serve');
  });

  it('refuses a different local service that answers with JSON on the same port', async () => {
    const { outcome } = await servedWith({ ...fixtureHealth, productId: 'some-other-local-server' });
    expect(outcome).toMatchObject({ served: false, reason: 'not_noltri_core' });
  });

  it('refuses a Core speaking a protocol this entry does not understand', async () => {
    const { outcome } = await servedWith({ ...fixtureHealth, protocolVersion: '2' });
    expect(outcome).toMatchObject({ served: false, reason: 'protocol_mismatch' });
    if (outcome.served) throw new Error('unreachable');
    expect(outcome.detail).toContain(CORE_PROTOCOL_VERSION);
  });

  it('serves the library tools once the Core has identified itself, and says so on the log channel only', async () => {
    const { outcome, lines } = await servedWith(fixtureHealth);
    expect(outcome).toEqual({ served: true, core: { version: fixtureHealth.version, instanceId: fixtureHealth.instanceId } });
    expect(lines.join('\n')).toContain('serving over stdio');
  });
});

describe('stdio over a real spawned process, against the frozen HTTP contract', () => {
  let core: FakeCore;

  beforeAll(async () => {
    core = await startFakeKnowledgeCore();
  });

  afterAll(async () => {
    await core.close();
  });

  function transportFor(env: Record<string, string>, stderr: 'pipe' | 'inherit'): StdioClientTransport {
    return new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', STIO_ENTRY],
      cwd: PACKAGE_ROOT,
      env: { ...getDefaultEnvironment(), ...env },
      stderr,
    });
  }

  it('initialize → tools/list → tools/call, with the token forwarded to the Core', async () => {
    const client = new Client({ name: 'stdio-e2e-client', version: '0.1.0' }, { capabilities: {} });
    const transport = transportFor(
      { KNOWLEDGE_API_URL: core.url, NOLTRI_ACCESS_TOKEN: 'stdio-token-2f6b', AUTH_REQUIRED: 'true' },
      'pipe',
    );
    const captured: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => captured.push(String(chunk)));

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toHaveLength(6);

      const result = await client.callTool({
        name: 'save_knowledge',
        arguments: {
          content: 'stdio 通道实测：知识一旦离开本机就要按不可信内容处理。',
          kind: 'knowledge',
          source: { type: 'agent', appName: 'stdio-e2e-client', title: 'P4-A' },
        },
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { item?: { id?: string; kind?: string } };
      expect(typeof structured.item?.id).toBe('string');

      const forwarded = core.calls.filter((call) => call.method === 'POST' && call.path === '/api/items');
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.authorization).toBe('Bearer stdio-token-2f6b');

      const stderrText = captured.join('');
      expect(stderrText).toContain('serving over stdio');
      expect(stderrText).not.toContain('stdio-token-2f6b');
    } finally {
      await client.close();
    }
  });

  it('exits with a refusal instead of pretending a foreign port is the Core', async () => {
    const client = new Client({ name: 'stdio-refuse-client', version: '0.1.0' }, { capabilities: {} });
    const transport = transportFor({ KNOWLEDGE_API_URL: 'http://127.0.0.1:9', NOLTRI_ACCESS_TOKEN: '', MCP_CORE_STARTUP_TIMEOUT_MS: '0' }, 'inherit');
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
