import { it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSqliteRepository } from '../../../packages/storage/src/sqlite';
import { createOfflineProvider } from '@noltri/ai-provider';
import { silentLogger } from '@noltri/shared';
import { testConfig } from './fakes';
import { applyCourseDocumentPatch, getCourseDocument } from '../src/services/course-workspace';
import { closeMetadata, getMetadataIndex } from '../src/services/metadata';

const saves = Number(process.env.REPLAY_SAVES ?? 24);
it('bounds full replay bodies through repeated 5000-line SQLite saves and never reapplies expired IDs', async () => {
  const base = path.resolve('../../.local'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'replay-check-'));
  const repository = await createSqliteRepository({ file: path.join(directory, 'profile.sqlite') });
  const deps = { repository, provider: createOfflineProvider(), config: testConfig(), logger: silentLogger };
  const actor = { userId: 'replay-check', actor: 'test' };
  try {
    const course = await repository.createNode({ userId: actor.userId, title: '5000 lines', nodeType: 'topic' });
    await repository.saveKnowledgeNote({ userId: actor.userId, topicId: course.id, chapterId: null, content: '```text\n' + 'A line of source text.\n'.repeat(4998) + '```' });
    let document = await getCourseDocument(deps, actor, course.id);
    const first = { courseId: course.id, baseDocumentRevision: document.documentRevision, entryRevisions: Object.fromEntries(document.entries.map(e => [e.id, e.revision])), changes: [{ from: document.markdown.indexOf('A line'), to: document.markdown.indexOf('A line'), insert: '0' }], requestId: '0' };
    let plateauBytes = 0;
    const heaps: number[] = [];
    const samples: Record<string,number>[] = [];
    for (let i = 0; i < saves; i++) {
      const request = i === 0 ? first : { ...first, requestId: String(i), baseDocumentRevision: document.documentRevision, entryRevisions: Object.fromEntries(document.entries.map(e => [e.id, e.revision])), changes: [{ from: document.markdown.indexOf('A line'), to: document.markdown.indexOf('A line'), insert: String(i % 10) }] };
      if(i % 20 === 0) console.info('replay progress', i);
      const result = await applyCourseDocumentPatch(deps, actor, request); document = result.documents[0];
      if (i === saves - 1) expect(await applyCourseDocumentPatch(deps, actor, request)).toEqual(result);
      await getMetadataIndex(deps, actor);
      if (i === 11 || i === saves - 1) {
        globalThis.gc?.(); heaps.push(process.memoryUsage().heapUsed);
        const state = await repository.getWorkspaceState(actor.userId);
        expect(Object.values(state.requests).filter(r => r.result).length).toBeLessThanOrEqual(8);
        const replayBytes = Buffer.byteLength(JSON.stringify(Object.values(state.requests).flatMap(r => r.result ? [r.result] : [])));
        expect(replayBytes).toBeLessThan(2 * 1024 * 1024);
        const bytes = Buffer.byteLength(JSON.stringify({...state,snapshots:[]}));
        samples.push({ saves:i+1, replayBytes, nonSnapshotStateBytes:bytes, stateBytes:Buffer.byteLength(JSON.stringify(state)), heapUsed:process.memoryUsage().heapUsed, snapshots:state.snapshots.length });
        if (i === 11) plateauBytes = bytes;
        else expect(bytes - plateauBytes).toBeLessThan(100_000);
      }
    }
    const before = await getCourseDocument(deps, actor, course.id);
    await expect(applyCourseDocumentPatch(deps, actor, first)).rejects.toMatchObject({ code: 'conflict', details: { replayExpired: true } });
    await expect(applyCourseDocumentPatch(deps, actor, { ...first, changes: [{ from: 0, to: 0, insert: 'tampered' }] })).rejects.toMatchObject({ code: 'conflict' });
    expect(await getCourseDocument(deps, actor, course.id)).toEqual(before);
    await writeFile(path.join(base, `replay-metrics-${saves}.json`), JSON.stringify({saves,samples,expiredReplayRejected:true},null,2));
    console.info('SQLite 5000-line replay plateau', { plateauBytes, finalBytes: Buffer.byteLength(JSON.stringify(await repository.getWorkspaceState(actor.userId))), heaps });
  } finally { await closeMetadata(deps, actor.userId); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}, saves * 3000);
