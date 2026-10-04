import type { CaptureAction, ContextScope, EdgeRelation, NodeStatus, ProcessingStatus, SourceType } from '@noltri/schema';

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
