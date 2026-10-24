/**
 * Configuration is the only place a number lives.
 *
 * PROJECT_MASTER §3.6 forbids hardcoded classification thresholds in code paths, so every tunable
 * below is read from the environment (`loadThresholds` / `loadScopeBudgets` already clamp and
 * validate), and pipeline / service modules receive values through `CoreConfig` only.
 * The defaults exported here are documentation of what the environment falls back to.
 */
import os from 'node:os';
import path from 'node:path';
import type { ScopeTokenBudget, Thresholds } from '@noltri/schema';
import {
  currentEnv,
  aiInputTokenLimit,
  envBoolean,
  envFloat,
  envInt,
  envString,
  loadAiConfig,
  loadScopeBudgets,
  loadStorageDriver,
  loadThresholds,
  type AiProviderConfig,
  type EnvSource,
} from '@noltri/shared';
import type { RepositoryOptions } from '@noltri/storage';

export const CORE_PACKAGE_NAME = '@noltri/knowledge-core';

/** Fallbacks for knobs that belong to Core itself (not to the frozen Thresholds contract). */
export const CORE_DEFAULTS = {
  version: '0.2.0',
  port: 8787,
  corsOrigin: '*',
  devUser: 'local-dev-user',
  maxItemsPerCapture: 6,
  actorLabelForMcp: 'mcp',
  /** Above this similarity a related node gets an explicit edge instead of staying implicit. */
  similarEdgeThreshold: 0.6,
  chatHistoryLimit: 12,
  relatedNodeCap: 6,
  treeDefaultDepth: 6,
  searchDefaultLimit: 10,
  /** Relative file names are always resolved against this, never against the current directory. */
  dataDirname: '.noltri',
  sqliteFilename: 'noltri.sqlite',
  /** Default home of the 本地客户端授权 store, under the same data directory as the profile database. */
  grantFilename: 'grants.json',
} as const;

/**
 * The profile database location, in order of precedence: an explicit file, an explicit data directory,
 * then `~/.noltri/data`. A desktop shell will hand its own app-data path in through `NOLTRI_DATA_DIR`;
 * until it does, this is the one place that decides where local knowledge lives, and it never writes
 * into the repository the code was checked out from.
 */
export function resolveSqliteFile(env: EnvSource = currentEnv()): string {
  const absolute = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(value));
  const direct = envString(env, 'NOLTRI_SQLITE_FILE');
  if (direct.length > 0) return absolute(direct);
  const dataDir = envString(env, 'NOLTRI_DATA_DIR');
  if (dataDir.length > 0) return path.join(absolute(dataDir), CORE_DEFAULTS.sqliteFilename);
  return path.join(
    os.homedir(),
    CORE_DEFAULTS.dataDirname,
    'data',
    CORE_DEFAULTS.sqliteFilename,
  );
}

export function resolveDataDirectory(env: EnvSource = currentEnv()): string {
  const absolute = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(value));
  const configured = envString(env, 'NOLTRI_DATA_DIR');
  if (configured.length > 0) return absolute(configured);
  const sqlite = envString(env, 'NOLTRI_SQLITE_FILE');
  if (sqlite.length > 0 && sqlite !== ':memory:') return path.dirname(absolute(sqlite));
  return path.join(os.homedir(), CORE_DEFAULTS.dataDirname, 'data');
}

export function resolveVaultDirectory(env: EnvSource = currentEnv()): string {
  const configured = envString(env, 'NOLTRI_NOTES_DIR');
  if (configured.length > 0) return path.isAbsolute(configured) ? configured : path.resolve(configured);
  return path.join(resolveDataDirectory(env), 'vault');
}

/**
 * The 本地客户端授权 store path: an explicit file, then `NOLTRI_DATA_DIR/grants.json` so a desktop profile
 * finds its grants beside its database, then empty = the feature stays off for hosts that never opted in.
 */
export function resolveGrantFile(env: EnvSource = currentEnv()): string {
  const absolute = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(value));
  const direct = envString(env, 'NOLTRI_GRANT_FILE');
  if (direct.length > 0) return absolute(direct);
  const dataDir = envString(env, 'NOLTRI_DATA_DIR');
  if (dataDir.length > 0) return path.join(absolute(dataDir), CORE_DEFAULTS.grantFilename);
  return '';
}

export interface CoreConfig {
  /** Storage selection handed to `createRepository`. */
  readonly storage: RepositoryOptions;
  /** AI provider selection handed to `createProvider`. */
  readonly ai: AiProviderConfig;
  readonly thresholds: Thresholds;
  readonly scopeBudgets: ScopeTokenBudget;
  readonly devUser: string;
  readonly devTokenRequired: boolean;
  readonly devToken: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly embeddingDim: number;
  /** Chat-only OpenAI-compatible providers can classify without an embedding endpoint. */
  readonly embeddingEnabled: boolean;
  readonly version: string;
  readonly maxItemsPerCapture: number;
  readonly actorLabelForMcp: string;
  readonly similarEdgeThreshold: number;
  readonly chatHistoryLimit: number;
  readonly relatedNodeCap: number;
  readonly treeDefaultDepth: number;
  readonly searchDefaultLimit: number;
  /** Absolute path of the local profile database, whichever driver is configured. */
  readonly sqliteFile: string;
  /** Default Markdown Vault, stored beside the profile unless explicitly overridden. */
  readonly dataDir: string;
  readonly vaultDir: string;
  /**
   * Where 本地客户端授权 grants live (`NOLTRI_GRANT_FILE`). Empty keeps today's single-credential
   * behaviour: grants are opt-in per deployment, so no existing host is locked out by this change.
   */
  readonly grantFile: string;
}

const positive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function loadCoreConfig(env: EnvSource = currentEnv()): CoreConfig {
  const ai = loadAiConfig(env);
  const driver = loadStorageDriver(env);
  const inputTokenLimit = aiInputTokenLimit(ai);
  const budget = (value: number) => inputTokenLimit === null ? value : Math.max(0, Math.min(value, inputTokenLimit));
  const rawBudgets = loadScopeBudgets(env);
  const scopeBudgets: ScopeTokenBudget = {
    current_node: budget(rawBudgets.current_node),
    section: budget(rawBudgets.section),
    tree: budget(rawBudgets.tree),
    whole_library: budget(rawBudgets.whole_library),
  };

  const storage: RepositoryOptions = {
    driver,
    // Resolved for every driver: `createRepository` is the only thing that decides what to do with it,
    // so a host that asks for sqlite gets a clear error and a host that does not pays nothing.
    sqliteFile: resolveSqliteFile(env),
  };

  return {
    storage,
    ai,
    thresholds: loadThresholds(env),
    scopeBudgets,
    devUser: envString(env, 'NOLTRI_DEV_USER_ID', CORE_DEFAULTS.devUser),
    devTokenRequired: envBoolean(env, 'NOLTRI_DEV_REQUIRE_TOKEN', false),
    devToken: envString(env, 'NOLTRI_DEV_TOKEN'),
    port: positive(envInt(env, 'PORT', CORE_DEFAULTS.port), CORE_DEFAULTS.port),
    corsOrigin: envString(env, 'CORS_ORIGIN', CORE_DEFAULTS.corsOrigin),
    embeddingDim: positive(ai.embeddingDim, 1536),
    embeddingEnabled: envBoolean(env, 'AI_EMBEDDINGS_ENABLED', true),
    version: envString(env, 'NOLTRI_VERSION', CORE_DEFAULTS.version),
    maxItemsPerCapture: positive(envInt(env, 'MAX_ITEMS_PER_CAPTURE', CORE_DEFAULTS.maxItemsPerCapture), 1),
    actorLabelForMcp: envString(env, 'MCP_ACTOR_LABEL', CORE_DEFAULTS.actorLabelForMcp),
    similarEdgeThreshold: envFloat(env, 'SIMILAR_EDGE_THRESHOLD', CORE_DEFAULTS.similarEdgeThreshold),
    chatHistoryLimit: positive(envInt(env, 'CHAT_HISTORY_LIMIT', CORE_DEFAULTS.chatHistoryLimit), 1),
    relatedNodeCap: positive(envInt(env, 'RELATED_NODE_CAP', CORE_DEFAULTS.relatedNodeCap), 1),
    treeDefaultDepth: positive(envInt(env, 'TREE_DEFAULT_DEPTH', CORE_DEFAULTS.treeDefaultDepth), 1),
    searchDefaultLimit: positive(envInt(env, 'SEARCH_DEFAULT_LIMIT', CORE_DEFAULTS.searchDefaultLimit), 1),
    sqliteFile: storage.sqliteFile ?? '',
    dataDir: resolveDataDirectory(env),
    vaultDir: resolveVaultDirectory(env),
    grantFile: resolveGrantFile(env),
  };
}
