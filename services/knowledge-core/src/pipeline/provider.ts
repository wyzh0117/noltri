/**
 * Every provider touchpoint goes through here.
 *
 * Two guarantees: (1) Knowledge Core only ever speaks the frozen `AIProvider` interface, so no SDK
 * import can leak into business logic (PROJECT_MASTER §8 "AI Layer"); (2) a throw becomes a typed
 * `provider_error`, which is what lets the capture pipeline mark the RawSource `failed` while
 * keeping the original material safe (V1_DEVELOPMENT §9).
 */
import { isKnowledgeError, knowledgeError, truncate, type KnowledgeError } from '@noltri/shared';
import type { CoreDeps } from '../types';

export const PROVIDER_TIMEOUT_LABEL = 'provider';

export function asProviderError(label: string, cause: unknown): KnowledgeError {
  if (isKnowledgeError(cause) && cause.code !== 'internal_error') return cause;
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  return knowledgeError('provider_error', `${label} 调用失败 / ${label} call failed: ${truncate(message, 240)}`, {
    label,
  });
}

/** Wraps one provider call. Storage errors are never relabelled as provider errors. */
export async function callProvider<T>(label: string, _deps: CoreDeps, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw asProviderError(label, error);
  }
}

/** True when a thrown error came from the model layer and therefore means "retryable later". */
export function isProviderFailure(error: unknown): boolean {
  return isKnowledgeError(error) && error.code === 'provider_error';
}
