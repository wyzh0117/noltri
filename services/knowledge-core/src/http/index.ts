/** Shared HTTP wiring for the local Core server and MCP stdio client. */
import type { AIProvider } from '@noltri/ai-provider';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProvider } from '@noltri/ai-provider';
import { createLogger, currentEnv, type EnvSource, type Logger } from '@noltri/shared';
import { createRepository, type KnowledgeRepository } from '@noltri/storage';
import { resolveIdentity } from '../auth';
import { createGrantResolver, FileGrantStore, listGrants, type GrantStore } from '../authorization';
import { loadCoreConfig, type CoreConfig } from '../config';
import { createKnowledgeCore, type KnowledgeCore } from '../core';
import { VaultService } from '../notes/vault';
import { createRequestHandler, type RequestHandler, type RouterDeps } from './router';

export interface CoreBundle {
  readonly handle: RequestHandler;
  readonly core: KnowledgeCore;
  readonly repository: KnowledgeRepository;
  readonly provider: AIProvider;
  readonly config: CoreConfig;
  readonly logger: Logger;
  readonly grants: GrantStore | null;
  readonly vault: VaultService;
  close(): Promise<void>;
}

export interface BuildHandlerOptions {
  logger?: Logger;
  grantStore?: GrantStore | null;
  /** Test/smoke injection. Omitted :memory: profiles receive a private temporary vault. */
  vaultRootPath?: string;
  vaultDataDir?: string;
}

export async function buildHandler(
  config: CoreConfig = loadCoreConfig(),
  options: BuildHandlerOptions = {},
): Promise<CoreBundle> {
  const logger = options.logger ?? createLogger('knowledge-core', 'info');
  const repository = await createRepository(config.storage);
  const ephemeralDataDir = config.sqliteFile === ':memory:' && options.vaultRootPath === undefined && options.vaultDataDir === undefined
    ? await mkdtemp(path.join(os.tmpdir(), 'noltri-core-memory-'))
    : null;
  const vault = new VaultService({
    rootPath: options.vaultRootPath ?? (ephemeralDataDir === null ? config.vaultDir : path.join(ephemeralDataDir, 'vault')),
    dataDir: options.vaultDataDir ?? ephemeralDataDir ?? config.dataDir,
    repository,
    userId: config.devUser,
  });
  const provider = createProvider(config.ai);
  const core = createKnowledgeCore({ repository, provider, config, logger, graphNoteStore: vault });
  const grants = options.grantStore !== undefined ? options.grantStore : config.grantFile.length > 0 ? new FileGrantStore(config.grantFile) : null;
  logger.info('knowledge core ready', {
    storageDriver: repository.driver,
    aiProvider: provider.id,
    embeddingDim: config.embeddingDim,
    attachThreshold: config.thresholds.similarityAttachThreshold,
    authorization: grants === null ? 'single-credential' : 'grants',
  });

  const deps: RouterDeps = { core, config, logger, grants, vault };
  if (grants !== null) {
    deps.identityResolver = createGrantResolver(grants, (request, cfg) => resolveIdentity(request, cfg, logger));
    logger.info('local client authorization enabled', { active: (await listGrants(grants)).filter((grant) => grant.revokedAt === null).length });
  }

  return {
    handle: createRequestHandler(deps), core, repository, provider, config, logger, grants, vault,
    close: async () => {
      await vault.close();
      const closable = repository as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
      if (ephemeralDataDir !== null) await rm(ephemeralDataDir, { recursive: true, force: true });
    },
  };
}

let shared: Promise<CoreBundle> | null = null;

export function sharedBundle(env: EnvSource = currentEnv()): Promise<CoreBundle> {
  if (shared === null) shared = buildHandler(loadCoreConfig(env));
  return shared;
}

export async function sharedHandler(env: EnvSource = currentEnv()): Promise<RequestHandler> {
  return (await sharedBundle(env)).handle;
}

export { createRequestHandler, type RequestHandler, type RouterDeps } from './router';
export { resolveIdentity, bearerOf, type Identity, type IdentityResolver } from '../auth';
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
