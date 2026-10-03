const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const SENTENCE_BOUNDARIES = /[。！？；!?;\n]+/;
const MIN_PIECE_LENGTH = 6;

export function normalizeWhitespace(text: string): string {
  return text.replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function normalizeKnowledgeText(text: string): string {
  const collapsed = text
    .replace(/\r\n?/g, '\n')
    .replace(/`{1,3}/g, '')
    .replace(/^[ \t]*[-*>+][ \t]+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n/g, ' ')
    .trim();
  return collapsed.replace(/([，。；：！？])\s+/g, '$1');
}

export function splitSentences(text: string, minimumLength = MIN_PIECE_LENGTH): string[] {
  const raw = text
    .split(SENTENCE_BOUNDARIES)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);

  const merged: string[] = [];
  for (const piece of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length < minimumLength) {
      merged[merged.length - 1] = `${last}，${piece}`;
    } else {
      merged.push(piece);
    }
  }
  if (merged.length === 0) {
    const whole = text.trim();
    return whole.length === 0 ? [] : [whole];
  }
  return merged;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const latin = lowered.match(/[a-z0-9_+#.-]{2,}/g) ?? [];
  const cjkRuns = lowered.match(/[\u3400-\u9FFF]+/g) ?? [];
  const grams: string[] = [...latin];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      grams.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      grams.push(run.slice(index, index + 2));
    }
  }
  return grams;
}

export function uniqueTokens(text: string): string[] {
  return Array.from(new Set(tokenize(text)));
}

export function tokenOverlap(first: string, second: string): number {
  const a = new Set(tokenize(first));
  const b = new Set(tokenize(second));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

export function cosineSimilarity(first: number[], second: number[]): number {
  const length = Math.min(first.length, second.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = first[index] ?? 0;
    const y = second[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const TITLE_STOP_PREFIX = /^(注意[:：]|提示[:：]|说明[:：]|例如[:：]|注[:：]|tip[:：]|note[:：]|example[:：])\s*/i;

export function deriveTitle(text: string, maxChars = 32): string {
  const firstLine = normalizeKnowledgeText(text).split(/[.!?。！？]/)[0] ?? text;
  const cleaned = firstLine.replace(TITLE_STOP_PREFIX, '').trim();
  const clipped = truncate(cleaned, maxChars).replace(/[，,、:：;；-]+$/u, '');
  return clipped.length === 0 ? truncate(cleaned, maxChars) : clipped;
}

export function isAsciiLatin(text: string): boolean {
  return !CJK_PATTERN.test(text);
}
