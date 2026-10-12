/**
 * Identity resolution.
 *
 * Identity comes from the credential on the request and never from a body or query field: a client
 * that could name its own userId could read another user's library, so `userId` is only ever produced
 * here. `authorization.ts` layers 本地客户端授权 grants on top of this resolver; the two credential
 * modes below are what the local build ships, in order of trust:
 *   1. NOLTRI_DEV_REQUIRE_TOKEN -> require the NOLTRI_DEV_TOKEN bearer (single-user local/dev).
 *   2. otherwise                -> NOLTRI_DEV_USER_ID (no credential; local loopback only).
 */
import { knowledgeError, type Logger } from '@noltri/shared';
import type { CoreConfig } from './config';
import type { ClientGrant } from './authorization';

export type IdentityVia = 'dev-token' | 'dev-open' | 'grant';

export interface Identity {
  readonly userId: string;
  /** Written into VersionRecord.actor. */
  readonly actor: string;
  readonly via: IdentityVia;
  /**
   * Set only when the bearer resolved through a grant. Scope enforcement reads it and nothing else,
   * so a legacy single-credential request is unaffected rather than silently denied.
   */
  readonly grant?: ClientGrant;
}

/** The seam `RouterDeps` accepts, so `authorization.ts` and `resolveIdentity` are interchangeable. */
export type IdentityResolver = (request: Request, config: CoreConfig, logger?: Logger) => Promise<Identity>;

export function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/** Version-record actor from the optional client hint; the hint never selects a user. */
export function actorOf(request: Request, config: CoreConfig): string {
  const hint = (request.headers.get('x-noltri-client') ?? '').trim().toLowerCase();
  const known = new Set(['extension', 'desktop', 'mcp', 'web_app', 'api']);
  if (hint === 'mcp') return config.actorLabelForMcp;
  return known.has(hint) ? hint : 'api';
}

export async function resolveIdentity(request: Request, config: CoreConfig, _logger?: Logger): Promise<Identity> {
  const actor = actorOf(request, config);

  if (config.devTokenRequired) {
    const token = bearerOf(request);
    if (config.devToken.length === 0) {
      throw knowledgeError('internal_error', 'NOLTRI_DEV_REQUIRE_TOKEN 已开启但未配置 NOLTRI_DEV_TOKEN');
    }
    if (token !== config.devToken) {
      throw knowledgeError('unauthorized', '开发令牌不匹配 / dev token mismatch');
    }
    return { userId: config.devUser, actor, via: 'dev-token' };
  }

  return { userId: config.devUser, actor, via: 'dev-open' };
}
