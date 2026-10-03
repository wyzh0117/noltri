const CJK_CHAR = /[\u3400-\u9FFF\uF900-\uFAFF]/g;

/** Heuristic, model-agnostic budget guard: never used for billing. */
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_CHAR) ?? []).length;
  const latinWords = (text.replace(CJK_CHAR, ' ').match(/[A-Za-z0-9_+#.'-]+/g) ?? []).length;
  return Math.max(1, Math.ceil(cjkCount * 0.7 + latinWords * 1.3));
}

export function fitsTokenBudget(text: string, budget: number): boolean {
  return estimateTokens(text) <= budget;
}
