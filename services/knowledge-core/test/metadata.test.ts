import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown, type ParsedMarkdown } from '@noltri/note-engine';
import { createInMemoryRepository } from '@noltri/storage';
import { createOfflineProvider } from '@noltri/ai-provider';
import { silentLogger } from '@noltri/shared';
import type { CoreDeps } from '../src/types';
import { testConfig } from './fakes';
import { loadWorkspace } from '../src/services/course-workspace';
import { getMetadataIndex, searchKnowledge, getBacklinks, resolveWorkspaceLink, rebuildMetadata, closeMetadata, subscribeMetadata } from '../src/services/metadata';
import { MarkdownParseThread, MetadataWorker } from '../src/workers/metadata-worker';

const actor = { userId: 'meta-user', actor: 'test' };
const closing: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closing.splice(0).map((close) => close())); });
async function fixture() {
  const repository = createInMemoryRepository();
  const deps: CoreDeps = { repository, provider: createOfflineProvider(), config: testConfig(), logger: silentLogger };
  closing.push(() => closeMetadata(deps, actor.userId));
  const a = await repository.createNode({ userId: actor.userId, title: 'C++', nodeType: 'topic' });
  const b = await repository.createNode({ userId: actor.userId, title: 'Python', nodeType: 'topic' });
  const shared = await repository.createNode({ userId: actor.userId, title: '变量', nodeType: 'chapter' });
  for (const course of [a, b]) await repository.createEdge({ userId: actor.userId, fromNodeId: shared.id, toNodeId: course.id, relationType: 'part_of', source: 'topic_chapter' });
  await repository.saveKnowledgeNote({ userId: actor.userId, topicId: a.id, chapterId: shared.id, content: '### 作用域\nC++ 独立正文 #编程/基础\n\n定义 ^变量定义' });
  await repository.saveKnowledgeNote({ userId: actor.userId, topicId: b.id, chapterId: shared.id, content: 'Python 独立正文 [[C++#变量]] [[C++#变量]] [[未来课程]]' });
  return { deps, repository, a, b, shared };
}

describe('metadata queues and real Node parse worker', () => {
  it('parses in the worker thread and isolates malformed YAML from subsequent work', async () => {
    const thread = new MarkdownParseThread(); closing.push(() => thread.close());
    expect((await thread.parse('## 中文\n正文')).headings[0].text).toBe('中文');
    await expect(thread.parse('---\na: [\n---\n正文')).rejects.toThrow('YAML');
    expect((await thread.parse('## 后续')).headings[0].text).toBe('后续');
  });
  it('caches by SHA/version/config, discards old revisions and invalidates resolution independently', async () => {
    let complete: ((metadata: ParsedMarkdown) => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const worker = new MetadataWorker(async (content) => content === 'slow' ? new Promise<ParsedMarkdown>((resolve) => { complete = resolve; started!(); }) : parseMarkdown(content));
    const old = worker.parse({ id: 'a', revision: 1, content: 'slow' }); await began;
    const current = worker.parse({ id: 'a', revision: 2, content: '## 新内容' });
    complete!(parseMarkdown('slow')); expect(await old).toBeUndefined();
    const result = (await current)!;
    await worker.parse({ id: 'b', revision: 1, content: '## 新内容' }); expect(worker.stats.cacheHits).toBe(1);
    await worker.parse({ id: 'b', revision: 2, content: '## 新内容', configVersion: '2' }); expect(worker.stats.parsed).toBe(3);
    worker.setGeneration(3);
    expect(await worker.resolve({ id: 'a', revision: 2, generation: 2, metadata: result.metadata, context: { courseId: 'a' }, targets: [] })).toBeUndefined();
    expect(await worker.resolve({ id: 'a', revision: 2, generation: 3, metadata: result.metadata, context: { courseId: 'a' }, targets: [] })).toEqual([]);
    expect(worker.stats.discarded).toBe(2);
    const controller = new AbortController(); controller.abort(); expect(await worker.parse({ id: 'cancelled', revision: 1, content: 'content', signal: controller.signal })).toBeUndefined();
  });
  it('failed jobs cannot poison later entries', async () => {
    const worker = new MetadataWorker(async (content) => { if (content === 'bad') throw new Error('bad'); return parseMarkdown(content); });
    const failed = worker.parse({ id: 'a', revision: 1, content: 'bad' });
    const good = worker.parse({ id: 'b', revision: 1, content: '## 好' });
    await expect(failed).rejects.toThrow('bad'); expect((await good)?.metadata.headings[0].text).toBe('好'); expect(worker.stats.failures).toBe(1);
  });
});

describe('authoritative metadata/search/backlink service', () => {
  it('keeps shared chapter instances separate and preserves every reference occurrence', async () => {
    const { deps, a, b } = await fixture();
    const events: number[] = []; const unsubscribe = subscribeMetadata(deps, actor.userId, (event) => events.push(event.revision));
    const index = await getMetadataIndex(deps, actor); const state = await loadWorkspace(deps, actor);
    const cppChapter = state.chapters.find((chapter) => chapter.courseId === a.id)!;
    const pyChapter = state.chapters.find((chapter) => chapter.courseId === b.id)!;
    const backlinks = await getBacklinks(deps, actor, { kind: 'chapter', courseId: a.id, courseChapterId: cppChapter.id });
    expect(backlinks.count).toBe(2); expect(new Set(backlinks.references.map((link) => link.reference.from)).size).toBe(2);
    expect((await getBacklinks(deps, actor, { kind: 'chapter', courseId: b.id, courseChapterId: pyChapter.id })).count).toBe(0);
    expect((await getBacklinks(deps, actor, { kind: 'course', courseId: a.id })).count).toBe(2);
    expect(index.objects.filter((object) => object.kind === 'entry' && object.courseId === a.id)[0].content).not.toContain('Python');
    expect(await resolveWorkspaceLink(deps, actor, { courseId: b.id }, '[[C++#变量#作用域]]')).toMatchObject({ status: 'resolved', target: { courseId: a.id, headingPath: ['变量', '作用域'] } });
    expect(events).toEqual([index.revision]); unsubscribe();
  });
  it('reconnects unresolved references after target creation without editing source text and can rebuild cache', async () => {
    const { deps, repository } = await fixture(); const before = await getMetadataIndex(deps, actor);
    expect(before.links.find((link) => link.reference.target === '未来课程')?.resolution.status).toBe('unresolved');
    const future = await repository.createNode({ userId: actor.userId, title: '未来课程', nodeType: 'topic' });
    const after = await getMetadataIndex(deps, actor);
    expect(after.links.find((link) => link.reference.target === '未来课程')?.resolution).toEqual({ status: 'resolved', target: { kind: 'course', courseId: future.id } });
    const rebuilt = await rebuildMetadata(deps, actor); expect(rebuilt.links).toEqual(after.links); expect(rebuilt.revision).toBe(after.revision);
  });
  it('searches exact objects, returns stable cursor, and respects actor snippet caps and user isolation', async () => {
    const { deps, a } = await fixture();
    const search = await searchKnowledge(deps, actor, 'content:独立正文', undefined, { limit: 1 });
    expect(search.hits).toHaveLength(1); expect(search.cursor).toBeTruthy();
    const next = await searchKnowledge(deps, { ...actor, snippetChars: 5 }, 'content:独立正文', search.cursor, { limit: 1 });
    expect(next.hits).toHaveLength(1); expect(next.hits[0].id).not.toBe(search.hits[0].id); expect(next.hits[0].snippet.length).toBeLessThanOrEqual(5);
    expect((await searchKnowledge(deps, actor, 'content:Python tag:编程')).hits).toEqual([]);
    expect((await searchKnowledge(deps, actor, 'tag:编程')).hits[0].location).toMatchObject({ courseId: a.id, kind: 'entry' });
    expect((await searchKnowledge(deps, actor, 'file:lesson.md')).hits).toEqual([]);
    await expect(searchKnowledge(deps, actor, 'content:中文', search.cursor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getMetadataIndex(deps, { userId: 'other', actor: 'test' })).objects).toEqual([]); await closeMetadata(deps, 'other');
  });
});
