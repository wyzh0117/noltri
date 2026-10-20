import { describe, expect, it } from 'vitest';
import { asKnowledgeError } from '@noltri/shared';
import { attachItemRecord, makeHarness } from './fakes';

async function node(harness: ReturnType<typeof makeHarness>, title: string, nodeType: string, parentId: string | null = null) {
  return harness.repository.createNode({ userId: harness.actor.userId, title, nodeType, parentId });
}

describe('topic and chapter graph', () => {
  it('keeps same-title topics distinct and scopes full and local graphs by stable IDs', async () => {
    const harness = makeHarness();
    const userId = harness.actor.userId;
    const discipline = await node(harness, '认知科学', 'discipline');
    const firstBranch = await node(harness, '学习科学', 'subdiscipline', discipline.id);
    const secondBranch = await node(harness, '脑科学', 'subdiscipline', discipline.id);
    const topicA = await node(harness, '记忆', 'topic', firstBranch.id);
    const topicB = await node(harness, '记忆', 'topic', secondBranch.id);
    const topicC = await node(harness, '学习策略', 'topic', firstBranch.id);
    const shared = await node(harness, '编码与提取', 'chapter', topicA.id);
    const privateChapter = await node(harness, '间隔练习', 'chapter', topicC.id);
    const secondBranchChapter = await node(harness, '工作记忆', 'chapter', topicB.id);
    await harness.repository.createEdge({
      userId,
      fromNodeId: shared.id,
      toNodeId: topicC.id,
      relationType: 'part_of',
      source: 'topic_chapter',
    });

    const whole = await harness.core.selectGraph({ kind: 'discipline', disciplineId: discipline.id }, harness.actor);
    expect(whole.nodes.filter((entry) => entry.nodeType === 'topic').map((entry) => entry.id).sort()).toEqual(
      [topicA.id, topicB.id, topicC.id].sort(),
    );
    expect(whole.nodes.filter((entry) => entry.nodeType === 'chapter').map((entry) => entry.id).sort()).toEqual(
      [shared.id, privateChapter.id, secondBranchChapter.id].sort(),
    );
    expect(whole.edges.filter((edge) => edge.fromNodeId === shared.id).map((edge) => edge.toNodeId).sort()).toEqual(
      [topicA.id, topicC.id].sort(),
    );

    const scoped = await harness.core.selectGraph({ kind: 'subdiscipline', disciplineId: discipline.id, subdisciplineId: firstBranch.id }, harness.actor);
    expect(scoped.nodes.map((entry) => entry.id)).not.toContain(topicB.id);
    expect(scoped.nodes.map((entry) => entry.id)).not.toContain(secondBranchChapter.id);

    const local = await harness.core.selectGraph({ kind: 'topic', disciplineId: discipline.id, anchorTopicId: topicA.id }, harness.actor);
    expect(local.nodes.map((entry) => entry.id)).toEqual(expect.arrayContaining([topicA.id, topicC.id, shared.id]));
    expect(local.nodes.map((entry) => entry.id)).not.toContain(topicB.id);
    expect(local.nodes.map((entry) => entry.id)).not.toContain(privateChapter.id);
  });

  it('anchors a parentless chapter to its existing membership before linking or adapting scopes', async () => {
    const harness = makeHarness();
    const userId = harness.actor.userId;
    const disciplineA = await node(harness, '物理', 'discipline');
    const branchA = await node(harness, '力学', 'subdiscipline', disciplineA.id);
    const topicA = await node(harness, '运动', 'topic', branchA.id);
    const disciplineB = await node(harness, '计算机', 'discipline');
    const branchB = await node(harness, '图形学', 'subdiscipline', disciplineB.id);
    const topicB = await node(harness, '渲染', 'topic', branchB.id);
    const chapter = await node(harness, '向量', 'chapter');
    const original = await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: topicA.id,
      relationType: 'part_of',
      source: 'topic_chapter',
    });
    const error = await harness.core.connectChapter(chapter.id, topicB.id, harness.actor)
      .then(() => null, (cause: unknown) => asKnowledgeError(cause));
    expect(error?.code).toBe('invalid_request');
    expect((await harness.repository.findNode(chapter.id, userId))?.parentId).toBeNull();
    expect(await harness.repository.findEdge(userId, chapter.id, topicA.id, 'part_of')).toEqual(original);

    // Older persisted data may already contain a conflicting edge. Keep the first valid anchor and
    // report/drop the conflicting edge instead of moving the chapter into another discipline.
    await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: topicB.id,
      relationType: 'part_of',
      source: 'legacy-invalid-membership',
    });
    const graphA = await harness.core.selectGraph({ kind: 'discipline', disciplineId: disciplineA.id }, harness.actor);
    expect(graphA.nodes.map((entry) => entry.id)).toContain(chapter.id);
    expect(graphA.edges).toContainEqual(expect.objectContaining({ fromNodeId: chapter.id, toNodeId: topicA.id }));
    expect(graphA.diagnostics).toContainEqual(expect.objectContaining({ reason: 'cross-discipline' }));
    const graphB = await harness.core.selectGraph({ kind: 'discipline', disciplineId: disciplineB.id }, harness.actor);
    expect(graphB.nodes.map((entry) => entry.id)).not.toContain(chapter.id);
    const stillRejected = await harness.core.connectChapter(chapter.id, topicB.id, harness.actor)
      .then(() => null, (cause: unknown) => asKnowledgeError(cause));
    expect(stillRejected?.code).toBe('invalid_request');
  });

  it('resolves only in-scope valid memberships and makes detached notes recoverable', async () => {
    const harness = makeHarness();
    const userId = harness.actor.userId;
    const discipline = await node(harness, '计算机科学', 'discipline');
    const branch = await node(harness, '算法', 'subdiscipline', discipline.id);
    const emptyBranch = await node(harness, '网络安全', 'subdiscipline', discipline.id);
    const topic = await node(harness, '图算法', 'topic', branch.id);
    const sharedTopic = await node(harness, '网络', 'topic', branch.id);
    const otherDiscipline = await node(harness, '数学', 'discipline');
    const outOfScopeTopic = await node(harness, '图论', 'topic', otherDiscipline.id);
    const chapter = await node(harness, '最短路径', 'chapter', topic.id);
    await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: sharedTopic.id,
      relationType: 'part_of',
      source: 'topic_chapter',
    });
    await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: outOfScopeTopic.id,
      relationType: 'part_of',
      source: 'legacy-invalid-membership',
    });
    await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: outOfScopeTopic.id,
      relationType: 'similar_to',
      source: 'fixture-invalid-membership',
    });
    await harness.repository.createEdge({
      userId,
      fromNodeId: chapter.id,
      toNodeId: chapter.id,
      relationType: 'part_of',
      source: 'fixture-self-loop',
    });
    await harness.repository.createEdge({
      userId,
      fromNodeId: 'missing-node',
      toNodeId: topic.id,
      relationType: 'part_of',
      source: 'fixture-missing-endpoint',
    });

    const scope = { kind: 'subdiscipline' as const, disciplineId: discipline.id, subdisciplineId: branch.id };
    expect(await harness.core.resolveChapter({ chapterId: chapter.id, scope }, harness.actor)).toEqual({
      kind: 'choose-topic',
      chapterId: chapter.id,
      topicIds: [topic.id, sharedTopic.id].sort(),
    });
    expect(await harness.core.resolveChapter({ chapterId: chapter.id, activeTopicId: sharedTopic.id, scope }, harness.actor)).toEqual({
      kind: 'resolved',
      topicId: sharedTopic.id,
      chapterId: chapter.id,
    });
    expect(await harness.core.resolveChapter({
      chapterId: chapter.id,
      scope: { kind: 'subdiscipline', disciplineId: discipline.id, subdisciplineId: emptyBranch.id },
    }, harness.actor)).toEqual({ kind: 'unavailable' });
    const scopedGraph = await harness.core.selectGraph(scope, harness.actor);
    expect(scopedGraph.nodes.map((entry) => entry.id)).not.toContain(outOfScopeTopic.id);
    expect(scopedGraph.edges.map((edge) => edge.toNodeId)).not.toContain(outOfScopeTopic.id);
    expect(scopedGraph.diagnostics).toContainEqual(expect.objectContaining({ reason: 'cross-discipline' }));
    expect(scopedGraph.diagnostics).toContainEqual(expect.objectContaining({ reason: 'self-loop' }));
    expect(scopedGraph.diagnostics).toContainEqual(expect.objectContaining({ reason: 'missing-endpoint' }));
    const rejectedCrossLink = await harness.core.connectChapter(chapter.id, outOfScopeTopic.id, harness.actor)
      .then(() => null, (error: unknown) => asKnowledgeError(error));
    expect(rejectedCrossLink?.code).toBe('invalid_request');

    await attachItemRecord(harness, chapter.id, 'Dijkstra 最短路径资料');
    await harness.core.saveGraphNote(topic.id, { chapterId: chapter.id, content: '图算法章节正文' }, harness.actor);
    const sourcesBefore = await harness.repository.listLinksForNode(chapter.id, userId);
    await harness.core.disconnectChapter(chapter.id, topic.id, harness.actor);
    expect(await harness.core.getGraphNote(topic.id, chapter.id, harness.actor)).toMatchObject({ content: '图算法章节正文' });
    expect(await harness.core.listGraphNotes(topic.id, harness.actor)).toMatchObject({
      notes: [{ chapterId: chapter.id, chapterTitle: '最短路径', attached: false }],
    });
    expect(await harness.repository.listLinksForNode(chapter.id, userId)).toEqual(sourcesBefore);
    expect(await harness.core.resolveChapter({ chapterId: chapter.id, scope }, harness.actor)).toEqual({ kind: 'resolved', topicId: sharedTopic.id, chapterId: chapter.id });

    const badNote = await harness.core.saveGraphNote(topic.id, { chapterId: discipline.id, content: 'invalid' }, harness.actor)
      .then(() => null, (error: unknown) => asKnowledgeError(error));
    expect(badNote?.code).toBe('not_found');
  });
});
