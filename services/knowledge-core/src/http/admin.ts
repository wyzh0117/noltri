/**
 * 连接中心's own endpoints — the 「后台管理的本地客户端授权」 that V1 §12 puts in place of a user-facing
 * `NOLTRI_DEV_TOKEN`.
 *
 * Minting a credential is the most powerful call this API has, so it is closed to the clients it mints
 * for: a grant can never manage grants, and a Core that asks for no credential at all cannot hand out
 * long-lived ones. What a listing returns is metadata only — the plaintext secret appears exactly once,
 * in the response that created it, and is never read back from the store.
 */
import {
  issueGrantRequestSchema,
  type GrantListResponse,
  type IssueGrantResponse,
  type RevokeGrantResponse,
} from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import { issueGrant, listGrants, publicGrant, revokeGrant, type GrantStore } from '../authorization';
import type { Identity } from '../auth';
import { parseWith } from './parse';

export interface AdminArgs {
  readonly method: string;
  /** The matched route shape, e.g. `api/admin/grants/:id/revoke`. */
  readonly path: string;
  readonly identity: Identity;
  readonly store: GrantStore | null;
  /** The id segment for routes that carry one; already percent-decoded by the router. */
  readonly id?: string;
  readonly body: unknown;
}

export type AdminResponse = GrantListResponse | IssueGrantResponse | RevokeGrantResponse;

function requireDeviceCredential(store: GrantStore | null, identity: Identity): GrantStore {
  if (store === null) {
    throw knowledgeError('conflict', '本机未启用客户端授权 / no local authorization store is configured');
  }
  if (identity.grant !== undefined) {
    throw knowledgeError('unauthorized', '客户端授权不能管理授权 / a client grant cannot manage grants', {
      reason: 'admin_needs_device_credential',
    });
  }
  if (identity.via === 'dev-open') {
    throw knowledgeError(
      'unauthorized',
      '未配置凭据的 Core 不能签发长期授权，请先设置 NOLTRI_DEV_TOKEN / an unauthenticated Core cannot mint credentials',
      { reason: 'admin_credential_required' },
    );
  }
  return store;
}

export async function handleAdminGrants(args: AdminArgs): Promise<AdminResponse> {
  const store = requireDeviceCredential(args.store, args.identity);

  if (args.path === 'api/admin/grants' && args.method === 'GET') {
    return { grants: [...(await listGrants(store))] };
  }

  if (args.path === 'api/admin/grants' && args.method === 'POST') {
    const input = parseWith(issueGrantRequestSchema, args.body, 'issue grant');
    const { grant, secret } = await issueGrant(store, {
      label: input.label,
      ...(input.client === undefined ? {} : { client: input.client }),
      scopes: input.scopes,
      ...(input.nodeIds === undefined ? {} : { nodeIds: input.nodeIds }),
      ...(input.snippetChars === undefined ? {} : { snippetChars: input.snippetChars }),
    });
    return { grant: publicGrant(grant), secret };
  }

  if (args.path === 'api/admin/grants/:id/revoke' && args.method === 'POST') {
    const revoked = await revokeGrant(store, String(args.id ?? ''));
    if (revoked === null) throw knowledgeError('not_found', `授权 ${String(args.id)} 不存在 / grant not found`);
    return { grant: revoked };
  }

  throw knowledgeError('not_found', `未知的授权端点 ${args.path} / unknown authorization endpoint`);
}
