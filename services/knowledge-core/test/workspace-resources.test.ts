import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceFixture } from './workspace-fixture';
import { normalizeResourcePath, uploadAttachment, readAttachment, listAttachments, deleteAttachment, importMarkdown, exportCourseMarkdown, startMarkdownDirectoryWatcher, renameAttachment, cleanupAttachments } from '../src/services/workspace-resources';
import { applyCourseDocumentPatch, getCourseDocument, loadWorkspace, patchWorkspaceProperties } from '../src/services/course-workspace';
import { closeMetadata } from '../src/services/metadata';
import { restoreSnapshot, getWorkspaceSettings, updateWorkspaceSettings } from '../src/services/recovery';

async function fixture(driver: 'memory' | 'sqlite' = 'memory') {
  const f = await workspaceFixture(driver);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noltri-resources-'));
  const deps = { ...f.deps, config: { ...f.deps.config, sqliteFile: path.join(directory, 'profile.sqlite') } };
  return { ...f, deps, directory, async close() { await closeMetadata(deps, f.actor.userId); await rm(directory, { recursive: true, force: true }); } };
}
describe('controlled workspace resources', () => {
  it('rejects traversal/protocol/normalization/case collisions, isolates users and preserves bytes/stable identities', async () => {
    const f = await fixture();
    try {
      for (const value of ['../a.png', 'folder/../a', '/a', 'https://evil/a', 'a\\b', '%2e%2e/a', 'A/e\u0301.png']) expect(() => normalizeResourcePath(value)).toThrow();
      expect(normalizeResourcePath('images/图.png')).toBe('images/图.png');
      const input = { path: 'images/图.png', mimeType: 'image/png', contentBase64: Buffer.from('bytes').toString('base64'), requestId: 'attachment-1' };
      const attached = await uploadAttachment(f.deps, f.actor, input);
      expect(attached).toHaveProperty('id');
      if (!('id' in attached)) throw new Error('Expected final upload');
      expect(await uploadAttachment(f.deps, f.actor, input)).toEqual(attached);
      expect(Buffer.from((await readAttachment(f.deps, f.actor, attached.id)).bytes).toString()).toBe('bytes');
      await expect(uploadAttachment(f.deps, f.actor, { ...input, path: 'IMAGES/图.png', requestId: 'collision' })).rejects.toMatchObject({ code: 'conflict' });
      await expect(readAttachment(f.deps, { userId: 'other', actor: 'test' }, attached.id)).rejects.toMatchObject({ code: 'not_found' });
      let doc = await getCourseDocument(f.deps, f.actor, f.a.id);
      doc = (await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: doc.markdown.length, to: doc.markdown.length, insert: `![one](${attached.path}) ![two](${attached.path})` }], requestId: 'embed-attachment' })).documents[0];
      expect((await listAttachments(f.deps, f.actor, f.a.id))[0].referenceCount).toBe(2);
      await expect(deleteAttachment(f.deps, f.actor, attached.id, attached.revision)).rejects.toMatchObject({ code: 'conflict' });
      const exported = await exportCourseMarkdown(f.deps, f.actor, f.a.id);
      expect(exported.markdown).toContain(attached.path); expect(exported.manifest.attachments[0].id).toBe(attached.id);
    } finally { await f.close(); }
  });
  it('stages bounded chunks idempotently, detects conflicts and finalizes only correct full digest', async () => {
    const f = await fixture();
    try {
      const one = Buffer.alloc(1024 * 1024, 1); const two = Buffer.alloc(8000, 2); const bytes = Buffer.concat([one, two]);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const base = { path: 'paper.pdf', mimeType: 'application/pdf', requestId: 'chunked-paper', chunkCount: 2, sha256 };
      const first = await uploadAttachment(f.deps, f.actor, { ...base, chunkIndex: 0, contentBase64: one.toString('base64') });
      if (!('complete' in first)) throw new Error('Expected staging');
      expect(await listAttachments(f.deps, f.actor)).toEqual([]);
      await expect(uploadAttachment(f.deps, f.actor, { ...base, uploadId: first.uploadId, chunkIndex: 0, contentBase64: two.toString('base64') })).rejects.toMatchObject({ code: 'conflict' });
      const finalInput = { ...base, uploadId: first.uploadId, chunkIndex: 1, contentBase64: two.toString('base64') };
      const final = await uploadAttachment(f.deps, f.actor, finalInput);
      if (!('id' in final)) throw new Error('Expected attachment');
      expect(final.size).toBe(bytes.length); expect(await uploadAttachment(f.deps, f.actor, finalInput)).toEqual(final);
      expect(createHash('sha256').update((await readAttachment(f.deps, f.actor, final.id)).bytes).digest('hex')).toBe(sha256);
      await deleteAttachment(f.deps, f.actor, final.id, final.revision);
      expect(await listAttachments(f.deps, f.actor)).toEqual([]);
    } finally { await f.close(); }
  });
  it('imports complete short/long originals through source-first capture without AI and exports provenance', async () => {
    const f = await fixture();
    try {
      const spy = vi.spyOn(f.deps.provider, 'extractKnowledge');
      const markdown = '---\naliases: [original]\nunknown: true\n---\n## Imported\n\n' + 'long '.repeat(10000);
      const doc = await getCourseDocument(f.deps, f.actor, f.a.id);
      const request = { courseId: f.a.id, courseChapterId: null, path: 'notes/original.md', markdown, requestId: 'import-original', expectedDocumentRevision: doc.documentRevision, replaceExisting: false };
      const result = await importMarkdown(f.deps, f.actor, request);
      expect(spy).not.toHaveBeenCalled();
      expect((await f.repository.findRawSource(result.rawSourceId, f.actor.userId))!.rawText).toBe(markdown);
      expect(result.document.chapters.some((chapter) => chapter.title === 'Imported')).toBe(true);
      expect(result.document.chapters.some((chapter) => chapter.title.includes('aliases:'))).toBe(false);
      expect(result.document.sourceLinks.some((link) => link.sourceId === result.rawSourceId)).toBe(true);
      expect((await importMarkdown(f.deps, f.actor, request)).duplicate).toBe(true);
      const exported = await exportCourseMarkdown(f.deps, f.actor, f.a.id);
      expect(exported.manifest.sources.map((value) => value.id)).toContain(result.rawSourceId);
      expect(exported.manifest.owners.some((value) => value.properties.unknown === true)).toBe(true);
      await expect(importMarkdown(f.deps, f.actor, { ...request, path: '../unsafe.md' })).rejects.toMatchObject({ code: 'invalid_request' });
      const shortDoc = await getCourseDocument(f.deps, f.actor, f.b.id);
      const short = await importMarkdown(f.deps, f.actor, { ...request, courseId: f.b.id, path: 'short.md', markdown: 'x', requestId: 'import-short', expectedDocumentRevision: shortDoc.documentRevision });
      expect((await f.repository.findRawSource(short.rawSourceId, f.actor.userId))!.rawText).toBe('x');
    } finally { await f.close(); }
  });
  it('persists SQLite import identity and replaces an unchanged import atomically with both originals preserved', async () => {
    const f = await fixture('sqlite');
    try {
      let document = await getCourseDocument(f.deps, f.actor, f.a.id);
      const input = { courseId: f.a.id, courseChapterId: null, path: 'replace.md', markdown: 'first original', requestId: 'first-version', expectedDocumentRevision: document.documentRevision, replaceExisting: false };
      const first = await importMarkdown(f.deps, f.actor, input);
      const originalEntry = first.document.entries.find((entry) => entry.markdown === 'first original')!;
      const second = await importMarkdown(f.deps, f.actor, { ...input, markdown: 'second original', requestId: 'second-version', expectedDocumentRevision: first.document.documentRevision, replaceExisting: true });
      expect(second.document.entries.find((entry) => entry.id === originalEntry.id)!.markdown).toBe('second original');
      expect(second.document.sources.map((source) => source.id)).toEqual(expect.arrayContaining([first.rawSourceId, second.rawSourceId]));
      expect((await f.repository.getWorkspaceState(f.actor.userId)).imports['replace.md'].sourceId).toBe(second.rawSourceId);
      expect((await f.repository.findRawSource(first.rawSourceId, f.actor.userId))!.rawText).toBe('first original');
    } finally { await f.close(); }
  });
  it('renames/moves one stable resource and exact references atomically with restorable mapping and conflict guards', async () => {
    const f = await fixture();
    try {
      const uploaded = await uploadAttachment(f.deps, f.actor, { path: 'papers/old.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('pdf bytes').toString('base64'), requestId: 'rename-paper' });
      if (!('id' in uploaded)) throw new Error('Expected final resource');
      let a = await getCourseDocument(f.deps, f.actor, f.a.id);
      const body = `![paper](${uploaded.path})\n\n~~~md\n![literal](${uploaded.path})\n~~~`;
      a = (await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: a.documentRevision, entryRevisions: {}, changes: [{ from: a.markdown.length, to: a.markdown.length, insert: body }], requestId: 'paper-reference' })).documents[0];
      const b = (await patchWorkspaceProperties(f.deps, f.actor, { owner: { kind: 'course', id: f.b.id }, expectedRevision: 1, properties: { paper: `[[${uploaded.path}|keep alias]]` }, requestId: 'paper-property' })).documents[0];
      const entry = a.entries[0];
      const request = { attachmentId: uploaded.id, path: 'archive/renamed.pdf', expectedRevision: uploaded.revision, expectedDocumentRevisions: { [a.courseId]: a.documentRevision, [b.courseId]: b.documentRevision }, expectedEntryRevisions: { [entry.id]: entry.revision }, requestId: 'rename-resource' };
      const before = await loadWorkspace(f.deps, f.actor);
      await expect(renameAttachment(f.deps, f.actor, { ...request, expectedEntryRevisions: {} })).rejects.toMatchObject({ code: 'conflict' });
      expect(await loadWorkspace(f.deps, f.actor)).toEqual(before);
      const result = await renameAttachment(f.deps, f.actor, request);
      expect(await renameAttachment(f.deps, f.actor, request)).toEqual(result);
      expect(result.attachment.id).toBe(uploaded.id); expect(result.attachment.originalPath).toBe('archive/renamed.pdf');
      expect(result.documents.find((doc) => doc.courseId === f.a.id)!.entries[0].markdown).toContain(`![paper](${result.attachment.path})`);
      expect(result.documents.find((doc) => doc.courseId === f.a.id)!.entries[0].markdown).toContain(`![literal](${uploaded.path})`);
      expect(result.documents.find((doc) => doc.courseId === f.b.id)!.properties.paper).toBe(`[[${result.attachment.path}|keep alias]]`);
      expect(Buffer.from((await readAttachment(f.deps, f.actor, uploaded.id)).bytes).toString()).toBe('pdf bytes');
      const state = await loadWorkspace(f.deps, f.actor); const snapshot = state.snapshots.find((value) => value.id === result.snapshotId)!;
      expect(snapshot.objectKeys).toContain(`attachment:${uploaded.id}`);
      await restoreSnapshot(f.deps, f.actor, snapshot.id, snapshot.afterRevisions);
      expect((await listAttachments(f.deps, f.actor))[0].path).toBe(uploaded.path);
      expect((await getCourseDocument(f.deps, f.actor, f.b.id)).properties.paper).toBe(`[[${uploaded.path}|keep alias]]`);
    } finally { await f.close(); }
  });
  it('defaults cleanup to ask, honors never/confirmation/always, and never deletes referenced or historical bytes', async () => {
    const f = await fixture();
    try {
      expect((await getWorkspaceSettings(f.deps, f.actor)).attachmentCleanup).toBe('ask');
      const uploaded = await uploadAttachment(f.deps, f.actor, { path: 'unused.png', mimeType: 'image/png', contentBase64: Buffer.from('unused').toString('base64'), requestId: 'cleanup-unused' });
      if (!('id' in uploaded)) throw new Error('Expected resource');
      expect(await cleanupAttachments(f.deps, f.actor)).toMatchObject({ confirmationRequired: true, candidateIds: [uploaded.id], deletedIds: [] });
      await updateWorkspaceSettings(f.deps, f.actor, { attachmentCleanup: 'never' });
      expect((await cleanupAttachments(f.deps, f.actor, { confirmed: true })).deletedIds).toEqual([]);
      await updateWorkspaceSettings(f.deps, f.actor, { attachmentCleanup: 'ask' });
      expect((await cleanupAttachments(f.deps, f.actor, { confirmed: true, attachmentIds: [uploaded.id], expectedRevisions: { [uploaded.id]: uploaded.revision } })).deletedIds).toEqual([uploaded.id]);
      await expect(readAttachment(f.deps, f.actor, uploaded.id)).rejects.toMatchObject({ code: 'not_found' });
      const referenced = await uploadAttachment(f.deps, f.actor, { path: 'referenced.png', mimeType: 'image/png', contentBase64: Buffer.from('referenced').toString('base64'), requestId: 'cleanup-referenced' });
      if (!('id' in referenced)) throw new Error('Expected resource');
      let doc = await getCourseDocument(f.deps, f.actor, f.a.id);
      doc = (await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: doc.markdown.length, to: doc.markdown.length, insert: `![ref](${referenced.path})` }], requestId: 'cleanup-embed' })).documents[0];
      await updateWorkspaceSettings(f.deps, f.actor, { attachmentCleanup: 'always' });
      expect((await cleanupAttachments(f.deps, f.actor)).candidateIds).not.toContain(referenced.id);
      const entry = doc.entries[0]; const range = doc.projection.find((value) => value.entryId === entry.id)!;
      await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from: range.from, to: range.to, insert: '' }], requestId: 'cleanup-remove-ref' });
      expect((await cleanupAttachments(f.deps, f.actor)).candidateIds).not.toContain(referenced.id);
      expect(Buffer.from((await readAttachment(f.deps, f.actor, referenced.id)).bytes).toString()).toBe('referenced');
    } finally { await f.close(); }
  });
  it('watches only configured directory, imports real files, and preserves local conflicts and external originals', async () => {
    const f = await fixture(); let watcher: Awaited<ReturnType<typeof startMarkdownDirectoryWatcher>> | undefined;
    try {
      const watched = path.join(f.directory, 'watched'); await mkdir(watched);
      await writeFile(path.join(watched, 'figure.png'), Buffer.from('image bytes'));
      await writeFile(path.join(watched, 'note.md'), 'external original ![figure](figure.png)');
      watcher = await startMarkdownDirectoryWatcher(f.deps, f.actor, { directory: watched, courseId: f.a.id });
      let doc = await getCourseDocument(f.deps, f.actor, f.a.id);
      const entry = doc.entries.find((value) => value.markdown.startsWith('external original'))!;
      expect(entry.markdown).toContain((await listAttachments(f.deps, f.actor))[0].path);
      const at = doc.projection.find((range) => range.entryId === entry.id)!.from;
      await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from: at, to: at, insert: 'local ' }], requestId: 'local-edit' });
      await writeFile(path.join(watched, 'note.md'), 'external changed');
      const result = await watcher.scan();
      expect(result.conflicts).toContain('note.md');
      doc = await getCourseDocument(f.deps, f.actor, f.a.id); expect(doc.entries.find((value) => value.id === entry.id)!.markdown).toBe('local ' + entry.markdown);
      expect(await readFile(path.join(watched, 'note.md'), 'utf8')).toBe('external changed');
      expect((await f.repository.listInbox({ userId: f.actor.userId })).some((source) => source.rawText === 'external changed')).toBe(true);
    } finally { watcher?.close(); await f.close(); }
  });
});

it('protects ./ and encoded attachment references through rename, cleanup and recovery', async () => {
  const f = await fixture('sqlite');
  try {
    const resource = await uploadAttachment(f.deps, f.actor, { path: '图.png', mimeType: 'image/png', contentBase64: Buffer.from('protected bytes').toString('base64'), requestId: 'relative-resource' });
    if (!('id' in resource)) throw new Error('Expected uploaded resource');
    let document = await getCourseDocument(f.deps, f.actor, f.a.id);
    document = (await applyCourseDocumentPatch(f.deps, f.actor, { courseId: f.a.id, baseDocumentRevision: document.documentRevision, entryRevisions: {}, changes: [{ from: document.markdown.length, to: document.markdown.length, insert: `![kept](./${resource.path.replace('图', '%E5%9B%BE')}#page=2)` }], requestId: 'relative-body' })).documents[0];
    expect((await listAttachments(f.deps, f.actor, f.a.id))[0].referenceCount).toBe(1);
    const preview = await cleanupAttachments(f.deps, f.actor); expect(preview.candidateIds).not.toContain(resource.id);
    const cleaned = await cleanupAttachments(f.deps, f.actor, { confirmed: true, attachmentIds: preview.candidateIds, expectedRevisions: preview.candidateRevisions });
    expect(cleaned.deletedIds).not.toContain(resource.id);
    expect(Buffer.from((await readAttachment(f.deps, f.actor, resource.id)).bytes).toString()).toBe('protected bytes');
    const renamed = await renameAttachment(f.deps, f.actor, { attachmentId: resource.id, path: 'renamed.png', expectedRevision: resource.revision, expectedDocumentRevisions: { [f.a.id]: document.documentRevision }, expectedEntryRevisions: Object.fromEntries(document.entries.map(e => [e.id, e.revision])), requestId: 'rename-relative' });
    expect(renamed.documents[0].markdown).toContain(`${renamed.attachment.path}#page=2`);
    expect(renamed.attachment.referenceCount).toBe(1);
    const snapshot = (await loadWorkspace(f.deps, f.actor)).snapshots.find(s => s.id === renamed.snapshotId)!;
    await restoreSnapshot(f.deps, f.actor, snapshot.id, snapshot.afterRevisions);
    expect((await cleanupAttachments(f.deps, f.actor)).candidateIds).not.toContain(resource.id);
    expect(Buffer.from((await readAttachment(f.deps, f.actor, resource.id)).bytes).toString()).toBe('protected bytes');
  } finally { await f.close(); }
});
it('rejects duplicate-import adoption into a different course or chapter', async () => {
  const f = await fixture();
  try {
    const document = await getCourseDocument(f.deps, f.actor, f.a.id), other = await getCourseDocument(f.deps, f.actor, f.b.id);
    const request = { courseId: f.a.id, courseChapterId: null, path: 'same.md', markdown: 'Imported body.', requestId: 'first-destination', expectedDocumentRevision: document.documentRevision, replaceExisting: false };
    const imported = await importMarkdown(f.deps, f.actor, request);
    expect((await importMarkdown(f.deps, f.actor, request)).document.courseId).toBe(f.a.id);
    for (const target of [{ courseId: f.b.id, courseChapterId: null, expectedDocumentRevision: other.documentRevision }, { courseId: f.a.id, courseChapterId: document.chapters[0].id, expectedDocumentRevision: imported.document.documentRevision }]) {
      await expect(importMarkdown(f.deps, f.actor, { ...request, ...target, requestId: 'other-destination' })).rejects.toMatchObject({ code: 'conflict' });
    }
    expect((await getCourseDocument(f.deps, f.actor, f.b.id)).markdown).toBe(other.markdown);
  } finally { await f.close(); }
});
