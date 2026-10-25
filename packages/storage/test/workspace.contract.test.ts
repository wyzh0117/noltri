import { describe, it, expect } from 'vitest';
import { createInMemoryRepository } from '../src/in-memory';
import { createSqliteRepository } from '../src/sqlite';
import { emptyWorkspaceState } from '../src/workspace';

describe.each(['memory', 'sqlite'] as const)('%s workspace atomic contract', (driver) => {
  const repo = () => driver === 'memory' ? createInMemoryRepository() : createSqliteRepository({ file: ':memory:' });
  it('persists deep copies, rejects stale CAS, tenant spoofing and cross-course chapters without partial writes', async () => {
    const repository = await repo();
    const state = emptyWorkspaceState();
    state.courses.push({ id: 'a', userId: 'u', title: 'A', documentRevision: 1, properties: {}, updatedAt: 'now' }, { id: 'b', userId: 'u', title: 'B', documentRevision: 1, properties: {}, updatedAt: 'now' });
    state.concepts.push({ id: 'concept', userId: 'u', title: 'Shared', revision: 1 });
    state.chapters.push({ id: 'chapter', userId: 'u', courseId: 'a', conceptId: 'concept', title: 'Shared', order: 0, revision: 1, properties: {}, detached: false });
    const saved = await repository.commitWorkspaceState('u', 0, state);
    state.courses[0].title = 'mutation';
    expect((await repository.getWorkspaceState('u')).courses[0].title).toBe('A');
    await expect(repository.commitWorkspaceState('u', 0, saved)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.commitWorkspaceState('other', 0, saved)).rejects.toMatchObject({ code: 'invalid_request' });
    saved.entries.push({ id: 'e', userId: 'u', courseId: 'b', courseChapterId: 'chapter', markdown: 'body', order: 0, revision: 1, properties: {}, blocks: [] });
    await expect(repository.commitWorkspaceState('u', 1, saved)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await repository.getWorkspaceState('u')).entries).toEqual([]);
    expect(await repository.getWorkspaceState('other')).toEqual(emptyWorkspaceState());
  });
});
