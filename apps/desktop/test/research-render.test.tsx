/**
 * 研究工作台 (P5-D) 面板渲染测试，全部走 `renderToStaticMarkup`：面板是纯 prop 驱动的，所以静态标记就是
 * 面板会画出来的全部内容 —— 不需要 WebView、不需要 jsdom、不需要 Core 在跑。下面 fixture 一律是**测试
 * 数据**，不是任何真实项目。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CharterVersion,
  Claim,
  DriftFinding,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchContextPackResponse,
  ResearchDecision,
  ResearchMapResponse,
  ResearchProject,
  ResearchQuestion,
  ResearchReviewMark,
  TimelineEvent,
} from '@noltri/schema';
import ResearchOverviewPanel from '../src/workbench/ResearchOverviewPanel';
import CharterPanel from '../src/workbench/CharterPanel';
import QuestionPanel from '../src/workbench/QuestionPanel';
import EvidencePanel from '../src/workbench/EvidencePanel';
import ClaimPanel from '../src/workbench/ClaimPanel';
import TimelinePanel from '../src/workbench/TimelinePanel';
import DriftPanel from '../src/workbench/DriftPanel';
import MapPanel from '../src/workbench/MapPanel';
import ContextPackPanel from '../src/workbench/ContextPackPanel';
import { draftFrom, emptyDraft, impactOptions, relationMode } from '../src/workbench/research-model';

const NOW = '2026-10-01T08:00:00.000Z';
const NOOP = (): void => undefined;

// --- 测试数据 -----------------------------------------------------------------

const PROJECT: ResearchProject = {
  id: 'p-1',
  userId: 'u-1',
  name: '测试项目：平台治理',
  description: null,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};

const CHARTER: ResearchCharter = {
  id: 'ch-1',
  projectId: 'p-1',
  userId: 'u-1',
  workingTitle: '测试项目：平台治理的章程',
  researchTopic: '平台治理',
  researchProblem: null,
  researchGap: null,
  researchQuestionsText: null,
  coreContribution: null,
  theoreticalLens: null,
  researchContext: null,
  unitOfAnalysis: null,
  researchMethod: '案例研究',
  targetArticleType: null,
  targetJournal: null,
  researchBoundary: '全国范围',
  claimBoundary: null,
  currentStage: '数据收集',
  createdAt: NOW,
  updatedAt: NOW,
};

const VERSION_TWO: CharterVersion = {
  id: 'cv-2',
  projectId: 'p-1',
  userId: 'u-1',
  version: 2,
  previousVersion: 1,
  charter: { ...CHARTER, researchBoundary: '试点省份' },
  changedFields: ['researchBoundary'],
  revisionReason: '把研究边界缩到试点省份',
  decisionId: null,
  approvedAt: NOW,
};

const VERSION_ONE: CharterVersion = {
  ...VERSION_TWO,
  id: 'cv-1',
  version: 1,
  previousVersion: null,
  changedFields: [],
  revisionReason: '首个基线',
};

const QUESTION_ONE: ResearchQuestion = {
  id: 'rq-1',
  projectId: 'p-1',
  userId: 'u-1',
  questionCode: 'RQ1',
  questionText: '平台规则如何影响执行者的自由裁量？',
  status: 'open',
  rationale: '现有文献对执行层注意不足。',
  relatedMethod: '半结构化访谈',
  createdAt: NOW,
  updatedAt: NOW,
};

const QUESTION_TWO: ResearchQuestion = { ...QUESTION_ONE, id: 'rq-2', questionCode: 'RQ2', status: 'answered' };

const EVIDENCE_ONE: Evidence = {
  id: 'ev-1',
  projectId: 'p-1',
  userId: 'u-1',
  type: 'interview',
  title: '实验记录 A',
  description: null,
  sourceReference: '访谈记录 2026-01',
  sourceLocation: '第 3 段',
  rawSourceId: 'src-1',
  nodeId: 'n-1',
  locationOrigin: 'captured',
  reliabilityNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const EVIDENCE_TWO: Evidence = {
  ...EVIDENCE_ONE,
  id: 'ev-2',
  title: '文献摘录 B',
  type: 'literature',
  nodeId: null,
  rawSourceId: null,
  locationOrigin: null,
  sourceReference: null,
  sourceLocation: null,
};

const CLAIM_ONE: Claim = {
  id: 'cl-1',
  projectId: 'p-1',
  userId: 'u-1',
  claimCode: 'C1',
  claimText: '规则越细，裁量空间越小。',
  claimType: 'empirical',
  status: 'draft',
  confidence: 0.6,
  boundary: '仅限平台执行层',
  createdAt: NOW,
  updatedAt: NOW,
};

const CLAIM_TWO: Claim = { ...CLAIM_ONE, id: 'cl-2', claimCode: 'C2', claimText: '执行者会创造性地规避规则。', status: 'proposed' };

const SECTION_ONE: ManuscriptSection = {
  id: 'sec-1',
  projectId: 'p-1',
  userId: 'u-1',
  sectionName: '引言',
  sectionReference: '§1',
  sortOrder: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const RELATION_CONTRADICTS: EntityRelation = {
  id: 'rel-1',
  projectId: 'p-1',
  userId: 'u-1',
  sourceType: 'evidence',
  sourceId: 'ev-1',
  relationType: 'contradicts',
  targetType: 'claim',
  targetId: 'cl-1',
  note: null,
  createdAt: NOW,
};

const RELATION_SUPPORTS: EntityRelation = {
  ...RELATION_CONTRADICTS,
  id: 'rel-2',
  relationType: 'supports',
  targetId: 'cl-2',
};

const RELATION_APPEARS_IN: EntityRelation = {
  ...RELATION_CONTRADICTS,
  id: 'rel-3',
  sourceType: 'claim',
  sourceId: 'cl-2',
  relationType: 'appears_in',
  targetType: 'manuscript_section',
  targetId: 'sec-1',
};

const MARK_ARCHIVED: ResearchReviewMark = {
  id: 'rm-1',
  projectId: 'p-1',
  userId: 'u-1',
  entityType: 'evidence',
  entityId: 'ev-1',
  reason: '这条证据的收录原文已被归档，请确认它是否仍然成立。',
  raisedBy: 'source_archived',
  charterVersion: null,
  status: 'pending',
  createdAt: NOW,
  updatedAt: NOW,
};

const MARK_BASELINE: ResearchReviewMark = {
  ...MARK_ARCHIVED,
  id: 'rm-2',
  entityType: 'claim',
  entityId: 'cl-1',
  raisedBy: 'charter_baseline',
  charterVersion: 2,
  reason: '章程基线 v2 点名了这个论点。',
};

const MARK_CLEARED: ResearchReviewMark = { ...MARK_ARCHIVED, id: 'rm-3', status: 'cleared' };

const DECISION: ResearchDecision = {
  id: 'dec-1',
  projectId: 'p-1',
  userId: 'u-1',
  title: '放弃问卷路线',
  decision: '改用半结构化访谈',
  reason: '执行层的裁量过程难以被量表捕捉。',
  alternatives: '问卷 + 补充访谈',
  rejectedAlternatives: null,
  impact: '数据收集推迟两周',
  relatedEntities: {},
  createdAt: NOW,
};

const CHANGE: ResearchChange = {
  id: 'chg-1',
  projectId: 'p-1',
  userId: 'u-1',
  changeType: 'method',
  before: '问卷',
  after: '半结构化访谈',
  reason: '抽样框不成立。',
  impact: null,
  relatedEntities: {},
  createdAt: NOW,
};

const EVENT: TimelineEvent = {
  id: 'evt-1',
  projectId: 'p-1',
  userId: 'u-1',
  eventType: 'milestone',
  occurredAt: '2026-04-02T09:30:00.000Z',
  title: '完成开题',
  summary: null,
  sourceType: 'manual',
  sourceId: null,
  relatedEntities: {},
  createdAt: NOW,
};

const IMPACTS = impactOptions([CLAIM_ONE, CLAIM_TWO], [EVIDENCE_ONE, EVIDENCE_TWO], [QUESTION_ONE], [SECTION_ONE]);

describe('研究总览面板', () => {
  it('draws the open project, its counts and the pending 复核标记', () => {
    const html = renderToStaticMarkup(
      <ResearchOverviewPanel
        projects={[PROJECT]}
        activeProject={PROJECT}
        counts={{ questions: 2, evidence: 2, claims: 2, sections: 1, relations: 3 }}
        marks={[MARK_ARCHIVED, MARK_BASELINE, MARK_CLEARED]}
        newProjectName=""
        newProjectDescription=""
        busy={false}
        error={null}
        feedback={null}
        onPickProject={NOOP}
        onNewProjectName={NOOP}
        onNewProjectDescription={NOOP}
        onCreateProject={NOOP}
        onClearMark={NOOP}
      />,
    );
    expect(html).toContain('测试项目：平台治理 · 进行中');
    expect(html).toContain('研究问题');
    expect(html).toContain('证据 · 出处已归档');
    expect(html).toContain('论点 · 章程新基线 v2');
    expect(html).toContain('这条证据的收录原文已被归档，请确认它是否仍然成立。');
    expect(html.match(/标记已复核/g)?.length).toBe(2);
  });

  it('a cleared mark stays out of the list, and the create form speaks once', () => {
    const html = renderToStaticMarkup(
      <ResearchOverviewPanel
        projects={[PROJECT]}
        activeProject={PROJECT}
        counts={{ questions: 0, evidence: 0, claims: 0, sections: 0, relations: 0 }}
        marks={[MARK_CLEARED]}
        newProjectName="新项目"
        newProjectDescription=""
        busy={false}
        error={null}
        feedback="已新建项目：测试项目：平台治理"
        onPickProject={NOOP}
        onNewProjectName={NOOP}
        onNewProjectDescription={NOOP}
        onCreateProject={NOOP}
        onClearMark={NOOP}
      />,
    );
    expect(html).toContain('没有待复核的对象。');
    expect(html).not.toContain('出处已归档');
    expect(html).toContain('已新建项目：测试项目：平台治理');
    expect(html).not.toContain('disabled="">新建项目');
  });

  it('withholds 新建项目 until a name is typed', () => {
    const html = renderToStaticMarkup(
      <ResearchOverviewPanel
        projects={[]}
        activeProject={null}
        counts={{ questions: 0, evidence: 0, claims: 0, sections: 0, relations: 0 }}
        marks={[]}
        newProjectName=""
        newProjectDescription=""
        busy={false}
        error="Core 连不上"
        feedback={null}
        onPickProject={NOOP}
        onNewProjectName={NOOP}
        onNewProjectDescription={NOOP}
        onCreateProject={NOOP}
        onClearMark={NOOP}
      />,
    );
    expect(html).toContain('disabled="">新建项目');
    expect(html).toContain('还没有打开任何研究项目');
    expect(html).toContain('Core 连不上');
  });
});

describe('章程与边界面板', () => {
  it('draws all 15 fields from the draft and the baseline line', () => {
    const html = renderToStaticMarkup(
      <CharterPanel
        draft={draftFrom(CHARTER)}
        baseline={VERSION_TWO}
        versions={[VERSION_ONE, VERSION_TWO]}
        impactOptions={IMPACTS}
        impactSelected={{}}
        revisionReason=""
        busy={false}
        error={null}
        feedback={null}
        onField={NOOP}
        onRevisionReason={NOOP}
        onToggleImpact={NOOP}
        onSave={NOOP}
        onApprove={NOOP}
      />,
    );
    for (const label of [
      '工作标题',
      '研究主题',
      '研究问题',
      '研究缺口',
      '研究问题陈述',
      '核心贡献',
      '理论视角',
      '研究情境',
      '分析单位',
      '研究方法',
      '目标文章类型',
      '目标期刊',
      '研究边界',
      '论点边界',
      '当前阶段',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('当前基线：v2 · 2026-10-01 08:00 · 把研究边界缩到试点省份');
    expect(html).toContain('案例研究');
    expect(html).toContain('变化字段：研究边界');
    expect(html).toContain('首个基线');
    expect(html).toContain('字段无变化（首个基线的 changedFields 是空表，不是「全部字段都改了」）。');
    expect(html).not.toContain('disabled="">保存草稿');
  });

  it('refuses to save without a 工作标题 and to approve without a reason', () => {
    const html = renderToStaticMarkup(
      <CharterPanel
        draft={emptyDraft()}
        baseline={null}
        versions={[]}
        impactOptions={[]}
        impactSelected={{}}
        revisionReason="  "
        busy={false}
        error={null}
        feedback={null}
        onField={NOOP}
        onRevisionReason={NOOP}
        onToggleImpact={NOOP}
        onSave={NOOP}
        onApprove={NOOP}
      />,
    );
    expect(html).toContain('disabled="">保存草稿');
    expect(html).toContain('工作标题不能为空，否则保存无从进行。');
    expect(html).toContain('disabled="">批准并冻结基线');
    expect(html).toContain('尚未批准任何基线，偏移检查没有可对照的版本。');
    expect(html).toContain('还没有任何批准过的基线。');
    expect(html).toContain('这个项目还没有论点、证据、问题或章节可点名。');
  });

  it('says exactly what 批准 will send', () => {
    const html = renderToStaticMarkup(
      <CharterPanel
        draft={draftFrom(CHARTER)}
        baseline={VERSION_TWO}
        versions={[]}
        impactOptions={IMPACTS}
        impactSelected={{ 'claim:cl-1': true, 'manuscript_section:sec-1': false }}
        revisionReason=" 把边界缩到试点省份 "
        busy={false}
        error={null}
        feedback={null}
        onField={NOOP}
        onRevisionReason={NOOP}
        onToggleImpact={NOOP}
        onSave={NOOP}
        onApprove={NOOP}
      />,
    );
    expect(html).toContain('C1 规则越细，裁量空间越小。');
    expect(html).toContain('实验记录 A');
    expect(html).toContain('将点名 1 个对象；理由：把边界缩到试点省份');
    expect(html).not.toContain('disabled="">批准并冻结基线');
  });
});

describe('研究问题面板', () => {
  it('counts the open questions and draws stamps and statuses', () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={[QUESTION_TWO, QUESTION_ONE]} />);
    expect(html).toContain('共 2 条，其中 1 条仍是 open');
    expect(html).toContain('RQ1');
    expect(html).toContain('待回答');
    expect(html).toContain('已回答');
    expect(html).toContain('理由：现有文献对执行层注意不足。');
    expect(html).toContain('相关方法：半结构化访谈');
  });

  it('speaks honestly when there are none', () => {
    expect(renderToStaticMarkup(<QuestionPanel questions={[]} />)).toContain('这个项目还没有研究问题。');
  });
});

describe('证据工作台面板', () => {
  it('labels provenance as pointers, never as a manual locator someone typed', () => {
    const html = renderToStaticMarkup(
      <EvidencePanel
        evidence={[EVIDENCE_ONE, EVIDENCE_TWO]}
        marks={[MARK_ARCHIVED]}
        query={{ nodeId: '', rawSourceId: '' }}
        referenceResult={null}
        checking={false}
        error={null}
        onQuery={NOOP}
        onCheck={NOOP}
      />,
    );
    expect(html).toContain('出处：访谈记录 2026-01 · 第 3 段 ｜ 采集定位 · 知识节点 n-1 / 收录原文 src-1');
    expect(html).toContain('没有记录出处。');
    expect(html).toContain('待复核');
    expect(html).toContain('复核原因：这条证据的收录原文已被归档，请确认它是否仍然成立。');
    expect(html).toContain('disabled="">检查引用');
  });

  it('turns the R03 check into 「会动到什么」, grouped by project', () => {
    const html = renderToStaticMarkup(
      <EvidencePanel
        evidence={[]}
        marks={[]}
        query={{ nodeId: 'n-1', rawSourceId: '' }}
        referenceResult={[
          {
            projectId: 'p-1',
            projectName: '测试项目：平台治理',
            evidenceId: 'ev-1',
            evidenceTitle: '实验记录 A',
            evidenceType: 'interview',
            claimIds: ['cl-1', 'cl-2'],
          },
        ]}
        checking={false}
        error={null}
        onQuery={NOOP}
        onCheck={NOOP}
      />,
    );
    expect(html).toContain('被 1 个研究项目引用：1 条证据、2 个论点会被标记待复核。');
    expect(html).toContain('测试项目：平台治理');
    expect(html).toContain('证据：实验记录 A');
    expect(html).not.toContain('disabled="">检查引用');
  });

  it('says 可以安全归档 only for an empty answer', () => {
    const html = renderToStaticMarkup(
      <EvidencePanel
        evidence={[]}
        marks={[]}
        query={{ nodeId: '', rawSourceId: 'src-1' }}
        referenceResult={[]}
        checking={false}
        error={null}
        onQuery={NOOP}
        onCheck={NOOP}
      />,
    );
    expect(html).toContain('没有任何研究项目引用这个出处，可以安全归档。');
    expect(html).toContain('这个项目还没有证据。');
  });
});

describe('论点与章节面板', () => {
  function claimPanel(overrides: Partial<Parameters<typeof ClaimPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <ClaimPanel
        claims={[CLAIM_ONE, CLAIM_TWO]}
        evidence={[EVIDENCE_ONE, EVIDENCE_TWO]}
        questions={[QUESTION_ONE]}
        sections={[SECTION_ONE]}
        relations={[RELATION_CONTRADICTS, RELATION_SUPPORTS, RELATION_APPEARS_IN]}
        draft={{ modeKey: 'evidence_claim', relationType: 'supports', sourceId: '', targetId: '' }}
        busy={false}
        error={null}
        feedback={null}
        onMode={NOOP}
        onType={NOOP}
        onSource={NOOP}
        onTarget={NOOP}
        onCreateRelation={NOOP}
        onDeleteRelation={NOOP}
        {...overrides}
      />,
    );
  }

  it('says 反证 is not 支撑 and shows every edge pointing at a 论点', () => {
    const html = claimPanel();
    expect(html).toContain('C1 · 实证 · 草稿');
    expect(html).toContain('未被支撑');
    expect(html).toContain('有支撑');
    expect(html).toContain('证据关系：反证「实验记录 A」');
    expect(html).toContain('证据关系：支持「实验记录 A」');
    expect(html).toContain('论点：C2 执行者会创造性地规避规则。');
    expect(html).toContain('边界：仅限平台执行层');
  });

  it('offers exactly the shapes R02 admits, and the five 证据→论点 kinds', () => {
    const html = claimPanel();
    for (const label of ['证据 → 论点', '论点 → 研究问题', '论点 → 章节']) expect(html).toContain(`>${label}</option>`);
    for (const label of ['支持', '部分支持', '反证', '限定', '背景']) expect(html).toContain(`>${label}</option>`);
    expect(html).toContain('来源（证据）…');
    expect(html).toContain('目标（论点）…');
    expect(html).toContain('来源和目标都要选，才构成一条可写入的关系。');
    expect(html).toContain('disabled="">写入关系');
  });

  it('enables 写入关系 only when both ends are picked', () => {
    const html = claimPanel({
      draft: { modeKey: 'evidence_claim', relationType: 'partially_supports', sourceId: 'ev-1', targetId: 'cl-1' },
    });
    expect(html).not.toContain('disabled="">写入关系');
    expect(html).not.toContain('来源和目标都要选，才构成一条可写入的关系。');
  });

  it('names both ends of an existing relation with their own vocabulary', () => {
    const html = claimPanel();
    expect(html).toContain('证据「实验记录 A」→ 论点「C2」');
    expect(html).toContain('论点「C2」→ 章节「引言」');
  });
});

describe('决策与时间线面板', () => {
  it('shapes the server-ordered feed and keeps Decisions append-only', () => {
    const html = renderToStaticMarkup(<TimelinePanel decisions={[DECISION]} changes={[CHANGE]} events={[EVENT]} />);
    expect(html).toContain('里程碑');
    expect(html).toContain('完成开题');
    expect(html).toContain('2026-04-02 09:30');
    expect(html).toContain('放弃问卷路线');
    expect(html).toContain('改用半结构化访谈');
    expect(html).toContain('理由：执行层的裁量过程难以被量表捕捉。');
    expect(html).toContain('备选：问卷 + 补充访谈');
    expect(html).toContain('方法');
    expect(html).toContain('问卷 → 半结构化访谈');
    expect(html).not.toContain('编辑');
  });

  it('speaks honestly when the project has no history yet', () => {
    const html = renderToStaticMarkup(<TimelinePanel decisions={[]} changes={[]} events={[]} />);
    expect(html).toContain('这个项目还没有时间线事件。');
    expect(html).toContain('这个项目还没有记录决策。');
    expect(html).toContain('这个项目还没有记录变更。');
  });
});

describe('关系表格的三种形状都是可构造的', () => {
  it('every mode keeps its own direction and kind list', () => {
    expect(relationMode('evidence_claim').types).toHaveLength(5);
    expect(relationMode('claim_question').types).toEqual(['answers']);
    expect(relationMode('claim_section').types).toEqual(['appears_in']);
  });
});

// --- P6: 偏移检查 / 研究地图 / 上下文包 -----------------------------------------

const FINDING_CRITICAL: DriftFinding = {
  id: 'df-1',
  projectId: 'p-1',
  userId: 'u-1',
  driftType: 'causality_drift',
  severity: 'critical',
  description: '论点 C1 用了强因果词「决定」但缺少统计证据，「边界」还是空的',
  sourceEntityType: 'claim',
  sourceEntityId: 'cl-1',
  targetEntityType: null,
  targetEntityId: null,
  reason: null,
  recommendedAction: '弱化因果表述，或在边界里写清适用条件',
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
};

const FINDING_ACKNOWLEDGED: DriftFinding = {
  ...FINDING_CRITICAL,
  id: 'df-2',
  driftType: 'evidence_drift',
  severity: 'warning',
  description: '论点 C2 没有任何支持证据',
  recommendedAction: null,
  status: 'acknowledged',
};

const FINDING_RESOLVED: DriftFinding = {
  ...FINDING_ACKNOWLEDGED,
  id: 'df-3',
  status: 'resolved',
};

const MAP: ResearchMapResponse = {
  project: { id: 'p-1', name: '测试项目：平台治理', status: 'active' },
  charter: {
    workingTitle: '平台治理',
    coreContribution: null,
    researchBoundary: '全国范围',
    claimBoundary: null,
    currentStage: '数据收集',
  },
  questions: [{ id: 'rq-1', questionCode: 'RQ1', questionText: '平台规则如何影响执行者的自由裁量？', status: 'open' }],
  evidence: [
    { id: 'ev-1', type: 'interview', title: '实验记录 A' },
    { id: 'ev-2', type: 'literature', title: '文献摘录 B' },
  ],
  claims: [
    { id: 'cl-1', claimCode: 'C1', claimText: '规则越细，裁量空间越小。', claimType: 'empirical', status: 'draft', supported: true },
    { id: 'cl-2', claimCode: 'C2', claimText: '执行者会创造性地规避规则。', claimType: 'empirical', status: 'proposed', supported: false },
  ],
  sections: [{ id: 'sec-1', sectionName: '引言', sectionReference: '§1' }],
  edges: [
    { id: 'e-1', sourceType: 'evidence', sourceId: 'ev-1', relationType: 'contradicts', targetType: 'claim', targetId: 'cl-1' },
    { id: 'e-2', sourceType: 'evidence', sourceId: 'ev-2', relationType: 'supports', targetType: 'claim', targetId: 'cl-1' },
    { id: 'e-3', sourceType: 'claim', sourceId: 'cl-1', relationType: 'answers', targetType: 'research_question', targetId: 'rq-1' },
    { id: 'e-4', sourceType: 'claim', sourceId: 'cl-2', relationType: 'appears_in', targetType: 'manuscript_section', targetId: 'sec-1' },
  ],
  unsupportedClaimIds: ['cl-2'],
};

const PACK: ResearchContextPackResponse = {
  markdown: '## PROJECT\n测试项目：平台治理（数据收集）\n\n## Core Contribution\n（未填写）',
  blocks: [
    { heading: 'PROJECT', body: '测试项目：平台治理（数据收集）' },
    { heading: 'Core Contribution', body: '（未填写）' },
    { heading: 'Current Drift Warnings', body: '- [warning] 论点 C2 没有任何支持证据' },
  ],
  generatedAt: NOW,
};

describe('偏移检查面板 (P6)', () => {
  function driftPanel(overrides: Partial<Parameters<typeof DriftPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <DriftPanel
        findings={[FINDING_RESOLVED, FINDING_ACKNOWLEDGED, FINDING_CRITICAL]}
        summary={{ total: 3, info: 0, warning: 1, critical: 1 }}
        manuscriptText=""
        busy={false}
        error={null}
        feedback={null}
        onManuscriptText={NOOP}
        onRun={NOOP}
        onPatch={NOOP}
        {...overrides}
      />,
    );
  }

  it('opens on 严重, keeps the run summary and offers moves only on live findings', () => {
    const html = driftPanel();
    expect(html).toContain('共 3 条 · 严重 1 · 警告 1 · 提示 0');
    expect(html).toContain('偏移发现（待处理 1 条）');
    expect(html).toContain('badge badge-danger">严重');
    expect(html).toContain('badge badge-warn">警告');
    expect(html).toContain('因果偏移');
    expect(html).toContain('证据偏移');
    expect(html).toContain('待处理');
    expect(html).toContain('已确认');
    expect(html).toContain('已解决');
    expect(html).toContain('建议：弱化因果表述，或在边界里写清适用条件');
    // 待处理 gets both moves, 已确认 only 解决, 已解决 none — the status is the record, not the buttons.
    expect(html.match(/>确认</g)?.length).toBe(1);
    expect(html.match(/>解决</g)?.length).toBe(2);
    expect(html).toContain('不调用模型');
    expect(html).toContain('粘贴摘要或讨论段落');
  });

  it('withholds 运行 while a run is in flight and speaks before the first one', () => {
    const running = driftPanel({ busy: true, summary: null, findings: [] });
    expect(running).toContain('disabled="">运行偏移检查');
    expect(running).toContain('还没有偏移发现。运行一次检查，或继续往下写。');

    const failed = driftPanel({ error: 'Core 连不上', feedback: '偏移检查完成：共 3 条 · 严重 1 · 警告 1 · 提示 0。' });
    expect(failed).toContain('Core 连不上');
    expect(failed).toContain('偏移检查完成');
  });
});

describe('研究地图面板 (P6)', () => {
  it('draws the layers with every edge as a sentence', () => {
    const html = renderToStaticMarkup(<MapPanel map={MAP} error={null} />);
    expect(html).toContain('1 个研究问题 · 2 条证据 · 2 个论点（1 个未被支撑）· 1 个章节 · 4 条关系边');
    expect(html).toContain('未被支撑的论点：C2 执行者会创造性地规避规则。 —— 地图上它们是悬空的。');
    expect(html).toContain('badge badge-accent">有支撑');
    expect(html).toContain('badge badge-warn">未被支撑');
    expect(html).toContain('反证「实验记录 A」');
    expect(html).toContain('支持「文献摘录 B」');
    expect(html).toContain('回答「C1 规则越细，裁量空间越小。」');
    expect(html).toContain('出现于「C2 执行者会创造性地规避规则。」');
    expect(html).toContain('访谈');
    expect(html).toContain('文献');
  });

  it('is honest while it loads and when a project has no map content', () => {
    expect(renderToStaticMarkup(<MapPanel map={null} error={null} />)).toContain('正在载入研究地图…');

    const empty: ResearchMapResponse = {
      ...MAP,
      questions: [],
      evidence: [],
      claims: [],
      sections: [],
      edges: [],
      unsupportedClaimIds: [],
    };
    const html = renderToStaticMarkup(<MapPanel map={empty} error="Core 连不上" />);
    expect(html).toContain('还没有研究问题。');
    expect(html).toContain('还没有证据。');
    expect(html).toContain('还没有论点。');
    expect(html).toContain('还没有章节。');
    expect(html).toContain('Core 连不上');
    expect(html).not.toContain('未被支撑的论点：');
  });
});

describe('上下文包面板 (P6)', () => {
  it('draws the blocks in order and keeps the markdown one fold away', () => {
    const html = renderToStaticMarkup(<ContextPackPanel pack={PACK} error={null} />);
    expect(html).toContain('3 个区块 · 生成于 2026-10-01 08:00');
    expect(html).toContain('PROJECT');
    expect(html).toContain('测试项目：平台治理（数据收集）');
    expect(html).toContain('Core Contribution');
    expect(html).toContain('（未填写）');
    expect(html).toContain('Current Drift Warnings');
    expect(html).toContain('- [warning] 论点 C2 没有任何支持证据');
    expect(html).toContain('Markdown 原文（与上面的区块同内容）');
    expect(html.indexOf('PROJECT')).toBeLessThan(html.indexOf('Core Contribution'));
  });

  it('is honest while it loads', () => {
    expect(renderToStaticMarkup(<ContextPackPanel pack={null} error={null} />)).toContain('正在载入上下文包…');
  });
});
