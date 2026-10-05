/**
 * `@noltri/knowledge-core/http` — the host-facing wiring.
 *
 * `apps/web` route handlers and `services/mcp-server` both call `buildHandler`, so a request that
 * arrives over HTTP and a request that arrives over MCP run through the same core object, the same
 * repository and the same provider (V1_DEVELOPMENT §19 Phase 8: one pipeline for every client).
 */
import type { AIProvider } from '@noltri/ai-provider';
import { createProvider } from '@noltri/ai-provider';
import { createLogger, currentEnv, type EnvSource, type Logger } from '@noltri/shared';
import { createRepository, type KnowledgeRepository } from '@noltri/storage';
import { resolveIdentity } from '../auth';
import { createGrantResolver, FileGrantStore, listGrants, type GrantStore } from '../authorization';
import { loadCoreConfig, type CoreConfig } from '../config';
import { createKnowledgeCore, type KnowledgeCore } from '../core';
import { createRequestHandler, type RequestHandler, type RouterDeps } from './router';

export interface CoreBundle {
  readonly handle: RequestHandler;
  readonly core: KnowledgeCore;
  readonly repository: KnowledgeRepository;
  readonly provider: AIProvider;
  readonly config: CoreConfig;
  readonly logger: Logger;
  /** The 本地客户端授权 store, or null when this deployment kept the single-credential behaviour. */
  readonly grants: GrantStore | null;
  /** Releases a Postgres pool when the driver owns one; the memory driver has nothing to close. */
  close(): Promise<void>;
}

export interface BuildHandlerOptions {
  logger?: Logger;
  /** Overrides the `NOLTRI_GRANT_FILE` decision: pass a store to force grants on, `null` to force off. */
  grantStore?: GrantStore | null;
}

export async function buildHandler(
  config: CoreConfig = loadCoreConfig(),
  options: BuildHandlerOptions = {},
): Promise<CoreBundle> {
  const logger = options.logger ?? createLogger('knowledge-core', config.ai.driver === 'offline' ? 'info' : 'info');
  const repository = await createRepository(config.storage);
  const provider = createProvider(config.ai);
  const core = createKnowledgeCore({ repository, provider, config, logger });

  const grants = options.grantStore !== undefined ? options.grantStore : config.grantFile.length > 0 ? new FileGrantStore(config.grantFile) : null;

  logger.info('knowledge core ready', {
    storageDriver: repository.driver,
    aiProvider: provider.id,
    embeddingDim: config.embeddingDim,
    attachThreshold: config.thresholds.similarityAttachThreshold,
    authorization: grants === null ? 'single-credential' : 'grants',
  });

  const deps: RouterDeps = { core, config, logger, grants };
  if (grants !== null) {
    // Every request re-reads the store, so 撤销 takes effect on connections that are already open (M04).
    deps.identityResolver = createGrantResolver(grants, (request, cfg) => resolveIdentity(request, cfg, logger));
    logger.info('local client authorization enabled', { active: (await listGrants(grants)).filter((g) => g.revokedAt === null).length });
  }

  return {
    handle: createRequestHandler(deps),
    core,
    repository,
    provider,
    config,
    logger,
    grants,
    close: async () => {
      const closable = repository as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
    },
  };
}

let shared: Promise<CoreBundle> | null = null;

/**
 * Serverless-friendly singleton: a warm Lambda/Function instance reuses one repository pool instead of
 * opening a connection per request.
 */
export function sharedBundle(env: EnvSource = currentEnv()): Promise<CoreBundle> {
  if (shared === null) shared = buildHandler(loadCoreConfig(env));
  return shared;
}

export async function sharedHandler(env: EnvSource = currentEnv()): Promise<RequestHandler> {
  return (await sharedBundle(env)).handle;
}

export { createRequestHandler, type RequestHandler, type RouterDeps } from './router';
export { resolveIdentity, clearIdentityCache, bearerOf, type Identity, type IdentityResolver } from '../auth';
export {
  FileGrantStore,
  InMemoryGrantStore,
  createGrantResolver,
  findGrant,
  hashSecret,
  issueGrant,
  listGrants,
  publicGrant,
  requireNodeAccess,
  requireScope,
  revokeGrant,
  scopeForAction,
  GRANT_SCOPES,
  type ClientGrant,
  type GrantScope,
  type GrantStore,
  type NewGrantInput,
  type PublicGrant,
} from '../authorization';
export { resolveGrantFile } from '../config';
