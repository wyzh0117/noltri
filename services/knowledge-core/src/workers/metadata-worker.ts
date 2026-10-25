import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { PARSER_VERSION, resolveKnowledgeLink, type ParsedMarkdown, type LinkContext, type LinkTarget, type LinkResolution, type MarkdownLink } from '@noltri/note-engine';

export interface ParseJob { id: string; revision: number; content: string; configVersion?: string; signal?: AbortSignal }
export interface ParseResult { id: string; revision: number; hash: string; cacheKey: string; metadata: ParsedMarkdown }
export interface ResolveJob { id: string; revision: number; generation: number; metadata: ParsedMarkdown; context: LinkContext; targets: LinkTarget[]; stableTargets?: Map<string, LinkResolution>; signal?: AbortSignal }
export interface ResolvedReference { reference: MarkdownLink; resolution: LinkResolution }
export type ParseExecutor = (content: string) => Promise<ParsedMarkdown>;

/** A single reusable Node worker keeps Markdown parsing off Core's request/event loop. */
export class MarkdownParseThread {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: ParsedMarkdown) => void; reject: (error: Error) => void }>();
  parse: ParseExecutor = (content) => new Promise((resolve, reject) => {
    if (!this.worker) {
      const compiled = new URL('./metadata-parser.mjs', import.meta.url);
      if (existsSync(compiled)) this.worker = new Worker(compiled);
      else {
        const moduleUrl = import.meta.resolve('@noltri/note-engine');
        this.worker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        const { tsImport } = require('tsx/esm/api');
        const ready = tsImport(${JSON.stringify(moduleUrl)}, ${JSON.stringify(import.meta.url)});
        parentPort.on('message', async ({ id, content }) => {
          try { const { parseMarkdown } = await ready; parentPort.postMessage({ id, metadata: parseMarkdown(content) }); }
          catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
        });`, { eval: true });
      }
      this.worker.on('message', (message: { id: number; metadata?: ParsedMarkdown; error?: string }) => {
        const job = this.pending.get(message.id); this.pending.delete(message.id);
        if (job) { if (message.metadata) job.resolve(message.metadata); else job.reject(new Error(message.error ?? 'Metadata parse failed')); }
        if (!this.pending.size) this.worker?.unref();
      });
      this.worker.on('error', (error) => { for (const job of this.pending.values()) job.reject(error); this.pending.clear(); this.worker = undefined; });
    }
    const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.worker.ref(); this.worker.postMessage({ id, content });
  });
  async close(): Promise<void> {
    const worker = this.worker; this.worker = undefined;
    for (const job of this.pending.values()) job.reject(new Error('Metadata worker closed')); this.pending.clear();
    if (worker) await worker.terminate();
  }
}

/** Independent parse/resolve tails isolate failures and discard stale object/generation results. */
export class MetadataWorker {
  private parseTail: Promise<unknown> = Promise.resolve();
  private resolveTail: Promise<unknown> = Promise.resolve();
  private latest = new Map<string, number>();
  private cache = new Map<string, ParsedMarkdown>();
  private generation = 0;
  readonly stats = { parsed: 0, cacheHits: 0, discarded: 0, failures: 0, resolved: 0 };
  constructor(private readonly executor: ParseExecutor, private readonly maxCacheEntries = 2048) {}
  setGeneration(generation: number): void { this.generation = Math.max(this.generation, generation); }
  parse(job: ParseJob): Promise<ParseResult | undefined> {
    this.latest.set(job.id, Math.max(this.latest.get(job.id) ?? 0, job.revision));
    const run = async () => {
      if (job.signal?.aborted || this.latest.get(job.id) !== job.revision) { this.stats.discarded++; return undefined; }
      const hash = createHash('sha256').update(job.content, 'utf8').digest('hex');
      const cacheKey = `${hash}:${PARSER_VERSION}:${job.configVersion ?? '1'}`;
      let metadata = this.cache.get(cacheKey);
      if (metadata) { this.stats.cacheHits++; this.cache.delete(cacheKey); this.cache.set(cacheKey, metadata); }
      else {
        metadata = await this.executor(job.content); this.stats.parsed++;
        this.cache.set(cacheKey, metadata);
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      if (job.signal?.aborted || this.latest.get(job.id) !== job.revision) { this.stats.discarded++; return undefined; }
      return { id: job.id, revision: job.revision, hash, cacheKey, metadata };
    };
    const result = this.parseTail.then(run); this.parseTail = result.catch(() => { this.stats.failures++; }); return result;
  }
  resolve(job: ResolveJob): Promise<ResolvedReference[] | undefined> {
    const run = () => {
      if (job.signal?.aborted || this.latest.get(job.id) !== job.revision || job.generation !== this.generation) { this.stats.discarded++; return undefined; }
      const result = job.metadata.links.map((reference) => {
        const previous = job.stableTargets?.get(`${reference.from}:${reference.target}`);
        const stableTarget = previous?.status === 'resolved' ? previous.target : undefined;
        return { reference, resolution: resolveKnowledgeLink({ ...job.context, ...(stableTarget ? { stableTarget } : {}) }, reference.target, job.targets) };
      });
      this.stats.resolved += result.length; return result;
    };
    const result = this.resolveTail.then(run); this.resolveTail = result.catch(() => { this.stats.failures++; }); return result;
  }
  clearCache(): void { this.cache.clear(); }
  pruneCache(activeHashes: ReadonlySet<string>): void { for (const key of this.cache.keys()) if (!activeHashes.has(key.split(':')[0])) this.cache.delete(key); }
}
