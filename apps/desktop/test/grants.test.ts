/**
 * 连接中心's credential decisions (M01 明确授权 / M02 幂等 / M04 撤销). These are the rules that decide
 * which key leaves this app into a file the project does not control, so they are tested as pure data
 * rather than by clicking through a webview.
 */
import { describe, expect, it } from 'vitest';
import { ApiClientError, type IssueGrantResponse, type PublicGrant } from '@noltri/api-client';
import type { TargetFacts } from '../src/lib/types';
import {
  AGENT_SCOPES,
  classifyMintFailure,
  credentialFromMint,
  currentGrant,
  describeGrant,
  grantClientOptions,
  grantLabelFor,
  supersededGrants,
} from '../src/lib/grants';

function facts(patch: Partial<TargetFacts> = {}): TargetFacts {
  return {
    target: 'claude_desktop',
    label: 'Claude Desktop',
    serverName: 'noltri',
    configPath: '/Users/tester/Library/Application Support/Claude/claude_desktop_config.json',
    configPathExists: true,
    writeSupported: true,
    supportState: 'writable',
    officialSettingsUrl: null,
    docsUrl: null,
    guidance: '写入后需要重启客户端。',
    installedApps: [],
    appPath: null,
    appVersion: null,
    endpoint: 'http://127.0.0.1:8790/mcp',
    coreBaseUrl: 'http://127.0.0.1:8787',
    tokenConfigured: true,
    ...patch,
  };
}

function grantOf(patch: Partial<PublicGrant> = {}): PublicGrant {
  return {
    id: 'grant-1',
    label: '知序 · Claude Desktop',
    client: 'claude_desktop',
    scopes: ['capture', 'read'],
    nodeIds: null,
    createdAt: '2026-10-05T08:00:00.000Z',
    revokedAt: null,
    ...patch,
  };
}

function refused(status: number, message: string, details?: unknown): ApiClientError {
  return new ApiClientError(status, 'unauthorized', message, details);
}

describe('grant identity (M02 幂等的键)', () => {
  it('labels the grant by the target it belongs to', () => {
    expect(grantLabelFor(facts())).toBe('知序 · Claude Desktop');
  });

  it('builds a client against the core base url, not the mcp endpoint', () => {
    expect(grantClientOptions(facts(), '  device-token  ')).toEqual({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'device-token',
      clientHint: 'desktop',
    });
  });

  it('keeps an empty device token out of the request instead of sending a blank bearer', () => {
    expect(grantClientOptions(facts(), '   ')).toEqual({ baseUrl: 'http://127.0.0.1:8787', clientHint: 'desktop' });
  });

  it('offers only the scopes an agent may default to', () => {
    expect([...AGENT_SCOPES]).toEqual(['capture', 'read']);
  });
});

describe('currentGrant / supersededGrants', () => {
  it('picks the newest live grant of the label', () => {
    const older = grantOf({ id: 'grant-old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = grantOf({ id: 'grant-new', createdAt: '2026-03-01T00:00:00.000Z' });
    expect(currentGrant([newer, older], '知序 · Claude Desktop')?.id).toBe('grant-new');
  });

  it('ignores revoked grants and other labels', () => {
    expect(currentGrant([grantOf({ revokedAt: '2026-04-01T00:00:00.000Z' })], '知序 · Claude Desktop')).toBeNull();
    expect(currentGrant([grantOf({ label: '知序 · Cursor' })], '知序 · Claude Desktop')).toBeNull();
  });

  it('hands back everything of the label except the grant just installed', () => {
    const keep = grantOf({ id: 'grant-new' });
    const stale = grantOf({ id: 'grant-old' });
    const other = grantOf({ id: 'grant-cursor', label: '知序 · Cursor' });
    const gone = grantOf({ id: 'grant-gone', revokedAt: '2026-02-01T00:00:00.000Z' });
    expect(supersededGrants([stale, keep, other, gone], '知序 · Claude Desktop', 'grant-new').map((g) => g.id)).toEqual([
      'grant-old',
    ]);
  });
});

describe('describeGrant', () => {
  it('reads as scopes · project reach · liveness, in Chinese labels', () => {
    expect(describeGrant(grantOf())).toBe('采集 + 读取 · 全部项目 · 生效中');
  });

  it('counts the projects a limited grant may see and marks a revoked one', () => {
    expect(describeGrant(grantOf({ nodeIds: ['node-a', 'node-b'], revokedAt: '2026-05-01T00:00:00.000Z' }))).toBe(
      '采集 + 读取 · 2 个项目 · 已撤销',
    );
  });
});

describe('classifyMintFailure', () => {
  it('separates a deployment without grants from a Core that is simply not there', () => {
    expect(classifyMintFailure(refused(409, 'conflict'))).toBe('not-configured');
    expect(classifyMintFailure(new ApiClientError(0, 'internal_error', 'fetch failed'))).toBe('unreachable');
    expect(classifyMintFailure(new Error('boom'))).toBe('unreachable');
  });

  it('recognises the refusal to mint without a device credential', () => {
    expect(
      classifyMintFailure(refused(401, 'no credential', { reason: 'admin_credential_required' })),
    ).toBe('no-device-credential');
  });

  it('treats any other answer as a plain refusal', () => {
    expect(classifyMintFailure(refused(401, 'bad token'))).toBe('refused');
    expect(classifyMintFailure(refused(500, 'boom'))).toBe('refused');
  });
});

describe('credentialFromMint — 什么凭据可以离开这台机器', () => {
  const minted: IssueGrantResponse = {
    grant: grantOf(),
    secret: 'a-fresh-per-client-secret-xyz',
  };

  it('writes the fresh grant secret, never the device token', () => {
    const credential = credentialFromMint({ minted, error: null, deviceToken: 'device-token', label: '知序 · Claude Desktop' });
    expect(credential).toMatchObject({ ok: true, token: 'a-fresh-per-client-secret-xyz', grant: minted.grant });
    if (!credential.ok) throw new Error('unreachable');
    expect(credential.note).toContain('只属于该客户端');
    expect(JSON.stringify(credential)).not.toContain('device-token');
  });

  it('falls back to the device credential only when this Core never enabled 客户端授权, and says so', () => {
    const credential = credentialFromMint({
      minted: null,
      error: refused(409, 'no local authorization store'),
      deviceToken: 'device-token',
      label: '知序 · Claude Desktop',
    });
    expect(credential).toMatchObject({ ok: true, token: 'device-token', grant: null });
    if (!credential.ok) throw new Error('unreachable');
    expect(credential.note).toContain('沿用设备凭据');
  });

  it.each([
    ['no-device-credential', refused(401, 'cannot mint', { reason: 'admin_credential_required' })],
    ['unreachable', new ApiClientError(0, 'internal_error', 'Connection refused')],
    ['refused', refused(403, 'nope')],
  ])('refuses the whole write when the mint fails as %s', (kind, error) => {
    expect(classifyMintFailure(error)).toBe(kind);
    const credential = credentialFromMint({ minted: null, error, deviceToken: 'device-token', label: '知序 · Claude Desktop' });
    expect(credential.ok).toBe(false);
    if (credential.ok) throw new Error('unreachable');
    expect(credential.detail).toContain('没有写入任何配置');
    expect(credential.detail).not.toContain('device-token');
  });
});
