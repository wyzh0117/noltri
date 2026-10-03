/**
 * Classification Engine + dedupe rules (V1_DEVELOPMENT §9, PROJECT_MASTER §2.2 / §3.3 / §3.6).
 *
 * The attach bar is configuration, node titles are reused under the same parent, and a near-duplicate
 * never rewrites the knowledge it merged into.
 */
import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '@noltri/shared';
import type { ClassifyInput } from '@noltri/ai-provider';
import type { Script } from './fakes';
import { captureOf, makeHarness, repoCalls, testConfig, thresholdsOf } from './fakes';

const ORIGINAL = '浓缩咖啡的粉水比通常控制在一比十八左右，萃取时间约二十五秒。';
const NEAR_DUPLICATE = '手冲咖啡的粉水比通常控制在一比十八左右，萃取时间约二十五秒。';

const PYTHON_TEXT = 'Python 的元组一旦创建就不能修改，因此可以作为字典的键使用。';
const ESPRESSO_TEXT = '意式浓缩咖啡的萃取压力通常约为九个大气压。';

function createScript(path: string[]): Script {
  return {
    classify: () => ({ action: 'create', newNodePath: path, confidence: 0.4, reason: '知识库中没有可归档的节点' }),
  };
}

function attachScript(nodeId: string): Script {
  return { classify: () => ({ action: 'attach', nodeId, confidence: 0.91, reason: '同一主题' }) };
}

describe('classification', () => {
  it('hands the configured attach threshold to the provider', async () => {
    const harness = makeHarness({ config: testConfig({ thresholds: thresholdsOf({ similarityAttachThreshold: 0.42 }) }) });
    await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);

    const input = harness.provider.classifyInputs[0] as ClassifyInput;
    expect(input.attachThreshold).toBe(0.42);
    expect(input.itemText).toBe(PYTHON_TEXT.slice(0, input.itemText.length));
    // The suggested title is derived from the point text and kept short enough to be a node title.
    const suggestedTitle = input.suggestedTitle ?? '';
    expect(suggestedTitle.startsWith('Python')).toBe(true);
    expect(suggestedTitle.length).toBeLessThanOrEqual(30);
    expect(input.candidates.length).toBeLessThanOrEqual(harness.config.thresholds.candidateNodeLimit);
  });

  it('merges at or above the threshold and classifies below it', async () => {
    const probe = makeHarness();
    await probe.core.capture(captureOf(ORIGINAL), probe.actor);
    await probe.core.capture(captureOf(NEAR_DUPLICATE), probe.actor);

    // The exact texts the pipeline embedded, so the maths below is the pipeline's own maths.
    const first = String(probe.provider.embedInputs[0]?.[0]);
    const second = String(probe.provider.embedInputs[1]?.[0]);
    const [vectorA, vectorB] = await probe.provider.embed([first, second]);
    const score = cosineSimilarity(vectorA as number[], vectorB as number[]);
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.95);

    const merging = makeHarness({ config: testConfig({ thresholds: thresholdsOf({ similarityAttachThreshold: score - 0.01 }) }) });
    const classifying = makeHarness({
      config: testConfig({ thresholds: thresholdsOf({ similarityAttachThreshold: score + 0.01 }) }),
      script: createScript(['咖啡', '冲煮比例']),
    });

    // Seed both trees with the original point: nothing can merge into an empty library.
    const seedInMerging = await merging.core.capture(captureOf(ORIGINAL), merging.actor);
    await classifying.core.capture(captureOf(ORIGINAL), classifying.actor);
    const mergeClassifyCalls = merging.provider.classifyInputs.length;
    const createClassifyCalls = classifying.provider.classifyInputs.length;
    expect(mergeClassifyCalls).toBeGreaterThan(0);

    const secondInMerging = await merging.core.capture(captureOf(NEAR_DUPLICATE), merging.actor);
    const secondInClassifying = await classifying.core.capture(captureOf(NEAR_DUPLICATE), classifying.actor);

    // Above the bar the similarity engine answers on its own: the classifier is never asked, and the
    // point lands on the node that already holds its near-duplicate.
    expect(secondInMerging.items[0]?.action).toBe('merged');
    expect(secondInMerging.items[0]?.nodeId).toBe(seedInMerging.items[0]?.nodeId);
    expect(merging.provider.classifyInputs).toHaveLength(mergeClassifyCalls);

    // Below the bar the classifier is consulted again and the point lands where its decision says.
    expect(secondInClassifying.items[0]?.action).toBe('attached');
    expect(secondInClassifying.items[0]?.nodePath).toEqual(['咖啡', '冲煮比例']);
    expect(classifying.provider.classifyInputs.length).toBeGreaterThan(createClassifyCalls);
  });

  it('attaches to an existing node when the model says attach', async () => {
    const seeded = makeHarness();
    const first = await seeded.core.capture(captureOf(PYTHON_TEXT), seeded.actor);
    const targetNodeId = String(first.items[0]?.nodeId);

    const harness = makeHarness({ repository: seeded.repository, script: attachScript(targetNodeId) });
    const result = await harness.core.capture(captureOf(ESPRESSO_TEXT), harness.actor);

    expect(result.items[0]?.action).toBe('attached');
    expect(result.items[0]?.nodeId).toBe(targetNodeId);
    expect(result.items[0]?.confidenceTier).toBe('high');
  });

  it('reuses a node title under the same parent instead of duplicating it', async () => {
    const harness = makeHarness({ script: createScript(['咖啡', '冲煮比例']) });
    const first = await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);
    const second = await harness.core.capture(captureOf(ESPRESSO_TEXT), harness.actor);

    const nodes = await harness.repository.listNodes(harness.actor.userId);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.title).sort()).toEqual(['冲煮比例', '咖啡']);

    expect(first.items[0]?.action).toBe('created');
    expect(second.items[0]?.action).toBe('attached');
    expect(second.items[0]?.nodeId).toBe(first.items[0]?.nodeId);
    expect(second.items[0]?.nodePath).toEqual(['咖啡', '冲煮比例']);
  });

  it('matches a reused title case- and whitespace-insensitively', async () => {
    let calls = 0;
    const harness = makeHarness({
      script: {
        classify: () => {
          calls += 1;
          return {
            action: 'create',
            newNodePath: [calls === 1 ? 'Brewing Ratio' : '   brewing   ratio '],
            confidence: 0.4,
            reason: '同一节点名',
          };
        },
      },
    });

    await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);
    const second = await harness.core.capture(captureOf(ESPRESSO_TEXT), harness.actor);

    expect(second.items[0]?.action).toBe('attached');
    expect(await harness.repository.listNodes(harness.actor.userId)).toHaveLength(1);
  });

  it('builds the whole ancestor chain for a multi-level newNodePath', async () => {
    const harness = makeHarness({ script: createScript(['编程', 'Python', '装饰器']) });
    const result = await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);
    const leafId = String(result.items[0]?.nodeId);

    expect(result.items[0]?.action).toBe('created');
    expect(result.items[0]?.nodePath).toEqual(['编程', 'Python', '装饰器']);

    const titles = (await harness.repository.listNodes(harness.actor.userId)).map((node) => node.title);
    expect(titles.sort()).toEqual(['Python', '编程', '装饰器']);

    const root = await harness.repository.findNodeByTitle(harness.actor.userId, '编程', null);
    const python = await harness.repository.findNodeByTitle(harness.actor.userId, 'Python', String(root?.id));
    const leaf = await harness.repository.findNode(leafId, harness.actor.userId);
    expect(root?.parentId).toBeNull();
    expect(python?.parentId).toBe(root?.id);
    expect(leaf?.parentId).toBe(python?.id);

    const versions = await harness.repository.listVersionRecords(harness.actor.userId);
    expect(versions.filter((record) => record.operation === 'create')).toHaveLength(3);

    const edges = await harness.repository.listEdgesForNode(harness.actor.userId, leafId);
    expect(edges.map((edge) => edge.relationType)).toContain('part_of');
  });

  it('merges a near duplicate without ever rewriting the original knowledge', async () => {
    const harness = makeHarness();
    const first = await harness.core.capture(captureOf(ORIGINAL), harness.actor);
    const originalItemId = String(first.items[0]?.knowledgeItemId);
    const beforeItem = await harness.repository.findKnowledgeItem(originalItemId, harness.actor.userId);
    const beforeSource = await harness.repository.findRawSource(first.rawSourceId, harness.actor.userId);
    const nodesBefore = (await harness.repository.listNodes(harness.actor.userId)).length;

    const second = await harness.core.capture(captureOf(ORIGINAL), harness.actor);

    expect(second.rawSourceId).not.toBe(first.rawSourceId);
    expect(second.items[0]?.action).toBe('merged');
    expect(second.items[0]?.nodeId).toBe(first.items[0]?.nodeId);
    expect(second.items[0]?.knowledgeItemId).not.toBe(originalItemId);

    const afterItem = await harness.repository.findKnowledgeItem(originalItemId, harness.actor.userId);
    expect(
      Buffer.compare(
        Buffer.from(String(beforeItem?.normalizedText), 'utf8'),
        Buffer.from(String(afterItem?.normalizedText), 'utf8'),
      ),
    ).toBe(0);
    expect(afterItem?.updatedAt).toBe(beforeItem?.updatedAt);

    const afterSource = await harness.repository.findRawSource(first.rawSourceId, harness.actor.userId);
    expect(
      Buffer.compare(Buffer.from(String(beforeSource?.rawText), 'utf8'), Buffer.from(String(afterSource?.rawText), 'utf8')),
    ).toBe(0);

    // The merge added evidence; it did not restructure or rewrite anything.
    expect((await harness.repository.listNodes(harness.actor.userId)).length).toBe(nodesBefore);
    expect(repoCalls(harness.timeline)).not.toContain('updateKnowledgeItem');
  });

  it('keeps the tree honest when the provider attaches to a node that does not exist', async () => {
    const harness = makeHarness({ script: attachScript('missing-node-id') });
    const result = await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);

    expect(result.items[0]?.action).toBe('created');
    const node = await harness.repository.findNode(String(result.items[0]?.nodeId), harness.actor.userId);
    expect(node).not.toBeNull();
    expect(node?.title.length).toBeGreaterThan(0);
  });

  it('links a captured point back to its provenance and its neighbours', async () => {
    const harness = makeHarness();
    await harness.core.capture(captureOf(PYTHON_TEXT), harness.actor);
    const related = await harness.core.capture(
      captureOf('Python 的列表可以随时追加和删除元素，因此不能作为字典的键使用。'),
      harness.actor,
    );

    const edges = await harness.repository.listEdgesForNode(harness.actor.userId, String(related.items[0]?.nodeId));
    expect(edges.length).toBeGreaterThanOrEqual(1);
    for (const edge of edges) {
      expect(['part_of', 'similar_to', 'derived_from']).toContain(edge.relationType);
    }
  });
});
