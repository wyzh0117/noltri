import { DEFAULT_SCOPE_TOKEN_BUDGET, DEFAULT_THRESHOLDS, type ScopeTokenBudget, type Thresholds } from '@noltri/schema';

export type EnvSource = Record<string, string | undefined>;

export function currentEnv(): EnvSource {
  const candidate = (globalThis as { process?: { env?: EnvSource } }).process;
  return candidate?.env ?? {};
}

export function envString(env: EnvSource, key: string, fallback = ''): string {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function envInt(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envFloat(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBoolean(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function loadThresholds(env: EnvSource = currentEnv()): Thresholds {
  const high = clamp01(envFloat(env, 'CLASSIFY_HIGH_CONFIDENCE', DEFAULT_THRESHOLDS.highConfidence));
  const mediumRaw = clamp01(
    envFloat(env, 'CLASSIFY_MEDIUM_CONFIDENCE', DEFAULT_THRESHOLDS.mediumConfidence),
  );
  return {
    highConfidence: high,
    mediumConfidence: Math.min(mediumRaw, high),
    similarityAttachThreshold: clamp01(
      envFloat(env, 'SIMILARITY_ATTACH_THRESHOLD', DEFAULT_THRESHOLDS.similarityAttachThreshold),
    ),
    similaritySearchLimit: envInt(env, 'SIMILARITY_SEARCH_LIMIT', DEFAULT_THRESHOLDS.similaritySearchLimit),
    candidateNodeLimit: envInt(env, 'CLASSIFY_CANDIDATE_LIMIT', DEFAULT_THRESHOLDS.candidateNodeLimit),
    minNewNodeItemCount: envInt(env, 'MIN_NEW_NODE_ITEMS', DEFAULT_THRESHOLDS.minNewNodeItemCount),
  };
}

export function loadScopeBudgets(env: EnvSource = currentEnv()): ScopeTokenBudget {
  return {
    current_node: envInt(env, 'TOKEN_BUDGET_NODE', DEFAULT_SCOPE_TOKEN_BUDGET.current_node),
    section: envInt(env, 'TOKEN_BUDGET_SECTION', DEFAULT_SCOPE_TOKEN_BUDGET.section),
    tree: envInt(env, 'TOKEN_BUDGET_TREE', DEFAULT_SCOPE_TOKEN_BUDGET.tree),
    whole_library: envInt(env, 'TOKEN_BUDGET_LIBRARY', DEFAULT_SCOPE_TOKEN_BUDGET.whole_library),
  };
}

export type StorageDriver = 'memory' | 'sqlite';

const STORAGE_DRIVERS: readonly StorageDriver[] = ['memory', 'sqlite'];

export function loadStorageDriver(env: EnvSource = currentEnv()): StorageDriver {
  const raw = envString(env, 'STORAGE_DRIVER', 'memory').toLowerCase();
  const found = STORAGE_DRIVERS.find((driver) => driver === raw);
  if (found === undefined) {
    throw new Error(
      `Unknown STORAGE_DRIVER "${raw}" — expected one of ${STORAGE_DRIVERS.map((driver) => `"${driver}"`).join(', ')}`,
    );
  }
  return found;
}

export type AiDriver = 'openai' | 'offline';

export interface AiProviderConfig {
  driver: AiDriver;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  embeddingDim: number;
  timeoutMs: number;
  temperature: number;
}

export function loadAiConfig(env: EnvSource = currentEnv()): AiProviderConfig {
  const raw = envString(env, 'AI_PROVIDER', 'offline').toLowerCase();
  if (raw !== 'openai' && raw !== 'offline') {
    throw new Error(`Unknown AI_PROVIDER "${raw}" — expected "openai" or "offline"`);
  }
  const driver: AiDriver = raw;
  return {
    driver,
    apiKey: envString(env, 'AI_API_KEY'),
    baseUrl: envString(env, 'AI_BASE_URL', 'https://api.openai.com/v1'),
    chatModel: envString(env, 'AI_CHAT_MODEL', 'gpt-4o-mini'),
    embedModel: envString(env, 'AI_EMBED_MODEL', 'text-embedding-3-small'),
    embeddingDim: envInt(env, 'AI_EMBEDDING_DIM', 1536),
    timeoutMs: envInt(env, 'AI_REQUEST_TIMEOUT_MS', 45_000),
    temperature: envFloat(env, 'AI_TEMPERATURE', 0.2),
  };
}
