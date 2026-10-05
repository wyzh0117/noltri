/**
 * Desktop capture contract: whatever the pill or paste window sends must be a valid CaptureRequest
 * (client "desktop"), and — like the architecture gate requires for all four clients — it may never
 * carry a user identity field.
 */
import { describe, expect, it } from 'vitest';
import { buildCaptureRequest } from '@noltri/api-client';
import { captureRequestSchema } from '@noltri/schema';
import { runCaptureFlow } from '../src/lib/capture-flow';
import type { CaptureFlowConfig } from '../src/lib/capture-flow';

const LONG_TEXT = '卡片笔记法的核心是用自己的话重写，让每张卡片只承载一个想法，便于未来重组。'.repeat(2);

function desktopRequest(input: { text: string; appName?: string }) {
  return buildCaptureRequest({
    text: input.text,
    client: 'desktop',
    source: {
      type: 'desktop_app',
      ...(input.appName ? { appName: input.appName } : {}),
    },
  });
}

describe('desktop capture request contract', () => {
  it('builds a schema-valid CaptureRequest with client "desktop"', () => {
    const request = desktopRequest({ text: LONG_TEXT, appName: 'Safari' });
    const parsed = captureRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    expect(request.capture.client).toBe('desktop');
    expect(request.source.type).toBe('desktop_app');
  });

  it('carries no user identity fields anywhere in the payload', () => {
    const request = desktopRequest({ text: LONG_TEXT, appName: 'Notes' }) as unknown as Record<string, unknown>;
    const keys = JSON.stringify(request);
    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('user_id');
  });

  it('rejects text shorter than the frozen minimum before any network call', async () => {
    const calls: string[] = [];
    const config: CaptureFlowConfig = {
      apiBaseUrl: 'http://127.0.0.1:9',
      apiToken: '',
    };
    const outcome = await runCaptureFlow(config, { text: '太短', appName: 'X', via: 'pill' });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('捕获契约');
    expect(calls).toHaveLength(0);
  });

  it('reports a failed provider run as preserved-raw, not success', async () => {
    const { createServer } = await import('node:http');
    type ServerWithClose = import('node:http').Server;
    const server: ServerWithClose = createServer((req, res) => {
      if (req.method === 'POST' && (req.url ?? '').startsWith('/api/capture')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            rawSourceId: 'raw-1',
            requestId: 'req-desktop-contract-00',
            stage: 'failed',
            duplicate: false,
            items: [],
            processingStatus: 'failed',
            errorReason: 'provider 超时',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found' } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const outcome = await runCaptureFlow(
        { apiBaseUrl: `http://127.0.0.1:${String(port)}`, apiToken: '' },
        { text: LONG_TEXT, appName: 'Notes', via: 'paste' },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('原文已保存');
      expect(outcome.message).toContain('provider 超时');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('surfaces the placement path on success', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.method === 'POST' && (req.url ?? '').startsWith('/api/capture')) {
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          const body = JSON.parse(raw) as { capture?: { client?: string } };
          expect(body.capture?.client).toBe('desktop');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              rawSourceId: 'raw-2',
              requestId: 'req-desktop-contract-01',
              stage: 'completed',
              duplicate: false,
              processingStatus: 'done',
              items: [
                {
                  knowledgeItemId: 'item-1',
                  text: LONG_TEXT,
                  nodeId: 'node-1',
                  nodePath: ['个人管理', '卡片笔记法'],
                  action: 'attached',
                  confidence: 0.9,
                  confidenceTier: 'high',
                },
              ],
            }),
          );
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found' } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const outcome = await runCaptureFlow(
        { apiBaseUrl: `http://127.0.0.1:${String(port)}`, apiToken: '' },
        { text: LONG_TEXT, appName: 'Notes', via: 'paste' },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.path).toEqual(['个人管理', '卡片笔记法']);
      expect(outcome.message).toContain('个人管理 / 卡片笔记法');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
