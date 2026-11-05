/** Shared HTTP wiring for the local Core server and MCP stdio client. */
import type { AIProvider } from '@noltri/ai-provider';
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProvider } from '@noltri/ai-provider';
import { createLogger, currentEnv, knowledgeError, type EnvSource, type Logger } from '@noltri/shared';
import { createRepository, isEphemeralStorage, type KnowledgeRepository } from '@noltri/storage';
import { resolveIdentity } from '../auth';
import { createGrantResolver, FileGrantStore, listGrants, type GrantStore } from '../authorization';
import { loadCoreConfig, type CoreConfig } from '../config';
import { createKnowledgeCore, type KnowledgeCore } from '../core';
import { ProcessingRulesStore } from '../services/processing-rules';
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
  readonly processingRules: ProcessingRulesStore;
  close(): Promise<void>;
}

export interface BuildHandlerOptions {
  logger?: Logger;
  grantStore?: GrantStore | null;
  /** Test/smoke injection. Memory-backed profiles without overrides receive a private temporary vault. */
  vaultRootPath?: string;
  vaultDataDir?: string;
}

export async function buildHandler(
  config: CoreConfig = loadCoreConfig(),
  options: BuildHandlerOptions = {},
): Promise<CoreBundle> {
  const logger = options.logger ?? createLogger('knowledge-core', 'info');
  const repository = await createRepository(config.storage);
  const ephemeralDataDir = isEphemeralStorage(config.storage) && options.vaultRootPath === undefined && options.vaultDataDir === undefined
    ? await mkdtemp(path.join(os.tmpdir(), 'noltri-core-memory-'))
    : null;
  let startedVault: VaultService | undefined;
  const closeRepository = async () => {
    const closable = repository as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') await closable.close();
  };
  try {
    // This root is host-owned; no request body, query or vault-root header can select it.
    const profileDataDir = options.vaultDataDir ?? ephemeralDataDir ?? config.dataDir;
    let processingRules: ProcessingRulesStore;
    try {
      await mkdir(profileDataDir, { recursive: true });
      const canonicalProfile = await realpath(profileDataDir);
      processingRules = await ProcessingRulesStore.open({
        root: path.join(canonicalProfile, 'processing-rules'),
        defaults: { thresholds: { ...config.thresholds }, extractionInstructions: '', classificationInstructions: '' },
      });
    } catch {
      // Never enable provider defaults after damaged/unsafe rules storage fails to open.
      throw knowledgeError('storage_error', 'Processing rules storage unavailable');
    }
    const recoveredCaptureItems = await repository.recoverInterruptedCaptureBatches();
    if (recoveredCaptureItems > 0) logger.info('recovered interrupted capture batch items', { count: recoveredCaptureItems });
    const vault = new VaultService({
      rootPath: options.vaultRootPath ?? (ephemeralDataDir === null ? config.vaultDir : path.join(ephemeralDataDir, 'vault')),
      dataDir: profileDataDir,
      repository,
      userId: config.devUser,
    });
    startedVault = vault;
    const provider = createProvider(config.ai, { imageRecognitionModel: config.imageRecognitionModel });
    const core = createKnowledgeCore({ repository, provider, config, logger, graphNoteStore: vault, vault, processingRules });
    const grants = options.grantStore !== undefined ? options.grantStore : config.grantFile.length > 0 ? new FileGrantStore(config.grantFile) : null;
    logger.info('knowledge core ready', {
      storageDriver: repository.driver,
      aiProvider: provider.id,
      embeddingDim: config.embeddingDim,
      attachThreshold: config.thresholds.similarityAttachThreshold,
      authorization: grants === null ? 'single-credential' : 'grants',
    });
    const deps: RouterDeps = { core, config, logger, grants, vault, processingRules };
    if (grants !== null) {
      deps.identityResolver = createGrantResolver(grants, (request, cfg) => resolveIdentity(request, cfg, logger));
      logger.info('local client authorization enabled', { active: (await listGrants(grants)).filter((grant) => grant.revokedAt === null).length });
    }
    return {
      handle: createRequestHandler(deps), core, repository, provider, config, logger, grants, vault, processingRules,
      close: async () => {
        await vault.close();
        await closeRepository();
        if (ephemeralDataDir !== null) await rm(ephemeralDataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try { await startedVault?.close(); } catch { /* Preserve the startup cause. */ }
    try { await closeRepository(); } catch { /* Preserve the startup cause. */ }
    if (ephemeralDataDir !== null) await rm(ephemeralDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
