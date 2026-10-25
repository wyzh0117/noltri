import type { ContentEntry } from '@noltri/schema';
import { describe, it, expect } from 'vitest';
import { workspaceFixture } from './workspace-fixture';
import { getCourseDocument, moveSourceAssignments, loadWorkspace, syncBlocks, applyCourseDocumentPatch, patchWorkspaceProperties } from '../src/services/course-workspace';
import { restoreSnapshot } from '../src/services/recovery';

describe.each(['memory', 'sqlite'] as const)('%s source assignments/recovery', (driver) => {
  async function fixture() {
    const f = await workspaceFixture(driver);
    const { repository, deps, actor, a, b, c } = f;
    const one = await repository.createRawSource({ userId: 'u', rawText: 'original one', sourceType: 'manual', capturedAt: 'now' });
    const two = await repository.createRawSource({ userId: 'u', rawText: 'original two', sourceType: 'manual', capturedAt: 'now' });
    const state = await loadWorkspace(deps, actor);
    const entries: ContentEntry[] = [
      { id: 'moving', userId: 'u', courseId: a.id, courseChapterId: state.chapters.find((item) => item.courseId === a.id)!.id, markdown: `moving ^same\n\n[[${a.id}#Variables]]`, order: 0, revision: 1, properties: {}, blocks: [] },
      { id: 'staying', userId: 'u', courseId: a.id, courseChapterId: null, markdown: 'staying', order: 1, revision: 1, properties: {}, blocks: [] },
      { id: 'target', userId: 'u', courseId: b.id, courseChapterId: null, markdown: 'target ^same', order: 0, revision: 1, properties: {}, blocks: [] },
      { id: 'incoming', userId: 'u', courseId: c.id, courseChapterId: null, markdown: `[[${a.id}#^same|keep label]]`, order: 0, revision: 1, properties: {}, blocks: [] },
    ];
    for (const entry of entries) syncBlocks(entry);
    state.entries.push(...entries);
    state.sourceLinks.push({ entryId: 'moving', sourceId: one.id, locations: [{ page: 1 }, { page: 2 }] }, { entryId: 'moving', sourceId: two.id, locations: [] }, { entryId: 'staying', sourceId: one.id, locations: [] });
    await repository.commitWorkspaceState('u', state.revision, state);
    const request = { sourceId: one.id, entryIds: ['moving'], toCourseId: b.id, toCourseChapterId: null, expectedEntryRevisions: { moving: 1, incoming: 1 }, expectedDocumentRevisions: { [a.id]: 1, [b.id]: 1, [c.id]: 1 }, requestId: 'move' };
    return { ...f, one, two, request, blockId: entries[0].blocks[0].id };
  }
  it('moves only selected entry, preserves all provenance/internal block ID, rewrites incoming references and deduplicates sources atomically', async () => {
    const { deps, actor, repository, a, b, c, one, two, request, blockId } = await fixture();
    const result = await moveSourceAssignments(deps, actor, request);
    expect(await moveSourceAssignments(deps, actor, request)).toEqual(result);
    const target = result.documents.find((doc) => doc.courseId === b.id)!;
    expect(target.sources.map((value) => value.id).sort()).toEqual([one.id, two.id].sort());
    const moved = target.entries.find((entry) => entry.id === 'moving')!;
    expect(moved.blocks[0]).toMatchObject({ id: blockId, alias: 'same-2' });
    expect(moved.markdown).toContain(`${a.id}#Variables`);
    expect(result.documents.find((doc) => doc.courseId === a.id)!.entries.map((value) => value.id)).toEqual(['staying']);
    expect(result.documents.find((doc) => doc.courseId === c.id)!.entries[0].markdown).toContain(`${b.id}#^same-2|keep label`);
    expect((await repository.findRawSource(one.id, 'u'))!.rawText).toBe('original one');
    const state = await loadWorkspace(deps, actor);
    const snapshot = state.snapshots.find((value) => value.id === result.snapshotId)!;
    expect(snapshot.objectKeys).toEqual(expect.arrayContaining([`course:${a.id}`, `course:${b.id}`, `course:${c.id}`, 'entry:moving', 'entry:incoming']));
    const restored = await restoreSnapshot(deps, actor, snapshot.id, snapshot.afterRevisions);
    expect(restored.documents.find((doc) => doc.courseId === a.id)!.entries.find((entry) => entry.id === 'moving')!.blocks[0]).toMatchObject({ id: blockId, alias: 'same' });
    expect(restored.documents.find((doc) => doc.courseId === c.id)!.entries[0].markdown).toContain(`${a.id}#^same|keep label`);
    expect((await loadWorkspace(deps, actor)).snapshots).toHaveLength(2);
  });
  it('rolls back every object on omitted/stale incoming reference revisions and rejects partial snapshot checks', async () => {
    const { deps, actor, request, b } = await fixture();
    const before = await loadWorkspace(deps, actor);
    await expect(moveSourceAssignments(deps, actor, { ...request, expectedEntryRevisions: { moving: 1 } })).rejects.toMatchObject({ code: 'conflict' });
    expect(await loadWorkspace(deps, actor)).toEqual(before);
    const moved = await moveSourceAssignments(deps, actor, request);
    const state = await loadWorkspace(deps, actor);
    const snapshot = state.snapshots.find((value) => value.id === moved.snapshotId)!;
    await expect(restoreSnapshot(deps, actor, snapshot.id, { [`course:${b.id}`]: 2 })).rejects.toMatchObject({ code: 'conflict' });
    let doc = await getCourseDocument(deps, actor, b.id);
    const entry = doc.entries.find((value) => value.id === 'target')!;
    const from = doc.projection.find((value) => value.entryId === entry.id)!.from;
    await applyCourseDocumentPatch(deps, actor, { courseId: b.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from, to: from, insert: 'edited ' }], requestId: 'after-move' });
    const edited = await loadWorkspace(deps, actor);
    await expect(restoreSnapshot(deps, actor, snapshot.id, snapshot.afterRevisions)).rejects.toMatchObject({ code: 'conflict' });
    expect(await loadWorkspace(deps, actor)).toEqual(edited);
  });
  it('edits properties only on their explicit owner with unknown imported values retained', async () => {
    const { deps, actor, a, b } = await fixture();
    const result = await patchWorkspaceProperties(deps, actor, { owner: { kind: 'entry', id: 'moving' }, expectedRevision: 1, properties: { tags: ['a/b'], aliases: ['alias'], count: 2, flag: true, custom: { nested: ['x'] } }, requestId: 'properties' });
    const entry = result.documents[0].entries.find((value) => value.id === 'moving')!;
    expect(entry.properties).toMatchObject({ count: 2, flag: true, custom: { nested: ['x'] } });
    expect(result.documents[0].properties).toEqual({});
    expect((await getCourseDocument(deps, actor, b.id)).properties).toEqual({});
    await expect(patchWorkspaceProperties(deps, actor, { owner: { kind: 'entry', id: 'moving' }, expectedRevision: 1, properties: {}, requestId: 'stale-properties' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
