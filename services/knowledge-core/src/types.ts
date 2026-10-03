/**
 * Shared seams for Knowledge Core.
 *
 * Nothing here imports an HTTP framework: the domain layer is host-agnostic and is driven by
 * `src/http/router.ts` (web standards only), by the future MCP server, or directly in tests.
 */
import type { AIProvider } from '@noltri/ai-provider';
import type { Logger } from '@noltri/shared';
import type { KnowledgeRepository } from '@noltri/storage';
import type { CoreConfig } from './config';

/**
 * Who is acting. `userId` always comes from the authenticated request (see `src/auth.ts`),
 * never from a body or query field — V1 has no tenant switching in the payload.
 */
export interface ActorContext {
  readonly userId: string;
  /** Written into VersionRecord.actor, e.g. "web_app" | "desktop" | "extension" | "mcp" | "api". */
  readonly actor: string;
}

/** Everything a core service or pipeline step needs. Constructed once, in `createKnowledgeCore`. */
export interface CoreDeps {
  readonly repository: KnowledgeRepository;
  readonly provider: AIProvider;
  readonly config: CoreConfig;
  readonly logger: Logger;
}

/** Upper bound of a node chain the pipeline is willing to create from one classification answer. */
export const MAX_NODE_PATH_DEPTH = 6;

/** error_reason is stored trimmed so a stack trace never becomes knowledge data. */
export const ERROR_REASON_MAX_CHARS = 500;

/** Node titles are capped by the frozen `updateNodeInputSchema` (max 200). */
export const MAX_NODE_TITLE_CHARS = 200;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Deterministic, storage-safe confidence rounding (three decimals keeps tier boundaries stable). */
export function roundConfidence(value: number): number {
  return Number(clamp01(value).toFixed(3));
}
