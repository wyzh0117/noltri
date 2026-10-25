import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  uploadAttachmentSchema, workspaceAttachmentSchema, importMarkdownSchema, courseMarkdownExportSchema,
  WORKSPACE_ATTACHMENT_MAX_BYTES, WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES,
  type WorkspaceAttachment, type UploadAttachmentRequest, type AttachmentUploadResult,
  type ImportMarkdownRequest, type ImportMarkdownResult, type CourseMarkdownExport,
  type WorkspaceState, type WorkspaceContent,
} from '@noltri/schema';
import { parseMarkdown, setFrontmatterProperties, rewriteReferences } from '@noltri/note-engine';
import { createId, knowledgeError, nowIso } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { runCapture } from '../pipeline/capture';
import { loadWorkspace, getCourseDocument, validateRequestSize, applyCourseDocumentPatch } from './course-workspace';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const pathKey = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US');
/** Paths are portable identities, never a browser URL or an absolute filesystem path. */
export function normalizeResourcePath(value: string): string {
  if (!value || value !== value.normalize('NFC') || value.includes('\\') || /[\u0000-\u001f\u007f:%?#]/.test(value) || value.startsWith('/') || value.endsWith('/')) throw knowledgeError('invalid_request', 'Resource path must be a normalized relative path');
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.trim() !== part || /[<>"|*]/.test(part))) throw knowledgeError('invalid_request', 'Resource path contains an unsafe segment');
  return parts.join('/');
}
function resourceRoot(deps: CoreDeps, actor: ActorContext): string { return path.join(path.dirname(deps.config.sqliteFile), 'attachments', digest(actor.userId).slice(0, 24)); }
function resourceFile(deps: CoreDeps, actor: ActorContext, attachmentId: string): string {
  if (!/^[a-f0-9]{32}$/.test(attachmentId)) throw knowledgeError('invalid_request', 'Invalid attachment identity');
  return path.join(resourceRoot(deps, actor), attachmentId);
}
function referenceCourses(content: WorkspaceContent, attachment: { path: string }): string[] {
  const owners = [
    ...content.courses.map((object) => ({ courseId: object.id, markdown: setFrontmatterProperties('', object.properties) })),
    ...content.chapters.map((object) => ({ courseId: object.courseId, markdown: setFrontmatterProperties('', object.properties) })),
    ...content.entries.flatMap((object) => [{ courseId: object.courseId, markdown: object.markdown }, { courseId: object.courseId, markdown: setFrontmatterProperties('', object.properties) }]),
  ];
  return owners.flatMap((owner) => parseMarkdown(owner.markdown, { tolerateInvalidFrontmatter: true }).links.filter((link) => {
    try { return normalizeResourcePath(link.target) === attachment.path; } catch { return false; }
  }).map(() => owner.courseId));
}
function attachmentView(state: WorkspaceState, value: WorkspaceState['attachments'][number]): WorkspaceAttachment {
  return workspaceAttachmentSchema.parse({ ...value, referenceCount: referenceCourses(state, value).length });
}
async function readStored(deps: CoreDeps, actor: ActorContext, id: string): Promise<Buffer> {
  const filename = resourceFile(deps, actor, id);
  const root = await realpath(resourceRoot(deps, actor));
  const actual = await realpath(filename);
  if (path.dirname(actual) !== root || (await lstat(filename)).isSymbolicLink()) throw knowledgeError('invalid_request', 'Attachment escapes controlled resource directory');
  return readFile(actual);
}
export async function listAttachments(deps: CoreDeps, actor: ActorContext, courseId?: string): Promise<WorkspaceAttachment[]> {
  const state = await loadWorkspace(deps, actor);
  if (courseId && !state.courses.some((course) => course.id === courseId)) throw knowledgeError('not_found', 'Course not found');
  return state.attachments.filter((value) => !courseId || referenceCourses(state, value).includes(courseId)).map((value) => attachmentView(state, value));
}
export async function readAttachment(deps: CoreDeps, actor: ActorContext, id: string): Promise<{ attachment: WorkspaceAttachment; bytes: Uint8Array }> {
  const state = await loadWorkspace(deps, actor);
  const value = state.attachments.find((item) => item.id === id);
  if (!value) throw knowledgeError('not_found', 'Attachment not found');
  const bytes = await readStored(deps, actor, id);
  if (bytes.length !== value.size || digest(bytes) !== value.sha256) throw knowledgeError('storage_error', 'Attachment integrity check failed');
  return { attachment: attachmentView(state, value), bytes };
}

export async function uploadAttachment(deps: CoreDeps, actor: ActorContext, input: UploadAttachmentRequest): Promise<AttachmentUploadResult> {
  validateRequestSize(input);
  const request = uploadAttachmentSchema.parse(input);
  const originalPath = normalizeResourcePath(request.path);
  if (!/^(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|application\/(?:pdf|octet-stream)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/plain)$/i.test(request.mimeType)) throw knowledgeError('invalid_request', 'Unsupported attachment media type');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.contentBase64)) throw knowledgeError('invalid_request', 'Attachment is not canonical base64');
  let bytes = Buffer.from(request.contentBase64, 'base64');
  if (bytes.length > WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES) throw knowledgeError('invalid_request', 'Attachment chunk exceeds 1 MiB; split into chunks', { maxBytes: WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES });
  const chunkCount = request.chunkCount ?? 1;
  const chunkIndex = request.chunkIndex ?? 0;
  if (chunkIndex >= chunkCount || (chunkCount > 1 && !request.sha256)) throw knowledgeError('invalid_request', 'Chunked upload needs a full-file SHA256 and valid chunk index');
  const initialState = await loadWorkspace(deps, actor);
  const completed = initialState.attachments.find((item) => item.requestId === request.requestId);
  if (completed && chunkCount > 1) {
    if (completed.originalPath !== originalPath || completed.mimeType !== request.mimeType || completed.sha256 !== request.sha256) throw knowledgeError('conflict', 'Attachment requestId was already used');
    return attachmentView(initialState, completed);
  }
  let staging: string | undefined;
  if (chunkCount > 1) {
    const uploadId = request.uploadId ?? createId();
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(uploadId)) throw knowledgeError('invalid_request', 'Invalid upload identity');
    staging = path.join(resourceRoot(deps, actor), '.staging', uploadId);
    await mkdir(staging, { recursive: true });
    const metadata = JSON.stringify({ requestId: request.requestId, path: originalPath, mimeType: request.mimeType, chunkCount, sha256: request.sha256 });
    try { await writeFile(path.join(staging, 'manifest.json'), metadata, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (await readFile(path.join(staging, 'manifest.json'), 'utf8') !== metadata) throw knowledgeError('conflict', 'Upload metadata changed'); }
    const chunkFile = path.join(staging, String(chunkIndex));
    try { await writeFile(chunkFile, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (digest(await readFile(chunkFile)) !== digest(bytes)) throw knowledgeError('conflict', 'Chunk already contains different bytes'); }
    const present = (await readdir(staging)).filter((name) => /^\d+$/.test(name));
    if (present.length !== chunkCount) return { complete: false, uploadId, receivedChunks: present.length, totalChunks: chunkCount };
    bytes = Buffer.concat(await Promise.all(Array.from({ length: chunkCount }, (_, index) => readFile(path.join(staging!, String(index))))));
  }
  if (bytes.length > WORKSPACE_ATTACHMENT_MAX_BYTES || (request.sha256 && digest(bytes) !== request.sha256)) throw knowledgeError('invalid_request', 'Attachment exceeds 8 MiB or SHA256 does not match');
  const state = await loadWorkspace(deps, actor);
  const previous = state.attachments.find((item) => item.requestId === request.requestId);
  if (previous) {
    if (previous.originalPath !== originalPath || previous.sha256 !== digest(bytes) || previous.mimeType !== request.mimeType) throw knowledgeError('conflict', 'Attachment requestId was already used');
    return attachmentView(state, previous);
  }
  if (state.attachments.some((item) => pathKey(item.originalPath) === pathKey(originalPath))) throw knowledgeError('conflict', 'Attachment path already exists (case and Unicode normalized)');
  const id = digest(`${actor.userId}\0${request.requestId}`).slice(0, 32);
  await mkdir(resourceRoot(deps, actor), { recursive: true });
  const filename = resourceFile(deps, actor, id);
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (digest(await readStored(deps, actor, id)) !== digest(bytes)) throw knowledgeError('conflict', 'Resource identity already contains different bytes'); }
  const record = { id, userId: actor.userId, path: `attachments/${id}/${path.posix.basename(originalPath).replace(/\s+/g, '-')}`, originalPath, mimeType: request.mimeType, size: bytes.length, sha256: digest(bytes), createdAt: nowIso(), revision: 1, requestId: request.requestId };
  state.attachments.push(record);
  await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  if (staging) await rm(staging, { recursive: true, force: true });
  return attachmentView(state, record);
}
export async function deleteAttachment(deps: CoreDeps, actor: ActorContext, id: string, expectedRevision: number): Promise<void> {
  const state = await loadWorkspace(deps, actor);
  const value = state.attachments.find((item) => item.id === id);
  if (!value) throw knowledgeError('not_found', 'Attachment not found');
  if (value.revision !== expectedRevision) throw knowledgeError('conflict', 'Attachment changed');
  if (referenceCourses(state, value).length || state.snapshots.some((snapshot) => referenceCourses(snapshot.before, value).length > 0)) throw knowledgeError('conflict', 'Attachment is referenced by content or recovery history');
  state.attachments = state.attachments.filter((item) => item.id !== id);
  await deps.repository.commitWorkspaceState(actor.userId, state.revision, state);
  // Keep bytes until profile maintenance: a successful metadata delete must never race a restoring reader.
}

export async function importMarkdown(deps: CoreDeps, actor: ActorContext, input: ImportMarkdownRequest): Promise<ImportMarkdownResult> {
  validateRequestSize(input);
  const request = importMarkdownSchema.parse(input);
  const importedPath = normalizeResourcePath(request.path);
  if (!/\.md$/i.test(importedPath)) throw knowledgeError('invalid_request', 'Import requires a Markdown .md file');
  let state = await loadWorkspace(deps, actor);
  if (!state.courses.some((course) => course.id === request.courseId)) throw knowledgeError('not_found', 'Course not found');
  if (request.courseChapterId !== null && !state.chapters.some((chapter) => chapter.id === request.courseChapterId && chapter.courseId === request.courseId)) throw knowledgeError('invalid_request', 'Import chapter belongs to another course');
  const key = pathKey(importedPath);
  const previous = state.imports[key];
  if (previous && previous.path !== importedPath) throw knowledgeError('conflict', 'Import path differs only by case or Unicode normalization');
  const contentHash = digest(request.markdown);
  const capture = await runCapture(deps, actor, { requestId: digest(`${importedPath}\0${contentHash}`), text: request.markdown, source: { type: 'manual', title: importedPath }, capture: { client: 'desktop', deviceId: 'markdown-import', capturedAt: nowIso() } }, { importOriginal: true });
  if (previous?.contentHash === contentHash) return { rawSourceId: previous.sourceId, document: await getCourseDocument(deps, actor, previous.courseId), duplicate: true };
  if (previous && (!request.replaceExisting || previous.courseId !== request.courseId)) throw knowledgeError('conflict', 'Import already exists; original preserved, explicit replacement required', { rawSourceId: capture.rawSourceId });
  const document = await getCourseDocument(deps, actor, request.courseId);
  if (document.documentRevision !== request.expectedDocumentRevision) throw knowledgeError('conflict', 'Course changed; original preserved', { rawSourceId: capture.rawSourceId });
  state = await loadWorkspace(deps, actor);
  if (previous) for (const [entryId, revision] of Object.entries(previous.revisions)) {
    if (state.entries.find((entry) => entry.id === entryId)?.revision !== revision) throw knowledgeError('conflict', 'Imported content has local edits; original preserved without overwrite', { rawSourceId: capture.rawSourceId, entryId });
  }
  const selected = previous ? document.projection.filter((range) => (range.entryId && previous.entryIds.includes(range.entryId)) || (range.courseChapterId && range.kind === 'chapter' && previous.chapterIds.includes(range.courseChapterId))) : [];
  let from: number; let to: number;
  if (previous && selected.length) {
    from = Math.min(...selected.map((range) => range.from)); to = Math.max(...selected.map((range) => range.to));
    if (document.projection.some((range) => range.from >= from && range.to <= to && !selected.includes(range))) throw knowledgeError('conflict', 'Imported content has interleaved local content; original preserved', { rawSourceId: capture.rawSourceId });
  } else {
    if (previous) throw knowledgeError('conflict', 'Imported content was removed; original preserved', { rawSourceId: capture.rawSourceId });
    const chapters = document.projection.filter((range) => range.kind === 'chapter');
    if (request.courseChapterId === null) from = chapters[0]?.from ?? document.markdown.length;
    else { const index = chapters.findIndex((range) => range.courseChapterId === request.courseChapterId); from = chapters[index + 1]?.from ?? document.markdown.length; }
    to = from;
  }
  const parsedInput = parseMarkdown(request.markdown, { tolerateInvalidFrontmatter: true });
  const resourceEdits = parsedInput.links.flatMap((reference) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference.target) || reference.target.startsWith('/')) return [];
    try {
      const normalized = normalizeResourcePath(path.posix.normalize(path.posix.join(path.posix.dirname(importedPath), reference.target)));
      const attachment = state.attachments.find((value) => value.originalPath === normalized);
      return attachment ? [{ reference, target: attachment.path }] : [];
    } catch { return []; }
  });
  const importedText = resourceEdits.length ? rewriteReferences(request.markdown, resourceEdits) : request.markdown;
  const parsedOriginal = parseMarkdown(importedText, { tolerateInvalidFrontmatter: true });
  const importedBody = parsedOriginal.frontmatter && !parsedOriginal.frontmatterError ? importedText.slice(parsedOriginal.frontmatter.to).replace(/^\r?\n/, '') : importedText;
  const originalIds = new Set(state.entries.map((entry) => entry.id));
  const revisions = Object.fromEntries(document.entries.map((entry) => [entry.id, entry.revision]));
  const result = await applyCourseDocumentPatch(deps, actor, { courseId: request.courseId, baseDocumentRevision: request.expectedDocumentRevision, entryRevisions: revisions, changes: [{ from, to, insert: `\n\n${importedBody}\n\n` }], requestId: `import:${digest(request.requestId).slice(0, 40)}` }, (next, before) => {
    const imported = next.entries.filter((entry) => entry.courseId === request.courseId && (!originalIds.has(entry.id) || previous?.entryIds.includes(entry.id) || before.entries.find((value) => value.id === entry.id)?.markdown !== entry.markdown));
    if (imported[0] && !parsedOriginal.frontmatterError) imported[0].properties = { ...imported[0].properties, ...parsedOriginal.properties };
    if (!imported.length) throw knowledgeError('invalid_request', 'Markdown import has no body content');
    for (const entry of imported) if (!next.sourceLinks.some((link) => link.entryId === entry.id && link.sourceId === capture.rawSourceId)) next.sourceLinks.push({ entryId: entry.id, sourceId: capture.rawSourceId, locations: [{ path: importedPath }] });
    next.imports[key] = { path: importedPath, sourceId: capture.rawSourceId, courseId: request.courseId, entryIds: imported.map((entry) => entry.id), chapterIds: next.chapters.filter((chapter) => chapter.courseId === request.courseId && (!before.chapters.some((value) => value.id === chapter.id) || previous?.chapterIds.includes(chapter.id))).map((chapter) => chapter.id), revisions: Object.fromEntries(imported.map((entry) => [entry.id, entry.revision])), contentHash };
  });
  return { rawSourceId: capture.rawSourceId, document: result.documents.find((value) => value.courseId === request.courseId)!, duplicate: false };
}

export async function exportCourseMarkdown(deps: CoreDeps, actor: ActorContext, courseId: string): Promise<CourseMarkdownExport> {
  const document = await getCourseDocument(deps, actor, courseId);
  const attachments = await listAttachments(deps, actor, courseId);
  const title = document.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || courseId;
  return courseMarkdownExportSchema.parse({ filename: `${title}.md`, markdown: setFrontmatterProperties(document.markdown, document.properties), manifest: { sources: document.sources, attachments, owners: [{ kind: 'course', id: document.courseId, properties: document.properties }, ...document.chapters.map((chapter) => ({ kind: 'chapter', id: chapter.id, properties: chapter.properties })), ...document.entries.map((entry) => ({ kind: 'entry', id: entry.id, properties: entry.properties }))] } });
}

/** Only startup configuration may supply directory; API callers never provide filesystem paths. */
export async function startMarkdownDirectoryWatcher(deps: CoreDeps, actor: ActorContext, options: { directory: string; courseId: string }): Promise<{ close(): void; scan(): Promise<{ imported: number; conflicts: string[] }> }> {
  const directory = await realpath(options.directory);
  if (!(await lstat(directory)).isDirectory()) throw knowledgeError('invalid_request', 'Configured Markdown directory is not a directory');
  let closed = false; let running: Promise<{ imported: number; conflicts: string[] }> | undefined; let timer: NodeJS.Timeout | undefined;
  const scan = (): Promise<{ imported: number; conflicts: string[] }> => {
    if (running) return running;
    running = (async () => {
      let imported = 0; const conflicts: string[] = [];
      const files = await readdir(directory, { recursive: true, withFileTypes: true });
      const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain' };
      for (const file of files) {
        const mimeType = mimeTypes[path.extname(file.name).toLowerCase()];
        if (closed || !file.isFile() || !mimeType) continue;
        const full = path.join(file.parentPath, file.name); const relative = path.relative(directory, full).split(path.sep).join('/');
        try {
          normalizeResourcePath(relative);
          if (await realpath(full) !== full || !full.startsWith(directory + path.sep)) throw knowledgeError('invalid_request', 'Watched attachment escapes configured directory');
          const bytes = await readFile(full);
          if (bytes.length > WORKSPACE_ATTACHMENT_MAX_BYTES) throw knowledgeError('invalid_request', 'Watched attachment exceeds 8 MiB');
          const sha256 = digest(bytes); const chunkCount = Math.max(1, Math.ceil(bytes.length / WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES));
          let uploadId: string | undefined;
          for (let index = 0; index < chunkCount; index++) {
            const result = await uploadAttachment(deps, actor, { path: relative, mimeType, requestId: digest(`${relative}\0${sha256}`), sha256, chunkCount, chunkIndex: index, uploadId, contentBase64: bytes.subarray(index * WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES, (index + 1) * WORKSPACE_ATTACHMENT_CHUNK_MAX_BYTES).toString('base64') });
            if ('complete' in result) uploadId = result.uploadId;
          }
        } catch (error) { conflicts.push(relative); deps.logger.warn('Watched attachment preserved a conflict', { path: relative, reason: error instanceof Error ? error.message : String(error) }); }
      }
      for (const file of files) {
        if (closed) break;
        if (!file.isFile() || !/\.md$/i.test(file.name)) continue;
        const full = path.join(file.parentPath, file.name);
        const relative = path.relative(directory, full).split(path.sep).join('/');
        try {
          normalizeResourcePath(relative);
          const actual = await realpath(full);
          if (actual !== full || !actual.startsWith(directory + path.sep)) throw knowledgeError('invalid_request', 'Watched resource escapes configured directory');
          const markdown = await readFile(actual, 'utf8');
          const document = await getCourseDocument(deps, actor, options.courseId);
          const result = await importMarkdown(deps, actor, { courseId: options.courseId, courseChapterId: null, path: relative, markdown, requestId: digest(`${relative}\0${digest(markdown)}`), expectedDocumentRevision: document.documentRevision, replaceExisting: true });
          if (!result.duplicate) imported++;
        } catch (error) { conflicts.push(relative); deps.logger.warn('Watched Markdown import preserved a conflict', { path: relative, reason: error instanceof Error ? error.message : String(error) }); }
      }
      return { imported, conflicts };
    })().finally(() => { running = undefined; });
    return running;
  };
  const watcher: FSWatcher = watch(directory, { recursive: true }, () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void scan().catch((error: unknown) => deps.logger.warn('Watched directory scan failed', { reason: String(error) })); }, 200); });
  try { await scan(); } catch (error) { watcher.close(); throw error; }
  return { scan, close() { closed = true; watcher.close(); if (timer) clearTimeout(timer); } };
}
