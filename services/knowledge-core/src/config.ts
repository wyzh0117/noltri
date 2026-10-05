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
  version: '0.1.0',
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
  /** Supabase JWT verification cache window, so one token is not re-checked per request. */
  authCacheMs: 60_000,
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
  readonly version: string;
  readonly maxItemsPerCapture: number;
  readonly actorLabelForMcp: string;
  readonly similarEdgeThreshold: number;
  readonly chatHistoryLimit: number;
  readonly relatedNodeCap: number;
  readonly treeDefaultDepth: number;
  readonly searchDefaultLimit: number;
  readonly authCacheMs: number;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  /** Absolute path of the local profile database, whichever driver is configured. */
  readonly sqliteFile: string;
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
  const databaseUrl = envString(env, 'DATABASE_URL') || envString(env, 'DIRECT_URL');

  const storage: RepositoryOptions = {
    driver,
    embeddingDim: ai.embeddingDim,
    // Resolved for every driver: `createRepository` is the only thing that decides what to do with it,
    // so a host that asks for sqlite gets a clear error and a host that does not pays nothing.
    sqliteFile: resolveSqliteFile(env),
    ...(databaseUrl.length > 0 ? { databaseUrl } : {}),
    ...(env['STATEMENT_TIMEOUT_MS'] ? { statementTimeoutMs: envInt(env, 'STATEMENT_TIMEOUT_MS', 30_000) } : {}),
    ...(env['STORAGE_POOL_MAX'] ? { maxConnections: envInt(env, 'STORAGE_POOL_MAX', 5) } : {}),
  };

  return {
    storage,
    ai,
    thresholds: loadThresholds(env),
    scopeBudgets: loadScopeBudgets(env),
    devUser: envString(env, 'NOLTRI_DEV_USER_ID', CORE_DEFAULTS.devUser),
    devTokenRequired: envBoolean(env, 'NOLTRI_DEV_REQUIRE_TOKEN', false),
    devToken: envString(env, 'NOLTRI_DEV_TOKEN'),
    port: positive(envInt(env, 'PORT', CORE_DEFAULTS.port), CORE_DEFAULTS.port),
    corsOrigin: envString(env, 'CORS_ORIGIN', CORE_DEFAULTS.corsOrigin),
    embeddingDim: positive(ai.embeddingDim, 1536),
    version: envString(env, 'NOLTRI_VERSION', CORE_DEFAULTS.version),
    maxItemsPerCapture: positive(envInt(env, 'MAX_ITEMS_PER_CAPTURE', CORE_DEFAULTS.maxItemsPerCapture), 1),
    actorLabelForMcp: envString(env, 'MCP_ACTOR_LABEL', CORE_DEFAULTS.actorLabelForMcp),
    similarEdgeThreshold: envFloat(env, 'SIMILAR_EDGE_THRESHOLD', CORE_DEFAULTS.similarEdgeThreshold),
    chatHistoryLimit: positive(envInt(env, 'CHAT_HISTORY_LIMIT', CORE_DEFAULTS.chatHistoryLimit), 1),
    relatedNodeCap: positive(envInt(env, 'RELATED_NODE_CAP', CORE_DEFAULTS.relatedNodeCap), 1),
    treeDefaultDepth: positive(envInt(env, 'TREE_DEFAULT_DEPTH', CORE_DEFAULTS.treeDefaultDepth), 1),
    searchDefaultLimit: positive(envInt(env, 'SEARCH_DEFAULT_LIMIT', CORE_DEFAULTS.searchDefaultLimit), 1),
    authCacheMs: positive(envInt(env, 'AUTH_CACHE_MS', CORE_DEFAULTS.authCacheMs), 1_000),
    supabaseUrl: envString(env, 'SUPABASE_URL'),
    supabaseAnonKey: envString(env, 'SUPABASE_ANON_KEY'),
    sqliteFile: storage.sqliteFile ?? '',
    grantFile: resolveGrantFile(env),
  };
}
