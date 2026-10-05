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
import {
  createRepository,
  createResearchRepository,
  supportsResearchDriver,
  type KnowledgeRepository,
  type ResearchRepository,
} from '@noltri/storage';
import { resolveIdentity } from '../auth';
import { createGrantResolver, FileGrantStore, listGrants, type GrantStore } from '../authorization';
import { loadCoreConfig, type CoreConfig } from '../config';
import { createKnowledgeCore, type KnowledgeCore } from '../core';
import { createResearchDomain, type ResearchDomain } from '../research';
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
  /** The Research half, or null when the configured storage driver has no research implementation. */
  readonly researchRepository: ResearchRepository | null;
  readonly research: ResearchDomain | null;
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

  // Research keeps its own repository handle on the same profile file: WAL is what lets the second handle
  // read while the first writes. A driver with no research implementation (the kept-alive cloud profile)
  // leaves `research` unset, so the endpoints answer the honest research_not_wired refusal instead of
  // pretending to hold an empty library — and the bundle still builds, because 网页版 lives until P7.
  const researchRepository = supportsResearchDriver(config.storage.driver)
    ? await createResearchRepository(config.storage)
    : null;
  const research = researchRepository === null ? null : createResearchDomain(researchRepository);
  const core = createKnowledgeCore({
    repository,
    provider,
    config,
    logger,
    ...(research === null ? {} : { research }),
  });

  const grants = options.grantStore !== undefined ? options.grantStore : config.grantFile.length > 0 ? new FileGrantStore(config.grantFile) : null;

  logger.info('knowledge core ready', {
    storageDriver: repository.driver,
    aiProvider: provider.id,
    embeddingDim: config.embeddingDim,
    attachThreshold: config.thresholds.similarityAttachThreshold,
    authorization: grants === null ? 'single-credential' : 'grants',
    research: research === null ? 'not wired' : researchRepository?.driver ?? 'unknown',
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
    researchRepository,
    research,
    close: async () => {
      const closable = repository as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
      // Two handles, two closes: the research half holds its own WAL connection to the same file.
      const closableResearch = researchRepository as { close?: () => Promise<void> } | null;
      if (closableResearch !== null && typeof closableResearch.close === 'function') await closableResearch.close();
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
export type { ResearchDomain } from '../research';
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
