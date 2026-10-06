import type {
  CaptureAction,
  ClaimStatus,
  ClaimType,
  ContextScope,
  EdgeRelation,
  EvidenceLocationOrigin,
  EvidenceType,
  NodeStatus,
  ProcessingStatus,
  ResearchChangeType,
  ResearchEntityType,
  ResearchProjectStatus,
  ResearchQuestionStatus,
  ResearchRelationType,
  ReviewMarkRaisedBy,
  ReviewMarkStatus,
  SourceType,
  TimelineEventType,
} from '@noltri/schema';

export const relationLabels: Record<EdgeRelation, string> = {
  part_of: '属于',
  prerequisite_of: '是…的前置',
  similar_to: '相似',
  contrast_with: '对比',
  causes: '导致',
  implements: '实现',
  example_of: '是…的例子',
  supports: '支持',
  contradicts: '冲突',
  derived_from: '派生自',
};

export const scopeLabels: Record<ContextScope, string> = {
  current_node: '当前节点',
  section: '当前章节',
  tree: '整棵知识树',
  whole_library: '整个知识库',
};

/** `whole_library` stays available but is never the default and is visually flagged as advanced. */
export const scopeIsAdvanced: Record<ContextScope, boolean> = {
  current_node: false,
  section: false,
  tree: false,
  whole_library: true,
};

export const scopeDescriptions: Record<ContextScope, string> = {
  current_node: '只装载这个节点及其知识点、来源摘要。',
  section: '装载所在章节：上级节点、直接子节点与相关节点。',
  tree: '装载整个知识域树，上下文较大。',
  whole_library: '装载整个知识库，开销最大，仅在确有必要时使用。',
};

export const matchedByLabels = {
  semantic: '语义',
  keyword: '关键词',
  both: '语义 + 关键词',
} as const;

export const nodeStatusLabels: Record<NodeStatus, string> = {
  active: '有效',
  archived: '已归档',
  needs_review: '待核实',
};

/** 收件箱 badges: every capture sits in exactly one of these four states. */
export const processingStatusLabels: Record<ProcessingStatus, string> = {
  pending: '待整理',
  processing: '整理中',
  done: '已归纳',
  failed: '归纳失败',
};

export const sourceTypeLabels: Record<SourceType, string> = {
  web: '网页',
  desktop_app: '桌面应用',
  agent: 'Agent',
  manual: '手动粘贴',
};

export const captureActionLabels: Record<CaptureAction, string> = {
  created: '新建节点',
  attached: '归入已有节点',
  merged: '合并进已有知识',
};

export function relationLabel(relationType: string): string {
  return relationLabels[relationType as EdgeRelation] ?? relationType;
}

/**
 * Research vocabulary (contract §1). A label that still carried its snake_case token would let a panel
 * show 「partially_supports」 to a user, so these maps are pinned by the same completeness test as the
 * knowledge ones.
 */
export const researchProjectStatusLabels: Record<ResearchProjectStatus, string> = {
  active: '进行中',
  archived: '已归档',
  completed: '已完成',
};

export const researchQuestionStatusLabels: Record<ResearchQuestionStatus, string> = {
  open: '待回答',
  answered: '已回答',
  revised: '已修订',
  dropped: '已搁置',
};

export const evidenceTypeLabels: Record<EvidenceType, string> = {
  literature: '文献',
  dataset: '数据',
  analysis_result: '分析结果',
  figure: '图',
  table: '表',
  interview: '访谈',
  expert_judgement: '专家判断',
  document: '文档',
  note: '笔记',
  external_source: '外部来源',
  other: '其他',
};

/** `manual` is 定位 the user typed; `captured` came in with a 采集 and may point at an archived object. */
export const evidenceLocationOriginLabels: Record<EvidenceLocationOrigin, string> = {
  manual: '手动定位',
  captured: '采集定位',
};

export const claimTypeLabels: Record<ClaimType, string> = {
  descriptive: '描述性',
  empirical: '实证',
  methodological: '方法',
  interpretive: '解释性',
  theoretical: '理论',
  contribution: '贡献',
  limitation: '局限',
};

export const claimStatusLabels: Record<ClaimStatus, string> = {
  draft: '草稿',
  proposed: '待确认',
  confirmed: '已确认',
  revised: '已修订',
  dropped: '已放弃',
};

export const researchRelationTypeLabels: Record<ResearchRelationType, string> = {
  supports: '支持',
  partially_supports: '部分支持',
  contradicts: '反证',
  qualifies: '限定',
  contextualizes: '背景',
  answers: '回答',
  appears_in: '出现于',
  changes: '改变',
  affects: '影响',
  relates_to: '相关',
};

export const researchChangeTypeLabels: Record<ResearchChangeType, string> = {
  research_question: '研究问题',
  method: '方法',
  scope: '范围',
  claim: '论点',
  contribution: '贡献',
  journal: '期刊',
  evidence: '证据',
  structure: '结构',
  other: '其他',
};

export const researchEntityTypeLabels: Record<ResearchEntityType, string> = {
  research_project: '研究项目',
  research_charter: '章程',
  research_question: '研究问题',
  evidence: '证据',
  claim: '论点',
  research_decision: '决策',
  research_change: '变更',
  drift_finding: '偏移',
  manuscript_section: '章节',
};

export const reviewMarkRaisedByLabels: Record<ReviewMarkRaisedBy, string> = {
  charter_baseline: '章程新基线',
  source_archived: '出处已归档',
};

export const reviewMarkStatusLabels: Record<ReviewMarkStatus, string> = {
  pending: '待处理',
  cleared: '已处理',
};

export const timelineEventTypeLabels: Record<TimelineEventType, string> = {
  decision: '决策',
  change: '变更',
  milestone: '里程碑',
};

/** Same pass-through rule as `relationLabel`: an unknown token is shown as-is, never blanked. */
export function researchRelationLabel(relationType: string): string {
  return researchRelationTypeLabels[relationType as ResearchRelationType] ?? relationType;
}
