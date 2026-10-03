/**
 * Tree Engine + Move Engine (V1_DEVELOPMENT §8 GET /api/tree, POST /api/nodes/:id/move, §17.2).
 *
 * The tree is the product's surface: counts must be truthful, empty nodes must still show up, and a
 * structurally impossible move must be refused without touching the existing tree (PROJECT_MASTER §2.4).
 */
import { describe, expect, it } from 'vitest';
import { moveNodeResponseSchema, nodeDetailSchema, treeResponseSchema } from '@noltri/schema';
import type { TreeNode } from '@noltri/schema';
import { asKnowledgeError, nowIso } from '@noltri/shared';
import type { Harness } from './fakes';
import { attachItemRecord, createNodeRecord, makeHarness } from './fakes';

interface Seeded {
  harness: Harness;
  coffeeId: string;
  brewingId: string;
  storageId: string;
  grinderId: string;
}

/**
 * 咖啡
 *   冲煮参数        (2 items)
 *     磨豆机        (1 item)
 *   存放方式        (0 items, an empty node must still be structure)
 */
async function seedTree(): Promise<Seeded> {
  const harness = makeHarness();
  const coffeeId = await createNodeRecord(harness, '咖啡', null);
  const brewingId = await createNodeRecord(harness, '冲煮参数', coffeeId);
  const storageId = await createNodeRecord(harness, '存放方式', coffeeId);
  const grinderId = await createNodeRecord(harness, '磨豆机', brewingId);

  await attachItemRecord(harness, coffeeId, '咖啡豆的香气会在烘焙后十四天内明显衰减。');
  await attachItemRecord(harness, coffeeId, '常温密封存放最能保留咖啡的香气。');
  await attachItemRecord(harness, brewingId, '手冲咖啡的粉水比通常控制在一比十五左右。');
  await attachItemRecord(harness, brewingId, '水温升高会提高萃取率，也容易带出苦味。');
  await attachItemRecord(harness, grinderId, '磨豆机的刻度决定粉粒粗细，进而影响萃取速度。');

  return { harness, coffeeId, brewingId, storageId, grinderId };
}

function findNode(nodes: readonly TreeNode[], title: string): TreeNode | null {
  for (const node of nodes) {
    if (node.title === title) return node;
    const found = node.children === undefined ? null : findNode(node.children, title);
    if (found !== null) return found;
  }
  return null;
}

function nodeOf(nodes: readonly TreeNode[], title: string): TreeNode {
  const found = findNode(nodes, title);
  if (found === null) throw new Error(`node ${title} missing from tree`);
  return found;
}

describe('tree engine', () => {
  it('counts items on the node, counts them again for the subtree and keeps empty nodes', async () => {
    const { harness, storageId } = await seedTree();
    const raw = await harness.core.getTree({}, harness.actor);
    expect(treeResponseSchema.safeParse(raw).success).toBe(true);

    const tree = treeResponseSchema.parse(raw);
    const coffee = nodeOf(tree.nodes, '咖啡');
    const brewing = nodeOf(tree.nodes, '冲煮参数');

    expect(coffee.itemCount).toBe(2);
    expect(coffee.descendantItemCount).toBe(5);
    expect(coffee.childCount).toBe(2);
    expect(brewing.itemCount).toBe(2);
    expect(brewing.descendantItemCount).toBe(3);
    expect(brewing.childCount).toBe(1);
    expect(tree.totalNodes).toBe(4);

    // An empty node is still part of the knowledge tree.
    expect(coffee.children?.map((child) => child.title)).toContain('存放方式');
    const empty = await harness.repository.findNode(storageId, harness.actor.userId);
    expect(empty?.title).toBe('存放方式');
  });

  it('cuts at the requested depth but keeps the descendant count truthful', async () => {
    const { harness } = await seedTree();
    const tree = treeResponseSchema.parse(await harness.core.getTree({ depth: 2 }, harness.actor));
    const coffee = nodeOf(tree.nodes, '咖啡');
    const brewing = nodeOf(tree.nodes, '冲煮参数');

    expect(coffee.children?.map((child) => child.title).sort()).toEqual(['冲煮参数', '存放方式'].sort());
    expect(brewing.children).toBeUndefined();
    // The hidden 磨豆机 item is still accounted for.
    expect(brewing.descendantItemCount).toBe(3);
    expect(coffee.descendantItemCount).toBe(5);
  });

  it('never renders more than six levels however deep the tree grows', async () => {
    const harness = makeHarness();
    let parentId: string | null = null;
    for (let level = 1; level <= 9; level += 1) {
      parentId = await createNodeRecord(harness, `层 ${String(level)}`, parentId);
    }
    const tree = treeResponseSchema.parse(await harness.core.getTree({ depth: 99 }, harness.actor));
    let depth = 0;
    let cursor = tree.nodes[0];
    while (cursor !== undefined && cursor.children !== undefined && cursor.children.length > 0) {
      depth += 1;
      cursor = cursor.children[0];
    }
    expect(depth + 1).toBe(6);
  });

  it('roots the response at a chosen node', async () => {
    const { harness, brewingId } = await seedTree();
    const tree = treeResponseSchema.parse(await harness.core.getTree({ rootId: brewingId }, harness.actor));

    expect(tree.rootId).toBe(brewingId);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.title).toBe('冲煮参数');
    expect(tree.nodes[0]?.descendantItemCount).toBe(3);
    expect(tree.totalNodes).toBe(2);
  });

  it('answers identically on repeat calls, so sibling order is stable', async () => {
    const { harness } = await seedTree();
    const first = await harness.core.getTree({}, harness.actor);
    const second = await harness.core.getTree({}, harness.actor);
    expect(second).toEqual(first);
  });

  it('reports a missing tree root instead of inventing one', async () => {
    const { harness } = await seedTree();
    await expect(harness.core.getTree({ rootId: 'missing-node' }, harness.actor)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('node detail and patch', () => {
  it('shows the breadcrumb, the items with their sources, the children and the stats', async () => {
    const { harness, brewingId, storageId } = await seedTree();
    await harness.repository.createEdge({
      userId: harness.actor.userId,
      fromNodeId: brewingId,
      toNodeId: storageId,
      relationType: 'similar_to',
      confidence: 0.5,
      source: 'similarity_engine',
    });
    const detail = nodeDetailSchema.parse(await harness.core.getNodeDetail(brewingId, harness.actor));

    expect(detail.node.id).toBe(brewingId);
    expect(detail.path.map((segment) => segment.title)).toEqual(['咖啡', '冲煮参数']);
    expect(detail.items).toHaveLength(2);
    expect(detail.children.map((child) => child.title)).toEqual(['磨豆机']);
    expect(detail.stats).toEqual({ itemCount: 2, sourceCount: 2, childCount: 1 });
    expect(detail.relatedNodes.map((entry) => [entry.node.title, entry.relationType])).toEqual([
      ['存放方式', 'similar_to'],
    ]);
    for (const entry of detail.items) {
      expect(entry.sources).toHaveLength(1);
      expect(entry.sources[0]?.sourceType).toBe('manual');
    }
  });

  it('dedupes a source shared by several items on the node', async () => {
    const harness = makeHarness();
    const nodeId = await createNodeRecord(harness, 'Python', null);
    const source = await harness.repository.createRawSource({
      userId: harness.actor.userId,
      rawText: '元组不可修改，因此可以做键；列表可以修改，因此不能做键。',
      sourceType: 'web',
      sourceUrl: 'https://example.com/py',
      capturedAt: nowIso(),
    });
    const texts = ['元组不可修改，因此可以做键。', '列表可以修改，因此不能做键。'];
    const vectors = await harness.provider.embed(texts);
    for (const [index, text] of texts.entries()) {
      const item = await harness.repository.createKnowledgeItem({
        userId: harness.actor.userId,
        rawSourceId: source.id,
        normalizedText: text,
        summary: null,
        confidence: 0.8,
        embedding: vectors[index],
        embeddingStatus: 'ready',
        embeddingModel: 'offline-deterministic',
      });
      await harness.repository.linkItemToNode({
        userId: harness.actor.userId,
        itemId: item.id,
        nodeId,
        relationType: index === 0 ? 'primary' : 'supports',
        confidence: 0.8,
      });
    }

    const detail = nodeDetailSchema.parse(await harness.core.getNodeDetail(nodeId, harness.actor));
    expect(detail.items).toHaveLength(2);
    expect(detail.stats).toEqual({ itemCount: 2, sourceCount: 1, childCount: 0 });
    expect(detail.items[0]?.sources.map((entry) => entry.rawSourceId)).toEqual([source.id]);
  });

  it('renames through patch and records a reversible rename', async () => {
    const { harness, brewingId } = await seedTree();
    const before = await harness.repository.listVersionRecords(harness.actor.userId);

    const updated = await harness.core.patchNode(brewingId, { title: '  冲煮参数与水温  ' }, harness.actor);
    expect(updated.title).toBe('冲煮参数与水温');

    const after = await harness.repository.listVersionRecords(harness.actor.userId);
    const rename = after.filter((record) => record.entityId === brewingId && record.operation === 'rename');
    expect(rename).toHaveLength(1);
    expect(after).toHaveLength(before.length + 1);
    expect(rename[0]?.before).toMatchObject({ title: '冲煮参数' });
    expect(rename[0]?.after).toMatchObject({ title: '冲煮参数与水温' });
    expect(rename[0]?.actor).toBe(harness.actor.actor);

    const detail = nodeDetailSchema.parse(await harness.core.getNodeDetail(brewingId, harness.actor));
    expect(detail.path.map((segment) => segment.title)).toEqual(['咖啡', '冲煮参数与水温']);
  });

  it('archiving through patch is versioned too, summary-only edits are not', async () => {
    const { harness, storageId } = await seedTree();
    const recordsBefore = await harness.repository.listVersionRecords(harness.actor.userId);

    const archived = await harness.core.patchNode(storageId, { status: 'archived' }, harness.actor);
    expect(archived.status).toBe('archived');
    const afterArchive = await harness.repository.listVersionRecords(harness.actor.userId);
    expect(afterArchive).toHaveLength(recordsBefore.length + 1);
    expect(afterArchive.at(-1)?.operation).toBe('archive');

    // A summary edit carries no structure operation in the frozen contract, so it changes nothing
    // version-wise; the node still holds the new text.
    const summarised = await harness.core.patchNode(storageId, { summary: '避光、干燥、不进冰箱' }, harness.actor);
    expect(summarised.summary).toBe('避光、干燥、不进冰箱');
    expect(await harness.repository.listVersionRecords(harness.actor.userId)).toHaveLength(afterArchive.length);
  });

  it('refuses to patch a node that does not exist', async () => {
    const { harness } = await seedTree();
    await expect(harness.core.patchNode('missing', { title: '新名字' }, harness.actor)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('move engine', () => {
  it('re-parents a node, rewrites its path and writes a version record', async () => {
    const { harness, grinderId, storageId, brewingId } = await seedTree();
    const pathBefore = (await harness.repository.nodePath(harness.actor.userId, grinderId)).map((s) => s.title);
    expect(pathBefore).toEqual(['咖啡', '冲煮参数', '磨豆机']);
    const recordsBefore = await harness.repository.listVersionRecords(harness.actor.userId);

    const moved = moveNodeResponseSchema.parse(
      await harness.core.moveNode(grinderId, { targetParentId: storageId, actor: 'web_app' }, harness.actor),
    );

    expect(moved.cycleDetected).toBe(false);
    expect(moved.node.parentId).toBe(storageId);
    expect(moved.path.map((segment) => segment.title)).toEqual(['咖啡', '存放方式', '磨豆机']);
    expect(moved.versionRecordId.length).toBeGreaterThan(0);

    const records = await harness.repository.listVersionRecords(harness.actor.userId);
    expect(records).toHaveLength(recordsBefore.length + 1);
    const record = records.find((entry) => entry.id === moved.versionRecordId);
    expect(record?.entityId).toBe(grinderId);
    expect(record?.before).toMatchObject({ parentId: brewingId });
    expect(record?.after).toMatchObject({ parentId: storageId });
    expect(record?.actor).toBe('web_app');

    const tree = treeResponseSchema.parse(await harness.core.getTree({}, harness.actor));
    expect(nodeOf(tree.nodes, '存放方式').childCount).toBe(1);
    expect(nodeOf(tree.nodes, '磨豆机').itemCount).toBe(1);
  });

  it('moves a node back to the root of the tree', async () => {
    const { harness, grinderId } = await seedTree();
    const moved = await harness.core.moveNode(grinderId, { targetParentId: null }, harness.actor);
    expect(moved.node.parentId).toBeNull();
    expect(moved.path.map((segment) => segment.title)).toEqual(['磨豆机']);
    const tree = treeResponseSchema.parse(await harness.core.getTree({}, harness.actor));
    expect(tree.nodes.map((node) => node.title)).toContain('磨豆机');
  });

  it('refuses to move a node inside its own descendant and leaves the tree untouched', async () => {
    const { harness, coffeeId, brewingId, grinderId } = await seedTree();
    const snapshot = await harness.core.getTree({}, harness.actor);
    const recordsBefore = await harness.repository.listVersionRecords(harness.actor.userId);
    const edgesBefore = await harness.repository.listEdgesForNode(harness.actor.userId, coffeeId);

    const error = asKnowledgeError(
      await harness.core.moveNode(coffeeId, { targetParentId: grinderId }, harness.actor).catch((e: unknown) => e),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ cycleDetected: true, nodeId: coffeeId });

    expect(await harness.core.getTree({}, harness.actor)).toEqual(snapshot);
    expect(await harness.repository.listVersionRecords(harness.actor.userId)).toHaveLength(recordsBefore.length);
    expect(await harness.repository.listEdgesForNode(harness.actor.userId, coffeeId)).toEqual(edgesBefore);
    const parent = await harness.repository.findNode(brewingId, harness.actor.userId);
    expect(parent?.parentId).toBe(coffeeId);
  });

  it('refuses to move a node inside itself', async () => {
    const { harness, brewingId } = await seedTree();
    const error = asKnowledgeError(
      await harness.core.moveNode(brewingId, { targetParentId: brewingId }, harness.actor).catch((e: unknown) => e),
    );
    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
  });

  it('reports a missing node or a missing target instead of moving nothing', async () => {
    const { harness, coffeeId } = await seedTree();
    await expect(harness.core.moveNode('missing', { targetParentId: coffeeId }, harness.actor)).rejects.toMatchObject({
      code: 'not_found',
    });
    const error = asKnowledgeError(
      await harness.core.moveNode(coffeeId, { targetParentId: 'missing-target' }, harness.actor).catch((e: unknown) => e),
    );
    expect(error.code).toBe('not_found');
  });
});
