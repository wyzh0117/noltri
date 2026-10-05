import type { TargetFacts } from './types';

/**
 * The Agent support matrix as a view model (V1 §11, M01 / M06).
 *
 * The native layer already returns an explicit `supportState`; this module only turns it into Chinese
 * labels and rows, and its one real rule is that an unrecognised state degrades to 未验证 rather than
 * to 已支持. A matrix that guesses on a new value would eventually tell a user some Agent was connected
 * when nothing was ever verified against it.
 */

export const SUPPORT_LABELS: Readonly<Record<string, string>> = {
  writable: '可代写配置',
  guided: '仅引导，本应用不代写',
  unverified: '未验证：需人工配置',
};

export const UNKNOWN_SUPPORT_LABEL = '未验证：需人工配置';

export function supportLabel(supportState: string): string {
  return SUPPORT_LABELS[supportState] ?? UNKNOWN_SUPPORT_LABEL;
}

export function isVerified(supportState: string): boolean {
  return supportState === 'writable' || supportState === 'guided';
}

/** Writing is offered only when the state says so *and* there is a verified path to write to. */
export function canWriteConfig(facts: Pick<TargetFacts, 'supportState' | 'writeSupported' | 'configPath'>): boolean {
  return facts.supportState === 'writable' && facts.writeSupported && facts.configPath !== null;
}

export function hasOfficialEntry(facts: Pick<TargetFacts, 'officialSettingsUrl' | 'docsUrl'>): boolean {
  return facts.officialSettingsUrl !== null || facts.docsUrl !== null;
}

export interface AgentRow {
  readonly term: string;
  readonly value: string;
}

export function agentRows(facts: TargetFacts): readonly AgentRow[] {
  const detected = facts.installedApps.length > 0;
  return [
    {
      term: '检测',
      value: detected ? `已检测到 ${facts.installedApps.length} 个安装` : '未在本机检测到',
    },
    { term: '版本', value: facts.appVersion ?? (detected ? '版本未知' : '—') },
    { term: '支持状态', value: supportLabel(facts.supportState) },
    {
      term: '配置范围',
      value: facts.configPath ?? '该客户端不由本应用读写配置文件',
    },
    {
      term: '连接方式',
      value: `${facts.endpoint}（Streamable HTTP）→ 本机 Core ${facts.coreBaseUrl}`,
    },
    {
      term: '权限',
      value: facts.tokenConfigured
        ? '携带本机令牌，工具侧只有采集与检索等既有能力'
        : '未配置令牌，本机 Core 按开放模式处理',
    },
  ];
}
