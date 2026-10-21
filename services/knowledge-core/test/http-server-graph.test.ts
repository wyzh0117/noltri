import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_GRAPH_NOTE_CHARS, apiErrorSchema, captureResultSchema, graphSelectionSchema, treeResponseSchema, type KnowledgeNode } from '@noltri/schema';
import { FileGrantStore, issueGrant } from '../src/authorization';
import { startServer } from '../src/server';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { captureOf } from './fakes';

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

  it('reuses legacy domains through HTTP capture, exposes discipline scopes and preserves exact grants', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'noltri-legacy-taxonomy-'));
    directories.push(directory);
    const sqliteFile = path.join(directory, 'profile.sqlite');
    const grantFile = path.join(directory, 'grants.json');
    const env = {
      STORAGE_DRIVER: 'sqlite',
      NOLTRI_SQLITE_FILE: sqliteFile,
      NOLTRI_DATA_DIR: directory,
      NOLTRI_GRANT_FILE: grantFile,
      NOLTRI_DEV_USER_ID: 'legacy-taxonomy-user',
      NOLTRI_DEV_REQUIRE_TOKEN: 'false',
      NOLTRI_DEV_TOKEN: '',
      AI_PROVIDER: 'offline',
      AI_EMBEDDINGS_ENABLED: 'false',
    } as const;
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    let running: Awaited<ReturnType<typeof startServer>> | undefined;
    let legacyRootId = '';
    let legacyTopicId = '';
    let sharedChapterId = '';
    let originalSourceId = '';
    let originalItemId = '';
    let legacyEdgeIds: string[] = [];
    const userId = env.NOLTRI_DEV_USER_ID;
    const originalBody = '旧知识正文保持原样。';
    const originalSourceText = '旧来源原文保持原样。';
    const originalNoteText = '旧章节正文保持原样。';
    const oldPath = ['数学', '概率论', '概率基础'];
    const deepAiPath = ['数据科学', '统计学习', '概率图模型', '变分推断'];
    const manualPath = ['数学', '概率新方向', '贝叶斯估计'];

    try {
      running = await startServer({ port: 0 });
      const address = running.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${String(address.port)}`;
      const repository = running.bundle.repository;
      const grants = running.bundle.grants;
      if (!(grants instanceof FileGrantStore)) throw new Error('test server grant store is not file-backed');

      // Let the offline extractor drive the real pipeline while pinning classification to a known path.
      Object.defineProperty(running.bundle.provider, 'id', { value: 'scripted' });
      let classification = 0;
      running.bundle.provider.classifyKnowledge = async () => {
        classification += 1;
        return {
          action: 'create',
          newNodePath: classification === 1 ? oldPath : deepAiPath,
          confidence: 0.9,
          reason: '确定性 taxonomy 回归',
        };
      };

      const legacyRoot = await repository.createNode({
        userId, title: '数学', nodeType: 'domain', summary: '保留的旧根摘要', confidence: 0.8,
      });
      legacyRootId = legacyRoot.id;
      const legacyBranch = await repository.createNode({
        userId, title: '概率论', nodeType: 'domain', parentId: legacyRoot.id, summary: '保留的旧分支摘要', confidence: 0.7,
      });
      const legacyTopic = await repository.createNode({ userId, title: '概率基础', nodeType: 'topic', parentId: legacyBranch.id });
      legacyTopicId = legacyTopic.id;
      const sharedTopic = await repository.createNode({ userId, title: '条件概率', nodeType: 'topic', parentId: legacyBranch.id });
      const physics = await repository.createNode({ userId, title: '物理学', nodeType: 'discipline' });
      const mixedBranch = await repository.createNode({ userId, title: '力学', nodeType: 'domain', parentId: physics.id });
      const physicsTopic = await repository.createNode({ userId, title: '波动', nodeType: 'topic', parentId: mixedBranch.id });
      const sharedChapter = await repository.createNode({ userId, title: '概率章节', nodeType: 'chapter' });
      sharedChapterId = sharedChapter.id;

      const legacyEdges = await Promise.all([
        repository.createEdge({ userId, fromNodeId: legacyBranch.id, toNodeId: legacyRoot.id, relationType: 'part_of', source: 'legacy-import' }),
        repository.createEdge({ userId, fromNodeId: legacyTopic.id, toNodeId: legacyBranch.id, relationType: 'part_of', source: 'legacy-import' }),
        repository.createEdge({ userId, fromNodeId: sharedTopic.id, toNodeId: legacyBranch.id, relationType: 'part_of', source: 'legacy-import' }),
        repository.createEdge({ userId, fromNodeId: sharedChapter.id, toNodeId: legacyTopic.id, relationType: 'part_of', source: 'topic_chapter' }),
        repository.createEdge({ userId, fromNodeId: sharedChapter.id, toNodeId: sharedTopic.id, relationType: 'part_of', source: 'topic_chapter' }),
        repository.createEdge({ userId, fromNodeId: sharedChapter.id, toNodeId: physicsTopic.id, relationType: 'part_of', source: 'legacy-invalid-membership' }),
      ]);
      legacyEdgeIds = legacyEdges.map((edge) => edge.id);

      const originalSource = await repository.createRawSource({
        userId, rawText: originalSourceText, sourceType: 'manual', capturedAt: '2026-10-20T00:00:00.000Z',
      });
      originalSourceId = originalSource.id;
      const originalItem = await repository.createKnowledgeItem({
        userId,
        rawSourceId: originalSource.id,
        normalizedText: originalBody,
        confidence: 0.8,
        isAiDerived: false,
      });
      originalItemId = originalItem.id;
      const originalLink = await repository.linkItemToNode({
        userId, itemId: originalItem.id, nodeId: legacyTopic.id, relationType: 'primary', confidence: 1,
      });
      await repository.saveKnowledgeNote({
        userId, topicId: legacyTopic.id, chapterId: sharedChapter.id, content: originalNoteText,
      });

      const captureSecret = (await issueGrant(grants, { label: 'regression capture', scopes: ['capture'] })).secret;
      const wideReadSecret = (await issueGrant(grants, { label: 'regression read', scopes: ['read', 'mutate'] })).secret;
      const exactReadSecret = (await issueGrant(grants, {
        label: 'exact legacy scope', scopes: ['read'],
        nodeIds: [legacyRoot.id, legacyBranch.id, legacyTopic.id, sharedTopic.id, sharedChapter.id],
      })).secret;
      const rootOnlySecret = (await issueGrant(grants, {
        label: 'legacy root only', scopes: ['read'], nodeIds: [legacyRoot.id],
      })).secret;

      const capturedResponse = await fetch(`${base}/api/capture`, {
        method: 'POST',
        headers: { authorization: `Bearer ${captureSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(captureOf('这条内容用于验证旧概率路径的分类复用。', 'desktop')),
      });
      expect(capturedResponse.status).toBe(200);
      const captured = captureResultSchema.parse(await capturedResponse.json());
      expect(captured.items[0]).toMatchObject({ nodeId: legacyTopic.id, nodePath: oldPath, action: 'attached' });

      const treeResponse = await fetch(`${base}/api/tree`, { headers: { authorization: `Bearer ${wideReadSecret}` } });
      expect(treeResponse.status).toBe(200);
      const tree = treeResponseSchema.parse(await treeResponse.json());
      const treeNode = (id: string) => {
        const pending = [...tree.nodes];
        while (pending.length > 0) {
          const node = pending.pop();
          if (node?.id === id) return node;
          pending.push(...(node?.children ?? []));
        }
        return undefined;
      };
      expect(treeNode(legacyRoot.id)).toMatchObject({ id: legacyRoot.id, nodeType: 'discipline' });
      expect(treeNode(legacyBranch.id)).toMatchObject({ id: legacyBranch.id, nodeType: 'subdiscipline' });
      expect(treeNode(mixedBranch.id)).toMatchObject({ id: mixedBranch.id, nodeType: 'subdiscipline' });

      const rootScope = { kind: 'discipline', disciplineId: legacyRoot.id } as const;
      const branchScope = { kind: 'subdiscipline', disciplineId: legacyRoot.id, subdisciplineId: legacyBranch.id } as const;
      const deniedGraph = await fetch(`${base}/api/graph/select`, {
        method: 'POST', headers: { authorization: `Bearer ${rootOnlySecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(rootScope),
      });
      expect(deniedGraph.status).toBe(401);
      expect(apiErrorSchema.parse(await deniedGraph.json()).error.details).toMatchObject({ reason: 'node_not_granted' });

      const rootGraphResponse = await fetch(`${base}/api/graph/select`, {
        method: 'POST', headers: { authorization: `Bearer ${exactReadSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(rootScope),
      });
      expect(rootGraphResponse.status).toBe(200);
      const rootGraph = graphSelectionSchema.parse(await rootGraphResponse.json());
      expect(rootGraph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([legacyTopic.id, sharedTopic.id, sharedChapter.id]));
      expect(rootGraph.edges.filter((edge) => edge.fromNodeId === sharedChapter.id).map((edge) => edge.toNodeId).sort())
        .toEqual([legacyTopic.id, sharedTopic.id].sort());
      expect(rootGraph.diagnostics).toContainEqual(expect.objectContaining({ entityId: legacyEdges[5]!.id, reason: 'cross-discipline' }));

      const branchGraphResponse = await fetch(`${base}/api/graph/select`, {
        method: 'POST', headers: { authorization: `Bearer ${exactReadSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(branchScope),
      });
      expect(branchGraphResponse.status).toBe(200);
      expect(graphSelectionSchema.parse(await branchGraphResponse.json()).nodes.map((node) => node.id))
        .toEqual(expect.arrayContaining([legacyTopic.id, sharedTopic.id, sharedChapter.id]));

      const resolved = await fetch(`${base}/api/graph/resolve-chapter`, {
        method: 'POST', headers: { authorization: `Bearer ${exactReadSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chapterId: sharedChapter.id, scope: branchScope }),
      });
      expect(await resolved.json()).toEqual({
        kind: 'choose-topic', chapterId: sharedChapter.id, topicIds: [legacyTopic.id, sharedTopic.id].sort(),
      });

      const physicsGraphResponse = await fetch(`${base}/api/graph/select`, {
        method: 'POST', headers: { authorization: `Bearer ${wideReadSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'discipline', disciplineId: physics.id }),
      });
      const physicsGraph = graphSelectionSchema.parse(await physicsGraphResponse.json());
      expect(physicsGraph.nodes.map((node) => node.id)).toContain(physicsTopic.id);
      expect(physicsGraph.nodes.map((node) => node.id)).not.toContain(sharedChapter.id);

      const crossLinkSecret = (await issueGrant(grants, {
        label: 'cross discipline writer', scopes: ['mutate'], nodeIds: [sharedChapter.id, physicsTopic.id],
      })).secret;
      const crossLink = await fetch(`${base}/api/chapters/${sharedChapter.id}/topics/${physicsTopic.id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${crossLinkSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chapterId: sharedChapter.id, topicId: physicsTopic.id }),
      });
      expect(crossLink.status).toBe(400);
      expect(await repository.findEdge(userId, sharedChapter.id, physicsTopic.id, 'part_of')).toEqual(legacyEdges[5]);

      const newCaptureResponse = await fetch(`${base}/api/capture`, {
        method: 'POST',
        headers: { authorization: `Bearer ${captureSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(captureOf('这条内容用于验证四层AI分类路径。', 'desktop')),
      });
      expect(newCaptureResponse.status).toBe(200);
      const newCapture = captureResultSchema.parse(await newCaptureResponse.json());
      const deepNodes: (KnowledgeNode | null)[] = [];
      for (const title of deepAiPath) deepNodes.push(await repository.findNodeByTitle(userId, title, deepNodes.at(-1)?.id ?? null));
      expect(deepNodes.map((node) => node?.nodeType)).toEqual(['discipline', 'subdiscipline', 'domain', 'topic']);
      expect(newCapture.items[0]?.nodePath).toEqual(deepAiPath);

      const manualPathResponse = await fetch(`${base}/api/items/${captured.rawSourceId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${wideReadSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subjectPath: manualPath }),
      });
      expect(manualPathResponse.status).toBe(200);
      const manualRoot = await repository.findNodeByTitle(userId, manualPath[0]!, null);
      const manualBranch = await repository.findNodeByTitle(userId, manualPath[1]!, manualRoot?.id);
      const manualLeaf = await repository.findNodeByTitle(userId, manualPath[2]!, manualBranch?.id);
      expect([manualRoot?.nodeType, manualBranch?.nodeType, manualLeaf?.nodeType]).toEqual([
        'domain', 'subdiscipline', 'topic',
      ]);

      expect(await repository.findNode(legacyRoot.id, userId)).toEqual(legacyRoot);
      expect(await repository.findNode(legacyBranch.id, userId)).toEqual(legacyBranch);
      expect(await repository.findRawSource(originalSource.id, userId)).toEqual(originalSource);
      expect(await repository.findKnowledgeItem(originalItem.id, userId)).toEqual(originalItem);
      expect(await repository.listLinksForItem(originalItem.id, userId)).toEqual([originalLink]);
      expect(await repository.getKnowledgeNote(userId, legacyTopic.id, sharedChapter.id)).toMatchObject({ content: originalNoteText });
      for (const edge of legacyEdges) expect(await repository.findEdge(userId, edge.fromNodeId, edge.toNodeId, 'part_of')).toEqual(edge);
      expect((await grants.read()).find((grant) => grant.label === 'exact legacy scope')?.nodeIds)
        .toEqual([legacyRoot.id, legacyBranch.id, legacyTopic.id, sharedTopic.id, sharedChapter.id]);
    } finally {
      if (running !== undefined) await running.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const reopened = new SqliteRepository({ file: sqliteFile });
    try {
      expect((await reopened.findNode(legacyRootId, userId))?.nodeType).toBe('domain');
      expect((await reopened.findRawSource(originalSourceId, userId))?.rawText).toBe(originalSourceText);
      expect((await reopened.findKnowledgeItem(originalItemId, userId))?.normalizedText).toBe(originalBody);
      expect((await reopened.listLinksForItem(originalItemId, userId))).toHaveLength(1);
      expect(await reopened.getKnowledgeNote(userId, legacyTopicId, sharedChapterId)).toMatchObject({ content: originalNoteText });
      const retainedGrant = (await new FileGrantStore(grantFile).read()).find((grant) => grant.label === 'exact legacy scope');
      expect(retainedGrant?.nodeIds).toContain(legacyRootId);
      expect((await reopened.listEdges(userId)).map((edge) => edge.id)).toEqual(expect.arrayContaining(legacyEdgeIds));
    } finally {
      await reopened.close();
    }
  }, 30_000);
});
