import { describe, expect, it } from 'vitest';
import { incompleteWikiLinkAt, replaceMentionAt } from './notes-model';

describe('Markdown link completion', () => {
  it('finds only the unfinished wiki link before the editor cursor', () => {
    expect(incompleteWikiLinkAt('[[done]] then [[read', 20)).toEqual({ start: 14, end: 20, query: 'read' });
    expect(incompleteWikiLinkAt('[[done]]', 8)).toBeNull();
    expect(incompleteWikiLinkAt('[[unfinished\nparagraph', 13)).toBeNull();
    expect(incompleteWikiLinkAt('[[unfinished|alias', 19)).toBeNull();
  });

  it('writes a readable alias while preserving the canonical target path', () => {
    expect(replaceMentionAt('A readable title', 0, 16, 'A readable title', '/_library/Items/item.md', 'Source title'))
      .toBe('[[/_library/Items/item.md|Source title]]');
  });
});
