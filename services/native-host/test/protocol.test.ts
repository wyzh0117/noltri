import { describe, expect, it } from 'vitest';
import { forbiddenScope, hostRequestSchema, HOST_PROTOCOL_VERSION, INVALID_REQUEST_MESSAGE, MAX_CAPTURES_PER_MESSAGE, parseHostRequest } from '../src/protocol';
import { captureRequest, SECRET_TEXT } from './fixtures';

function accepted(raw: unknown) {
  const result = parseHostRequest(raw);
  if ('refusal' in result) throw new Error(`expected acceptance, got ${result.refusal.message}`);
  return result.request;
}

function refused(raw: unknown) {
  const result = parseHostRequest(raw);
  if (!('refusal' in result)) throw new Error('expected refusal');
  return result.refusal;
}

describe('host request surface', () => {
  it('accepts the four verbs a collecting extension needs', () => {
    expect(accepted({ type: 'hello' }).type).toBe('hello');
    expect(accepted({ type: 'health' }).type).toBe('health');
    expect(accepted({ type: 'capture', request: captureRequest() }).type).toBe('capture');
    const batch = accepted({ type: 'capture_batch', requests: [captureRequest(), captureRequest({ requestId: 'req-native-host-test-02' })] });
    if (batch.type !== 'capture_batch') throw new Error('unreachable');
    expect(batch.requests).toHaveLength(2);
  });

  it('publishes the protocol version it speaks', () => {
    expect(HOST_PROTOCOL_VERSION).toBe('1');
    expect(MAX_CAPTURES_PER_MESSAGE).toBe(4);
  });

  const FORBIDDEN = [
    'export_all', 'export_library', 'dump_database', 'read_file', 'write_file', 'exec', 'shell',
    'delete_node', 'move_node', 'list_nodes', 'search_knowledge', 'http_request', 'open_url',
    'get_credentials', 'set_token', 'install', 'uninstall', 'model_run', 'prompt_injection',
  ];

  it.each(FORBIDDEN)('refuses the verb %s — the host has no such capability', (type) => {
    const refusal = refused({ type, target: '全库', command: 'rm -rf /' });
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe('forbidden_scope');
    expect(refusal.retryable).toBe(false);
    expect(refusal.message).toContain('只接受采集与健康检查');
  });

  it('refuses a batch larger than the cap, so one message cannot become a dump', () => {
    const requests = Array.from({ length: MAX_CAPTURES_PER_MESSAGE + 1 }, (_unused, index) =>
      captureRequest({ requestId: `req-batch-${String(index).padStart(2, '0')}-------` }),
    );
    expect(refused({ type: 'capture_batch', requests }).code).toBe('invalid_request');
    expect(refused({ type: 'capture_batch', requests: [] }).code).toBe('invalid_request');
  });

  it('refuses a malformed capture before it could reach the Core', () => {
    expect(refused({ type: 'capture', request: captureRequest({ text: '太短' }) }).code).toBe('invalid_request');
    expect(refused({ type: 'capture', request: captureRequest({ requestId: 'short' }) }).code).toBe('invalid_request');
    expect(refused({ type: 'capture' }).code).toBe('invalid_request');
  });

  it('tells a rule violation apart from a capability the host never has (§7.5)', () => {
    const overCap = refused({ type: 'capture_batch', requests: Array.from({ length: 9 }, (_u, i) => captureRequest({ requestId: `req-cap-${String(i)}---------` })) });
    const wrongVerb = refused({ type: 'export_all' });

    expect(overCap.message).toBe(INVALID_REQUEST_MESSAGE);
    expect(overCap.message).toContain('最多 4 条');
    expect(wrongVerb.code).toBe('forbidden_scope');
    expect(overCap.code).not.toBe(wrongVerb.code);
    expect(JSON.stringify([overCap, wrongVerb])).not.toContain(SECRET_TEXT);
  });

  it.each([undefined, null, 'capture', 42, [], true])('refuses a non-object frame (%s)', (raw) => {
    expect(refused(raw).code).toBe('forbidden_scope');
  });

  it('never echoes the payload of a refused message, because it can hold the user selection', () => {
    const refusal = refused({
      type: 'export_all',
      text: SECRET_TEXT,
      surroundingContext: SECRET_TEXT,
      note: `含机密：${SECRET_TEXT}`,
    });
    const rendered = JSON.stringify(refusal);
    expect(rendered).not.toContain(SECRET_TEXT);
    expect(rendered).not.toContain('机密');
  });

  it('names a well-formed verb but refuses to quote a hostile one', () => {
    expect(forbiddenScope({ type: 'export_all' }).message).toContain('export_all');

    const hostile = { type: `token\u0000${'x'.repeat(400)}\n[伪造日志]`, text: SECRET_TEXT };
    const message = forbiddenScope(hostile).message;
    expect(message).not.toContain('伪造日志');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(120);
    expect(message).not.toContain(SECRET_TEXT);
  });

  it('strips unknown fields from an accepted capture body instead of forwarding them', () => {
    const request = accepted({ type: 'capture', request: { ...captureRequest(), command: 'ls', accessToken: 'sk-live-secret' } });
    if (request.type !== 'capture') throw new Error('unreachable');
    expect(Object.keys(request.request)).not.toContain('command');
    expect(JSON.stringify(request.request)).not.toContain('sk-live-secret');
    expect(request.request.requestId).toBe('req-native-host-test-01');
  });
});
