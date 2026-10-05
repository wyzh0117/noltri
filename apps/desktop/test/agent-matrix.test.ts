import { describe, expect, it } from 'vitest';
import {
  SUPPORT_LABELS,
  UNKNOWN_SUPPORT_LABEL,
  agentRows,
  canWriteConfig,
  hasOfficialEntry,
  isVerified,
  supportLabel,
} from '../src/lib/agent-matrix';
import type { TargetFacts } from '../src/lib/types';

function facts(patch: Partial<TargetFacts> = {}): TargetFacts {
  return {
    target: 'claude_desktop',
    label: 'Claude Desktop',
    serverName: 'noltri',
    configPath: '/Users/tester/Library/Application Support/Claude/claude_desktop_config.json',
    configPathExists: true,
    writeSupported: true,
    supportState: 'writable',
    officialSettingsUrl: 'https://example.test/settings',
    docsUrl: 'https://example.test/docs',
    guidance: '写入后需要重启客户端。',
    installedApps: ['/Applications/Claude.app'],
    appPath: '/Applications/Claude.app',
    appVersion: '1.2.3',
    endpoint: 'http://127.0.0.1:8790/mcp',
    coreBaseUrl: 'http://127.0.0.1:8787',
    tokenConfigured: true,
    ...patch,
  };
}

describe('agent support matrix (M01 / M06)', () => {
  it('labels the three registered states and nothing else', () => {
    expect(supportLabel('writable')).toBe(SUPPORT_LABELS['writable']);
    expect(supportLabel('guided')).toBe(SUPPORT_LABELS['guided']);
    expect(supportLabel('unverified')).toBe(SUPPORT_LABELS['unverified']);
    expect(Object.keys(SUPPORT_LABELS)).toEqual(['writable', 'guided', 'unverified']);
  });

  /// M06: a state the UI has never heard of must not read as support.
  it('degrades an unknown state to 未验证 instead of claiming support', () => {
    expect(supportLabel('auto_connected')).toBe(UNKNOWN_SUPPORT_LABEL);
    expect(supportLabel('')).toBe(UNKNOWN_SUPPORT_LABEL);
    expect(isVerified('auto_connected')).toBe(false);
    expect(isVerified('writable')).toBe(true);
    expect(isVerified('unverified')).toBe(false);
  });

  it('offers the write button only for a verified, writable target with a real path', () => {
    expect(canWriteConfig(facts())).toBe(true);
    expect(canWriteConfig(facts({ supportState: 'unverified', writeSupported: false }))).toBe(false);
    expect(canWriteConfig(facts({ configPath: null }))).toBe(false);
    expect(canWriteConfig(facts({ writeSupported: false }))).toBe(false);
  });

  it('hides official-entry buttons when there is no verified URL rather than inventing one', () => {
    expect(hasOfficialEntry(facts())).toBe(true);
    expect(hasOfficialEntry(facts({ officialSettingsUrl: null, docsUrl: 'https://example.test/docs' }))).toBe(true);
    expect(hasOfficialEntry(facts({ officialSettingsUrl: null, docsUrl: null }))).toBe(false);
  });

  it('tells detection, version and the unverified state apart for an agent we can see but have not tested', () => {
    const rows = agentRows(
      facts({
        target: 'qoder',
        supportState: 'unverified',
        writeSupported: false,
        configPath: null,
        officialSettingsUrl: null,
        docsUrl: null,
        appVersion: null,
      }),
    );
    const byTerm = new Map(rows.map((row) => [row.term, row.value]));
    expect(byTerm.get('检测')).toBe('已检测到 1 个安装');
    expect(byTerm.get('版本')).toBe('版本未知');
    expect(byTerm.get('支持状态')).toBe(UNKNOWN_SUPPORT_LABEL);
    expect(byTerm.get('配置范围')).toBe('该客户端不由本应用读写配置文件');
    expect(byTerm.get('连接方式')).toContain('http://127.0.0.1:8787');
  });

  it('reports an absent agent without a version row that implies one', () => {
    const rows = new Map(agentRows(facts({ installedApps: [], appPath: null, appVersion: null })).map((row) => [row.term, row.value]));
    expect(rows.get('检测')).toBe('未在本机检测到');
    expect(rows.get('版本')).toBe('—');
  });

  it('states honestly whether a token is in play', () => {
    const withToken = new Map(agentRows(facts()).map((row) => [row.term, row.value]));
    expect(withToken.get('权限')).toContain('携带本机令牌');
    const without = new Map(agentRows(facts({ tokenConfigured: false })).map((row) => [row.term, row.value]));
    expect(without.get('权限')).toContain('未配置令牌');
  });
});
