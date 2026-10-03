/**
 * Pure unit tests for the research workbench view models: timeline merging and ordering, drift
 * severity grouping and the layered Research Map projection. No DOM, no server, no React.
 *
 * The fixtures deliberately mix decision/change/milestone events with tied timestamps and leave one
 * claim without supporting evidence, because those are the cases the panels must render honestly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DriftFinding,
  ResearchChange,
  ResearchDecision,
  ResearchMapResponse,
  TimelineEvent,
} from '@noltri/schema';
import {
  buildMapViewModel,
  buildTimelineView,
  countFindingsBySeverity,
  formatRelatedEntities,
  groupFindingsBySeverity,
  incomingEdges,
  labelOf,
  outgoingEdges,
  researchRelationTypeLabels,
} from '../lib/research-view';

const NOW = '2026-06-01T08:00:00.000Z';

function timelineEvent(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, 'id'>): TimelineEvent {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    eventType: 'milestone',
    occurredAt: NOW,
    title: '事件',
    summary: null,
    sourceType: 'manual',
    sourceId: null,
    relatedEntities: {},
    createdAt: NOW,
    ...overrides,
  };
}

function finding(overrides: Partial<DriftFinding> & Pick<DriftFinding, 'id' | 'severity'>): DriftFinding {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    driftType: 'evidence_drift',
    description: '缺少证据',
    sourceEntityType: 'claim',
    sourceEntityId: 'claim-1',
    targetEntityType: null,
    targetEntityId: null,
    reason: null,
    recommendedAction: null,
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test('timeline: merges decision, change and milestone newest first with deterministic ties', () => {
  const decision: ResearchDecision = {
    id: 'dec-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: '采用 ISM + ANP',
    decision: '保留两阶段结构建模',
    reason: '样本量不足以支撑统计因果推断',
    alternatives: null,
    rejectedAlternatives: null,
    impact: null,
    relatedEntities: { claim: 'C-021' },
    createdAt: '2026-03-18T09:00:00.000Z',
  };
  const change: ResearchChange = {
    id: 'chg-1',
    projectId: 'proj-1',
    userId: 'user-1',
    changeType: 'research_question',
    before: 'RQ2 关注整体重要性',
    after: 'RQ2 关注目标依赖的决策优先级',
    reason: 'ANP 输出是目标依赖的相对权重',
    impact: 'Introduction / Method',
    relatedEntities: { rq: 'RQ2', order: 3 },
    createdAt: '2026-04-02T09:00:00.000Z',
  };
  const events: TimelineEvent[] = [
    timelineEvent({
      id: 'evt-dec',
      eventType: 'decision',
      occurredAt: '2026-03-18T09:00:00.000Z',
      title: '采用 ISM + ANP',
      sourceType: 'research_decision',
      sourceId: 'dec-1',
    }),
    timelineEvent({
      id: 'evt-chg',
      eventType: 'change',
      occurredAt: '2026-04-02T09:00:00.000Z',
      title: 'RQ2 modified',
      sourceType: 'research_change',
      sourceId: 'chg-1',
    }),
    // Two manual milestones share occurredAt: createdAt then id decide the order.
    timelineEvent({
      id: 'evt-b',
      title: '投稿 V1',
      summary: '完成第一版投稿包',
      occurredAt: '2026-07-22T00:00:00.000Z',
      createdAt: '2026-07-22T01:00:00.000Z',
      relatedEntities: { journal: 'IJPR' },
    }),
    timelineEvent({
      id: 'evt-a',
      title: '投稿 V1（旧）',
      occurredAt: '2026-07-22T00:00:00.000Z',
      createdAt: '2026-07-22T02:00:00.000Z',
    }),
  ];

  const view = buildTimelineView(events, { decisions: [decision], changes: [change] });
  assert.deepEqual(
    view.map((entry) => entry.event.id),
    ['evt-a', 'evt-b', 'evt-chg', 'evt-dec'],
  );
  assert.equal(view[0]?.dateLabel, '2026-07-22');

  const decisionEntry = view.find((entry) => entry.event.id === 'evt-dec');
  assert.equal(decisionEntry?.typeLabel, '决策');
  assert.equal(decisionEntry?.detail.what, '采用 ISM + ANP：保留两阶段结构建模');
  assert.equal(decisionEntry?.detail.why, '样本量不足以支撑统计因果推断');
  assert.deepEqual(decisionEntry?.detail.related, ['claim: C-021']);

  const changeEntry = view.find((entry) => entry.event.id === 'evt-chg');
  assert.equal(changeEntry?.detail.what, '研究问题：RQ2 关注整体重要性 → RQ2 关注目标依赖的决策优先级');
  assert.equal(changeEntry?.detail.why, 'ANP 输出是目标依赖的相对权重');
  assert.deepEqual(changeEntry?.detail.related, ['rq: RQ2', 'order: 3']);

  const milestone = view.find((entry) => entry.event.id === 'evt-b');
  assert.equal(milestone?.typeLabel, '里程碑');
  assert.equal(milestone?.detail.what, '完成第一版投稿包');
  assert.equal(milestone?.detail.why, null);
  assert.deepEqual(milestone?.detail.related, ['journal: IJPR']);
});

test('timeline: a sourceId without its source object falls back to the event itself', () => {
  const events = [timelineEvent({ id: 'evt-orphan', eventType: 'change', title: '孤立变更', sourceId: 'missing', summary: '摘要兜底' })];
  const view = buildTimelineView(events);
  assert.equal(view[0]?.detail.what, '摘要兜底');
  assert.equal(view[0]?.detail.why, null);
  assert.deepEqual(view[0]?.detail.related, []);
});

test('timeline: formatRelatedEntities handles object, array and empty bags', () => {
  assert.deepEqual(formatRelatedEntities({ a: 1, b: 'x' }), ['a: 1', 'b: x']);
  assert.deepEqual(formatRelatedEntities(['甲', { n: 2 }]), ['甲', '{"n":2}']);
  assert.deepEqual(formatRelatedEntities(null), []);
  assert.deepEqual(formatRelatedEntities(undefined), []);
});

test('drift: groups findings critical → warning → info and omits empty groups', () => {
  const findings = [
    finding({ id: 'f1', severity: 'info' }),
    finding({ id: 'f2', severity: 'critical' }),
    finding({ id: 'f3', severity: 'warning' }),
    finding({ id: 'f4', severity: 'critical' }),
  ];
  const groups = groupFindingsBySeverity(findings);
  assert.deepEqual(
    groups.map((group) => group.severity),
    ['critical', 'warning', 'info'],
  );
  assert.deepEqual(
    groups[0]?.findings.map((entry) => entry.id),
    ['f2', 'f4'],
  );
  assert.equal(groups[0]?.severityLabel, '严重');
  assert.equal(groupFindingsBySeverity([finding({ id: 'only', severity: 'warning' })]).length, 1);
});

test('drift: counts findings per severity and totals them', () => {
  const counts = countFindingsBySeverity([
    finding({ id: 'f1', severity: 'info' }),
    finding({ id: 'f2', severity: 'critical' }),
    finding({ id: 'f3', severity: 'warning' }),
    finding({ id: 'f4', severity: 'warning' }),
  ]);
  assert.deepEqual(counts, { total: 4, info: 1, warning: 2, critical: 1 });
});

const MAP: ResearchMapResponse = {
  project: { id: 'proj-1', name: 'Noltri Research Demo', status: 'active' },
  charter: {
    workingTitle: '冷链物流服务质量研究',
    coreContribution: '提出面向冷链的服务质量结构模型',
    researchBoundary: '因素间的结构关系，不含统计因果',
    claimBoundary: 'ISM 关系 ≠ 统计因果',
    currentStage: '方法定稿',
  },
  questions: [
    { id: 'rq-1', questionCode: 'RQ1', questionText: '服务质量因素如何结构化组织？', status: 'open' },
    { id: 'rq-2', questionCode: 'RQ2', questionText: '哪些因素处于较高层级？', status: 'dropped' },
  ],
  evidence: [
    { id: 'ev-1', type: 'expert_judgement', title: '德尔菲专家评分' },
    { id: 'ev-2', type: 'literature', title: '供应链服务质量综述' },
  ],
  claims: [
    { id: 'cl-1', claimCode: 'C-021', claimText: '可靠性因素处于结构模型较高层级。', claimType: 'empirical', status: 'confirmed', supported: true },
    { id: 'cl-2', claimCode: 'C-022', claimText: 'ANP 权重反映目标依赖的相对优先级。', claimType: 'interpretive', status: 'proposed', supported: true },
    { id: 'cl-3', claimCode: 'C-023', claimText: '冷链鲁棒性可外推到其他行业。', claimType: 'contribution', status: 'draft', supported: false },
  ],
  sections: [{ id: 'sec-1', sectionName: 'Results', sectionReference: '4.2' }],
  edges: [
    { id: 'r1', sourceType: 'evidence', sourceId: 'ev-1', relationType: 'supports', targetType: 'claim', targetId: 'cl-1' },
    { id: 'r2', sourceType: 'claim', sourceId: 'cl-1', relationType: 'answers', targetType: 'research_question', targetId: 'rq-1' },
    { id: 'r3', sourceType: 'claim', sourceId: 'cl-1', relationType: 'appears_in', targetType: 'manuscript_section', targetId: 'sec-1' },
    { id: 'r4', sourceType: 'evidence', sourceId: 'ev-2', relationType: 'contextualizes', targetType: 'claim', targetId: 'cl-3' },
  ],
  unsupportedClaimIds: ['cl-3'],
};

test('map: layers are ordered questions → evidence → claims → sections → contribution', () => {
  const model = buildMapViewModel(MAP);
  assert.deepEqual(
    model.layers.map((layer) => layer.key),
    ['questions', 'evidence', 'claims', 'sections', 'contribution'],
  );
  assert.deepEqual(
    model.layers.map((layer) => layer.title),
    ['研究问题', '证据', '主张', '论文章节', '核心贡献'],
  );
  assert.equal(model.layers[0]?.nodes.length, 2);
  assert.equal(model.layers[1]?.nodes.length, 2);
  assert.equal(model.layers[2]?.nodes.length, 3);
  assert.equal(model.layers[3]?.nodes.length, 1);
  assert.equal(model.layers[4]?.nodes.length, 1);
});

test('map: claim nodes carry code, status meta and a warn tone when evidence is missing', () => {
  const model = buildMapViewModel(MAP);
  const claims = model.layers.find((layer) => layer.key === 'claims')?.nodes ?? [];
  const supported = claims.find((node) => node.id === 'cl-1');
  assert.equal(supported?.code, 'C-021');
  assert.equal(supported?.meta, '实证性 · 已确认 · 有证据支持');
  assert.equal(supported?.tone, 'default');

  const missing = claims.find((node) => node.id === 'cl-3');
  assert.equal(missing?.tone, 'warn');
  assert.ok(missing?.meta?.includes('缺证据支持'));
  assert.equal(claims.find((node) => node.id === 'cl-2')?.tone, 'default');

  const droppedQuestion = model.layers[0]?.nodes.find((node) => node.id === 'rq-2');
  assert.equal(droppedQuestion?.tone, 'muted');
  assert.equal(droppedQuestion?.meta, '已放弃');
});

test('map: the contribution layer shows coreContribution with the working title and stage', () => {
  const model = buildMapViewModel(MAP);
  const contribution = model.layers.find((layer) => layer.key === 'contribution')?.nodes[0];
  assert.equal(contribution?.id, 'contribution');
  assert.equal(contribution?.title, '提出面向冷链的服务质量结构模型');
  assert.equal(contribution?.meta, '冷链物流服务质量研究 · 方法定稿');
  assert.equal(contribution?.tone, 'default');
});

test('map: an empty coreContribution falls back to a muted placeholder', () => {
  const model = buildMapViewModel({
    ...MAP,
    charter: { ...MAP.charter, coreContribution: null, currentStage: null },
  });
  const contribution = model.layers.find((layer) => layer.key === 'contribution')?.nodes[0];
  assert.equal(contribution?.title, '（尚未填写 Core Contribution）');
  assert.equal(contribution?.tone, 'muted');
  assert.equal(contribution?.meta, '冷链物流服务质量研究');
});

test('map: edges read as text and split into incoming / outgoing by node', () => {
  const model = buildMapViewModel(MAP);
  assert.deepEqual(
    model.edges.map((edge) => edge.text),
    ['德尔菲专家评分 支持 C-021', 'C-021 回答 RQ1', 'C-021 出现于 Results', '供应链服务质量综述 背景化 C-023'],
  );
  assert.deepEqual(
    incomingEdges(model, 'cl-1').map((edge) => edge.id),
    ['r1'],
  );
  assert.deepEqual(
    outgoingEdges(model, 'cl-1').map((edge) => edge.id),
    ['r2', 'r3'],
  );
  assert.equal(labelOf(researchRelationTypeLabels, 'partially_supports'), '部分支持');
  assert.equal(labelOf(researchRelationTypeLabels, 'unknown_relation' as never), 'unknown_relation');
});
