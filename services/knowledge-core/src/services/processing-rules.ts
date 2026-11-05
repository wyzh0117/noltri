import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import {
  processingRecordSchema, processingRulesDraftSchema, processingRulesSchema, processingRulesSnapshotSchema,
  type ProcessingRecord, type ProcessingRules, type ProcessingRulesDraft, type ProcessingRulesSnapshot,
} from '@noltri/schema';

const STATE_FILE = 'processing-rules.json';
const TEMP_FILE = '.processing-rules.tmp';
const MAX_FILE_BYTES = 12_000_000;
const MAX_VERSIONS = 1000;
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  draft: processingRulesDraftSchema,
  versions: z.array(processingRulesSnapshotSchema).min(1).max(MAX_VERSIONS),
  records: z.array(processingRecordSchema).max(500),
}).strict();
type State = z.infer<typeof stateSchema>;
export interface ProcessingRulesStoreOptions {
  /** Absolute, canonical directory supplied by the host; its parent must exist. */
  root: string;
  defaults: ProcessingRules;
  /** Keep the most recent metadata records, between 1 and 500. Defaults to 200. */
  recordLimit?: number;
}
export class ProcessingRulesStoreError extends Error {
  constructor(readonly code: 'revision_conflict' | 'version_not_found' | 'unsafe_path' | 'invalid_state' | 'state_conflict' | 'version_limit') {
    super(code);
    this.name = 'ProcessingRulesStoreError';
  }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function hash(rules: ProcessingRules): string {
  // Schema parsing fixes property order; hashes identify content, not external authenticity.
  return createHash('sha256').update(JSON.stringify(processingRulesSchema.parse(rules))).digest('hex');
}
function snapshot(rules: ProcessingRules, sequence: number): State['versions'][number] {
  const contentHash = hash(rules);
  return { versionId: `rules-${sequence}-${contentHash.slice(0, 12)}`, contentHash, createdAt: new Date().toISOString(), rules: structuredClone(rules) };
}
function validateState(value: unknown): State {
  const state = stateSchema.parse(value);
  for (const [index, version] of state.versions.entries()) {
    if (version.contentHash !== hash(version.rules) || version.versionId !== `rules-${index + 1}-${version.contentHash.slice(0, 12)}`) {
      throw new ProcessingRulesStoreError('invalid_state');
    }
  }
  const ids = new Set(state.versions.map((version) => version.versionId));
  if (state.records.some((record) => !ids.has(record.ruleVersionId)) || new Set(state.records.map((record) => record.recordId)).size !== state.records.length) {
    throw new ProcessingRulesStoreError('invalid_state');
  }
  return state;
}

/** Local durable store; consumers must explicitly capture getAppliedSnapshot() for each task. */
export class ProcessingRulesStore {
  private queue: Promise<unknown> = Promise.resolve();
  private rootIdentity?: { dev: number; ino: number };
  private constructor(private readonly root: string, private readonly recordLimit: number, private state: State) {}

  static async open(options: ProcessingRulesStoreOptions): Promise<ProcessingRulesStore> {
    const rules = processingRulesSchema.parse(options.defaults);
    const recordLimit = z.number().int().min(1).max(500).parse(options.recordLimit ?? 200);
    if (!isAbsolute(options.root)) throw new ProcessingRulesStoreError('unsafe_path');
    const store = new ProcessingRulesStore(resolve(options.root), recordLimit, {
      schemaVersion: 1, draft: { revision: 0, rules }, versions: [snapshot(rules, 1)], records: [],
    });
    await store.checkRoot(true);
    const loaded = await store.readState();
    if (loaded) store.state = loaded;
    else await store.writeState(store.state, true);
    return store;
  }

  readDraft(): ProcessingRulesDraft { return structuredClone(this.state.draft); }
  getAppliedSnapshot(): ProcessingRulesSnapshot { return immutable(structuredClone(this.state.versions[this.state.versions.length - 1])); }
  listVersions(): ProcessingRulesSnapshot[] { return this.state.versions.map((value) => immutable(structuredClone(value))); }
  listRecords(): ProcessingRecord[] { return structuredClone(this.state.records).slice(-this.recordLimit); }

  saveDraft(rules: unknown, expectedRevision: number): Promise<ProcessingRulesDraft> {
    return this.mutate(async (next) => {
      this.expectRevision(expectedRevision);
      next.draft = { revision: next.draft.revision + 1, rules: processingRulesSchema.parse(rules) };
      return structuredClone(next.draft);
    });
  }
  applyDraft(expectedRevision: number): Promise<ProcessingRulesSnapshot> {
    return this.mutate(async (next) => {
      this.expectRevision(expectedRevision);
      return this.addVersion(next, next.draft.rules);
    });
  }
  rollback(versionId: string, expectedRevision: number): Promise<ProcessingRulesSnapshot> {
    return this.mutate(async (next) => {
      this.expectRevision(expectedRevision);
      const previous = next.versions.find((version) => version.versionId === versionId);
      if (!previous) throw new ProcessingRulesStoreError('version_not_found');
      next.draft.rules = structuredClone(previous.rules);
      return this.addVersion(next, previous.rules);
    });
  }
  appendRecord(record: unknown): Promise<ProcessingRecord> {
    return this.mutate(async (next) => {
      const parsed = processingRecordSchema.parse(record);
      if (!next.versions.some((version) => version.versionId === parsed.ruleVersionId)) throw new ProcessingRulesStoreError('version_not_found');
      next.records = [...next.records.filter((value) => value.recordId !== parsed.recordId), parsed].slice(-this.recordLimit);
      return structuredClone(parsed);
    });
  }
  private expectRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision !== this.state.draft.revision) throw new ProcessingRulesStoreError('revision_conflict');
  }
  private addVersion(next: State, rules: ProcessingRules): ProcessingRulesSnapshot {
    if (next.versions.length >= MAX_VERSIONS) throw new ProcessingRulesStoreError('version_limit');
    const version = snapshot(processingRulesSchema.parse(rules), next.versions.length + 1);
    next.versions.push(version);
    next.draft.revision++;
    return immutable(structuredClone(version));
  }
  private mutate<T>(change: (next: State) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = await change(next);
      validateState(next);
      await this.writeState(next);
      this.state = next;
      return result;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async checkRoot(create = false): Promise<void> {
    const rootParts = this.root.slice(parse(this.root).root.length).split('/').filter(Boolean);
    let current = parse(this.root).root;
    for (const part of rootParts) {
      current = join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!missing(error) || !create || current !== this.root) throw error;
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ProcessingRulesStoreError('unsafe_path');
      if (current === this.root) {
        if (this.rootIdentity && (this.rootIdentity.ino !== info.ino || this.rootIdentity.dev !== info.dev)) throw new ProcessingRulesStoreError('unsafe_path');
        this.rootIdentity = { dev: info.dev, ino: info.ino };
      }
    }
    if (dirname(this.root) === this.root) throw new ProcessingRulesStoreError('unsafe_path');
  }
  private async readState(): Promise<State | undefined> {
    await this.checkRoot();
    const path = join(this.root, STATE_FILE);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) throw new ProcessingRulesStoreError('unsafe_path');
    } catch (error) { if (missing(error)) return undefined; throw error; }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES || info.nlink !== 1) throw new ProcessingRulesStoreError('unsafe_path');
      return validateState(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  }
  private async writeState(next: State, initial = false): Promise<void> {
    const persisted = await this.readState();
    if (initial ? persisted !== undefined : !persisted || JSON.stringify(persisted) !== JSON.stringify(this.state)) throw new ProcessingRulesStoreError('state_conflict');
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new ProcessingRulesStoreError('invalid_state');
    const temporary = join(this.root, TEMP_FILE);
    // Exclusive creation refuses existing files, directories and symlinks; never removes an unowned temporary file.
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    let rootRejected = false;
    let temporaryIdentity: { dev: number; ino: number } | undefined;
    try {
      const owned = await file.stat();
      temporaryIdentity = { dev: owned.dev, ino: owned.ino };
      await file.writeFile(encoded, 'utf8');
      await file.sync();
      await file.close();
      try { await this.checkRoot(); }
      catch (error) { rootRejected = true; throw error; }
      await rename(temporary, join(this.root, STATE_FILE));
      renamed = true;
    } finally {
      await file.close().catch(() => undefined);
      if (!renamed && !rootRejected && temporaryIdentity) {
        try {
          // A failed write may have yielded while the root or temporary path was replaced.
          // Cleanup is optional: retain the file unless both root and inode ownership still hold.
          await this.checkRoot();
          const current = await lstat(temporary);
          if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1
            && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
            await unlink(temporary);
          }
        } catch { /* Preserve the original failure and avoid untrusted-path cleanup. */ }
      }
    }
  }
}
