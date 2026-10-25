import { describe, it, expect } from 'vitest';
import { createInMemoryRepository } from '@noltri/storage';
import { createSqliteRepository } from '../../../packages/storage/src/sqlite';
import { createOfflineProvider } from '@noltri/ai-provider';
import { silentLogger } from '@noltri/shared';
import type { CoreDeps } from '../src/types';
import { testConfig } from './fakes';
import { getCourseDocument, applyCourseDocumentPatch, loadWorkspace, getLegacyCourseNote, saveLegacyCourseNote } from '../src/services/course-workspace';

import { workspaceFixture } from './workspace-fixture';

describe.each(['memory', 'sqlite'] as const)('%s course migration/projection', (driver) => {
  it('migrates shared concepts to independent instances, preserves exact legacy body and detached notes, without guessed sources or duplicates', async () => {
    const { repository, deps, actor, a, b, shared } = await workspaceFixture(driver);
    const detached = await repository.createNode({ userId: 'u', title: 'Detached', nodeType: 'chapter' });
    await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: shared.id, content: 'Python body\n\n```md\n## not a chapter\n```' });
    await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: shared.id, content: 'Java body' });
    await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: detached.id, content: 'Detached body' });
    const source = await repository.createRawSource({ userId: 'u', rawText: 'Python body', sourceType: 'manual', capturedAt: 'now' });
    const item = await repository.createKnowledgeItem({ userId: 'u', rawSourceId: source.id, normalizedText: 'Python body', confidence: 1 });
    await repository.linkItemToNode({ userId: 'u', itemId: item.id, nodeId: shared.id, relationType: 'primary', confidence: 1 });
    const first = await getCourseDocument(deps, actor, a.id);
    const second = await getCourseDocument(deps, actor, b.id);
    expect(first.chapters.find((value) => value.conceptId === shared.id)!.id).not.toBe(second.chapters[0].id);
    expect(first.entries.find((value) => value.markdown.startsWith('Python'))!.markdown).toBe('Python body\n\n```md\n## not a chapter\n```');
    expect(first.entries.some((value) => value.markdown === 'Java body')).toBe(false);
    expect(first.sourceLinks).toEqual([]);
    expect(first.chapters.find((value) => value.conceptId === detached.id)?.detached).toBe(true);
    expect(first.entries.some((value) => value.markdown === 'Detached body')).toBe(true);
    expect(first.markdown).not.toContain('Detached body');
    const state = await loadWorkspace(deps, actor);
    const again = await loadWorkspace(deps, actor);
    expect(again).toEqual(state);
    expect(again.entries).toHaveLength(3);
    await expect(getCourseDocument(deps, { userId: 'other', actor: 'test' }, a.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('keeps stable IDs through typing, H2 rename/removal, creates explicit concepts, checks revisions and idempotency', async () => {
    const { repository, deps, actor, a, shared } = await workspaceFixture(driver);
    await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: shared.id, content: 'alpha\n\n```md\n## code\n```' });
    let doc = await getCourseDocument(deps, actor, a.id);
    const id = doc.entries[0].id; const chapterId = doc.chapters[0].id;
    const from = doc.markdown.indexOf('alpha') + 5;
    const request = { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [id]: doc.entries[0].revision }, changes: [{ from, to: from, insert: ' beta' }], requestId: 'typing' };
    const result = await applyCourseDocumentPatch(deps, actor, request);
    expect(await applyCourseDocumentPatch(deps, actor, request)).toEqual(result);
    doc = result.documents[0];
    expect(doc.entries).toHaveLength(1); expect(doc.entries[0].id).toBe(id); expect(doc.entries[0].markdown).toContain('alpha beta'); expect(doc.chapters).toHaveLength(1);
    await expect(applyCourseDocumentPatch(deps, actor, { ...request, requestId: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
    const titleAt = doc.markdown.indexOf('Variables');
    doc = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: titleAt, to: titleAt + 9, insert: 'Names' }], requestId: 'rename' })).documents[0];
    expect(doc.chapters[0].id).toBe(chapterId);
    const heading = doc.projection.find((range) => range.kind === 'chapter')!;
    doc = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: heading.from, to: heading.to, insert: '' }], requestId: 'remove-heading' })).documents[0];
    expect(doc.entries[0].id).toBe(id); expect(doc.entries[0].courseChapterId).toBeNull(); expect(doc.chapters).toHaveLength(0);
    expect((await getCourseDocument(deps, actor, a.id)).chapters).toHaveLength(0);
    const at = doc.markdown.length;
    doc = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: at, to: at, insert: '## Variables\n\nnew' }], requestId: 'new-heading' })).documents[0];
    expect(doc.chapters[0].conceptId).not.toBe(shared.id);
    await saveLegacyCourseNote(deps, actor, a.id, null, 'compatibility');
    expect((await getLegacyCourseNote(deps, actor, a.id, null)).content).toBe('compatibility');
    expect((await getCourseDocument(deps, actor, a.id)).entries[0].markdown).toBe('compatibility');
  });
  it('accepts long content without truncation, rejects byte ceiling, foreign entries and malformed coordinates', async () => {
    const { deps, actor, a } = await workspaceFixture(driver);
    let doc = await getCourseDocument(deps, actor, a.id);
    const request = { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: doc.markdown.length, to: doc.markdown.length, insert: 'x'.repeat(100_000) }], requestId: 'long' };
    doc = (await applyCourseDocumentPatch(deps, actor, request)).documents[0];
    expect(doc.entries[0].markdown).toHaveLength(100_000);
    await expect(applyCourseDocumentPatch(deps, actor, { ...request, requestId: 'foreign', baseDocumentRevision: doc.documentRevision, entryRevisions: { foreign: 1 } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(applyCourseDocumentPatch(deps, actor, { ...request, requestId: 'huge', changes: [{ from: 0, to: 0, insert: '中'.repeat(800_000) }] })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

it('imports new captures after migration and adapts YAML into authoritative properties', async () => {
  const { repository, deps, actor, a } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: null, content: '---\ntags: [legacy]\nunknown:\n  number: 4\n---\nLegacy body' });
  let document = await getCourseDocument(deps, actor, a.id);
  expect(document.entries[0].properties).toMatchObject({ tags: ['legacy'], unknown: { number: 4 } });
  expect(document.entries[0].markdown).toBe('Legacy body');
  const source = await repository.createRawSource({ userId: 'u', rawText: 'new capture', sourceType: 'manual', capturedAt: 'now' });
  const item = await repository.createKnowledgeItem({ userId: 'u', rawSourceId: source.id, normalizedText: 'new capture', confidence: 1 });
  await repository.linkItemToNode({ userId: 'u', itemId: item.id, nodeId: a.id, relationType: 'primary', confidence: 1 });
  document = await getCourseDocument(deps, actor, a.id);
  expect(document.entries).toHaveLength(2); expect(document.sourceLinks).toHaveLength(1);
  expect(document.sourceLinks[0].entryId).toBe(document.entries.find((value) => value.markdown === 'new capture')!.id);
});

it('keeps entry/source/block identities on split, merge and reorder', async () => {
  const { repository, deps, actor, a } = await workspaceFixture();
  const source = await repository.createRawSource({ userId: 'u', rawText: 'alpha', sourceType: 'manual', capturedAt: 'now' });
  const item = await repository.createKnowledgeItem({ userId: 'u', rawSourceId: source.id, normalizedText: 'alpha\n\nbeta ^keep', confidence: 1 });
  await repository.linkItemToNode({ userId: 'u', itemId: item.id, nodeId: a.id, relationType: 'primary', confidence: 1 });
  let document = await getCourseDocument(deps, actor, a.id);
  const originalId = document.entries[0].id; const blockId = document.entries[0].blocks[0].id;
  const at = document.markdown.indexOf('beta');
  document = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: document.documentRevision, entryRevisions: { [originalId]: 1 }, changes: [{ from: at, to: at, insert: '## New\n\n' }], requestId: 'split' })).documents[0];
  expect(document.entries).toHaveLength(2); expect(document.entries[0].id).toBe(originalId); expect(document.entries[1].blocks[0].id).toBe(blockId);
  expect(document.sourceLinks).toHaveLength(2);
  const secondId = document.entries[1].id;
  const full = `# ${document.title}\n\nbeta ^keep\n\nalpha\n\n## New\n\n`;
  document = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: document.documentRevision, entryRevisions: Object.fromEntries(document.entries.map((value) => [value.id, value.revision])), changes: [{ from: 0, to: document.markdown.length, insert: full }], requestId: 'reorder' })).documents[0];
  expect(document.entries.map((value) => value.id)).toEqual([secondId, originalId]); expect(document.entries[0].blocks[0].id).toBe(blockId);
  const first = document.projection.find((value) => value.entryId === secondId)!;
  const second = document.projection.find((value) => value.entryId === originalId)!;
  document = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: document.documentRevision, entryRevisions: Object.fromEntries(document.entries.map((value) => [value.id, value.revision])), changes: [{ from: first.from, to: second.to, insert: 'alpha beta ^keep' }], requestId: 'merge' })).documents[0];
  expect(document.entries).toHaveLength(1); expect(document.sourceLinks).toHaveLength(1); expect(document.entries[0].blocks[0].id).toBe(blockId);
});

it('atomically rewrites resolved course/heading/block/property references on rename while preserving explicit aliases', async () => {
  const { repository, deps, actor, a, b, shared } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: shared.id, content: '### Deep\n\nbody ^old' });
  await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: null, content: `[[${a.id}#Variables|chapter label]] [[${a.id}#Deep]] [[${a.id}#^old|block label]] [[Python]] [[missing]]` });
  let doc = await getCourseDocument(deps, actor, a.id);
  let state = await loadWorkspace(deps, actor);
  state.courses.find((value) => value.id === b.id)!.properties = { citation: `[[${a.id}#^old|property alias]]` };
  await repository.commitWorkspaceState('u', state.revision, state);
  const changes = [
    { from: doc.markdown.indexOf('Python'), to: doc.markdown.indexOf('Python') + 6, insert: 'Py' },
    { from: doc.markdown.indexOf('Variables'), to: doc.markdown.indexOf('Variables') + 9, insert: 'Names' },
    { from: doc.markdown.indexOf('Deep'), to: doc.markdown.indexOf('Deep') + 4, insert: 'Details' },
    { from: doc.markdown.indexOf('^old') + 1, to: doc.markdown.indexOf('^old') + 4, insert: 'new' },
  ];
  const result = await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [doc.entries[0].id]: doc.entries[0].revision }, changes, requestId: 'rename-all' });
  const incoming = result.documents.find((value) => value.courseId === b.id)!;
  expect(incoming.entries[0].markdown).toContain(`${a.id}#Names|chapter label`);
  expect(incoming.entries[0].markdown).toContain(`${a.id}#Names#Details`);
  expect(incoming.entries[0].markdown).toContain(`${a.id}#^new|block label`);
  expect(incoming.entries[0].markdown).toContain(`[[${a.id}]]`);
  expect(incoming.entries[0].markdown).toContain('[[missing]]');
  expect(incoming.properties.citation).toContain(`${a.id}#^new|property alias`);
  expect((await repository.findNode(a.id, 'u'))!.title).toBe('Py');
});

it('reserves existing block aliases when inserting a new alias before them', async () => {
  const { repository, deps, actor, a, b } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: null, content: 'old body ^old' });
  await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: null, content: `[[${a.id}#^old]]` });
  let doc = await getCourseDocument(deps, actor, a.id);
  const blockId = doc.entries[0].blocks[0].id; const entry = doc.entries[0]; const from = doc.projection.find((range) => range.entryId === entry.id)!.from;
  await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from, to: from, insert: 'new body ^new\n\n' }], requestId: 'insert-new-block' });
  doc = await getCourseDocument(deps, actor, a.id);
  expect(doc.entries.flatMap((value) => value.blocks).find((block) => block.alias === 'old')!.id).toBe(blockId);
  expect(doc.entries.flatMap((value) => value.blocks).find((block) => block.alias === 'new')!.id).not.toBe(blockId);
  expect((await getCourseDocument(deps, actor, b.id)).entries[0].markdown).toContain('#^old');
});

it('preserves H3 link targets when headings reorder within one entry', async () => {
  const { repository, deps, actor, a, b } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: null, content: '### Alpha\n\na\n\n### Beta\n\nb' });
  await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: null, content: `[[${a.id}#Beta]]` });
  const doc = await getCourseDocument(deps, actor, a.id); const entry = doc.entries[0]; const span = doc.projection.find((range) => range.entryId === entry.id)!;
  await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from: span.from, to: span.to, insert: '### Beta\n\nb\n\n### Alpha\n\na' }], requestId: 'reorder-h3' });
  expect((await getCourseDocument(deps, actor, b.id)).entries[0].markdown).toContain('#Beta');
});

it('keeps quoted/list H2 headings inside the same entry and leaves course structure unchanged', async () => {
  const { repository, deps, actor, a } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: null, content: 'body' });
  const doc = await getCourseDocument(deps, actor, a.id); const entry = doc.entries[0]; const span = doc.projection.find((range) => range.entryId === entry.id)!;
  const text = '> ## Quote heading\n> quoted body\n\n- ## List heading\n  list body';
  const result = await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from: span.from, to: span.to, insert: text }], requestId: 'nested-h2' });
  expect(result.documents[0].chapters).toHaveLength(doc.chapters.length);
  expect(result.documents[0].entries[0].markdown).toBe(text);
});

it('retains old H2 instance when a new H2 is inserted at exactly its start', async () => {
  const { repository, deps, actor, a, b, shared } = await workspaceFixture();
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: shared.id, content: 'old chapter body' });
  await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: null, content: `[[${a.id}#Variables]]` });
  const doc = await getCourseDocument(deps, actor, a.id); const chapter = doc.chapters[0]; const at = doc.projection.find((range) => range.kind === 'chapter')!.from;
  const result = await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: {}, changes: [{ from: at, to: at, insert: '## New\n\n' }], requestId: 'insert-new-h2' });
  expect(result.documents[0].chapters.find((value) => value.title === 'Variables')!.id).toBe(chapter.id);
  expect(result.documents[0].chapters.find((value) => value.title === 'New')!.id).not.toBe(chapter.id);
  expect((await getCourseDocument(deps, actor, b.id)).entries[0].markdown).toContain('#Variables');
});

it('isolates malformed legacy YAML, preserves its exact text and keeps every course editable', async () => {
  const { repository, deps, actor, a, b } = await workspaceFixture();
  const invalid = '---\ninvalid: [unterminated\n---\nOriginal body';
  await repository.saveKnowledgeNote({ userId: 'u', topicId: a.id, chapterId: null, content: invalid });
  await repository.saveKnowledgeNote({ userId: 'u', topicId: b.id, chapterId: null, content: 'valid body' });
  expect((await getCourseDocument(deps, actor, b.id)).entries[0].markdown).toBe('valid body');
  let doc = await getCourseDocument(deps, actor, a.id);
  expect(doc.entries[0].markdown).toBe(invalid);
  expect((await loadWorkspace(deps, actor)).migration.unconfirmed.some((value) => value.includes('invalid-frontmatter'))).toBe(true);
  const entry = doc.entries[0]; const range = doc.projection.find((value) => value.entryId === entry.id)!;
  doc = (await applyCourseDocumentPatch(deps, actor, { courseId: a.id, baseDocumentRevision: doc.documentRevision, entryRevisions: { [entry.id]: entry.revision }, changes: [{ from: range.to, to: range.to, insert: ' edited' }], requestId: 'edit-invalid-yaml' })).documents[0];
  expect(doc.entries[0].markdown).toBe(invalid + ' edited');
});
