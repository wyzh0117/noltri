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
import { ApiClient, ApiClientError, type IssueGrantResponse, type PublicGrant } from '@noltri/api-client';
import type { GrantScope } from '@noltri/api-client';
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
  return `${scopes} · ${projects} · ${grant.revokedAt === null ? '生效中' : '已撤销'}`;
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
