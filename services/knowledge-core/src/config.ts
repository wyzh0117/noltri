/**
 * Configuration is the only place a number lives.
 *
 * PROJECT_MASTER §3.6 forbids hardcoded classification thresholds in code paths, so every tunable
 * below is read from the environment (`loadThresholds` / `loadScopeBudgets` already clamp and
 * validate), and pipeline / service modules receive values through `CoreConfig` only.
 * The defaults exported here are documentation of what the environment falls back to.
 */
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
} as const;

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
  };
}
