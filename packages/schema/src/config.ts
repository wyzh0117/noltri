import { z } from 'zod';
import type { ConfidenceTier, ContextScope } from './enums';

export const thresholdsSchema = z.object({
  highConfidence: z.number().min(0).max(1),
  mediumConfidence: z.number().min(0).max(1),
  similarityAttachThreshold: z.number().min(0).max(1),
  similaritySearchLimit: z.number().int().min(1).max(50),
  candidateNodeLimit: z.number().int().min(1).max(200),
  minNewNodeItemCount: z.number().int().min(1).max(20),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  highConfidence: 0.75,
  mediumConfidence: 0.55,
  similarityAttachThreshold: 0.82,
  similaritySearchLimit: 8,
  candidateNodeLimit: 40,
  minNewNodeItemCount: 1,
};

export const scopeTokenBudgetSchema = z.record(
  z.enum(['current_node', 'section', 'tree', 'whole_library']),
  z.number().int().min(500).max(60_000),
);
export type ScopeTokenBudget = z.infer<typeof scopeTokenBudgetSchema>;

export const DEFAULT_SCOPE_TOKEN_BUDGET: ScopeTokenBudget = {
  current_node: 2_000,
  section: 5_000,
  tree: 12_000,
  whole_library: 24_000,
};

export function tierForConfidence(confidence: number, thresholds: Thresholds): ConfidenceTier {
  if (confidence >= thresholds.highConfidence) return 'high';
  if (confidence >= thresholds.mediumConfidence) return 'medium';
  return 'low';
}

export function budgetForScope(scope: ContextScope, budgets: ScopeTokenBudget): number {
  return budgets[scope] ?? budgets.current_node;
}
