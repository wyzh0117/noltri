import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_GRAPH_NOTE_CHARS } from '@noltri/schema';
import { clearNoteDraft, listNoteDrafts, readNoteDraft, writeNoteDraft } from './note-drafts';

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); }
  getItem(key: string): string | null { return this.entries.get(key) ?? null; }
  key(index: number): string | null { return [...this.entries.keys()][index] ?? null; }
  removeItem(key: string): void { this.entries.delete(key); }
  setItem(key: string, value: string): void { this.entries.set(key, String(value)); }
}

describe('recoverable note drafts', () => {
  const storage = new MemoryStorage();

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it('stores notes independently by topic and chapter identity', () => {
    vi.stubGlobal('window', { localStorage: storage });
    const topicDraft = { topicId: 'topic-a', chapterId: null, content: 'overview', updatedAt: '2026-10-20T00:00:00.000Z' };
    const chapterDraft = { topicId: 'topic-a', chapterId: 'chapter-a', content: 'chapter body', updatedAt: '2026-10-20T00:01:00.000Z' };

    expect(writeNoteDraft(topicDraft)).toBe(true);
    expect(writeNoteDraft(chapterDraft)).toBe(true);
    expect(readNoteDraft(topicDraft)).toEqual(topicDraft);
    expect(listNoteDrafts()).toEqual([topicDraft, chapterDraft]);
  });

  it('clears only the version the server accepted, preserving edits made in flight', () => {
    vi.stubGlobal('window', { localStorage: storage });
    const identity = { topicId: 'topic-a', chapterId: null };
    const oldDraft = { ...identity, content: 'sent', updatedAt: '2026-10-20T00:00:00.000Z' };
    const newerDraft = { ...identity, content: 'newer edit', updatedAt: '2026-10-20T00:01:00.000Z' };

    expect(writeNoteDraft(oldDraft)).toBe(true);
    expect(writeNoteDraft(newerDraft)).toBe(true);
    expect(clearNoteDraft(identity, oldDraft.content)).toBe(true);
    expect(readNoteDraft(identity)).toEqual(newerDraft);
    expect(clearNoteDraft(identity, newerDraft.content)).toBe(true);
    expect(readNoteDraft(identity)).toBeNull();
  });

  it('keeps over-limit text intact in the local recovery layer', () => {
    vi.stubGlobal('window', { localStorage: storage });
    const content = 'x'.repeat(MAX_GRAPH_NOTE_CHARS + 1);
    const identity = { topicId: 'topic-large', chapterId: null };

    expect(writeNoteDraft({ ...identity, content, updatedAt: '2026-10-20T00:00:00.000Z' })).toBe(true);
    expect(readNoteDraft(identity)?.content).toBe(content);
  });
});
