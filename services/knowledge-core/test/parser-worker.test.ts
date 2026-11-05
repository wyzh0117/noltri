import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MetadataParserWorker } from '../src/notes/parser';

describe('metadata parser worker recovery', () => {
  it('backs off when the worker asset is missing and retries after it appears', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-parser-worker-'));
    const parser = new MetadataParserWorker(pathToFileURL(path.join(directory, 'parser.mjs')).href);
    try {
      const failures = await Promise.allSettled(Array.from({ length: 16 }, () => parser.parse('content', 2_000)));
      expect(failures.every((result) => result.status === 'rejected')).toBe(true);
      expect(parser.restarts).toBe(1);

      await writeFile(path.join(directory, 'parser-worker.mjs'), [
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.on('message', ({ id }) => parentPort.postMessage({ id, result: { metadata: {} } }));",
      ].join('\n'));
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await expect(parser.parse('content')).resolves.toMatchObject({ metadata: {} });
      expect(parser.restarts).toBe(1);
    } finally {
      await parser.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);
});
