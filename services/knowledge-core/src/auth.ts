/**
 * Identity resolution.
 *
 * Identity comes from the credential on the request and never from a body or query field: a client
 * that could name its own userId could read another user's library, so `userId` is only ever produced
 * here. Four modes, in order of trust:
 *   0. NOLTRI_GRANT_FILE configured -> a bearer that matches a live 本地客户端授权 grant resolves to
 *      that grant's identity and carries the grant along, which is what makes per-client scopes and
 *      revocation checkable on every request (see `authorization.ts`). Anything else falls through.
 *   1. SUPABASE_URL configured  -> verify the bearer JWT against `${SUPABASE_URL}/auth/v1/user`,
 *                                 cached per token for ~60s so one turn does not become N calls.
 *   2. NOLTRI_DEV_REQUIRE_TOKEN -> require the NOLTRI_DEV_TOKEN bearer (single-user local/dev).
 *   3. otherwise                -> NOLTRI_DEV_USER_ID (no credential; local loopback only).
 * No SDK is imported: the verification is a plain web-standard fetch.
 */
import { knowledgeError, type Logger } from '@noltri/shared';
import type { CoreConfig } from './config';
import type { ClientGrant } from './authorization';

export type IdentityVia = 'supabase' | 'dev-token' | 'dev-open' | 'grant';

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

interface CacheEntry {
  readonly userId: string;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** FNV-1a over the token: a cache key only, never used as a credential or as a secret check. */
function tokenCacheKey(token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${String(token.length)}:${String(hash >>> 0)}`;
}

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

function readSub(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const sub = (payload as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : null;
}

async function verifySupabaseToken(config: CoreConfig, token: string, logger?: Logger): Promise<string> {
  const key = tokenCacheKey(token);
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.userId;

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };
  if (config.supabaseAnonKey.length > 0) headers.apikey = config.supabaseAnonKey;

  let response: Response;
  try {
    response = await fetch(`${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, { headers });
  } catch (error) {
    // Fail closed: an unreachable auth service must never fall back to the dev identity.
    logger?.error('supabase auth unreachable', { reason: error instanceof Error ? error.message : 'unknown' });
    throw knowledgeError('internal_error', '无法验证令牌 / identity service could not be reached');
  }

  if (!response.ok) {
    throw knowledgeError('unauthorized', '令牌无效或已过期 / token is invalid or expired');
  }

  const payload: unknown = await response.json().catch(() => null);
  const userId = readSub(payload);
  if (userId === null) {
    throw knowledgeError('unauthorized', '令牌缺少用户标识 / token carries no user id');
  }

  cache.set(key, { userId, expiresAt: Date.now() + config.authCacheMs });
  if (cache.size > 512) {
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(entryKey);
    }
  }
  return userId;
}

export async function resolveIdentity(request: Request, config: CoreConfig, logger?: Logger): Promise<Identity> {
  const actor = actorOf(request, config);

  if (config.supabaseUrl.length > 0) {
    const token = bearerOf(request);
    if (token.length === 0) {
      throw knowledgeError('unauthorized', '缺少访问令牌 / bearer token required');
    }
    return { userId: await verifySupabaseToken(config, token, logger), actor, via: 'supabase' };
  }

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

/** Test seam: the token cache is module-level so serverless reuse is real, but it must be clearable. */
export function clearIdentityCache(): void {
  cache.clear();
}
