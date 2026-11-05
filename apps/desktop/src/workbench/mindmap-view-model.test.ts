import { describe, expect, it } from 'vitest';
import { buildNoteMindmap } from './mindmap-view-model';

describe('derived note mindmap view model', () => {
  it('maps duplicate headings by source offset while preserving heading levels and parentage', () => {
    const source = [
      '---',
      'title: metadata only',
      '---',
      'Intro text',
      '',
      '# Same',
      'body A',
      '### Deep',
      'body deep',
      '## Same',
      'body B',
      '# Same',
      'body C',
      '',
    ].join('\n');
    const view = buildNoteMindmap(source, 'notes/sample.md');

    expect(view.leadBody).toBe('Intro text');
    expect(view.roots.map(({ title, level }) => [title, level])).toEqual([['Same', 1], ['Same', 1]]);
    expect(view.roots[0]?.body).toBe('body A');
    expect(view.roots[0]?.children.map(({ title, level, body }) => [title, level, body])).toEqual([
      ['Deep', 3, 'body deep'],
      ['Same', 2, 'body B'],
    ]);
    expect(view.roots[1]?.body).toBe('body C');
    expect(view.roots.map(({ sourceOffset }) => sourceOffset)).toEqual([
      source.indexOf('# Same'), source.lastIndexOf('# Same'),
    ]);
    expect(new Set(view.roots.flatMap((root) => [root.id, ...root.children.map(({ id }) => id)])).size).toBe(4);
    expect(source).toContain('title: metadata only');
  });

  it('uses renderer setext heading boundaries and retains CRLF source offsets', () => {
    const source = 'Topic\r\n=====\r\nLead\r\nSubtopic\r\n---------\r\nDetail';
    const view = buildNoteMindmap(source, 'notes/crlf.md');

    expect(view.roots).toHaveLength(1);
    expect(view.roots[0]).toMatchObject({ title: 'Topic', level: 1, sourceOffset: 0, body: '' });
    expect(view.roots[0]?.children[0]).toMatchObject({ title: 'Lead\nSubtopic', level: 2, body: 'Detail' });
    expect(source.slice(view.roots[0]!.sourceOffset, view.roots[0]!.sourceOffset + 5)).toBe('Topic');
  });

  it('does not mistake fenced code headings for document hierarchy', () => {
    const source = [
      '# Real',
      'before',
      '```md',
      '## Not a heading',
      '~~~',
      '### Still code',
      '~~~',
      '```',
      'after',
      '# Next',
      'done',
    ].join('\n');
    const view = buildNoteMindmap(source);

    expect(view.roots.map(({ title }) => title)).toEqual(['Real', 'Next']);
    expect(view.roots[0]?.body).toContain('## Not a heading');
    expect(view.roots[0]?.body).toContain('### Still code');
    expect(view.roots[0]?.body).toContain('after');
  });

  it('ignores headings inside a fenced code block nested in a list and keeps the block as parent body', () => {
    const source = '# Root\n- ```md\n  # fake\n  ```\n## Real\nB';
    const view = buildNoteMindmap(source);

    expect(view.roots.map(({ title, level }) => [title, level])).toEqual([['Root', 1]]);
    expect(view.roots[0]?.body).toBe('- ```md\n  # fake\n  ```');
    expect(view.roots[0]?.children.map(({ title, level, body }) => [title, level, body])).toEqual([
      ['Real', 2, 'B'],
    ]);
  });

  it('keeps a thematic break after a list item in its body instead of creating a setext heading', () => {
    const listSource = '# Root\n- item\n---\n## Real\nB';
    const listView = buildNoteMindmap(listSource);
    expect(listView.roots.map(({ title }) => title)).toEqual(['Root']);
    expect(listView.roots[0]?.body).toBe('- item\n---');
    expect(listView.roots[0]?.children.map(({ title }) => title)).toEqual(['Real']);
  });

  it('keeps a thematic break after an indented code block in its body instead of creating a setext heading', () => {
    const codeSource = '# Root\n    code line\n---\n## Real\nB';
    const codeView = buildNoteMindmap(codeSource);
    expect(codeView.roots.map(({ title }) => title)).toEqual(['Root']);
    expect(codeView.roots[0]?.body).toBe('code line\n---');
    expect(codeView.roots[0]?.children.map(({ title }) => title)).toEqual(['Real']);
  });

  it('keeps actual setext headings and following thematic breaks in the matching body sections', () => {
    const source = '# Root\nActual child\n---\nText\n\n---\n## Real\nB';
    const view = buildNoteMindmap(source);

    expect(view.roots.map(({ title, level }) => [title, level])).toEqual([['Root', 1]]);
    expect(view.roots[0]?.children.map(({ title, level, body }) => [title, level, body])).toEqual([
      ['Actual child', 2, 'Text\n\n---'],
      ['Real', 2, 'B'],
    ]);
    expect(source).toContain('Actual child\n---');
    expect(source).toContain('Text\n\n---');
  });

  it('keeps a multi-line setext heading intact and preserves its complete following Markdown body', () => {
    const source = '# Root\nHeading line one\nHeading line two\n---\nParagraph one\n```md\n# not a heading\n```\nParagraph two';
    const view = buildNoteMindmap(source);

    expect(view.roots).toHaveLength(1);
    expect(view.roots[0]?.body).toBe('');
    expect(view.roots[0]?.children.map(({ title, level, body }) => [title, level, body])).toEqual([
      ['Heading line one\nHeading line two', 2, 'Paragraph one\n```md\n# not a heading\n```\nParagraph two'],
    ]);
  });

  it('represents plain text and empty notes without inventing headings', () => {
    expect(buildNoteMindmap('').isEmpty).toBe(true);
    expect(buildNoteMindmap('   \n\n').isEmpty).toBe(true);
    expect(buildNoteMindmap('Plain text\nsecond line')).toMatchObject({
      isEmpty: false, leadBody: 'Plain text\nsecond line', roots: [],
    });
  });

  it('handles long notes with thousands of sibling nodes in source order', () => {
    const headings = Array.from({ length: 2_500 }, (_, index) => `## Node ${index}\nBody ${index}`).join('\n');
    const source = `# Root\n${headings}`;
    const view = buildNoteMindmap(source, 'notes/long.md');

    expect(view.roots).toHaveLength(1);
    expect(view.roots[0]?.children).toHaveLength(2_500);
    expect(view.roots[0]?.children[0]).toMatchObject({ title: 'Node 0', body: 'Body 0' });
    expect(view.roots[0]?.children.at(-1)).toMatchObject({ title: 'Node 2499', body: 'Body 2499' });
    expect(view.roots[0]!.children[2_499]!.sourceOffset).toBe(source.indexOf('## Node 2499'));
  });
});
