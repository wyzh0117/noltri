import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_GRAPH_NOTE_CHARS, apiErrorSchema } from '@noltri/schema';
import { FileGrantStore, issueGrant } from '../src/authorization';
import { startServer } from '../src/server';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';

const directories: string[] = [];
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('Graph v3.1 over the local HTTP server and SQLite', () => {
  it('enforces exact-node grants, preserves existing discipline anchors and accepts the bounded note maximum', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'noltri-graph-http-'));
    directories.push(directory);
    const sqliteFile = path.join(directory, 'profile.sqlite');
    const env = {
      STORAGE_DRIVER: 'sqlite',
      NOLTRI_SQLITE_FILE: sqliteFile,
      NOLTRI_DATA_DIR: directory,
      NOLTRI_GRANT_FILE: path.join(directory, 'grants.json'),
      NOLTRI_DEV_USER_ID: 'graph-http-user',
      NOLTRI_DEV_REQUIRE_TOKEN: 'false',
      NOLTRI_DEV_TOKEN: '',
      AI_PROVIDER: 'offline',
    } as const;
    const previous = new Map<string, string | undefined>();
    let topicId = '';
    let chapterId = '';
    const content = '\u0001'.repeat(MAX_GRAPH_NOTE_CHARS);
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    let running: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      running = await startServer({ port: 0 });
      const address = running.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${String(address.port)}`;
      const repository = running.bundle.repository;
      const userId = running.bundle.config.devUser;
      const disciplineA = await repository.createNode({ userId, title: '物理学', nodeType: 'discipline' });
      const branchA = await repository.createNode({ userId, title: '力学', nodeType: 'subdiscipline', parentId: disciplineA.id });
      const topicA = await repository.createNode({ userId, title: '运动', nodeType: 'topic', parentId: branchA.id });
      topicId = topicA.id;
      const disciplineB = await repository.createNode({ userId, title: '计算机科学', nodeType: 'discipline' });
      const branchB = await repository.createNode({ userId, title: '图形学', nodeType: 'subdiscipline', parentId: disciplineB.id });
      const topicB = await repository.createNode({ userId, title: '渲染', nodeType: 'topic', parentId: branchB.id });
      const chapter = await repository.createNode({ userId, title: '向量', nodeType: 'chapter' });
      chapterId = chapter.id;
      const originalEdge = await repository.createEdge({
        userId,
        fromNodeId: chapter.id,
        toNodeId: topicA.id,
        relationType: 'part_of',
        source: 'topic_chapter',
      });
      const grants = running.bundle.grants;
      if (!(grants instanceof FileGrantStore)) throw new Error('test server grant store is not file-backed');

      const rootOnly = (await issueGrant(grants, { label: 'only root', scopes: ['read'], nodeIds: [disciplineA.id] })).secret;
      const graphDenied = await fetch(`${base}/api/graph/select`, {
        method: 'POST', headers: { authorization: `Bearer ${rootOnly}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'discipline', disciplineId: disciplineA.id }),
      });
      expect(graphDenied.status).toBe(401);
      expect(apiErrorSchema.parse(await graphDenied.json()).error.details).toMatchObject({ reason: 'node_not_granted' });
      const resolveDenied = await fetch(`${base}/api/graph/resolve-chapter`, {
        method: 'POST', headers: { authorization: `Bearer ${rootOnly}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chapterId: chapter.id, scope: { kind: 'discipline', disciplineId: disciplineA.id } }),
      });
      expect(resolveDenied.status).toBe(401);

      const topicOnly = (await issueGrant(grants, { label: 'topic only', scopes: ['read'], nodeIds: [topicA.id] })).secret;
      const noteOnly = await repository.saveKnowledgeNote({ userId, topicId: topicA.id, chapterId: chapter.id, content: '索引不可越权' });
      expect(noteOnly.content).toBe('索引不可越权');
      const indexDenied = await fetch(`${base}/api/notes/${topicA.id}/chapters`, { headers: { authorization: `Bearer ${topicOnly}` } });
      expect(indexDenied.status).toBe(401);
      expect(apiErrorSchema.parse(await indexDenied.json()).error.details).toMatchObject({ reason: 'node_not_granted' });

      const relationWriter = (await issueGrant(grants, {
        label: 'cross link attempt', scopes: ['mutate'], nodeIds: [chapter.id, topicB.id],
      })).secret;
      const crossLink = await fetch(`${base}/api/chapters/${chapter.id}/topics/${topicB.id}`, {
        method: 'PUT', headers: { authorization: `Bearer ${relationWriter}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chapterId: chapter.id, topicId: topicB.id }),
      });
      expect(crossLink.status).toBe(400);
      expect(await repository.findEdge(userId, chapter.id, topicA.id, 'part_of')).toEqual(originalEdge);
      expect((await running.bundle.core.selectGraph({ kind: 'discipline', disciplineId: disciplineA.id }, { userId, actor: 'test' })).nodes.map((node) => node.id)).toContain(chapter.id);
      expect((await running.bundle.core.selectGraph({ kind: 'discipline', disciplineId: disciplineB.id }, { userId, actor: 'test' })).nodes.map((node) => node.id)).not.toContain(chapter.id);

      const noteWriter = (await issueGrant(grants, {
        label: 'note writer', scopes: ['read', 'mutate'], nodeIds: [topicA.id, chapter.id],
      })).secret;
      // U+0001 forces JSON's six-byte control-character escape without SQLite's special NUL handling.
      const body = JSON.stringify({ chapterId: chapter.id, content });
      expect(Buffer.byteLength(body)).toBeLessThan(256_000);
      const saved = await fetch(`${base}/api/notes/${topicA.id}`, {
        method: 'PUT', headers: { authorization: `Bearer ${noteWriter}`, 'content-type': 'application/json' }, body,
      });
      expect(saved.status).toBe(200);
      expect((await repository.getKnowledgeNote(userId, topicA.id, chapter.id))?.content).toBe(content);

      const tooLong = await fetch(`${base}/api/notes/${topicA.id}`, {
        method: 'PUT', headers: { authorization: `Bearer ${noteWriter}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chapterId: chapter.id, content: 'x'.repeat(MAX_GRAPH_NOTE_CHARS + 1) }),
      });
      expect(tooLong.status).toBe(400);
      expect(apiErrorSchema.parse(await tooLong.json()).error.details).toMatchObject({
        0: expect.objectContaining({ message: expect.stringContaining(String(MAX_GRAPH_NOTE_CHARS)) }),
      });
      expect((await repository.getKnowledgeNote(userId, topicA.id, chapter.id))?.content).toBe(content);
    } finally {
      if (running !== undefined) await running.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const reopened = new SqliteRepository({ file: sqliteFile });
    try {
      expect((await reopened.getKnowledgeNote('graph-http-user', topicId, chapterId))?.content).toBe(content);
    } finally {
      await reopened.close();
    }
  }, 20_000);
});
