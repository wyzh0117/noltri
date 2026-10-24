import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInMemoryRepository } from '@noltri/storage';
import { VaultService } from '../src/notes/vault';

const base = await mkdtemp(path.join(tmpdir(), 'noltri-vault-benchmark-'));
const repositories: Array<{ close?: () => Promise<void> }> = [];
const measure = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - started) };
};
const makeVault = (rootPath: string, dataDir: string) => {
  const repository = createInMemoryRepository();
  repositories.push(repository as { close?: () => Promise<void> });
  return new VaultService({ rootPath, dataDir, repository, userId: 'synthetic-benchmark' });
};

try {
  const coldRoot = path.join(base, 'cold-vault');
  const coldData = path.join(base, 'cold-data');
  await mkdir(coldRoot, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    await writeFile(path.join(coldRoot, `Note-${String(index).padStart(4, '0')}.md`), `# Note ${index}\n\nneedle content ${index}\n`);
  }
  const cold = makeVault(coldRoot, coldData);
  const coldLoad = await measure(() => cold.initialize());
  await cold.close();
  const warm = makeVault(coldRoot, coldData);
  const warmLoad = await measure(() => warm.initialize());
  await warm.close();

  const searchRoot = path.join(base, 'search-vault');
  await mkdir(searchRoot, { recursive: true });
  for (let index = 0; index < 10_000; index += 1) {
    await writeFile(path.join(searchRoot, `Search-${String(index).padStart(5, '0')}.md`), `# Search ${index}\n\nneedle shared text ${index}\n`);
  }
  const searchVault = makeVault(searchRoot, path.join(base, 'search-data'));
  const indexedSearch = await measure(() => searchVault.initialize());
  const search = await measure(() => searchVault.search('needle shared', 10_000));
  await searchVault.close();

  const renameRoot = path.join(base, 'rename-vault');
  await mkdir(renameRoot, { recursive: true });
  await writeFile(path.join(renameRoot, 'Target.md'), '# Target\n');
  for (let index = 0; index < 100; index += 1) {
    await writeFile(path.join(renameRoot, `Ref-${index}.md`), `[[Target]]\n`);
  }
  const renameVault = makeVault(renameRoot, path.join(base, 'rename-data'));
  await renameVault.initialize();
  const rename = await measure(() => renameVault.renamePath('Target.md', 'Renamed.md'));
  await renameVault.close();

  const latencyRoot = path.join(base, 'latency-vault');
  await mkdir(latencyRoot, { recursive: true });
  await writeFile(path.join(latencyRoot, 'Target.md'), '# Target\n');
  await writeFile(path.join(latencyRoot, 'Source.md'), '[[Target]]\n');
  const latencyVault = makeVault(latencyRoot, path.join(base, 'latency-data'));
  await latencyVault.initialize();
  const editToBacklinks = await measure(async () => {
    const source = await latencyVault.getFile('Source.md');
    await latencyVault.writeFile('Source.md', 'No outgoing link\n', source.etag);
    return (await latencyVault.getBacklinks('Target.md')).backlinks.length;
  });
  if (editToBacklinks.value !== 0) throw new Error('single-file edit did not update the backlink index');
  const beforeExternalChange = (await latencyVault.snapshot()).revision;
  const externalStarted = performance.now();
  await writeFile(path.join(latencyRoot, 'External.md'), '# External update\n');
  let externalChangeSeen = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const changes = await latencyVault.changesAfter(beforeExternalChange);
    if (changes.events.some((event) => event.path === 'External.md')) { externalChangeSeen = true; break; }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!externalChangeSeen) throw new Error('external file change was not indexed by the watcher');
  const externalChangeMs = Math.round(performance.now() - externalStarted);
  await latencyVault.close();

  console.log(JSON.stringify({
    generated: { coldNotes: 1_000, searchNotes: 10_000, renameReferences: 100, externalChangeFiles: 1 },
    coldLoadMs: coldLoad.ms,
    warmLoadMs: warmLoad.ms,
    searchIndexLoad10kMs: indexedSearch.ms,
    search10kMs: search.ms,
    searchHits: search.value.results.length,
    rename100RefsMs: rename.ms,
    renamedPath: rename.value.path,
    editToBacklinksMs: editToBacklinks.ms,
    remainingBacklinksAfterEdit: editToBacklinks.value,
    externalChangeIndexMs: externalChangeMs,
  }, null, 2));
} finally {
  for (const repository of repositories) await repository.close?.();
  await rm(base, { recursive: true, force: true });
}
