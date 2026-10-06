/**
 * 研究工作台 rules, tested as pure functions (P5-D). These decide what a reviewer reads before archiving a
 * 出处, what a 章程 save sends, and which 论点 are 未被支撑 — so they must hold without a WebView or a Core.
 * Fixtures are 测试造数: a 测试项目, not a real study.
 */
import { describe, expect, it } from 'vitest';
import type {
  Claim,
  DriftFinding,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchCharter,
  ResearchContextPackResponse,
  ResearchMapResponse,
  ResearchQuestion,
  ResearchReferenceMatch,
  ResearchReviewMark,
  TimelineEvent,
} from '@noltri/schema';
import {
  CHARTER_FIELD_LABELS,
  CHARTER_FIELD_ORDER,
  RELATION_MODES,
  approvalEntities,
  approvalIsSendable,
  approvalPayload,
  baselineLine,
  changedFieldLabels,
  claimEvidenceLinks,
  claimIsSupported,
  draftFrom,
  draftPayload,
  emptyDraft,
  evidenceProvenanceLines,
  findingIsActionable,
  groupReferences,
  impactKey,
  impactOptions,
  mapIncomingLinks,
  mapSummaryLine,
  markLine,
  packMetaLine,
  pendingMarks,
  referenceSummary,
  relationIsSendable,
  relationPayload,
  sectionClaims,
  severityBadgeClass,
  severityLine,
  sortFindings,
  stamp,
  timelineRows,
  unsupportedClaims,
} from '../src/workbench/research-model';

const ISO = '2026-10-06T08:00:00.000Z';

function charterOf(overrides: Partial<ResearchCharter> = {}): ResearchCharter {
  return {
    id: 'chtr-1',
    projectId: 'rp-1',
    userId: 'user-1',
    workingTitle: '碳定价与工业排放',
    researchTopic: null,
    researchProblem: null,
    researchGap: null,
    researchQuestionsText: null,
    coreContribution: null,
    theoreticalLens: null,
    researchContext: null,
    unitOfAnalysis: null,
    researchMethod: null,
    targetArticleType: null,
    targetJournal: null,
    researchBoundary: null,
    claimBoundary: null,
    currentStage: '开题',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function claimOf(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    projectId: 'rp-1',
    userId: 'user-1',
    claimCode: `C-${id}`,
    claimText: `论点 ${id}`,
    claimType: 'empirical',
    status: 'draft',
    confidence: 0.5,
    boundary: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function evidenceOf(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    projectId: 'rp-1',
    userId: 'user-1',
    type: 'dataset',
    title: `证据 ${id}`,
    description: null,
    sourceReference: null,
    sourceLocation: null,
    rawSourceId: null,
    nodeId: null,
    locationOrigin: null,
    reliabilityNote: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function relationOf(id: string, overrides: Partial<EntityRelation> = {}): EntityRelation {
  return {
    id,
    projectId: 'rp-1',
    userId: 'user-1',
    sourceType: 'evidence',
    sourceId: 'ev-1',
    relationType: 'supports',
    targetType: 'claim',
    targetId: 'cl-1',
    note: null,
    createdAt: ISO,
    ...overrides,
  };
}

describe('章程 drafts', () => {
  it('fills every declared field from the stored row and leaves the rest blank', () => {
    const draft = draftFrom(charterOf({ currentStage: '写作' }));
    expect(draft.currentStage).toBe('写作');
    expect(draft.claimBoundary).toBe('');
    expect(Object.keys(CHARTER_FIELD_LABELS).sort()).toEqual(Object.keys(draft).sort());
  });

  it('turns a cleared field back into null and keeps only 工作标题 as a hard requirement', () => {
    const payload = draftPayload({ ...emptyDraft(), workingTitle: '  碳定价与工业排放  ' });
    expect(payload?.workingTitle).toBe('碳定价与工业排放');
    expect(payload?.claimBoundary).toBeNull();
    expect(Object.keys(payload ?? {}).sort()).toEqual(Object.keys(CHARTER_FIELD_LABELS).sort());
  });

  it('refuses a save with no 工作标题 instead of sending an empty title', () => {
    expect(draftPayload(emptyDraft())).toBeNull();
    expect(draftPayload({ ...emptyDraft(), workingTitle: '   ' })).toBeNull();
  });

  it('never carries identity fields into a save body', () => {
    const payload = draftPayload(draftFrom(charterOf())) ?? {};
    expect(Object.keys(payload)).not.toContain('id');
    expect(Object.keys(payload)).not.toContain('userId');
    expect(Object.keys(payload)).not.toContain('projectId');
  });

  it('renders 工作标题 first and pins the baseline line for a project with no approval yet', () => {
    expect(CHARTER_FIELD_ORDER[0]).toBe('workingTitle');
    expect(CHARTER_FIELD_ORDER).toHaveLength(Object.keys(CHARTER_FIELD_LABELS).length);
    expect(baselineLine(null)).toContain('尚未批准任何基线');
    expect(changedFieldLabels(['researchBoundary', 'claimBoundary'])).toEqual(['研究边界', '论点边界']);
  });
});

describe('批准 a 章程 revision', () => {
  const claims = [claimOf('cl-1')];
  const evidence = [evidenceOf('ev-1')];
  const questions: ResearchQuestion[] = [
    {
      id: 'rq-1',
      projectId: 'rp-1',
      userId: 'user-1',
      questionCode: 'RQ1',
      questionText: '碳价如何影响排放？',
      status: 'open',
      rationale: null,
      relatedMethod: null,
      createdAt: ISO,
      updatedAt: ISO,
    },
  ];
  const sections: ManuscriptSection[] = [
    {
      id: 'sec-1',
      projectId: 'rp-1',
      userId: 'user-1',
      sectionName: '引言',
      sectionReference: null,
      sortOrder: 1,
      createdAt: ISO,
      updatedAt: ISO,
    },
  ];

  it('offers the objects a revision can invalidate, keyed by type and id', () => {
    const options = impactOptions(claims, evidence, questions, sections);
    expect(options.map((option) => option.type)).toEqual(['claim', 'evidence', 'research_question', 'manuscript_section']);
    expect(impactKey(options[0]!)).toBe('claim:cl-1');
  });

  it('sends exactly the objects the approver ticked, and 点名空 means 一条也不加', () => {
    const options = impactOptions(claims, evidence, questions, sections);
    const ticked = { 'evidence:ev-1': true, 'claim:cl-1': true, 'manuscript_section:sec-1': false };
    expect(approvalEntities(ticked, options)).toEqual([
      { entityType: 'claim', entityId: 'cl-1' },
      { entityType: 'evidence', entityId: 'ev-1' },
    ]);
    expect(approvalPayload('收紧边界', approvalEntities({}, options)).affectedEntities).toEqual([]);
  });

  it('insists on a 修订理由 but not on naming objects', () => {
    expect(approvalIsSendable('  ')).toBe(false);
    expect(approvalIsSendable('把研究边界缩到试点省份')).toBe(true);
    expect(approvalPayload('  缩到试点省份 ', []).revisionReason).toBe('缩到试点省份');
  });
});

describe('复核标记', () => {
  function markOf(overrides: Partial<ResearchReviewMark> = {}): ResearchReviewMark {
    return {
      id: 'rm-1',
      projectId: 'rp-1',
      userId: 'user-1',
      entityType: 'evidence',
      entityId: 'ev-1',
      reason: '出处「排放数据摘录」已归档，这条引用需要重新确认',
      raisedBy: 'source_archived',
      charterVersion: null,
      status: 'pending',
      createdAt: ISO,
      updatedAt: ISO,
      ...overrides,
    };
  }

  it('shows only what still needs handling', () => {
    const marks = [markOf(), markOf({ id: 'rm-2', status: 'cleared' })];
    expect(pendingMarks(marks).map((mark) => mark.id)).toEqual(['rm-1']);
  });

  it('names the entity and the reason it was raised, baseline version included', () => {
    expect(markLine(markOf())).toBe('证据 · 出处已归档');
    expect(markLine(markOf({ raisedBy: 'charter_baseline', charterVersion: 3, entityType: 'claim' }))).toBe('论点 · 章程新基线 v3');
  });
});

describe('出处 read before archiving', () => {
  it('separates the 定位 the user wrote from the pointers the system holds', () => {
    const typed = evidenceOf('ev-1', { sourceReference: '测试年鉴 2024', sourceLocation: '表 3-2', locationOrigin: 'manual' });
    expect(evidenceProvenanceLines(typed)).toEqual(['测试年鉴 2024 · 表 3-2']);

    const captured = evidenceOf('ev-2', { nodeId: 'n-1', rawSourceId: 'src-1', locationOrigin: 'captured' });
    expect(evidenceProvenanceLines(captured)).toEqual(['采集定位 · 知识节点 n-1 / 收录原文 src-1']);
  });

  it('says 出处指针 when a pointer exists but nobody recorded where the 定位 came from', () => {
    expect(evidenceProvenanceLines(evidenceOf('ev-3', { rawSourceId: 'src-9' }))).toEqual(['出处指针 · 收录原文 src-9']);
    expect(evidenceProvenanceLines(evidenceOf('ev-4'))).toEqual([]);
  });

  it('groups the check by project and counts the 论点 that would need review', () => {
    const matches: ResearchReferenceMatch[] = [
      { projectId: 'rp-1', projectName: '测试项目：碳定价与工业排放', evidenceId: 'ev-1', evidenceTitle: '排放数据摘录', evidenceType: 'dataset', claimIds: ['cl-1'] },
      { projectId: 'rp-1', projectName: '测试项目：碳定价与工业排放', evidenceId: 'ev-2', evidenceTitle: '访谈记录', evidenceType: 'interview', claimIds: ['cl-1', 'cl-2'] },
      { projectId: 'rp-2', projectName: '测试项目：另一个', evidenceId: 'ev-3', evidenceTitle: '旧笔记', evidenceType: 'note', claimIds: [] },
    ];
    const grouped = groupReferences(matches);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.evidenceTitles).toEqual(['排放数据摘录', '访谈记录']);
    expect(grouped[0]?.claimCount).toBe(2);
    expect(referenceSummary(matches)).toBe('被 2 个研究项目引用：3 条证据、2 个论点会被标记待复核。');
    expect(referenceSummary([])).toBe('没有任何研究项目引用这个出处，可以安全归档。');
  });
});

describe('论点 support and the relation directions the 工作台 writes', () => {
  const claims = [claimOf('cl-1'), claimOf('cl-2')];

  it('counts 支持 and 部分支持 as supported, and 反证／限定／背景 as not 支持 (R02)', () => {
    const relations = [
      relationOf('rel-1', { targetId: 'cl-1', relationType: 'partially_supports' }),
      relationOf('rel-2', { targetId: 'cl-2', relationType: 'contradicts' }),
      relationOf('rel-3', { targetId: 'cl-2', relationType: 'qualifies' }),
    ];
    expect(claimIsSupported('cl-1', relations)).toBe(true);
    expect(claimIsSupported('cl-2', relations)).toBe(false);
    expect(unsupportedClaims(claims, relations).map((claim) => claim.id)).toEqual(['cl-2']);
  });

  it('lists every 证据 wired to a 论点, 反证 included', () => {
    const relations = [
      relationOf('rel-1', { targetId: 'cl-1', sourceId: 'ev-1', relationType: 'supports' }),
      relationOf('rel-2', { targetId: 'cl-1', sourceId: 'ev-2', relationType: 'contradicts' }),
      relationOf('rel-3', { targetId: 'cl-2', sourceId: 'ev-9', relationType: 'supports' }),
    ];
    const links = claimEvidenceLinks('cl-1', relations, [evidenceOf('ev-1'), evidenceOf('ev-2')]);
    expect(links).toEqual([
      { relationType: 'supports', title: '证据 ev-1' },
      { relationType: 'contradicts', title: '证据 ev-2' },
    ]);
  });

  it('walks 论点 → 章节 with appears_in only', () => {
    const relations = [
      relationOf('rel-1', { sourceType: 'claim', sourceId: 'cl-1', relationType: 'appears_in', targetType: 'manuscript_section', targetId: 'sec-1' }),
      relationOf('rel-2', { sourceType: 'claim', sourceId: 'cl-2', relationType: 'appears_in', targetType: 'manuscript_section', targetId: 'sec-1' }),
      relationOf('rel-3', { sourceType: 'claim', sourceId: 'cl-1', relationType: 'answers', targetType: 'research_question', targetId: 'rq-1' }),
    ];
    expect(sectionClaims('sec-1', relations, claims).map((claim) => claim.id)).toEqual(['cl-1', 'cl-2']);
  });

  it('writes only the three directions the chain has, and trims the ids', () => {
    expect(RELATION_MODES.map((mode) => `${mode.sourceType}→${mode.targetType}`)).toEqual([
      'evidence→claim',
      'claim→research_question',
      'claim→manuscript_section',
    ]);
    const mode = RELATION_MODES[0]!;
    expect(mode.types).toEqual(['supports', 'partially_supports', 'contradicts', 'qualifies', 'contextualizes']);
    expect(relationPayload(mode, ' ev-1 ', 'qualifies', ' cl-1 ')).toEqual({
      sourceType: 'evidence',
      sourceId: 'ev-1',
      relationType: 'qualifies',
      targetType: 'claim',
      targetId: 'cl-1',
    });
    expect(relationIsSendable('ev-1', '  ')).toBe(false);
  });
});

describe('时间线 rows', () => {
  it('stamps the occurrence and names the event type in Chinese', () => {
    const events: TimelineEvent[] = [
      {
        id: 'tl-1',
        projectId: 'rp-1',
        userId: 'user-1',
        eventType: 'milestone',
        occurredAt: '2026-10-06T08:30:00.000Z',
        title: '开题',
        summary: null,
        sourceType: 'manual',
        sourceId: null,
        relatedEntities: {},
        createdAt: ISO,
      },
    ];
    const rows = timelineRows(events);
    expect(rows[0]).toEqual({ id: 'tl-1', when: '2026-10-06 08:30', typeLabel: '里程碑', title: '开题', summary: null });
    expect(stamp('2026-10-06T08:30:00.000Z')).toBe('2026-10-06 08:30');
    expect(stamp('写于 2026 年秋')).toBe('写于 2026 年秋');
  });
});

// --- P6: 偏移检查 / 研究地图 / 上下文包 -----------------------------------------

function findingOf(overrides: Partial<DriftFinding> = {}): DriftFinding {
  return {
    id: 'df-1',
    projectId: 'rp-1',
    userId: 'user-1',
    driftType: 'evidence_drift',
    severity: 'warning',
    description: '论点 C-2 没有任何 supports／partially_supports 关系',
    sourceEntityType: 'claim',
    sourceEntityId: 'cl-2',
    targetEntityType: null,
    targetEntityId: null,
    reason: null,
    recommendedAction: '补充证据或弱化论点表述',
    status: 'open',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function mapOf(overrides: Partial<ResearchMapResponse> = {}): ResearchMapResponse {
  return {
    project: { id: 'rp-1', name: '碳定价与工业排放', status: 'active' },
    charter: {
      workingTitle: '碳定价与工业排放',
      coreContribution: '边境调节的证据',
      researchBoundary: null,
      claimBoundary: null,
      currentStage: '写作',
    },
    questions: [{ id: 'rq-1', questionCode: 'RQ1', questionText: '碳价如何影响排放？', status: 'open' }],
    evidence: [
      { id: 'ev-1', type: 'dataset', title: '排放数据' },
      { id: 'ev-2', type: 'interview', title: '访谈记录' },
    ],
    claims: [
      { id: 'cl-1', claimCode: 'C-1', claimText: '碳价降低了排放。', claimType: 'empirical', status: 'confirmed', supported: true },
      { id: 'cl-2', claimCode: 'C-2', claimText: '企业会转移排放。', claimType: 'empirical', status: 'draft', supported: false },
    ],
    sections: [{ id: 'sec-1', sectionName: '引言', sectionReference: '§1' }],
    edges: [
      { id: 'e-1', sourceType: 'evidence', sourceId: 'ev-1', relationType: 'supports', targetType: 'claim', targetId: 'cl-1' },
      { id: 'e-2', sourceType: 'evidence', sourceId: 'ev-2', relationType: 'contradicts', targetType: 'claim', targetId: 'cl-1' },
      { id: 'e-3', sourceType: 'claim', sourceId: 'cl-1', relationType: 'answers', targetType: 'research_question', targetId: 'rq-1' },
      { id: 'e-4', sourceType: 'claim', sourceId: 'cl-2', relationType: 'appears_in', targetType: 'manuscript_section', targetId: 'sec-1' },
    ],
    unsupportedClaimIds: ['cl-2'],
    ...overrides,
  };
}

describe('偏移发现的排序与徽章', () => {
  it('reports the run in severity order, from the very counts the Core returned', () => {
    expect(severityLine({ total: 3, info: 1, warning: 1, critical: 1 })).toBe('共 3 条 · 严重 1 · 警告 1 · 提示 1');
  });

  it('opens the list on the worst item and breaks ties by recency', () => {
    const rows = sortFindings([
      findingOf({ id: 'df-info', severity: 'info' }),
      findingOf({ id: 'df-critical', severity: 'critical', createdAt: '2026-01-01T00:00:00.000Z' }),
      findingOf({ id: 'df-warning', severity: 'warning', createdAt: '2026-02-01T00:00:00.000Z' }),
      findingOf({ id: 'df-warning-new', severity: 'warning', createdAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    expect(rows.map((finding) => finding.id)).toEqual(['df-critical', 'df-warning-new', 'df-warning', 'df-info']);
  });

  it('paints 严重 红色 and gives buttons only to the two live statuses', () => {
    expect(severityBadgeClass('critical')).toBe('badge badge-danger');
    expect(severityBadgeClass('warning')).toBe('badge badge-warn');
    expect(severityBadgeClass('info')).toBe('badge badge-quiet');
    expect(findingIsActionable(findingOf({ status: 'open' }))).toBe(true);
    expect(findingIsActionable(findingOf({ status: 'acknowledged' }))).toBe(true);
    expect(findingIsActionable(findingOf({ status: 'resolved' }))).toBe(false);
    expect(findingIsActionable(findingOf({ status: 'dismissed' }))).toBe(false);
  });
});

describe('研究地图的层与边', () => {
  it('summarizes the layers with the dangling count inside', () => {
    expect(mapSummaryLine(mapOf())).toBe('1 个研究问题 · 2 条证据 · 2 个论点（1 个未被支撑）· 1 个章节 · 4 条关系边');
  });

  it('names every edge into a 论点 in the map vocabulary — 反证 included', () => {
    expect(mapIncomingLinks('claim', 'cl-1', mapOf())).toEqual(['支持「排放数据」', '反证「访谈记录」']);
    expect(mapIncomingLinks('claim', 'cl-2', mapOf())).toEqual([]);
  });

  it('walks the other two directions, falling back to the raw id when a name is missing', () => {
    expect(mapIncomingLinks('research_question', 'rq-1', mapOf())).toEqual(['回答「C-1 碳价降低了排放。」']);
    expect(mapIncomingLinks('manuscript_section', 'sec-1', mapOf())).toEqual(['出现于「C-2 企业会转移排放。」']);

    const danglingEdge = mapOf({
      edges: [
        { id: 'e-9', sourceType: 'evidence', sourceId: 'ev-9', relationType: 'supports', targetType: 'claim', targetId: 'cl-1' },
      ],
    });
    expect(mapIncomingLinks('claim', 'cl-1', danglingEdge)).toEqual(['支持「ev-9」']);
  });
});

describe('上下文包 meta', () => {
  it('counts the blocks and stamps the generation time', () => {
    const pack: ResearchContextPackResponse = {
      markdown: '## PROJECT\n碳定价与工业排放',
      blocks: [
        { heading: 'PROJECT', body: '碳定价与工业排放' },
        { heading: 'Core Contribution', body: '（未填写）' },
      ],
      generatedAt: '2026-10-06T08:30:00.000Z',
    };
    expect(packMetaLine(pack)).toBe('2 个区块 · 生成于 2026-10-06 08:30');
  });
});
