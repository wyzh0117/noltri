import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createInMemoryRepository } from '@noltri/storage';
import { VaultService } from '../src/notes/vault';

const directories: string[] = [];
afterAll(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Vault refresh event publication', () => {
  it('publishes changed revisions only after backlinks use the matching index', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noltri-refresh-atomicity-'));
    directories.push(directory);
    const rootPath = path.join(directory, 'vault');
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, 'Target.md'), '# Target\n');
    await writeFile(path.join(rootPath, 'Source.md'), '# Source\n');

    const repository = createInMemoryRepository();
    const vault = new VaultService({ rootPath, dataDir: path.join(directory, 'data'), repository, userId: 'refresh-atomicity-test' });
    const internals = vault as unknown as {
      refresh: (force: boolean) => Promise<void>;
      rebuildLinks: () => Promise<void>;
    };
    let releaseLinks: () => void = () => {};
    let refresh: Promise<void> | null = null;
    try {
      await vault.initialize();
      const baseline = await vault.changesAfter(0);
      const originalRebuildLinks = internals.rebuildLinks.bind(vault);
      let enterRebuild!: () => void;
      const rebuildEntered = new Promise<void>((resolve) => { enterRebuild = resolve; });
      const rebuildGate = new Promise<void>((resolve) => { releaseLinks = resolve; });
      let pauseNextRebuild = true;
      internals.rebuildLinks = async () => {
        if (pauseNextRebuild) {
          pauseNextRebuild = false;
          enterRebuild();
          await rebuildGate;
        }
        await originalRebuildLinks();
      };

      await writeFile(path.join(rootPath, 'Source.md'), '# Source\n\n[[Target]]\n');
      refresh = internals.refresh(true);
      await rebuildEntered;
      const beforeCommit = await vault.changesAfter(baseline.revision);
      expect(beforeCommit.revision).toBe(baseline.revision);
      expect(beforeCommit.events).toEqual([]);

      releaseLinks();
      await refresh;
      const afterCommit = await vault.changesAfter(baseline.revision);
      expect(afterCommit.events).toContainEqual({ kind: 'changed', path: 'Source.md' });
      const backlinks = await vault.getBacklinks('Target.md');
      expect(backlinks.revision).toBe(afterCommit.revision);
      expect(backlinks.backlinks).toContainEqual(expect.objectContaining({ sourcePath: 'Source.md', count: 1 }));
    } finally {
      releaseLinks();
      if (refresh !== null) await refresh.catch(() => undefined);
      await vault.close();
      await (repository as { close?: () => Promise<void> }).close?.();
    }
  });
});
