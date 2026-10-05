/**
 * 「Noltri Research Demo」测试项目种子（开发文档 §19 综合验收里那个「标明为测试项目」的样例）。
 *
 * 一个专门用于自动化和手工测试的科研项目：RQ×2、Evidence×5、Claim×5、Section×4、Decision×2、Change×2。
 * 内容语义取自开发文档 §10–§23 的冷链物流 ISM/ANP 例子；刻意不使用任何真实论文数据。
 *
 * 种子刻意留下的结构缺口就是 P6 六类检查的输入：C-03 无任何支持证据（evidence drift）、C-05 用「决定」这种
 * 因果强表述且没有 boundary（causality drift）、`changeType: 'journal'` 晚于章程落笔（journal drift）。
 * 断言它们属于 P6；本轮只保证这些对象能建、能读、能改。
 *
 * `buildResearchDemoData()` 是纯数据工厂；`seedResearchDemo()` 只经 `ResearchDomain` 门面写入，
 * 因此同一份种子可用于 memory（测试）与 sqlite（真实落盘）两种驱动。
 */
import type {
  CharterRequest,
  Claim,
  CreateClaimRequest,
  CreateEntityRelationRequest,
  CreateEvidenceRequest,
  CreateResearchChangeRequest,
  CreateResearchDecisionRequest,
  CreateResearchProjectRequest,
  CreateResearchQuestionRequest,
  CreateSectionRequest,
  CreateTimelineEventRequest,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
  TimelineEvent,
} from '@noltri/schema';
import type { ResearchDomain } from './index';

export interface ResearchDemoData {
  project: CreateResearchProjectRequest;
  charter: CharterRequest;
  questions: CreateResearchQuestionRequest[];
  evidence: CreateEvidenceRequest[];
  claims: CreateClaimRequest[];
  sections: CreateSectionRequest[];
  relations: CreateEntityRelationRequest[];
  decisions: CreateResearchDecisionRequest[];
  changes: CreateResearchChangeRequest[];
  milestone: CreateTimelineEventRequest;
}

export interface ResearchDemoSeed {
  project: ResearchProject;
  charter: ResearchCharter;
  questions: ResearchQuestion[];
  evidence: Evidence[];
  claims: Claim[];
  sections: ManuscriptSection[];
  relations: EntityRelation[];
  decisions: ResearchDecision[];
  changes: ResearchChange[];
  events: TimelineEvent[];
}

export function buildResearchDemoData(): ResearchDemoData {
  return {
    project: {
      name: 'Noltri Research Demo',
      description: 'Research V1 演示项目：冷链物流服务质量因素的结构与决策优先级（虚构测试数据）。',
    },
    charter: {
      workingTitle: '冷链物流服务质量因素的结构组织与目标依赖决策优先级研究',
      researchTopic: '冷链物流服务质量因素之间的结构关系与决策优先级',
      researchProblem: '冷链服务质量因素众多，但因素之间的结构组织与决策优先级缺乏可追溯的整合刻画。',
      researchGap: '既有研究多给出因素清单，缺少结构层级与目标依赖优先级的联合分析。',
      researchQuestionsText: 'RQ1 冷链物流系统中服务质量因素如何结构化组织？RQ2 在既定决策目标下这些因素的决策优先级如何？',
      coreContribution: '构建冷链物流服务质量因素的 ISM 结构模型，并给出目标依赖的 ANP 决策优先级。',
      theoreticalLens: '服务质量理论 + 系统结构建模（ISM / ANP）',
      researchContext: '冷链物流服务质量评估',
      unitOfAnalysis: '服务质量因素',
      researchMethod: 'ISM + ANP（基于专家判断的结构建模与网络层次分析）',
      targetArticleType: '实证研究论文',
      targetJournal: 'Journal of Cold Chain Logistics（示例期刊）',
      researchBoundary:
        '研究对象：冷链物流服务质量因素之间的结构关系。研究范围：因素之间的专家判断依赖关系。不包含：统计意义上的因果推断。',
      claimBoundary:
        'ISM relationship ≠ statistical causality；ANP priority ≠ economic value；' +
        'Expert judgement ≠ objective population parameter；Robustness ≠ external validity。',
      currentStage: '分析与写作',
    },
    questions: [
      {
        questionCode: 'RQ1',
        questionText: 'How are service-quality factors structurally organized within the cold-chain logistics system?',
        rationale: '因素结构是后续优先级分析与论文论证的基础。',
        relatedMethod: 'ISM',
      },
      {
        questionCode: 'RQ2',
        questionText: 'What goal-dependent decision priorities do these factors have within the ANP model?',
        rationale: '决策优先级回答实践排序问题，但仅在指定决策目标下成立。',
        relatedMethod: 'ANP',
      },
    ],
    evidence: [
      {
        type: 'literature',
        title: '服务质量可靠性因素文献综述',
        description: '可靠性（reliability）相关因素在服务质量文献中被反复识别为核心维度。',
        sourceReference: '示例文献集（虚构）',
        sourceLocation: '综述笔记 §2',
        reliabilityNote: '多来源一致，但语境以常温物流为主。',
      },
      {
        type: 'expert_judgement',
        title: '德尔菲专家判断记录',
        description: '8 位冷链从业者对因素依赖关系的两轮判断汇总。',
        sourceReference: '示例专家 panel（虚构）',
        sourceLocation: '会议纪要 2026-03',
        reliabilityNote: '样本小，属专家判断而非总体参数。',
      },
      {
        type: 'analysis_result',
        title: 'ISM 层级划分结果',
        description: '可达矩阵与层级划分输出：可靠性因素位于第 1–2 层。',
        sourceReference: 'ISM 运行输出（虚构）',
        sourceLocation: '结果文件 ism-levels.csv',
        reliabilityNote: '依赖专家判断输入。',
      },
      {
        type: 'table',
        title: 'ANP 超级矩阵权重表',
        description: '未加权/加权超级矩阵与极限优先级向量。',
        sourceReference: 'ANP 运行输出（虚构）',
        sourceLocation: '表 4-2',
        reliabilityNote: '权重仅在设定决策目标下成立。',
      },
      {
        type: 'dataset',
        title: '2025 冷链企业调研数据集',
        description: '12 家冷链企业的服务质量调研记录，用于描述性统计。',
        sourceReference: '示例调研数据（虚构）',
        sourceLocation: 'dataset v0.3',
        reliabilityNote: '便利样本，不代表总体。',
      },
    ],
    claims: [
      {
        claimCode: 'C-01',
        claimText: '可靠性相关因素在 elicited ISM 模型中占据相对较高的结构层级。',
        claimType: 'empirical',
        status: 'proposed',
        confidence: 0.7,
        boundary: '结构层级反映专家判断下的依赖组织，不构成统计因果。',
      },
      {
        claimCode: 'C-02',
        claimText: 'ANP 权重反映特定决策目标下的相对优先级，而非普适重要性。',
        claimType: 'methodological',
        status: 'confirmed',
        confidence: 0.85,
        boundary: 'ANP priority ≠ economic value；目标改变则优先级可能改变。',
      },
      {
        claimCode: 'C-03',
        claimText: '服务质量因素的结构组织在不同决策目标下呈现稳定的分层形态。',
        claimType: 'interpretive',
        status: 'proposed',
        confidence: 0.5,
      },
      {
        claimCode: 'C-04',
        claimText: '本研究构建了冷链物流服务质量因素的 ISM 结构模型与目标依赖的 ANP 决策优先级整合框架。',
        claimType: 'contribution',
        status: 'proposed',
        confidence: 0.7,
        boundary: '贡献限于整合框架与其在示例冷链语境中的刻画。',
      },
      {
        claimCode: 'C-05',
        claimText: '可靠性因素决定整个冷链物流系统的服务质量并导致客户满意。',
        claimType: 'descriptive',
        status: 'draft',
        confidence: 0.4,
      },
    ],
    sections: [
      { sectionName: 'Results 4.1', sectionReference: 'ISM 结构层级', sortOrder: 1 },
      { sectionName: 'Results 4.2', sectionReference: 'ANP 优先级', sortOrder: 2 },
      { sectionName: 'Discussion 5.1', sectionReference: '结构与优先级的关系解释', sortOrder: 3 },
      { sectionName: 'Conclusion', sectionReference: '结论与边界声明', sortOrder: 4 },
    ],
    relations: [
      // E → C（supports / partially_supports），方向：evidence 支持 claim
      {
        sourceType: 'evidence', sourceId: '$E2', relationType: 'supports',
        targetType: 'claim', targetId: '$C1',
      },
      {
        sourceType: 'evidence', sourceId: '$E3', relationType: 'supports',
        targetType: 'claim', targetId: '$C1',
      },
      {
        sourceType: 'evidence', sourceId: '$E4', relationType: 'supports',
        targetType: 'claim', targetId: '$C2',
      },
      {
        sourceType: 'evidence', sourceId: '$E3', relationType: 'partially_supports',
        targetType: 'claim', targetId: '$C4',
      },
      {
        sourceType: 'evidence', sourceId: '$E2', relationType: 'supports',
        targetType: 'claim', targetId: '$C5',
      },
      // C-03 刻意没有任何支持证据。
      // C → RQ（answers）
      {
        sourceType: 'claim', sourceId: '$C1', relationType: 'answers',
        targetType: 'research_question', targetId: '$RQ1',
      },
      {
        sourceType: 'claim', sourceId: '$C3', relationType: 'answers',
        targetType: 'research_question', targetId: '$RQ1',
      },
      {
        sourceType: 'claim', sourceId: '$C5', relationType: 'answers',
        targetType: 'research_question', targetId: '$RQ1',
      },
      {
        sourceType: 'claim', sourceId: '$C2', relationType: 'answers',
        targetType: 'research_question', targetId: '$RQ2',
      },
      // C → Section（appears_in）
      {
        sourceType: 'claim', sourceId: '$C1', relationType: 'appears_in',
        targetType: 'manuscript_section', targetId: '$S1',
      },
      {
        sourceType: 'claim', sourceId: '$C2', relationType: 'appears_in',
        targetType: 'manuscript_section', targetId: '$S2',
      },
      {
        sourceType: 'claim', sourceId: '$C5', relationType: 'appears_in',
        targetType: 'manuscript_section', targetId: '$S3',
      },
      {
        sourceType: 'claim', sourceId: '$C4', relationType: 'appears_in',
        targetType: 'manuscript_section', targetId: '$S4',
      },
    ],
    decisions: [
      {
        title: '采用 ISM + ANP 方法组合',
        decision: '使用 ISM 刻画因素结构，ANP 给出目标依赖的决策优先级。',
        reason: '研究问题同时涉及结构组织与优先级排序，单一方法无法覆盖。',
        alternatives: 'DEMATEL；回归分析',
        rejectedAlternatives: '回归分析需要统计因果口径，与专家判断数据不匹配。',
        impact: 'Method / Results / Discussion',
      },
      {
        title: '删除 Hypothesis 3',
        decision: '删除原 Hypothesis 3（可靠性→满意度的因果假设）。',
        reason: '证据仅支持结构关联，不足以支撑因果表述（对照 Claim Boundary）。',
        alternatives: '弱化为相关性假设',
        rejectedAlternatives: '保留弱化版仍会诱导因果阅读，最终放弃。',
        impact: 'Introduction / Discussion / Conclusion',
      },
    ],
    changes: [
      {
        changeType: 'research_question',
        before: 'RQ2 focused on overall importance.',
        after: 'RQ2 focuses on goal-dependent decision priority.',
        reason:
          'ANP output represents relative priorities under the specified decision goal ' +
          'rather than universal importance.',
        impact: 'Introduction / Method / Results / Discussion / Conclusion',
      },
      {
        changeType: 'journal',
        before: 'Target journal: Journal of Cold Chain Logistics（示例）',
        after: 'Target journal: International Journal of Logistics Management（示例）',
        reason: '适配目标期刊范围调整（示例）。',
        impact: 'Contribution 表述 / Discussion 范围',
      },
    ],
    milestone: {
      occurredAt: '2026-07-22T00:00:00.000Z',
      title: 'Submission V1',
      summary: '演示项目首次投稿节点（虚构）。',
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Seeds the full demo project through the domain facade. The tiny pause before the Change rows keeps
 * `change.createdAt > charter.updatedAt` true whatever the clock's granularity is: the lists order on
 * that stamp, and P6's Method/Journal rules read it as「章程之后动过」.
 */
export async function seedResearchDemo(domain: ResearchDomain, userId: string): Promise<ResearchDemoSeed> {
  const data = buildResearchDemoData();

  const project = await domain.createProject(userId, data.project);
  const charter = await domain.upsertCharter(project.id, userId, data.charter);

  const questions: ResearchQuestion[] = [];
  for (const input of data.questions) {
    questions.push(await domain.createQuestion(project.id, userId, input));
  }

  const evidence: Evidence[] = [];
  for (const input of data.evidence) {
    evidence.push(await domain.createEvidence(project.id, userId, input));
  }

  const claims: Claim[] = [];
  for (const input of data.claims) {
    claims.push(await domain.createClaim(project.id, userId, input));
  }

  const sections: ManuscriptSection[] = [];
  for (const input of data.sections) {
    sections.push(await domain.createSection(project.id, userId, input));
  }

  // $E2/$C1/… placeholders resolve to the created ids by position.
  const slots: Record<string, string> = {
    $RQ1: questions[0]?.id ?? '',
    $RQ2: questions[1]?.id ?? '',
    $E1: evidence[0]?.id ?? '',
    $E2: evidence[1]?.id ?? '',
    $E3: evidence[2]?.id ?? '',
    $E4: evidence[3]?.id ?? '',
    $E5: evidence[4]?.id ?? '',
    $C1: claims[0]?.id ?? '',
    $C2: claims[1]?.id ?? '',
    $C3: claims[2]?.id ?? '',
    $C4: claims[3]?.id ?? '',
    $C5: claims[4]?.id ?? '',
    $S1: sections[0]?.id ?? '',
    $S2: sections[1]?.id ?? '',
    $S3: sections[2]?.id ?? '',
    $S4: sections[3]?.id ?? '',
  };

  const relations: EntityRelation[] = [];
  for (const input of data.relations) {
    relations.push(
      await domain.createRelation(project.id, userId, {
        ...input,
        sourceId: slots[input.sourceId] ?? input.sourceId,
        targetId: slots[input.targetId] ?? input.targetId,
      }),
    );
  }

  const decisions: ResearchDecision[] = [];
  for (const input of data.decisions) {
    decisions.push(await domain.createDecision(project.id, userId, input));
  }

  await sleep(5);
  const changes: ResearchChange[] = [];
  for (const input of data.changes) {
    changes.push(await domain.createChange(project.id, userId, input));
  }

  const milestone = await domain.createMilestone(project.id, userId, data.milestone);
  const timeline = await domain.listTimeline(project.id, userId);

  return {
    project,
    charter,
    questions,
    evidence,
    claims,
    sections,
    relations,
    decisions,
    changes,
    events: [milestone, ...timeline.filter((event) => event.id !== milestone.id)],
  };
}
