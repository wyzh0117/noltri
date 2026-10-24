import { parentPort } from 'node:worker_threads';
import { parseMarkdown } from './markdown';

interface ParseRequest { id: number; content: ArrayBuffer }

const port = parentPort;
if (port === null) throw new Error('Markdown parser worker requires a parent port');

port.on('message', (request: ParseRequest) => {
  try {
    const content = new TextDecoder().decode(request.content);
    port.postMessage({ id: request.id, result: parseMarkdown(content) });
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
