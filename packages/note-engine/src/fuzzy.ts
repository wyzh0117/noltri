import type { Span } from './types';
export interface FuzzyMatch { score: number; matches: Span[] }
/** Independent subsequence scorer; stable tie breaks never depend on host locale. */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  const wanted = [...query.normalize('NFC').toLocaleLowerCase('und')].filter((char) => !/\s/u.test(char));
  if (!wanted.length) return { score: 0, matches: [] };
  const chars: string[] = [], offsets: number[] = [], ends: number[] = [];
  for (const segment of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(candidate)) for (const char of segment.segment.normalize('NFC')) { chars.push(char); offsets.push(segment.index); ends.push(segment.index + segment.segment.length); }
  const lower = chars.map((char) => char.toLocaleLowerCase('und'));
  let best: FuzzyMatch | null = null;
  // ponytail: quadratic scans suit short switcher labels; use DP if long documents become candidates.
  for (let start = 0; start < chars.length; start++) {
    if (lower[start] !== wanted[0]) continue;
    const indices = [start]; let cursor = start + 1;
    for (const char of wanted.slice(1)) { while (cursor < chars.length && lower[cursor] !== char) cursor++; if (cursor === chars.length) break; indices.push(cursor++); }
    if (indices.length !== wanted.length) continue;
    let segments = 1, penalty = 0;
    for (let index = 1; index < indices.length; index++) {
      const previous = indices[index - 1], current = indices[index];
      if (current > previous + 1) {
        segments++;
        for (let skipped = previous + 1; skipped < current; skipped++) if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chars[skipped]) || /[^\p{L}\p{N}]/u.test(chars[skipped - 1] ?? '') || (/[a-z]/.test(chars[skipped - 1] ?? '') && /[A-Z]/.test(chars[skipped]))) penalty++;
      }
    }
    const score = -(segments - 1) - penalty / 10 - (indices.at(-1)! - start + 1 - wanted.length) / 100 - start / 1000 - chars.length / 10000;
    const matches: Span[] = [];
    for (const index of indices) { const from = offsets[index], to = ends[index]; const last = matches.at(-1); if (last && last.to >= from) last.to = Math.max(last.to, to); else matches.push({ from, to }); }
    if (!best || score > best.score) best = { score, matches };
  }
  return best;
}
export function rankFuzzy<T extends { id: string; title: string; recent?: number }>(query: string, items: readonly T[]): (T & FuzzyMatch)[] {
  return items.flatMap((item) => { const match = fuzzyMatch(query, item.title); return match ? [{ ...item, ...match }] : []; }).sort((a, b) => b.score - a.score || (b.recent ?? 0) - (a.recent ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
