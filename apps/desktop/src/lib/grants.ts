/**
 * 连接中心's credential decisions (V1 §12 明确授权, §431 默认权限按客户端和项目范围授予, M01/M04).
 *
 * What used to travel into a third-party config file was the device credential: one key that can do
 * everything, copied into an application this project does not control, and revocable only by editing
 * our own settings. A config write now mints a per-client grant instead, so 撤销 in this panel stops
 * exactly that Agent on its next request and leaves every other connection alone.
 *
 * Everything that decides is pure, because the alternative is a button whose security behaviour can
 * only be reviewed by clicking it.
 */
import {
  ApiClient,
  ApiClientError,
  MAX_SNIPPET_CHARS,
  MIN_SNIPPET_CHARS,
  type IssueGrantResponse,
  type PublicGrant,
} from '@noltri/api-client';
import type { GrantScope } from '@noltri/api-client';
import type { TreeNode } from '@noltri/schema';
import type { TargetFacts } from './types';

/**
 * An Agent may save what it finds and look things up. `mutate` — renaming, moving, filing — stays a
 * human action in the workbench: §431 gives destructive operations to a person, not to a default.
 */
export const AGENT_SCOPES: readonly GrantScope[] = ['capture', 'read'];

export const SCOPE_LABELS: Readonly<Record<GrantScope, string>> = {
  capture: '采集',
  read: '读取',
  mutate: '修改',
};

/** §435: the authorization screen has to say this, because it is true and the user cannot infer it. */
export const AGENT_PRIVACY_NOTE =
  'MCP 通信在本机，并不保证 Agent 的推理也在本机。若该客户端调用云端模型，工具返回的知识可能随上下文一起离开这台电脑。' +
  '不确定就收窄下面的授权。';

/** `issueGrantRequestSchema` refuses more than this; the panel stops the user before the request does. */
export const MAX_GRANTED_PROJECTS = 100;

/** Re-exported so the input's `min`/`max` are the same numbers the Core will check. */
export { MAX_SNIPPET_CHARS, MIN_SNIPPET_CHARS };

export interface GrantOptions {
  readonly captureOnly: boolean;
  readonly nodeIds: readonly string[];
  /** §435 限制返回片段. `null` = 不限制; a number caps every piece of text that connection reads back. */
  readonly snippetChars: number | null;
}

export const DEFAULT_GRANT_OPTIONS: GrantOptions = { captureOnly: false, nodeIds: [], snippetChars: null };

/**
 * The 限制返回片段 input parsed before anything is minted. Blank means 不限制; anything the Core would
 * refuse is reported here instead of turning a 「已连接」 panel into a silent no-cap grant.
 */
export interface SnippetSetting {
  readonly snippetChars: number | null;
  readonly error: string | null;
}

export function snippetSetting(raw: string): SnippetSetting {
  const text = raw.trim();
  if (text === '') return { snippetChars: null, error: null };
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_SNIPPET_CHARS || value > MAX_SNIPPET_CHARS) {
    return {
      snippetChars: null,
      error: `限制返回片段需要 ${String(MIN_SNIPPET_CHARS)}–${String(MAX_SNIPPET_CHARS)} 之间的整数，当前输入不会生效。`,
    };
  }
  return { snippetChars: value, error: null };
}

export function snippetCharsFor(options: GrantOptions): number | undefined {
  return options.snippetChars === null ? undefined : options.snippetChars;
}

/**
 * 只写采集 lets an Agent save what it finds without reading the library back. `mutate` is never offered:
 * §431 keeps destructive actions with a person.
 */
export function scopesFor(options: GrantOptions): GrantScope[] {
  return options.captureOnly ? ['capture'] : [...AGENT_SCOPES];
}

export function nodeSelectionFor(options: GrantOptions): string[] | undefined {
  return options.nodeIds.length === 0 ? undefined : [...options.nodeIds];
}

/**
 * The combinations Core will refuse at request time, named before the write instead of after. A
 * node-scoped grant cannot capture because auto-classification is what chooses the node (§431).
 */
export function grantOptionConflict(options: GrantOptions): string | null {
  if (options.nodeIds.length === 0) return null;
  if (options.captureOnly) {
    return '「只写采集」与「限制项目」同时勾选时，这个客户端既读不到内容，也写不进被限制的项目。请只保留一项。';
  }
  return (
    '限制项目的授权不能用于自动采集：归类会自行挑选项目，被限制的客户端只能读取与检索。' +
    '要让它也能保存，请放开到全部项目，或在收件箱人工归档它采集的内容。'
  );
}

export interface ProjectOption {
  readonly id: string;
  readonly label: string;
}

/** A flat, path-labelled list of every node — the 限制项目 picker, without a tree widget. */
export function projectOptions(nodes: readonly TreeNode[], trail: readonly string[] = []): ProjectOption[] {
  return nodes.flatMap((node) => {
    const label = [...trail, node.title].join(' / ');
    return [{ id: node.id, label }, ...projectOptions(node.children ?? [], [...trail, node.title])];
  });
}

export function toggleProject(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

/** The panel and the store meet on this string: it is how a connection is recognised again next time. */
export function grantLabelFor(facts: TargetFacts): string {
  return `知序 · ${facts.label}`;
}

export interface GrantClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly clientHint: 'desktop';
}

/** The client is built from the Core's base URL, not the `/mcp` endpoint the Agent itself calls. */
export function grantClientOptions(facts: TargetFacts, bearer: string): GrantClientOptions {
  const token = bearer.trim();
  return { baseUrl: facts.coreBaseUrl, ...(token === '' ? {} : { token }), clientHint: 'desktop' };
}

export function grantClientFor(facts: TargetFacts, bearer: string): ApiClient {
  return new ApiClient(grantClientOptions(facts, bearer));
}

/** Newest live grant carrying this label — the connection currently in force for that client. */
export function currentGrant(grants: readonly PublicGrant[], label: string): PublicGrant | null {
  const live = grants
    .filter((grant) => grant.label === label && grant.revokedAt === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return live.at(-1) ?? null;
}

/** Grants of this label other than the one we just installed: superseded, and owed a revocation. */
export function supersededGrants(grants: readonly PublicGrant[], label: string, keepId: string): PublicGrant[] {
  return grants.filter((grant) => grant.label === label && grant.revokedAt === null && grant.id !== keepId);
}

export function describeGrant(grant: PublicGrant): string {
  const scopes = grant.scopes.map((scope) => SCOPE_LABELS[scope]).join(' + ');
  const projects = grant.nodeIds === null ? '全部项目' : `${String(grant.nodeIds.length)} 个项目`;
  const snippet = grant.snippetChars === null ? '不限制片段' : `单次返回不超过 ${String(grant.snippetChars)} 字`;
  return `${scopes} · ${projects} · ${snippet} · ${grant.revokedAt === null ? '生效中' : '已撤销'}`;
}

export type MintFailure = 'not-configured' | 'no-device-credential' | 'unreachable' | 'refused';

/**
 * Why the Core would not mint. The distinction decides whether a config write may happen at all:
 * a deployment that never turned grants on is a known state, a silent Core is not a licence to write
 * the old all-powerful credential into someone else's config file.
 */
export function classifyMintFailure(error: unknown): MintFailure {
  if (!(error instanceof ApiClientError)) return 'unreachable';
  if (error.status === 0) return 'unreachable';
  if (error.status === 409) return 'not-configured';
  if (error.status === 401 && (error.details as { reason?: unknown } | undefined)?.reason === 'admin_credential_required') {
    return 'no-device-credential';
  }
  return 'refused';
}

export type WriteCredential =
  | {
      readonly ok: true;
      /** What goes into the third-party config: the fresh grant secret, or the device token when grants are off. */
      readonly token: string;
      readonly grant: PublicGrant | null;
      /** Shown in the panel and in the write confirmation, so the user knows which key left the machine. */
      readonly note: string;
    }
  | { readonly ok: false; readonly detail: string };

export interface MintInput {
  readonly minted: IssueGrantResponse | null;
  readonly error: unknown;
  readonly deviceToken: string;
  readonly label: string;
}

/**
 * The one place that decides whether a credential may leave this app. Only a deployment that has
 * deliberately not enabled 客户端授权 may keep using the device token, and it says so out loud.
 */
export function credentialFromMint(input: MintInput): WriteCredential {
  if (input.minted !== null) {
    return {
      ok: true,
      token: input.minted.secret,
      grant: input.minted.grant,
      note: `已为「${input.label}」签发专属授权（${describeGrant(input.minted.grant)}）。这份凭据只属于该客户端，可在连接中心撤销。`,
    };
  }

  switch (classifyMintFailure(input.error)) {
    case 'not-configured':
      return {
        ok: true,
        token: input.deviceToken,
        grant: null,
        note: '本机未启用客户端授权，本次写入沿用设备凭据。启用后可改为按客户端签发并随时撤销。',
      };
    case 'no-device-credential':
      return {
        ok: false,
        detail: '本地 Core 未配置设备凭据（NOLTRI_DEV_TOKEN），不能签发长期授权：没有写入任何配置。',
      };
    case 'unreachable':
      return {
        ok: false,
        detail: `本地 Core 未响应，未签发授权：没有写入任何配置。原因：${reasonText(input.error)}`,
      };
    case 'refused':
      return { ok: false, detail: `Core 拒绝签发授权：没有写入任何配置。原因：${reasonText(input.error)}` };
  }
}

function reasonText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '未知原因';
}
