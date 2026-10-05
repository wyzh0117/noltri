/**
 * R03 across the two halves of the product: 归档一个知识节点 answers for the research that cites it.
 *
 * `services/node.ts` is the only place the knowledge side reaches into research, and this file is the
 * proof of that one seam — through `core.patchNode`, the same call `PATCH /api/nodes/:id` makes. What it
 * pins: 归档 marks the 引用 and their 论点, the pointer is never re-bound, 恢复 does not report the 引用 as
 * verified, and a host that never wired a research repository keeps archiving as if none of this existed.
 */
import { describe, expect, it } from 'vitest';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import type { Harness } from './fakes';
import { createNodeRecord, makeHarness } from './fakes';
import { FakeResearchRepository } from './research-fakes';

interface Seeded {
  harness: Harness;
  domain: ResearchDomain;
  userId: string;
  projectId: string;
  nodeId: string;
  evidenceId: string;
  claimId: string;
}

/** 冷链访谈记录 ← Evidence(nodeId=…) → Claim, in one research project. */
async function seedCited(title = '冷链访谈记录'): Promise<Seeded> {
  const domain = createResearchDomain(new FakeResearchRepository());
  const harness = makeHarness({ research: domain });
  const userId = harness.actor.userId;
  const nodeId = await createNodeRecord(harness, title, null);
  const project = await domain.createProject(userId, { name: '冷链物流服务质量研究' });
  const evidence = await domain.createEvidence(project.id, userId, {
    type: 'interview',
    title: '访谈：王工 2026-03',
    nodeId,
    locationOrigin: 'captured',
  });
  const claim = await domain.createClaim(project.id, userId, {
    claimCode: 'C1',
    claimText: '可靠性因素处于结构性中介位置。',
    claimType: 'empirical',
  });
  await domain.createRelation(project.id, userId, {
    sourceType: 'evidence',
    sourceId: evidence.id,
    relationType: 'supports',
    targetType: 'claim',
    targetId: claim.id,
  });
  return { harness, domain, userId, projectId: project.id, nodeId, evidenceId: evidence.id, claimId: claim.id };
}

describe('archiving a knowledge node and its research 引用', () => {
  it('marks the 引用 and the 论点 it supports, and leaves the pointer alone', async () => {
    const seeded = await seedCited();
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {})).toEqual([]);

    const node = await seeded.harness.core.patchNode(seeded.nodeId, { status: 'archived' }, seeded.harness.actor);
    expect(node.status).toBe('archived');

    const marks = await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {});
    expect(marks.map((mark) => mark.entityId).sort()).toEqual([seeded.evidenceId, seeded.claimId].sort());
    expect(marks.every((mark) => mark.raisedBy === 'source_archived')).toBe(true);
    expect(marks.every((mark) => mark.status === 'pending')).toBe(true);
    // 标记要说得出是哪个出处，只给一个 id 用户读不懂。
    expect(marks.every((mark) => mark.reason.includes('冷链访谈记录'))).toBe(true);

    // 归档后引用仍可追溯：nodeId 既没有清空，也没有被悄悄换到别的文本上。
    const evidence = await seeded.domain.listEvidence(seeded.projectId, seeded.userId, {});
    expect(evidence[0]?.nodeId).toBe(seeded.nodeId);
    expect((await seeded.domain.findReferences(seeded.userId, { nodeId: seeded.nodeId }))[0]?.claimIds).toEqual([
      seeded.claimId,
    ]);
  });

  it('uses the title the user is renaming to, when one patch does both', async () => {
    const seeded = await seedCited('冷链访谈记录');
    await seeded.harness.core.patchNode(
      seeded.nodeId,
      { title: '冷链访谈记录（已停用）', status: 'archived' },
      seeded.harness.actor,
    );
    const marks = await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {});
    expect(marks[0]?.reason).toContain('冷链访谈记录（已停用）');
  });

  it('does not report a 引用 as verified when the node comes back', async () => {
    const seeded = await seedCited();
    await seeded.harness.core.patchNode(seeded.nodeId, { status: 'archived' }, seeded.harness.actor);
    await seeded.harness.core.patchNode(seeded.nodeId, { status: 'active' }, seeded.harness.actor);

    // 恢复出处 ≠ 这条 引用 已经被核验过：标记一条都不能少，状态一个都不能动。
    const afterRestore = await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {});
    expect(afterRestore).toHaveLength(2);
    expect(afterRestore.every((mark) => mark.status === 'pending')).toBe(true);

    // 再归档一次 is one refreshed mark per object, not a pile.
    await seeded.harness.core.patchNode(seeded.nodeId, { status: 'archived' }, seeded.harness.actor);
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {})).toHaveLength(2);

    // Only 处理完 clears it, and the row stays.
    const cleared = await seeded.domain.clearReviewMark(afterRestore[0]!.id, seeded.userId);
    expect(cleared.status).toBe('cleared');
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {})).toHaveLength(2);
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, { status: 'pending' })).toHaveLength(1);
  });

  it('archives a node nobody cites without marking anything', async () => {
    const seeded = await seedCited();
    const other = await createNodeRecord(seeded.harness, '没人引用的节点', null);
    const node = await seeded.harness.core.patchNode(other, { status: 'archived' }, seeded.harness.actor);
    expect(node.status).toBe('archived');
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {})).toEqual([]);
  });

  it('does not mark on a status change that is not an archive', async () => {
    const seeded = await seedCited();
    await seeded.harness.core.patchNode(seeded.nodeId, { status: 'needs_review' }, seeded.harness.actor);
    expect(await seeded.domain.listReviewMarks(seeded.projectId, seeded.userId, {})).toEqual([]);
  });

  it('archives without a second thought on a host with no research wiring', async () => {
    const harness = makeHarness();
    expect(harness.core.deps.research).toBeUndefined();
    const nodeId = await createNodeRecord(harness, '冷链访谈记录', null);

    const node = await harness.core.patchNode(nodeId, { status: 'archived' }, harness.actor);
    expect(node.status).toBe('archived');
    const detail = await harness.core.getNodeDetail(nodeId, harness.actor);
    expect(detail.node.status).toBe('archived');
  });
});
