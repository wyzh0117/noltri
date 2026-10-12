/**
 * 连接中心's three calls, checked at the seam the desktop uses: the URL, the payload validation before
 * anything leaves, and the one field that must survive the round trip — a secret the server shows once.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError, apiRoutes, type IssueGrantRequest } from '../src/client';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(response: { status: number; payload: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(response.payload), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function clientFor(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({ baseUrl: 'http://127.0.0.1:8787/', token: 'device-token', clientHint: 'desktop', fetchImpl });
}

const GRANT = {
  id: 'grant-1',
  label: 'Claude Desktop',
  client: 'claude',
  scopes: ['capture', 'read'],
  nodeIds: null,
  createdAt: '2026-10-05T08:00:00.000Z',
  revokedAt: null,
} as const;

/** The shape a real one is: 32 random bytes, base64url. The contract refuses anything shorter. */
const SECRET = 'dGVzdC1zZWNyZXQtdGhhdC1sb29rcy1saWtlLWEtcmVhbC1vbmU';

describe('ApiClient grant calls', () => {
  it('lists connections with the device bearer and no credential material', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { grants: [GRANT] } });
    const grants = await clientFor(fetchImpl).grants();

    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.grants}`);
    expect(calls[0]?.headers.authorization).toBe('Bearer device-token');
    expect(grants[0]?.label).toBe('Claude Desktop');
    // A listing is a screenshot-able surface: its shape carries no credential field at all.
    expect(Object.keys(grants[0] ?? {}).sort()).toEqual(
      ['client', 'createdAt', 'id', 'label', 'nodeIds', 'revokedAt', 'scopes', 'snippetChars'].sort(),
    );
    // The fixture above predates 限制返回片段, so this also proves an older Core still reads as 不限制.
    expect(grants[0]?.snippetChars).toBeNull();
  });

  it('issues a grant and hands the one-time secret through untouched', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { grant: GRANT, secret: SECRET } });
    const request: IssueGrantRequest = { label: 'Claude Desktop', client: 'claude', scopes: ['capture', 'read'] };
    const result = await clientFor(fetchImpl).issueGrant(request);

    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.body))).toEqual(request);
    expect(result.secret).toBe(SECRET);
    expect(result.grant.nodeIds).toBeNull();
  });

  it('keeps a project list when the caller narrows the grant', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { grant: { ...GRANT, nodeIds: ['n1'] }, secret: SECRET } });
    await clientFor(fetchImpl).issueGrant({ label: '只看 Python', scopes: ['read'], nodeIds: ['n1'] });
    expect(JSON.parse(String(calls[0]?.body)).nodeIds).toEqual(['n1']);
  });

  it('sends 限制返回片段 when the panel narrows it, and omits it when it does not', async () => {
    const payload = { grant: { ...GRANT, snippetChars: 200 }, secret: SECRET };
    const { calls, fetchImpl } = stub({ status: 200, payload });
    const client = clientFor(fetchImpl);
    await client.issueGrant({ label: '窄口 Agent', scopes: ['read'], snippetChars: 200 });
    await client.issueGrant({ label: '宽口 Agent', scopes: ['read'] });

    expect(JSON.parse(String(calls[0]?.body)).snippetChars).toBe(200);
    expect('snippetChars' in JSON.parse(String(calls[1]?.body))).toBe(false);
  });

  /** A half-built grant must not reach the network: it would mint a credential nobody intended. */
  const refused: readonly (readonly [string, unknown])[] = [
    ['an empty label', { label: '', scopes: ['read'] }],
    ['no scope', { label: 'x', scopes: [] }],
    ['an unknown scope', { label: 'x', scopes: ['everything'] }],
    ['an empty project list', { label: 'x', scopes: ['read'], nodeIds: [] }],
    // 限制返回片段 below the floor would return nothing readable; the panel offers a whole-document cap.
    ['a snippet cap too small to be useful', { label: 'x', scopes: ['read'], snippetChars: 4 }],
    ['a snippet cap bigger than a document', { label: 'x', scopes: ['read'], snippetChars: 90_000 }],
  ];
  it.each(refused)('refuses %s before sending', (_name, payload) => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { grant: GRANT, secret: SECRET } });
    expect(() => clientFor(fetchImpl).issueGrant(payload as IssueGrantRequest)).toThrowError(ApiClientError);
    expect(calls).toEqual([]);
  });

  it('revokes by id and reports the record that is now dead', async () => {
    const { calls, fetchImpl } = stub({ status: 200, payload: { grant: { ...GRANT, revokedAt: '2026-10-05T09:00:00.000Z' } } });
    const revoked = await clientFor(fetchImpl).revokeGrant('grant 1');

    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${apiRoutes.grantRevoke('grant 1')}`);
    expect(revoked.revokedAt).toBe('2026-10-05T09:00:00.000Z');
  });

  it('passes the server reason through, so the panel can tell 未启用 from 未授权', async () => {
    const { fetchImpl } = stub({
      status: 409,
      payload: { error: { code: 'conflict', message: '本机未启用客户端授权', retryable: false } },
    });
    const error = await clientFor(fetchImpl).grants().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(409);
    expect((error as ApiClientError).code).toBe('conflict');
    expect((error as ApiClientError).retryable).toBe(false);
  });
});
