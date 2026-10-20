import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isKnowledgeError } from '@noltri/shared';
import type { KnowledgeError } from '@noltri/shared';
import type { CreateRawSourceInput, KnowledgeItem, KnowledgeNode } from '@noltri/schema';
import type { KnowledgeRepository, MoveNodeRecordResult } from '../src/types';

export interface RepositoryContractOptions {
  /** Vector width the repository accepts; every fixture vector is padded to it. */
  embeddingDim?: number;
}

type MaybeRepository = KnowledgeRepository | Promise<KnowledgeRepository>;

const USER_PREFIX = 'contract-user';

/** Fixtures are padded to the widest driver, and zero padding leaves cosine geometry untouched. */
function makeVector(dim: number) {
  return function vector(...components: number[]): number[] {
    if (components.length > dim) {
      throw new Error(`fixture vector needs ${String(components.length)} slots but dim is ${String(dim)}`);
    }
    const padded = new Array<number>(dim).fill(0);
    components.forEach((component, index) => {
      padded[index] = component;
    });
    return padded;
  };
}

async function rejection(work: Promise<unknown>): Promise<KnowledgeError> {
  try {
    await work;
  } catch (cause: unknown) {
    if (!isKnowledgeError(cause)) {
      throw new Error(
        `expected a KnowledgeError, received ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return cause;
  }
  throw new Error('expected the call to reject');
}

/** Repositories that own a connection pool expose close(); the in-memory one does not. */
async function release(repository: KnowledgeRepository): Promise<void> {
  const candidate: unknown = Reflect.get(repository, 'close');
  if (typeof candidate === 'function') {
    await (candidate as () => Promise<void>).call(repository);
  }
}

/** Small wall-clock gaps so timestamp-ordered reads are deterministic on every driver. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 8);
  });
}

export function describeKnowledgeRepository(
  name: string,
  factory: () => MaybeRepository,
  options: RepositoryContractOptions = {},
): void {
  const dim = options.embeddingDim ?? 3;
  const timeout = 5_000;
  const vector = makeVector(dim);
  const foreignUser = () => `${USER_PREFIX}-foreign-${randomUUID()}`;

  async function scope<T>(work: (repository: KnowledgeRepository, userId: string) => Promise<T>): Promise<T> {
    const repository = await factory();
    try {
      return await work(repository, `${USER_PREFIX}-${randomUUID()}`);
    } finally {
      await release(repository);
    }
  }

  function sourceInput(userId: string, rawText: string): CreateRawSourceInput {
    return {
      userId,
      rawText,
      sourceType: 'manual',
      capturedAt: new Date().toISOString(),
      metadata: { origin: 'contract' },
    };
  }

  async function createKnownNode(repository: KnowledgeRepository, userId: string, title: string, parentId: string | null = null) {
    return repository.createNode({ userId, title, parentId });
  }

  async function itemWithSource(
    repository: KnowledgeRepository,
    userId: string,
    rawText: string,
    normalizedText: string,
    embedding: number[],
  ): Promise<{ item: KnowledgeItem; sourceId: string }> {
    const source = await repository.createRawSource(sourceInput(userId, rawText));
    const item = await repository.createKnowledgeItem({
      userId,
      rawSourceId: source.id,
      normalizedText,
      confidence: 0.8,
      embedding,
      embeddingModel: 'fixture-model',
    });
    return { item, sourceId: source.id };
  }

  describe(`${name} satisfies the KnowledgeRepository contract`, () => {
    it('round-trips a raw source and keeps it scoped to its owner', async () => {
      await scope(async (repository, userId) => {
        const created = await repository.createRawSource(sourceInput(userId, '原始文本 raw capture'));
        expect(created.processingStatus).toBe('pending');
        expect(created.errorReason).toBeNull();
        expect(created.metadata).toEqual({ origin: 'contract' });
        expect(await repository.findRawSource(created.id, userId)).toEqual(created);

        const done = await repository.updateRawSourceProcessing(created.id, userId, 'done');
        expect(done.processingStatus).toBe('done');
        expect(done.errorReason).toBeNull();

        const failed = await repository.updateRawSourceProcessing(created.id, userId, 'failed', '模型超时');
        expect(failed.processingStatus).toBe('failed');
        expect(failed.errorReason).toBe('模型超时');

        expect(await repository.findRawSource(created.id, foreignUser())).toBeNull();
        const missing = await rejection(repository.updateRawSourceProcessing('missing-id', userId, 'done'));
        expect(missing.code).toBe('not_found');
        expect(missing.message).toBe('RawSource missing-id not found');
      });
    }, timeout);

    it('carries the capture idempotency key and can be looked up by it', async () => {
      await scope(async (repository, userId) => {
        const keyed = await repository.createRawSource({
          ...sourceInput(userId, '带幂等键的原文 keyed capture'),
          requestId: 'req-contract-0001',
          clientId: 'extension',
        });
        expect(keyed.requestId).toBe('req-contract-0001');
        expect(keyed.clientId).toBe('extension');
        expect(await repository.findRawSource(keyed.id, userId)).toEqual(keyed);

        expect(await repository.findRawSourceByIdempotencyKey(userId, 'extension', 'req-contract-0001')).toMatchObject({
          id: keyed.id,
        });
        // Another entry point may never read this row, and another owner certainly may not.
        expect(await repository.findRawSourceByIdempotencyKey(userId, 'desktop', 'req-contract-0001')).toBeNull();
        expect(await repository.findRawSourceByIdempotencyKey(foreignUser(), 'extension', 'req-contract-0001')).toBeNull();
        expect(await repository.findRawSourceByIdempotencyKey(userId, 'extension', 'req-never-used')).toBeNull();
        expect(await repository.findRawSourceByIdempotencyKey(userId, 'extension', '')).toBeNull();

        const other = await repository.createRawSource({
          ...sourceInput(userId, '同文案不同请求 another keyed capture'),
          requestId: 'req-contract-0002',
          clientId: 'extension',
        });
        expect(other.id).not.toBe(keyed.id);

        // A capture that states no key keeps both columns null, so the partial unique index stays out of the way.
        const unkeyed = await repository.createRawSource(sourceInput(userId, '无幂等键的原文'));
        expect(unkeyed.requestId).toBeNull();
        expect(unkeyed.clientId).toBeNull();
        await repository.createRawSource(sourceInput(userId, '第二条无键原文'));
        expect(await repository.findRawSourceByIdempotencyKey(userId, 'extension', 'req-contract-0001')).toMatchObject({
          id: keyed.id,
        });
      });
    }, timeout);

    it('lists raw sources by id in the requested order and skips foreign rows', async () => {
      await scope(async (repository, userId) => {
        const first = await repository.createRawSource(sourceInput(userId, 'first'));
        await pause();
        const second = await repository.createRawSource(sourceInput(userId, 'second'));
        const foreign = await repository.createRawSource(sourceInput(foreignUser(), 'not mine'));

        const listed = await repository.listRawSourcesByIds([second.id, first.id, foreign.id, 'absent'], userId);
        expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
        expect(await repository.listRawSourcesByIds([], userId)).toEqual([]);
      });
    }, timeout);

    it('lists inbox sources newest-first, filtered by status and scoped to the owner', async () => {
      await scope(async (repository, userId) => {
        const oldest = await repository.createRawSource(sourceInput(userId, 'oldest'));
        await pause();
        const middle = await repository.createRawSource(sourceInput(userId, 'middle'));
        await pause();
        const newest = await repository.createRawSource(sourceInput(userId, 'newest'));
        await pause();
        const foreign = await repository.createRawSource(sourceInput(foreignUser(), 'foreign'));

        await repository.updateRawSourceProcessing(middle.id, userId, 'failed', '模型超时');
        await repository.updateRawSourceProcessing(foreign.id, foreign.userId, 'failed', '不应出现');

        expect((await repository.listInbox({ userId })).map((row) => row.id)).toEqual([
          newest.id,
          middle.id,
          oldest.id,
        ]);
        expect((await repository.listInbox({ userId, statuses: ['failed'] })).map((row) => row.id)).toEqual([
          middle.id,
        ]);
        expect(
          (await repository.listInbox({ userId, statuses: ['pending', 'processing'] })).map((row) => row.id),
        ).toEqual([newest.id, oldest.id]);
        expect((await repository.listInbox({ userId, limit: 2 })).map((row) => row.id)).toEqual([
          newest.id,
          middle.id,
        ]);
        expect((await repository.listInbox({ userId, limit: 2, offset: 2 })).map((row) => row.id)).toEqual([
          oldest.id,
        ]);
        expect(await repository.listInbox({ userId, offset: 99 })).toEqual([]);
        expect(await repository.listInbox({ userId: foreignUser() })).toEqual([]);
      });
    }, timeout);

    it('counts inbox rows per processing status for one owner only', async () => {
      await scope(async (repository, userId) => {
        await repository.createRawSource(sourceInput(userId, 'pending a'));
        const b = await repository.createRawSource(sourceInput(userId, 'pending b'));
        const c = await repository.createRawSource(sourceInput(userId, 'done c'));
        const d = await repository.createRawSource(sourceInput(userId, 'failed d'));
        await repository.updateRawSourceProcessing(c.id, userId, 'done');
        await repository.updateRawSourceProcessing(d.id, userId, 'failed', '模型超时');
        const foreign = await repository.createRawSource(sourceInput(foreignUser(), 'foreign pending'));

        expect(await repository.countInboxByStatus(userId)).toEqual({
          pending: 2,
          processing: 0,
          done: 1,
          failed: 1,
        });
        // The counter follows updates, it is not a snapshot of creation.
        await repository.updateRawSourceProcessing(b.id, userId, 'processing');
        expect(await repository.countInboxByStatus(userId)).toMatchObject({ pending: 1, processing: 1 });
        expect(await repository.countInboxByStatus(foreign.userId)).toEqual({
          pending: 1,
          processing: 0,
          done: 0,
          failed: 0,
        });
        expect(await repository.countInboxByStatus(`${USER_PREFIX}-nobody`)).toEqual({
          pending: 0,
          processing: 0,
          done: 0,
          failed: 0,
        });
      });
    }, timeout);

    it('creates, reads and patches knowledge items', async () => {
      await scope(async (repository, userId) => {
        const source = await repository.createRawSource(sourceInput(userId, '一段关于 HNSW 的原文'));
        const created = await repository.createKnowledgeItem({
          userId,
          rawSourceId: source.id,
          normalizedText: 'HNSW 图索引分层',
          summary: '索引导言',
          confidence: 0.7,
          embedding: vector(1, 0, 0),
          embeddingModel: 'fixture-model',
          isAiDerived: false,
        });
        expect(created.status).toBe('active');
        expect(created.isAiDerived).toBe(false);
        expect(created.summary).toBe('索引导言');
        expect(await repository.findKnowledgeItem(created.id, userId)).toEqual(created);
        expect(await repository.findKnowledgeItem(created.id, foreignUser())).toBeNull();

        await pause();
        const sibling = await repository.createKnowledgeItem({
          userId,
          rawSourceId: source.id,
          normalizedText: '向量距离用余弦',
          confidence: 0.9,
        });
        expect(sibling.summary).toBeNull();
        expect(sibling.isAiDerived).toBe(true);

        expect((await repository.listKnowledgeItemsForSource(source.id, userId)).map((row) => row.id)).toEqual([
          created.id,
          sibling.id,
        ]);
        expect(await repository.listKnowledgeItemsForSource('absent', userId)).toEqual([]);
        expect(
          (await repository.listKnowledgeItemsByIds([sibling.id, 'absent', created.id], userId)).map((row) => row.id),
        ).toEqual([sibling.id, created.id]);

        const patched = await repository.updateKnowledgeItem(created.id, userId, {
          summary: null,
          confidence: 0.35,
          status: 'merged',
          normalizedText: 'HNSW 图索引分层（改）',
        });
        expect(patched.summary).toBeNull();
        expect(patched.confidence).toBeCloseTo(0.35, 6);
        expect(patched.status).toBe('merged');
        expect(patched.normalizedText).toBe('HNSW 图索引分层（改）');
        expect(patched.createdAt).toBe(created.createdAt);

        const absent = await rejection(repository.updateKnowledgeItem('absent', userId, { confidence: 0.5 }));
        expect(absent.code).toBe('not_found');
        const foreign = await rejection(repository.updateKnowledgeItem(created.id, foreignUser(), { confidence: 0.5 }));
        expect(foreign.message).toBe(`KnowledgeItem ${created.id} not found`);
      });
    }, timeout);

    it('builds the tree, finds nodes by title and honours archive filters', async () => {
      await scope(async (repository, userId) => {
        const root = await createKnownNode(repository, userId, '  数据库  ');
        expect(root.title).toBe('数据库');
        expect(root.parentId).toBeNull();
        expect(root.status).toBe('active');
        expect(root.nodeType).toBe('topic');
        expect(root.confidence).toBeNull();
        expect(root.embeddingModel).toBeNull();

        const child = await repository.createNode({
          userId,
          title: '索引',
          summary: '索引家族',
          parentId: root.id,
          confidence: 0.6,
          embeddingModel: 'fixture-model',
        });
        const other = foreignUser();
        const foreignRoot = await createKnownNode(repository, other, '数据库');

        expect(await repository.findNode(child.id, userId)).toEqual(child);
        expect(await repository.findNode(child.id, foreignUser())).toBeNull();
        expect(await repository.findNodeByTitle(userId, '数据库')).toMatchObject({ id: root.id });
        expect(await repository.findNodeByTitle(userId, '  数据库 ')).toMatchObject({ id: root.id });
        expect(await repository.findNodeByTitle(userId, '索引', root.id)).toMatchObject({ id: child.id });
        expect(await repository.findNodeByTitle(userId, '索引', null)).toBeNull();
        expect(await repository.findNodeByTitle(userId, '不存在')).toBeNull();
        expect(await repository.findNodeByTitle(other, '数据库')).toMatchObject({ id: foreignRoot.id });

        expect((await repository.listRootNodes(userId)).map((row) => row.id)).toEqual([root.id]);
        expect((await repository.listChildNodes(userId, root.id)).map((row) => row.id)).toEqual([child.id]);
        expect(await repository.listChildNodes(userId, child.id)).toEqual([]);
        expect((await repository.listNodes(userId)).map((row) => row.id).sort()).toEqual([child.id, root.id].sort());

        const archived = await repository.updateNode({ id: child.id, userId, status: 'archived' });
        expect(archived.status).toBe('archived');
        expect((await repository.listNodes(userId)).map((row) => row.id)).toEqual([root.id]);
        expect((await repository.listNodes(userId, { includeArchived: true })).map((row) => row.id).sort()).toEqual(
          [child.id, root.id].sort(),
        );
        expect((await repository.listNodes(userId, { status: 'archived' })).map((row) => row.id)).toEqual([child.id]);
        expect(await repository.findNodeByTitle(userId, '索引', root.id)).toBeNull();
        expect(await repository.listRootNodes(userId)).toHaveLength(1);

        const renamed = await repository.updateNode({
          id: root.id,
          userId,
          title: ' 数据库系统 ',
          summary: '库与索引',
          confidence: null,
          embedding: vector(0, 1, 0),
          embeddingModel: 'fixture-model-2',
        });
        expect(renamed.title).toBe('数据库系统');
        expect(renamed.summary).toBe('库与索引');
        expect(renamed.confidence).toBeNull();
        expect(renamed.embeddingModel).toBe('fixture-model-2');
        expect(renamed.status).toBe('active');
        expect(renamed.createdAt).toBe(root.createdAt);

        const missingNode = await rejection(repository.updateNode({ id: 'absent', userId, title: 'x' }));
        expect(missingNode.message).toBe('KnowledgeNode absent not found');
        const missingParent = await rejection(repository.createNode({ userId, title: '孤儿', parentId: 'absent' }));
        expect(missingParent.code).toBe('not_found');
      });
    }, timeout);

    it('walks the path from the root down to a leaf', async () => {
      await scope(async (repository, userId) => {
        const root = await createKnownNode(repository, userId, '数据库');
        const middle = await createKnownNode(repository, userId, '索引', root.id);
        const leaf = await createKnownNode(repository, userId, 'HNSW', middle.id);

        expect(await repository.nodePath(userId, root.id)).toEqual([{ id: root.id, title: '数据库' }]);
        expect(await repository.nodePath(userId, leaf.id)).toEqual([
          { id: root.id, title: '数据库' },
          { id: middle.id, title: '索引' },
          { id: leaf.id, title: 'HNSW' },
        ]);
        expect(await repository.nodePath(foreignUser(), leaf.id)).toEqual([]);
        expect(await repository.nodePath(userId, 'absent')).toEqual([]);
      });
    }, timeout);

    it('moves a node, records the change and refuses cycles', async () => {
      await scope(async (repository, userId) => {
        const plants = await createKnownNode(repository, userId, '数据库');
        const indexBranch = await createKnownNode(repository, userId, '索引', plants.id);
        const hnsw = await createKnownNode(repository, userId, 'HNSW', plants.id);
        const detached = await createKnownNode(repository, userId, '检索');

        const moved: MoveNodeRecordResult = await repository.moveNode({
          userId,
          nodeId: hnsw.id,
          targetParentId: indexBranch.id,
          actor: 'contract-test',
        });
        expect(moved.node.id).toBe(hnsw.id);
        expect(moved.node.parentId).toBe(indexBranch.id);
        expect(moved.node.title).toBe('HNSW');
        expect(moved.path).toEqual([
          { id: plants.id, title: '数据库' },
          { id: indexBranch.id, title: '索引' },
          { id: hnsw.id, title: 'HNSW' },
        ]);
        expect(await repository.findNode(hnsw.id, userId)).toMatchObject({ parentId: indexBranch.id });
        expect((await repository.listChildNodes(userId, indexBranch.id)).map((row) => row.id)).toContain(hnsw.id);
        const edge = await repository.findEdge(userId, hnsw.id, indexBranch.id, 'part_of');
        expect(edge).toMatchObject({ source: 'tree_structure', confidence: 1 });
        expect(moved.versionRecordId).toEqual(expect.any(String));
        const records = await repository.listVersionRecords(userId, hnsw.id);
        expect(records[0]).toMatchObject({ entityId: hnsw.id, actor: 'contract-test', operation: 'move' });
        expect(records[0]).toMatchObject({ before: { parentId: plants.id }, after: { parentId: indexBranch.id } });

        const selfMove = await rejection(
          repository.moveNode({ userId, nodeId: hnsw.id, targetParentId: hnsw.id, actor: 'me' }),
        );
        expect(selfMove.code).toBe('conflict');
        expect(selfMove.message).toBe('A node cannot be moved inside itself');

        const cycleMove = await rejection(
          repository.moveNode({ userId, nodeId: plants.id, targetParentId: hnsw.id, actor: 'me' }),
        );
        expect(cycleMove.code).toBe('conflict');
        expect(cycleMove.message).toBe('Cannot move a node inside one of its own descendants');

        const vanishedNode = await rejection(
          repository.moveNode({ userId, nodeId: 'absent', targetParentId: plants.id, actor: 'me' }),
        );
        expect(vanishedNode.code).toBe('not_found');
        const vanishedTarget = await rejection(
          repository.moveNode({ userId, nodeId: hnsw.id, targetParentId: 'absent', actor: 'me' }),
        );
        expect(vanishedTarget.code).toBe('not_found');
        const foreignMove = await rejection(
          repository.moveNode({ userId: foreignUser(), nodeId: hnsw.id, targetParentId: plants.id, actor: 'me' }),
        );
        expect(foreignMove.code).toBe('not_found');

        const toRoot = await repository.moveNode({ userId, nodeId: hnsw.id, targetParentId: null, actor: 'me' });
        expect(toRoot.node.parentId).toBeNull();
        expect(toRoot.path).toEqual([{ id: hnsw.id, title: 'HNSW' }]);

        const reparented = await repository.moveNode({
          userId,
          nodeId: detached.id,
          targetParentId: indexBranch.id,
          actor: 'me',
        });
        expect(reparented.path.map((segment) => segment.title)).toEqual(['数据库', '索引', '检索']);
        const operations = (await repository.listVersionRecords(userId, detached.id)).map((record) => record.operation);
        expect(operations).toEqual(['reparent']);
      });
    }, timeout);

    it('links items to nodes idempotently and counts them', async () => {
      await scope(async (repository, userId) => {
        const nodeA = await createKnownNode(repository, userId, '索引');
        const nodeB = await createKnownNode(repository, userId, '检索');
        const empty = await createKnownNode(repository, userId, '空');
        const { item } = await itemWithSource(repository, userId, '原文', '余弦相似度', vector(1, 1, 0));
        const { item: other } = await itemWithSource(repository, userId, '原文2', '分层图', vector(0, 1, 0));

        const first = await repository.linkItemToNode({
          userId,
          itemId: item.id,
          nodeId: nodeA.id,
          relationType: 'primary',
          confidence: 0.4,
        });
        const again = await repository.linkItemToNode({
          userId,
          itemId: item.id,
          nodeId: nodeA.id,
          relationType: 'primary',
          confidence: 0.9,
        });
        expect(again.id).toBe(first.id);
        expect(again.confidence).toBeCloseTo(0.9, 6);
        const weaker = await repository.linkItemToNode({
          userId,
          itemId: item.id,
          nodeId: nodeA.id,
          relationType: 'primary',
          confidence: 0.2,
        });
        expect(weaker.confidence).toBeCloseTo(0.9, 6);
        expect(await repository.listLinksForItem(item.id, userId)).toHaveLength(1);
        expect((await repository.listLinksForNode(nodeA.id, userId)).map((link) => link.itemId)).toEqual([item.id]);

        await repository.linkItemToNode({
          userId,
          itemId: item.id,
          nodeId: nodeB.id,
          relationType: 'supports',
          confidence: 0.5,
        });
        await repository.linkItemToNode({
          userId,
          itemId: other.id,
          nodeId: nodeB.id,
          relationType: 'primary',
          confidence: 1,
        });
        expect(await repository.countItemsForNodes(userId, [nodeA.id, nodeB.id, empty.id])).toEqual({
          [nodeA.id]: 1,
          [nodeB.id]: 2,
          [empty.id]: 0,
        });
        expect(await repository.countItemsForNodes(userId, [])).toEqual({});
        expect(await repository.listLinksForItem(item.id, foreignUser())).toEqual([]);
        expect(await repository.listLinksForNode(nodeB.id, foreignUser())).toEqual([]);

        const missingItem = await rejection(
          repository.linkItemToNode({
            userId,
            itemId: 'absent',
            nodeId: nodeA.id,
            relationType: 'primary',
            confidence: 1,
          }),
        );
        expect(missingItem.code).toBe('not_found');
        const missingNode = await rejection(
          repository.linkItemToNode({
            userId,
            itemId: item.id,
            nodeId: 'absent',
            relationType: 'primary',
            confidence: 1,
          }),
        );
        expect(missingNode.code).toBe('not_found');
      });
    }, timeout);

    it('aggregates node statistics over links, sources and children', async () => {
      await scope(async (repository, userId) => {
        const parent = await createKnownNode(repository, userId, '数据库');
        const leaf = await createKnownNode(repository, userId, '索引', parent.id);
        const first = await itemWithSource(repository, userId, '原文一', '余弦相似度', vector(1, 0, 0));
        const second = await itemWithSource(repository, userId, '原文二', '分层图', vector(0, 1, 0));
        await repository.linkItemToNode({
          userId,
          itemId: first.item.id,
          nodeId: leaf.id,
          relationType: 'primary',
          confidence: 0.9,
        });
        await repository.linkItemToNode({
          userId,
          itemId: second.item.id,
          nodeId: leaf.id,
          relationType: 'primary',
          confidence: 0.8,
        });
        await createKnownNode(repository, userId, '子节点', leaf.id);

        expect(await repository.nodeStats(userId, leaf.id)).toMatchObject({
          itemCount: 2,
          sourceCount: 2,
          childCount: 1,
        });
        expect(await repository.nodeStats(userId, parent.id)).toMatchObject({ itemCount: 0, childCount: 1 });
        expect((await repository.listKnowledgeItemsForNode(leaf.id, userId)).map((row) => row.id)).toEqual([
          first.item.id,
          second.item.id,
        ]);
        expect(await repository.listKnowledgeItemsForNode(parent.id, foreignUser())).toEqual([]);
      });
    }, timeout);

    it('creates edges once and reads both directions', async () => {
      await scope(async (repository, userId) => {
        const left = await createKnownNode(repository, userId, '索引');
        const right = await createKnownNode(repository, userId, '检索');

        const created = await repository.createEdge({
          userId,
          fromNodeId: left.id,
          toNodeId: right.id,
          relationType: 'similar_to',
          confidence: 0.5,
          source: 'contract',
        });
        const again = await repository.createEdge({
          userId,
          fromNodeId: left.id,
          toNodeId: right.id,
          relationType: 'similar_to',
          confidence: 0.5,
          source: 'contract',
        });
        expect(again.id).toBe(created.id);
        expect(await repository.findEdge(userId, left.id, right.id, 'similar_to')).toMatchObject({ id: created.id });
        expect(await repository.findEdge(userId, left.id, right.id, 'derived_from')).toBeNull();
        expect(await repository.findEdge(foreignUser(), left.id, right.id, 'similar_to')).toBeNull();

        await repository.createEdge({
          userId,
          fromNodeId: right.id,
          toNodeId: left.id,
          relationType: 'derived_from',
          source: 'contract',
        });
        const fromLeft = await repository.listEdgesForNode(userId, left.id);
        const fromRight = await repository.listEdgesForNode(userId, right.id);
        expect(fromLeft.map((edge) => edge.id).sort()).toEqual(fromRight.map((edge) => edge.id).sort());
        expect(new Set(fromLeft.map((edge) => edge.relationType))).toEqual(new Set(['similar_to', 'derived_from']));
        expect(await repository.listEdgesForNode(foreignUser(), left.id)).toEqual([]);
      });
    }, timeout);

    it('ranks vector item matches by cosine similarity and honours the options', async () => {
      await scope(async (repository, userId) => {
        const far = await itemWithSource(repository, userId, '原文 A', '向量检索', vector(1, 0, 0));
        const close = await itemWithSource(repository, userId, '原文 B', '倒排索引', vector(0.5, 1, 0));
        const exact = await itemWithSource(repository, userId, '原文 C', '余弦距离', vector(1, 1, 0));
        const remote = await itemWithSource(repository, userId, '原文 E', '另一个来源', vector(1, 0.2, 0));
        const archived = await itemWithSource(repository, userId, '原文 D', '已归档', vector(1, 1, 0));
        await repository.updateKnowledgeItem(archived.item.id, userId, { status: 'archived' });
        const home = await createKnownNode(repository, userId, '索引');
        await repository.linkItemToNode({
          userId,
          itemId: exact.item.id,
          nodeId: home.id,
          relationType: 'primary',
          confidence: 1,
        });

        const query = vector(1, 1, 0);
        const all = await repository.searchSimilarItems(userId, query, { limit: 10 });
        expect(all.map((match) => match.itemId)).toEqual([exact.item.id, close.item.id, remote.item.id, far.item.id]);
        expect(all[0]).toMatchObject({ rawSourceId: exact.sourceId, text: '余弦距离', nodeId: home.id });
        expect(all[0].score).toBeCloseTo(1, 6);
        expect(all[1].score).toBeCloseTo(1.5 / (Math.SQRT2 * Math.sqrt(1.25)), 6);
        for (const match of all) {
          expect(match.score).toBeGreaterThanOrEqual(0);
          expect(match.score).toBeLessThanOrEqual(1);
        }

        expect(
          (await repository.searchSimilarItems(userId, query, { limit: 10, threshold: 0.9 })).map((m) => m.itemId),
        ).toEqual([exact.item.id, close.item.id]);
        expect((await repository.searchSimilarItems(userId, query, { limit: 1 })).map((m) => m.itemId)).toEqual([
          exact.item.id,
        ]);
        expect(
          (await repository.searchSimilarItems(userId, query, { limit: 10, excludeRawSourceId: far.sourceId })).map(
            (m) => m.itemId,
          ),
        ).toEqual([exact.item.id, close.item.id, remote.item.id]);
        expect(all.find((match) => match.itemId === remote.item.id)?.nodeId).toBeNull();
        expect(await repository.searchSimilarItems(foreignUser(), query, { limit: 10 })).toEqual([]);
      });
    }, timeout);

    it('ranks vector node matches and returns their path', async () => {
      await scope(async (repository, userId) => {
        const root = await createKnownNode(repository, userId, '数据库');
        const close = await repository.createNode({
          userId,
          title: '索引',
          parentId: root.id,
          embedding: vector(1, 1, 0),
          embeddingModel: 'fixture-model',
        });
        const far = await repository.createNode({
          userId,
          title: '检索',
          embedding: vector(1, 0, 0),
          embeddingModel: 'fixture-model',
        });
        await repository.createNode({ userId, title: '无向量', embeddingModel: 'fixture-model' });

        const matches = await repository.searchSimilarNodes(userId, vector(1, 1, 0), { limit: 10 });
        expect(matches.map((match) => match.nodeId)).toEqual([close.id, far.id]);
        expect(matches[0]).toMatchObject({ title: '索引' });
        expect(matches[0].path).toEqual([
          { id: root.id, title: '数据库' },
          { id: close.id, title: '索引' },
        ]);
        expect(matches[1].path).toEqual([{ id: far.id, title: '检索' }]);
        expect(matches[0].score).toBeCloseTo(1, 6);
        expect(
          (await repository.searchSimilarNodes(userId, vector(1, 1, 0), { threshold: 0.99 })).map((m) => m.nodeId),
        ).toEqual([close.id]);
        expect(await repository.searchSimilarNodes(foreignUser(), vector(1, 1, 0))).toEqual([]);
      });
    }, timeout);

    it('drops archived nodes from vector search', async () => {
      await scope(async (repository, userId) => {
        const keep = await repository.createNode({ userId, title: '保留', embedding: vector(1, 1, 0) });
        const drop = await repository.createNode({ userId, title: '归档', embedding: vector(1, 1, 0) });
        await repository.updateNode({ id: drop.id, userId, status: 'archived' });
        const matches = await repository.searchSimilarNodes(userId, vector(1, 1, 0), { limit: 10 });
        expect(matches.map((match) => match.nodeId)).toEqual([keep.id]);
      });
    }, timeout);

    it('searches keywords across items and nodes with a shared ranking', async () => {
      await scope(async (repository, userId) => {
        const indexed = await repository.createNode({
          userId,
          title: '倒排索引',
          summary: 'index term frequency',
        });
        const { item } = await itemWithSource(
          repository,
          userId,
          '关于倒排索引的原文',
          '倒排索引记录词频 postings',
          vector(1, 0, 0),
        );
        await repository.linkItemToNode({
          userId,
          itemId: item.id,
          nodeId: indexed.id,
          relationType: 'primary',
          confidence: 1,
        });
        await itemWithSource(repository, userId, '无关原文', '完全无关的内容', vector(0, 1, 0));
        const archivedItem = await itemWithSource(repository, userId, '归档原文', '倒排索引 已归档', vector(0, 1, 0));
        await repository.updateKnowledgeItem(archivedItem.item.id, userId, { status: 'archived' });

        const latin = await repository.searchKeyword(userId, 'index postings', { limit: 5 });
        expect(latin.length).toBeGreaterThan(0);
        expect(latin.every((match) => match.score > 0 && match.score <= 1)).toBe(true);
        for (let index = 1; index < latin.length; index += 1) {
          expect(latin[index - 1].score).toBeGreaterThanOrEqual(latin[index].score);
        }
        const postings = latin.find((match) => match.itemId === item.id);
        expect(postings).toBeDefined();
        expect(postings?.nodeId).toBe(indexed.id);
        expect(postings?.text).toBe('倒排索引记录词频 postings');
        expect(postings?.title).toBe('倒排索引记录词频 postings');

        const cjk = await repository.searchKeyword(userId, '倒排索引', { limit: 5 });
        const keys = cjk.map((match) => `${match.itemId ?? '-'}|${match.nodeId ?? '-'}`);
        expect(keys).toContain(`${item.id}|${indexed.id}`);
        expect(keys.some((key) => key.endsWith(`|${indexed.id}`))).toBe(true);
        expect(keys.some((key) => key.startsWith(`${archivedItem.item.id}|`))).toBe(false);

        expect(await repository.searchKeyword(userId, '   ')).toEqual([]);
        expect(await repository.searchKeyword(foreignUser(), 'index postings')).toEqual([]);
        expect(await repository.searchKeyword(userId, '不存在的词')).toEqual([]);
        expect(await repository.searchKeyword(userId, 'index', { limit: 1 })).toHaveLength(1);
      });
    }, timeout);

    it('writes version records newest-first and filters by entity', async () => {
      await scope(async (repository, userId) => {
        const nodeOne = await createKnownNode(repository, userId, '节点一');
        const nodeTwo = await createKnownNode(repository, userId, '节点二');

        await repository.createVersionRecord({
          userId,
          entityType: 'knowledge_node',
          entityId: nodeOne.id,
          operation: 'create',
          before: {},
          after: { title: '节点一' },
          actor: 'contract-test',
        });
        await pause();
        await repository.createVersionRecord({
          userId,
          entityType: 'knowledge_node',
          entityId: nodeOne.id,
          operation: 'rename',
          before: { title: '节点一' },
          after: { title: '重命名' },
          actor: 'contract-test',
        });
        await pause();
        await repository.createVersionRecord({
          userId,
          entityType: 'knowledge_item',
          entityId: nodeTwo.id,
          operation: 'merge',
          before: { merged: false },
          after: { merged: true },
          actor: 'other-actor',
        });

        const everything = await repository.listVersionRecords(userId);
        expect(everything.map((record) => record.operation)).toEqual(['merge', 'rename', 'create']);
        expect(new Set(everything.map((record) => record.userId))).toEqual(new Set([userId]));

        const forNode = await repository.listVersionRecords(userId, nodeOne.id);
        expect(forNode.map((record) => record.operation)).toEqual(['rename', 'create']);
        expect(forNode[1]).toMatchObject({ before: {}, after: { title: '节点一' }, actor: 'contract-test' });
        expect(await repository.listVersionRecords(foreignUser())).toEqual([]);
      });
    }, timeout);

    it('round-trips a conversation with its messages', async () => {
      await scope(async (repository, userId) => {
        const topic = await createKnownNode(repository, userId, '主题');
        const aside = await createKnownNode(repository, userId, '旁支');
        const conversation = await repository.createConversation({
          userId,
          nodeId: topic.id,
          scope: 'current_node',
          title: '关于主题',
        });
        expect(conversation.nodeId).toBe(topic.id);
        expect(conversation.updatedAt).toBe(conversation.createdAt);
        await pause();
        const free = await repository.createConversation({ userId, nodeId: null, scope: 'whole_library' });
        expect(free.title).toBeNull();

        expect(await repository.findConversation(conversation.id, userId)).toEqual(conversation);
        expect(await repository.findConversation(conversation.id, foreignUser())).toBeNull();

        await pause();
        const userTurn = await repository.addMessage({
          userId,
          conversationId: conversation.id,
          role: 'user',
          content: '解释一下',
        });
        // No context node stated: it inherits the conversation's own node.
        expect(userTurn.contextNodeId).toBe(topic.id);
        await pause();
        const answer = await repository.addMessage({
          userId,
          conversationId: conversation.id,
          role: 'assistant',
          content: '因为分层图更快',
          contextNodeId: aside.id,
        });
        expect(answer.contextNodeId).toBe(aside.id);
        await pause();
        const freeTurn = await repository.addMessage({
          userId,
          conversationId: free.id,
          role: 'user',
          content: '整体问一问',
        });
        expect(freeTurn.contextNodeId).toBeNull();
        const vanished = await rejection(
          repository.addMessage({ userId, conversationId: 'absent', role: 'user', content: 'x' }),
        );
        expect(vanished.message).toBe('Conversation absent not found');

        const messages = await repository.listMessages(conversation.id, userId);
        expect(messages.map((message) => message.id)).toEqual([userTurn.id, answer.id]);
        expect(messages.map((message) => message.content)).toEqual(['解释一下', '因为分层图更快']);
        expect((await repository.listMessages(free.id, userId)).map((message) => message.id)).toEqual([freeTurn.id]);
        expect(await repository.listMessages(conversation.id, foreignUser())).toEqual([]);
        expect(await repository.listMessages('absent', userId)).toEqual([]);

        const touched = await repository.findConversation(conversation.id, userId);
        expect(touched?.updatedAt).toBe(answer.createdAt);
        const touchedFree = await repository.findConversation(free.id, userId);
        expect(touchedFree?.updatedAt).toBe(freeTurn.createdAt);
        expect((await repository.listConversations(userId, topic.id)).map((row) => row.id)).toEqual([conversation.id]);
        expect((await repository.listConversations(userId)).map((row) => row.id)).toEqual([free.id, conversation.id]);
        expect(await repository.listConversations(foreignUser())).toEqual([]);
      });
    }, timeout);

    it('exposes exactly the node shape the schema promises', async () => {
      await scope(async (repository, userId) => {
        const created: KnowledgeNode = await repository.createNode({
          userId,
          title: '形状',
          embedding: vector(1, 0, 0),
          embeddingModel: 'fixture-model',
        });
        expect(Object.keys(created).sort()).toEqual(
          [
            'id',
            'userId',
            'title',
            'summary',
            'nodeType',
            'parentId',
            'status',
            'confidence',
            'embeddingModel',
            'masteryLevel',
            'createdAt',
            'updatedAt',
          ].sort(),
        );
        expect(created.masteryLevel).toBe('collected');

        const item = await repository.createKnowledgeItem({
          userId,
          rawSourceId: (await repository.createRawSource(sourceInput(userId, '原文'))).id,
          normalizedText: '一条知识',
          confidence: 0.5,
          embedding: vector(1, 0, 0),
          embeddingModel: 'fixture-model',
          embeddingStatus: 'ready',
        });
        expect(item.status).toBe('active');
        expect(await repository.searchSimilarItems(userId, vector(1, 0, 0), { limit: 5 })).toHaveLength(1);
      });
    }, timeout);

    it('stores one overview and one note per topic/chapter pair without crossing users', async () => {
      await scope(async (repository, userId) => {
        const parent = await repository.createNode({ userId, title: '学科', nodeType: 'discipline' });
        const topic = await repository.createNode({ userId, title: '同名', parentId: parent.id, nodeType: 'topic' });
        const otherTopic = await repository.createNode({ userId, title: '同名', parentId: parent.id, nodeType: 'topic' });
        const chapter = await repository.createNode({ userId, title: '第一章', parentId: topic.id, nodeType: 'chapter' });

        const overview = await repository.saveKnowledgeNote({ userId, topicId: topic.id, chapterId: null, content: '主题概览' });
        const first = await repository.saveKnowledgeNote({ userId, topicId: topic.id, chapterId: chapter.id, content: '章节草稿' });
        const updated = await repository.saveKnowledgeNote({ userId, topicId: topic.id, chapterId: chapter.id, content: '章节正文' });
        const homonym = await repository.saveKnowledgeNote({ userId, topicId: otherTopic.id, chapterId: chapter.id, content: '同名主题独立笔记' });

        expect((await repository.getKnowledgeNote(userId, topic.id, null))?.content).toBe('主题概览');
        expect((await repository.getKnowledgeNote(userId, topic.id, chapter.id))?.content).toBe('章节正文');
        expect(updated.createdAt).toBe(first.createdAt);
        expect(homonym.topicId).toBe(otherTopic.id);
        expect(await repository.getKnowledgeNote(foreignUser(), topic.id, chapter.id)).toBeNull();
        expect(await repository.listKnowledgeNotes(foreignUser(), topic.id)).toEqual([]);
        expect(await repository.listKnowledgeNotes(userId, topic.id)).toEqual([
          { topicId: topic.id, chapterId: null, updatedAt: overview.updatedAt },
          { topicId: topic.id, chapterId: chapter.id, updatedAt: updated.updatedAt },
        ]);
      });
    }, timeout);

    it('states its own storage health without leaking a credential', async () => {
      await scope(async (repository, userId) => {
        await repository.createRawSource(sourceInput(userId, '健康检查'));
        const health = repository.storageHealth();
        expect(health.driver).toBe(repository.driver);
        expect(health.ok).toBe(true);
        expect(Object.keys(health.detail).length).toBeGreaterThan(0);
        for (const [key, value] of Object.entries(health.detail)) {
          const type = value === null ? 'null' : typeof value;
          expect(['string', 'number', 'boolean', 'null']).toContain(type);
          expect(key.trim().length).toBeGreaterThan(0);
        }
        // Health answers before any credential exists, so nothing in it may look like one.
        const rendered = JSON.stringify(health).toLowerCase();
        for (const forbidden of ['password', 'secret', 'token', 'key=', 'postgres://', 'postgresql://']) {
          expect(rendered).not.toContain(forbidden);
        }
      });
    }, timeout);
  });
}
