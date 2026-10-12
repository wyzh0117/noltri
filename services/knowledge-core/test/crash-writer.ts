/**
 * Child-process half of the crash-durability scenario in `local-storage-slice.test.ts`.
 *
 * It commits one raw source through the same `createRepository` factory the app uses and then
 * SIGKILLs itself: no `close()`, no WAL checkpoint, no cleanup handler. The id it received for the
 * committed write is handed to the parent through a file (a synchronous write, so the pipe buffer
 * cannot swallow it) rather than through stdout.
 */
import { writeFileSync } from 'node:fs';
import { createRepository } from '@noltri/storage';

const [file = '', userId = '', receipt = ''] = process.argv.slice(2);
const repository = await createRepository({ driver: 'sqlite', sqliteFile: file });
const source = await repository.createRawSource({
  userId,
  rawText: '子进程写入后立刻被 SIGKILL，不做任何 close()。',
  sourceType: 'manual',
  capturedAt: new Date().toISOString(),
  metadata: { client: 'crash-test' },
});
writeFileSync(receipt, source.id, 'utf8');
process.kill(process.pid, 'SIGKILL');
