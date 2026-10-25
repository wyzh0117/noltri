import { describe, it, expect } from 'vitest';
import { parseMarkdown, setFrontmatterProperties, findUnlinkedMentions, resolveKnowledgeLink, rewriteReferences, formatLinkTarget, compileQuery, matchQuery, matchingCourseIds, rankFuzzy, fuzzyMatch, type LinkTarget } from '../src';

const targets: LinkTarget[] = [
  { courseId: 'cpp', title: 'C++', path: '理学/计算机/C++', aliases: ['C 语言进阶'], headings: [
    { depth: 2, text: '变量', path: ['变量'], from: 0, to: 0, contentFrom: 0, contentTo: 30, courseChapterId: 'cpp-var' },
    { depth: 3, text: '作用域', path: ['变量', '作用域'], from: 4, to: 12, contentFrom: 12, contentTo: 30, courseChapterId: 'cpp-var', entryId: 'cpp-entry' },
  ], blocks: [{ id: 'stable-block', alias: '定义', type: 'paragraph', text: '变量定义', from: 0, to: 10, entryId: 'cpp-entry', courseChapterId: 'cpp-var' }] },
  { courseId: 'python', title: 'Python', path: '理学/计算机/Python', headings: [{ depth: 2, text: '变量', path: ['变量'], from: 0, to: 0, contentFrom: 0, contentTo: 10, courseChapterId: 'py-var' }] },
  { courseId: 'cafe', title: 'Café\u00a0 Notes', path: '语言/Café Notes' },
];

describe('CommonMark metadata with UTF-16 locations', () => {
  it('extracts properties, wiki/property/reference links, embeds, tags, sections, tasks, blocks and footnotes', () => {
    const content = '---\naliases: [课程别名]\ntags: [中文, a/b]\nrelated: "[[C++#变量|保留]]"\nunknown: {nested: 9}\n---\n# 😀课程\n## 变量\n### 作用域\n- [ ] 学习 #中文\n- [x] 完成\n正文 [[C++#变量|显示]] ![[Python]] [链接][ref] #a/b\n\n定义 ^块1\n\n注[^1]\n\n[^1]: 脚注\n\n[ref]: Python.md\n\n`[[不应解析]] #排除`\n\n```md\n## 假标题\n[[假引用]]\n```\n';
    const meta = parseMarkdown(content);
    expect(meta.aliases).toEqual(['课程别名']); expect(meta.properties.unknown).toEqual({ nested: 9 });
    expect(meta.headings.map((heading) => heading.text)).toEqual(['😀课程', '变量', '作用域']);
    expect(meta.headings[2].path).toEqual(['😀课程', '变量', '作用域']);
    for (const heading of meta.headings) expect(content.slice(heading.from, heading.to)).toContain(heading.text);
    expect(meta.links.map((link) => [link.target, link.kind, link.embed])).toEqual([
      ['C++#变量', 'property', false], ['C++#变量', 'wiki', false], ['Python', 'wiki', true], ['Python.md', 'reference', false],
    ]);
    expect(meta.links[0].propertyPath).toEqual(['related']);
    expect(meta.tags.map((tag) => tag.tag)).toEqual(['中文', 'a/b', '中文', 'a/b']);
    expect(meta.tasks.map((task) => task.checked)).toEqual([false, true]);
    expect(meta.blocks.filter((block) => block.alias).map((block) => block.alias)).toEqual(['块1']);
    expect(meta.footnotes).toHaveLength(2);
  });
  it('CJK mentions exclude frontmatter, existing links, embeds, code and Latin substrings', () => {
    const text = '---\nalias: 变量\n---\n学习变量和变量。 TypeScript type types。 [[变量]] ![[变量]] [变量](target) `变量`\n\n```\n变量\n```';
    const found = findUnlinkedMentions(text, ['变量', 'type']);
    expect(found.map((match) => text.slice(match.from, match.to))).toEqual(['变量', '变量', 'type']);
    const first = found[0]; const linked = text.slice(0, first.from) + `[[${text.slice(first.from, first.to)}]]` + text.slice(first.to);
    expect(findUnlinkedMentions(linked, ['变量'])).toHaveLength(1);
  });
  it('section ends before the next heading of the same or shallower depth', () => {
    const text = '## A\n正文\n### B\n子正文\n## C\n尾'; const metadata = parseMarkdown(text);
    expect(metadata.headings[0].contentTo).toBe(text.indexOf('## C'));
    expect(metadata.headings[1].contentTo).toBe(text.indexOf('## C'));
    expect(metadata.headings[2].contentTo).toBe(text.length);
  });
  it('handles empty YAML and edits exact keys without changing the body', () => {
    const content = '---\n---\n正文';
    const changed = setFrontmatterProperties(content, { tags: ['中文'], unknown: { value: 3 } });
    expect(parseMarkdown(changed).properties).toEqual({ tags: ['中文'], unknown: { value: 3 } });
    expect(changed.slice(parseMarkdown(changed).frontmatter!.to)).toBe('\n正文');
    expect(parseMarkdown('- list item ^id').blocks.filter((block) => block.alias)).toHaveLength(1);
  });
});

describe('stable course-local knowledge resolution', () => {
  it.each([
    ['[[]]', 'python', 'resolved', 'python', undefined],
    ['[[C++]]', 'python', 'resolved', 'cpp', undefined],
    ['[[C++|别名]]', 'python', 'resolved', 'cpp', undefined],
    ['[[C++#变量]]', 'python', 'resolved', 'cpp', 'cpp-var'],
    ['[[#变量]]', 'python', 'resolved', 'python', 'py-var'],
    ['![[C 语言进阶]]', 'python', 'resolved', 'cpp', undefined],
    ['[[C++#变量#作用域]]', 'python', 'resolved', 'cpp', 'cpp-var'],
    ['[[C++#^定义]]', 'python', 'resolved', 'cpp', 'cpp-var'],
    ['[[C++#不存在]]', 'python', 'subpath-missing', 'cpp', undefined],
    ['[[C++#^不存在]]', 'python', 'subpath-missing', 'cpp', undefined],
    ['[[新课程]]', 'python', 'unresolved', undefined, undefined],
    ['[[CAFE\u0301  notes]]', 'python', 'resolved', 'cafe', undefined],
  ])('%s in %s returns %s', (raw, courseId, status, targetCourse, chapter) => {
    const result = resolveKnowledgeLink({ courseId }, raw, targets);
    expect(result.status).toBe(status);
    if ('target' in result) { expect(result.target.courseId).toBe(targetCourse); expect(result.target.courseChapterId).toBe(chapter); }
  });
  it('returns ambiguity for duplicate course names, aliases, heading instances, and imports', () => {
    const duplicate = [...targets, { ...targets[0], courseId: 'cpp2', path: '工学/计算机/C++' }];
    expect(resolveKnowledgeLink({ courseId: 'python' }, '[[C++]]', duplicate).status).toBe('ambiguous');
    expect(resolveKnowledgeLink({ courseId: 'python' }, '[[理学/计算机/C++#变量]]', duplicate)).toMatchObject({ status: 'resolved', target: { courseId: 'cpp', courseChapterId: 'cpp-var' } });
    expect(resolveKnowledgeLink({ courseId: 'python', importPaths: { 'notes/a.md': [{ kind: 'course', courseId: 'cpp' }, { kind: 'course', courseId: 'python' }] }, sourcePath: 'notes/source.md' }, './a.md', targets).status).toBe('ambiguous');
    const heads = [{ ...targets[0], headings: [...targets[0].headings!, { ...targets[0].headings![0], courseChapterId: 'second' }] }];
    expect(resolveKnowledgeLink({ courseId: 'cpp' }, '[[#变量]]', heads).status).toBe('ambiguous');
  });
  it('controlled imported relative paths never become filesystem paths', () => {
    const context = { courseId: 'python', sourcePath: 'notes/source.md', importPaths: { 'notes/a.md': [{ kind: 'course' as const, courseId: 'cpp' }] } };
    expect(resolveKnowledgeLink(context, './a.md#变量', targets)).toMatchObject({ status: 'resolved', target: { courseId: 'cpp' } });
    for (const raw of ['../../etc/passwd', 'file:///etc/passwd', 'javascript:alert(1)', '%E0%A4%A']) expect(resolveKnowledgeLink(context, raw, targets).status).toBe('unresolved');
  });
  it('stable course identity survives names changing; block formatting uses the current alias', () => {
    expect(resolveKnowledgeLink({ courseId: 'python', stableTarget: { kind: 'course', courseId: 'cpp' } }, '[[旧名]]', targets)).toEqual({ status: 'resolved', target: { kind: 'course', courseId: 'cpp' } });
    expect(formatLinkTarget({ kind: 'entry', courseId: 'cpp', entryId: 'cpp-entry', blockId: 'stable-block' }, targets)).toBe('cpp#^定义');
    expect(resolveKnowledgeLink({ courseId: 'python', stableTarget: { kind: 'entry', courseId: 'cpp', entryId: 'cpp-entry', blockId: 'stable-block' } }, '[[旧名#^旧块名]]', targets)).toMatchObject({ status: 'resolved', target: { blockId: 'stable-block' } });
  });
});

describe('reference-aware rewrites', () => {
  it('rewrites only AST references, preserves custom labels/Markdown display and YAML unknown keys/comments', () => {
    const text = '---\nrelated: "[[Old|自定义]]" # keep\nuntouched: "Old"\nnested:\n  relation: "[[Old]]"\n---\n[[Old|自定义]] [[Old|Old]] [Old](Old.md)\n`[[Old]]`\n正文 Old';
    const links = parseMarkdown(text).links;
    const result = rewriteReferences(text, links.map((reference) => ({ reference, target: reference.kind === 'markdown' ? 'New.md' : 'New', oldDefaultLabel: 'Old' })));
    expect(result).toContain('[[New|自定义]]'); expect(result).toContain('[[New|New]]'); expect(result).toContain('[Old](New.md)');
    expect(result).toContain('untouched: "Old"'); expect(result).toContain('# keep'); expect(result).toContain('`[[Old]]`'); expect(result).toContain('正文 Old');
    expect(parseMarkdown(result).properties).toMatchObject({ related: '[[New|自定义]]', nested: { relation: '[[New]]' } });
  });
  it('renames 100 references within one second with zero unresolved targets', () => {
    const text = Array.from({ length: 100 }, (_, index) => `引用${index} [[Old|标签${index}]]`).join('\n'); const start = performance.now();
    const result = rewriteReferences(text, parseMarkdown(text).links.map((reference) => ({ reference, target: 'cpp' })));
    expect(parseMarkdown(result).links.every((link) => resolveKnowledgeLink({ courseId: 'python' }, link.target, targets).status === 'resolved')).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('retains balanced/escaped destination parentheses when rewriting Markdown and definition targets', () => {
    const text = '[label](folder/a(b).md) [second][a:b]\n\n[a:b]: folder/a\\(b\\).md';
    const metadata = parseMarkdown(text);
    const rewritten = rewriteReferences(text, metadata.links.map((reference) => ({ reference, target: 'cpp' })));
    expect(rewritten).toBe('[label](cpp) [second][a:b]\n\n[a:b]: cpp');
  });
});

describe('one query AST for search and graph', () => {
  const content = '## 变量\n中文 alpha beta\n\n分块 gamma\n- [ ] unfinished alpha\n- [x] completed beta';
  const object = { id: 'entry:a', courseId: 'cpp', title: 'C++', path: '理学/计算机/C++/变量', file: 'lesson.md', content, tags: ['编程/基础', 'blue'], properties: { rating: 7, active: true, owner: 'Alice' }, metadata: parseMarkdown(content) };
  it.each([
    ['中文 "alpha beta"', true], ['中文 -missing', true], ['(missing OR 中文) alpha', true], ['missing OR 中文 alpha', true], ['中文 missing', false],
    ['path:计算机 file:lesson.md content:中文', true], ['line:(alpha beta)', true], ['line:(gamma alpha)', false], ['block:(gamma alpha)', false],
    ['section:(gamma alpha)', true], ['task-todo:unfinished', true], ['task-done:completed', true], ['task-todo:completed', false],
    ['tag:编程', true], ['tag:编', false], ['[rating:>6] [active:true] [owner:alice]', true], ['[rating<=7] [owner]', true],
    ['match-case:alice', false], ['match-case:content:ALPHA', false], ['ignore-case:content:ALPHA', true], [String.raw`content:/alpha\s+beta/i`, true],
    ['-(tag:red OR [rating:<3])', true],
  ])('%s → %s', (query, expected) => expect(matchQuery(compileQuery(query), object).matched).toBe(expected));
  it.each(['path:(file:foo)', 'block:(content:foo)', 'section:(line:foo)', 'task:(task-done:foo)', 'attachment:x', 'orphan:true', '(中文', '中文 OR', '[owner:alice', '/unterminated'])('rejects %s explicitly', (query) => expect(() => compileQuery(query)).toThrow());
  it('returns exact field ranges and supports budgets/cancellation, including adversarial regular expressions', () => {
    const result = matchQuery(compileQuery('content:中文'), object); expect(content.slice(result.hits[0].from, result.hits[0].to)).toBe('中文');
    const controller = new AbortController(); controller.abort(); expect(() => matchQuery(compileQuery('中文'), object, { signal: controller.signal })).toThrow('cancelled');
    expect(() => matchQuery(compileQuery('中文'), object, { budgetMs: -1 })).toThrow('budget');
    expect(matchQuery(compileQuery('content:/(a+)+$/'), { id: 'x', content: `${'a'.repeat(20000)}!` }, { budgetMs: 1000 }).matched).toBe(false);
  });
  it('applies complete AND to one object before projecting a course', () => {
    const objects = [{ id: 'a', courseId: 'course', content: 'alpha', tags: ['red'] }, { id: 'b', courseId: 'course', content: 'beta', tags: ['blue'] }];
    expect([...matchingCourseIds(compileQuery('alpha tag:blue'), objects)]).toEqual([]);
    expect([...matchingCourseIds(compileQuery('beta tag:blue'), objects)]).toEqual(['course']);
  });
  it('finds first batch from 10,000 ready objects within 300 ms', () => {
    const objects = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), content: `课文${index} 中文 alpha`, tags: ['编程'] })); const ast = compileQuery('中文 tag:编程'); const start = performance.now();
    const hits = []; for (const entry of objects) { if (matchQuery(ast, entry).matched) hits.push(entry.id); if (hits.length === 30) break; }
    expect(hits).toHaveLength(30); expect(performance.now() - start).toBeLessThan(300);
  });
});

it('deterministically ranks CJK/camelCase with matching character ranges', () => {
  const ranked = rankFuzzy('nfr', [{ id: '2', title: 'NoltriFileReader' }, { id: '1', title: 'nfr' }, { id: '3', title: 'no funny rabbits' }]);
  expect(ranked.map((item) => item.id)).toEqual(['1', '3', '2']);
  expect(fuzzyMatch('变量', 'C++变量作用域')?.matches).toEqual([{ from: 3, to: 5 }]);
  expect(fuzzyMatch('é', 'Cafe\u0301')?.matches).toEqual([{ from: 3, to: 5 }]);
  expect(rankFuzzy('中文', [{ id: 'b', title: '中文', recent: 1 }, { id: 'a', title: '中文', recent: 2 }]).map((item) => item.id)).toEqual(['a', 'b']);
});
