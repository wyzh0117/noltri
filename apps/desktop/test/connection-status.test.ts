import { afterEach, describe, expect, it } from 'vitest';
import { classifyProbe, probeCore, probeMcpTools, runConnectionProbe } from '../src/lib/connection-status';

describe('connection verdict table (pure)', () => {
  it('unreachable when the core health leg fails', () => {
    const verdict = classifyProbe({ coreOk: false, coreStatus: 0, mcpOk: false });
    expect(verdict.phase).toBe('unreachable');
    expect(verdict.detail).toContain('/api/health');
  });

  it('degraded when the core is up but tools/list fails', () => {
    const verdict = classifyProbe({ coreOk: true, mcpOk: false, mcpDetail: 'HTTP 401' });
    expect(verdict.phase).toBe('degraded');
    expect(verdict.detail).toContain('HTTP 401');
  });

  it('reachable only when both legs pass', () => {
    expect(classifyProbe({ coreOk: true, mcpOk: true }).phase).toBe('reachable');
  });
});

describe('live probe legs', () => {
  const servers: { close(): Promise<void>; port: number }[] = [];
  const { createServer } = require('node:http') as typeof import('node:http');

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
    const server = createServer(handler);
    servers.push({
      port: 0,
      close: () =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => resolveClose());
        }),
    });
    return new Promise((resolveListen) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        servers[servers.length - 1]!.port = port;
        resolveListen(port);
      });
    });
  }

  it('probeCore succeeds on 2xx and fails on network errors', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    const ok = await probeCore(`http://127.0.0.1:${String(port)}`);
    expect(ok.ok).toBe(true);

    const down = await probeCore('http://127.0.0.1:9');
    expect(down.ok).toBe(false);
  });

  it('probeMcpTools requires a non-empty tools array', async () => {
    const port = await listen((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as { method: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body.method === 'tools/list') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, { name: 'b' }] } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        }
      });
    });
    const ok = await probeMcpTools(`http://127.0.0.1:${String(port)}/mcp`, '');
    expect(ok.ok).toBe(true);

    const portEmpty = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    });
    const empty = await probeMcpTools(`http://127.0.0.1:${String(portEmpty)}/mcp`, '');
    expect(empty.ok).toBe(false);
  });

  it('runConnectionProbe against the real running shape: healthy core + tools', async () => {
    const port = await listen((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/api/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'capture_knowledge' }] } }));
      });
    });
    const result = await runConnectionProbe(`http://127.0.0.1:${String(port)}`, `http://127.0.0.1:${String(port)}/mcp`, '');
    expect(result.phase).toBe('reachable');
    expect(result.checkedAt).toBeTruthy();
  });

  it('runConnectionProbe reports degraded when the MCP leg 401s', async () => {
    const port = await listen((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/api/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized' } }));
    });
    const result = await runConnectionProbe(`http://127.0.0.1:${String(port)}`, `http://127.0.0.1:${String(port)}/mcp`, 'wrong');
    expect(result.phase).toBe('degraded');
    expect(result.detail).toContain('401');
  });
});
