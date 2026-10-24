import { Worker } from 'node:worker_threads';
import type { ParsedMarkdown } from './markdown';

interface ParseResponse { id: number; result?: ParsedMarkdown; error?: string }
type Job = { id: number; transferable: ArrayBuffer; timeoutMs: number; resolve: (result: ParsedMarkdown) => void; reject: (error: Error) => void };
const PARSE_TIMEOUT_MS = 10_000;

/** One worker and one in-flight transfer keep bulk indexing off the HTTP event loop. */
export class MetadataParserWorker {
  private worker: Worker;
  private nextId = 0;
  private pending: Job | null = null;
  private readonly queue: Job[] = [];
  private closed = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private timeoutCount = 0;

  constructor(private readonly moduleUrl: string) { this.worker = this.spawn(); }

  get queued(): number { return this.queue.length + (this.pending === null ? 0 : 1); }
  get restarts(): number { return this.restartCount; }
  get timeouts(): number { return this.timeoutCount; }

  parse(content: string, timeoutMs = PARSE_TIMEOUT_MS): Promise<ParsedMarkdown> {
    if (this.closed) return Promise.reject(new Error('Markdown parser worker is closed'));
    const bytes = new TextEncoder().encode(content);
    const transferable = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(transferable).set(bytes);
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, transferable, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimeout();
    this.pending?.reject(new Error('Markdown parser worker closed before parsing completed'));
    this.pending = null;
    for (const job of this.queue.splice(0)) job.reject(new Error('Markdown parser worker closed before parsing completed'));
    await this.worker.terminate();
  }

  private spawn(): Worker {
    const entry = new URL(this.moduleUrl.endsWith('.mjs') ? './parser-worker.mjs' : './parser-worker.ts', this.moduleUrl);
    const worker = new Worker(entry, {
      name: 'noltri-markdown-parser',
      ...(entry.pathname.endsWith('.ts') ? { execArgv: ['--import', import.meta.resolve('tsx')] } : {}),
    });
    worker.on('message', (response: ParseResponse) => {
      if (worker !== this.worker || this.pending?.id !== response.id) return;
      const job = this.pending;
      this.pending = null;
      this.clearTimeout();
      if (response.error !== undefined) job.reject(new Error(response.error));
      else if (response.result !== undefined) job.resolve(response.result);
      else job.reject(new Error('Markdown parser returned no result'));
      this.pump();
    });
    worker.on('error', (error) => { if (worker === this.worker) this.restart(error); });
    worker.on('exit', (code) => {
      if (!this.closed && worker === this.worker) this.restart(new Error(`Markdown parser worker exited with code ${String(code)}`));
    });
    return worker;
  }

  private pump(): void {
    if (this.closed || this.pending !== null) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.pending = job;
    this.timeout = setTimeout(() => {
      this.timeoutCount += 1;
      this.restart(new Error(`Markdown parse exceeded ${job.timeoutMs}ms`));
    }, job.timeoutMs);
    this.worker.postMessage({ id: job.id, content: job.transferable }, [job.transferable]);
  }

  private clearTimeout(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private restart(error: Error): void {
    if (this.closed) return;
    this.clearTimeout();
    const oldWorker = this.worker;
    const failed = this.pending;
    this.pending = null;
    this.restartCount += 1;
    this.worker = this.spawn();
    void oldWorker.terminate();
    failed?.reject(error);
    this.pump();
  }
}
