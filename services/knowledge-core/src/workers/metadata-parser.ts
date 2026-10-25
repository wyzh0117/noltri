import { parentPort } from 'node:worker_threads';
import { parseMarkdown } from '@noltri/note-engine';

parentPort?.on('message', ({ id, content }: { id: number; content: string }) => {
  try { parentPort?.postMessage({ id, metadata: parseMarkdown(content) }); }
  catch (error) { parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
