/**
 * 本地客户端授权 (V1 §12 表格：`NOLTRI_DEV_TOKEN` 不再作为用户入口，替换为后台管理的本地客户端授权).
 *
 * A grant is a credential for one client — one Agent, one browser, one install — carrying an explicit
 * scope list and optionally a list of projects it may touch (§431 默认权限按客户端和项目范围授予). Three
 * rules hold this together:
 *
 * 1. The store never holds the credential: it keeps a SHA-256 digest, and the plaintext is returned
 *    exactly once, at issue time (§16 客户端密钥不作为明文业务字段存储).
 * 2. Every request re-reads the store. A cached grant is a grant that keeps working after the user
 *    pressed 撤销, and M04 says 旧连接不能继续读写 — so freshness wins over the saved file read.
 * 3. Anything the grant does not say is refused: an unknown endpoint, a node outside 限制项目, a list
 *    request that would show projects the grant never named. Fail closed, with a reason the UI can show.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createId, knowledgeError } from '@noltri/shared';
import {
  grantScopeSchema,
  MAX_SNIPPET_CHARS,
  MIN_SNIPPET_CHARS,
  type GrantScope,
  type PublicGrant,
} from '@noltri/schema';
import type { CoreConfig } from './config';
import { bearerOf, type Identity, type IdentityResolver } from './auth';

// The wire contract owns the vocabulary: a store that accepted a scope the API does not recognise would
// be a grant nobody can issue and everybody has to guess at.
export type { GrantScope, PublicGrant };

export const GRANT_SCOPES: readonly GrantScope[] = grantScopeSchema.options;

export interface ClientGrant {
  readonly id: string;
  /** What the user called this connection, e.g. 「Claude Desktop」. Shown in 连接中心. */
  readonly label: string;
  /** Actor written into version records. Taken from the credential, never from a request header. */
  readonly client: string;
  readonly scopes: readonly GrantScope[];
  readonly secretHash: string;
  /** `null` = 全部项目; a list means only those node ids may be read or changed. */
  readonly nodeIds: readonly string[] | null;
  /** §435 限制返回片段. `null` returns what 检索 stores; a number caps each search hit's text. */
  readonly snippetChars: number | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface NewGrantInput {
  readonly label: string;
  readonly client?: string;
  readonly scopes: readonly GrantScope[];
  readonly nodeIds?: readonly string[];
  readonly snippetChars?: number;
  readonly now?: string;
}

export interface GrantStore {
  read(): Promise<readonly ClientGrant[]>;
  write(grants: readonly ClientGrant[]): Promise<void>;
}

function cloneGrant(grant: ClientGrant): ClientGrant {
  return {
    ...grant,
    scopes: [...grant.scopes],
    nodeIds: grant.nodeIds === null ? null : [...grant.nodeIds],
    snippetChars: grant.snippetChars ?? null,
  };
}

export class InMemoryGrantStore implements GrantStore {
  private grants: ClientGrant[] = [];

  async read(): Promise<readonly ClientGrant[]> {
    return this.grants.map(cloneGrant);
  }

  async write(grants: readonly ClientGrant[]): Promise<void> {
    this.grants = grants.map(cloneGrant);
  }
}

function isGrant(value: unknown): value is ClientGrant {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant['id'] === 'string' &&
    typeof grant['label'] === 'string' &&
    typeof grant['client'] === 'string' &&
    typeof grant['secretHash'] === 'string' &&
    typeof grant['createdAt'] === 'string' &&
    Array.isArray(grant['scopes']) &&
    grant['scopes'].every((scope) => GRANT_SCOPES.includes(scope as GrantScope)) &&
    (grant['nodeIds'] === null || Array.isArray(grant['nodeIds'])) &&
    // Absent is legal: a grants file written before 限制返回片段 existed carries no such field.
    (grant['snippetChars'] === undefined ||
      grant['snippetChars'] === null ||
      (typeof grant['snippetChars'] === 'number' && Number.isInteger(grant['snippetChars']))) &&
    (grant['revokedAt'] === null || typeof grant['revokedAt'] === 'string')
  );
}

/**
 * The grants live next to the local profile, with owner-only permissions and the same temp+rename
 * discipline as the app's own settings: a half-written authorization file must never decide who may
 * read the library.
 */
export class FileGrantStore implements GrantStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<readonly ClientGrant[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw knowledgeError('internal_error', `无法读取授权文件 / authorization store could not be read: ${reasonOf(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw knowledgeError('internal_error', `授权文件不是合法 JSON / authorization store is not JSON: ${reasonOf(error)}`);
    }
    const list = (parsed as { grants?: unknown }).grants;
    if (!Array.isArray(list)) {
      throw knowledgeError('internal_error', '授权文件缺少 grants 数组 / authorization store has no grants array');
    }
    // A malformed entry is not skipped: silently ignoring a record could ignore a revocation.
    if (!list.every(isGrant)) {
      throw knowledgeError('internal_error', '授权文件包含无法识别的条目 / authorization store holds an unreadable entry');
    }
    return (list as ClientGrant[]).map(cloneGrant);
  }

  async write(grants: readonly ClientGrant[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.noltri-grants.${createId()}.tmp`);
    await writeFile(tmp, `${JSON.stringify({ grants: grants.map(cloneGrant) }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function badGrant(message: string): Error {
  return knowledgeError('invalid_request', message);
}

/**
 * `unauthorized`, not a new code: the error-code enum is frozen by §8, so the distinction the UI needs
 * (wrong credential vs. credential fine but out of scope) travels in `details.reason` instead.
 */
function refused(reason: string, message: string, details: Record<string, unknown> = {}): never {
  throw knowledgeError('unauthorized', `${message} / access refused (${reason})`, { reason, ...details });
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function hashSecret(secret: string): string {
  return digestOf(secret).toString('hex');
}

export function publicGrant(grant: ClientGrant): PublicGrant {
  return {
    id: grant.id,
    label: grant.label,
    client: grant.client,
    scopes: [...grant.scopes],
    nodeIds: grant.nodeIds === null ? null : [...grant.nodeIds],
    snippetChars: grant.snippetChars ?? null,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  };
}

/** The plaintext credential is returned once and never stored — 撤销 is the only way back. */
export async function issueGrant(
  store: GrantStore,
  input: NewGrantInput,
): Promise<{ grant: ClientGrant; secret: string }> {
  const label = input.label.trim();
  if (label === '') throw badGrant('授权需要一个名称 / a grant needs a label');
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw badGrant('授权至少要包含一个范围 / a grant needs at least one scope');
  for (const scope of scopes) {
    if (!GRANT_SCOPES.includes(scope)) throw badGrant(`未知的授权范围：${String(scope)} / unknown scope`);
  }
  const nodeIds = input.nodeIds === undefined ? null : [...new Set(input.nodeIds.map((id) => id.trim()).filter((id) => id !== ''))];
  if (nodeIds !== null && nodeIds.length === 0) throw badGrant('限制项目列表为空 / the project list is empty');
  const client = (input.client ?? '').trim();
  const snippetChars = input.snippetChars ?? null;
  if (snippetChars !== null && (snippetChars < MIN_SNIPPET_CHARS || snippetChars > MAX_SNIPPET_CHARS)) {
    throw badGrant(`限制返回片段需在 ${String(MIN_SNIPPET_CHARS)}–${String(MAX_SNIPPET_CHARS)} 之间 / snippet cap out of range`);
  }

  const secret = randomBytes(32).toString('base64url');
  const grant: ClientGrant = {
    id: createId(),
    label,
    client: client === '' ? 'mcp' : client,
    scopes,
    secretHash: hashSecret(secret),
    nodeIds,
    snippetChars,
    createdAt: input.now ?? new Date().toISOString(),
    revokedAt: null,
  };
  const existing = await store.read();
  await store.write([...existing, grant]);
  return { grant, secret };
}

export async function listGrants(store: GrantStore): Promise<readonly PublicGrant[]> {
  return (await store.read()).map(publicGrant);
}

/**
 * Revocation is a timestamp, not a deletion: the record stays so 连接中心 can show 「已撤销」 and so a
 * replayed credential is refused with a reason instead of being an unknown token.
 */
export async function revokeGrant(store: GrantStore, id: string, now = new Date().toISOString()): Promise<PublicGrant | null> {
  const grants = await store.read();
  const index = grants.findIndex((grant) => grant.id === id);
  if (index < 0) return null;
  const current = grants[index];
  if (current === undefined) return null;
  const revoked: ClientGrant = { ...cloneGrant(current), revokedAt: now };
  await store.write(grants.map((grant, position) => (position === index ? revoked : grant)));
  return publicGrant(revoked);
}

export type GrantLookup =
  | { readonly kind: 'live'; readonly grant: ClientGrant }
  | { readonly kind: 'revoked'; readonly grant: ClientGrant }
  | { readonly kind: 'unknown' };

/** Constant-time over digests, so neither the length nor a prefix of the credential leaks through timing. */
export async function findGrant(store: GrantStore, secret: string): Promise<GrantLookup> {
  if (secret === '') return { kind: 'unknown' };
  const presented = digestOf(secret);
  let revokedMatch: ClientGrant | undefined;
  for (const grant of await store.read()) {
    const stored = Buffer.from(grant.secretHash, 'hex');
    if (stored.length !== presented.length || !timingSafeEqual(presented, stored)) continue;
    if (grant.revokedAt === null) return { kind: 'live', grant };
    revokedMatch = grant;
  }
  return revokedMatch === undefined ? { kind: 'unknown' } : { kind: 'revoked', grant: revokedMatch };
}

/**
 * A bearer that matches a live grant becomes that grant's identity; a bearer that matches a revoked one
 * is refused where it stands. A bearer that matches nothing falls through to the configured mode, so
 * turning grants on does not silently lock out the app's own device credential mid-migration.
 */
export function createGrantResolver(store: GrantStore, fallback: IdentityResolver): IdentityResolver {
  return async (request: Request, config: CoreConfig): Promise<Identity> => {
    const secret = bearerOf(request);
    if (secret === '') return await fallback(request, config);
    const found = await findGrant(store, secret);
    if (found.kind === 'revoked') {
      refused('grant_revoked', `「${found.grant.label}」的授权已被撤销，这条连接不能继续读写`);
    }
    if (found.kind === 'live') {
      return { userId: config.devUser, actor: found.grant.client, via: 'grant', grant: found.grant };
    }
    return await fallback(request, config);
  };
}

/**
 * One entry point, one scope. `capture` is the 只写采集 the privacy dialog offers; `read` covers the
 * tree, search, inbox, context and conversation reads an Agent needs; `mutate` is the destructive half
 * (§431 破坏性操作应返回需要确认的动作), which no client gets by default.
 */
const SCOPE_BY_ACTION: ReadonlyMap<string, GrantScope> = new Map<string, GrantScope>([
  ['POST api/capture', 'capture'],
  ['POST api/items', 'capture'],
  ['GET api/items', 'read'],
  ['GET api/items/:id', 'read'],
  ['GET api/items/:id/relations', 'read'],
  ['PATCH api/items/:id', 'mutate'],
  ['DELETE api/items/:id', 'mutate'],
  ['POST api/items/:id/relations', 'mutate'],
  ['DELETE api/items/:id/relations/:targetId', 'mutate'],
  ['POST api/items/:id/restore', 'mutate'],
  ['GET api/tree', 'read'],
  ['GET api/inbox', 'read'],
  ['GET api/inbox/:id', 'read'],
  ['POST api/inbox/:id/assign', 'mutate'],
  ['GET api/nodes/:id', 'read'],
  ['PATCH api/nodes/:id', 'mutate'],
  ['POST api/nodes/:id/move', 'mutate'],
  ['POST api/search', 'read'],
  ['POST api/node-context', 'read'],
  ['POST api/chat', 'read'],
  ['GET api/conversations', 'read'],
  ['GET api/conversations/:id/messages', 'read'],
  ['POST api/capture/:id/retry', 'mutate'],
]);

export function scopeForAction(method: string, path: string): GrantScope | undefined {
  return SCOPE_BY_ACTION.get(`${method} ${path}`);
}

/** `undefined` grant = the legacy single-credential path, which has no per-client scope to check. */
export function requireScope(grant: ClientGrant | undefined, method: string, path: string): void {
  if (grant === undefined) return;
  const scope = scopeForAction(method, path);
  if (scope === undefined) {
    refused('route_not_granted', `该端点不在本地授权范围内：${method} ${path}`);
  }
  if (!grant.scopes.includes(scope)) {
    refused('scope_not_granted', `「${grant.label}」的授权不含「${scope}」范围`, { scope });
  }
}

/**
 * 限制项目: a grant with a node list may touch exactly those nodes. A request that would show more than
 * them — a whole tree, an unscoped search — is refused rather than filtered, because a filtered result
 * still answers questions the user never authorized.
 */
export function requireNodeAccess(grant: ClientGrant | undefined, nodeId: string | null | undefined, what: string): void {
  if (grant === undefined || grant.nodeIds === null) return;
  if (nodeId === null || nodeId === undefined || nodeId === '') {
    refused('listing_not_scoped', `「${grant.label}」只授权了指定项目，${what}不在授权范围内`);
  }
  if (nodeId !== undefined && nodeId !== '' && !grant.nodeIds.includes(nodeId)) {
    refused('node_not_granted', `「${grant.label}」没有被授权访问该项目`, { nodeId });
  }
}
