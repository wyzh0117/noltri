/**
 * Pure view models for the Research workbench: Chinese labels, timeline merging, drift grouping and
 * the layered Research Map projection. No React and no DOM, so every display rule is unit-testable
 * and stays the single source of truth for the research panels.
 */

import type {
  ClaimStatus,
  ClaimType,
  DriftFinding,
  DriftFindingStatus,
  DriftSeverity,
  DriftType,
  EvidenceType,
  JsonValue,
  ResearchChange,
  ResearchChangeType,
  ResearchDecision,
  ResearchEntityType,
  ResearchMapResponse,
  ResearchProjectStatus,
  ResearchQuestionStatus,
  ResearchRelationType,
  TimelineEvent,
  TimelineEventType,
} from '@noltri/schema';

// --- labels ----------------------------------------------------------------

export const researchProjectStatusLabels: Record<ResearchProjectStatus, string> = {
  active: '研究中',
  archived: '已归档',
  completed: '已完成',
};

export const researchQuestionStatusLabels: Record<ResearchQuestionStatus, string> = {
  open: '待解决',
  answered: '已回答',
  revised: '已修订',
  dropped: '已放弃',
};

export const evidenceTypeLabels: Record<EvidenceType, string> = {
  literature: '文献',
  dataset: '数据集',
  analysis_result: '分析结果',
  figure: '图表',
  table: '表格',
  interview: '访谈',
  expert_judgement: '专家判断',
  document: '文档',
  note: '笔记',
  external_source: '外部来源',
  other: '其他',
};

export const claimTypeLabels: Record<ClaimType, string> = {
  descriptive: '描述性',
  empirical: '实证性',
  methodological: '方法论',
  interpretive: '解释性',
  theoretical: '理论性',
  contribution: '贡献',
  limitation: '局限',
};

export const claimStatusLabels: Record<ClaimStatus, string> = {
  draft: '草稿',
  proposed: '已提出',
  confirmed: '已确认',
  revised: '已修订',
  dropped: '已放弃',
};

export const researchChangeTypeLabels: Record<ResearchChangeType, string> = {
  research_question: '研究问题',
  method: '方法',
  scope: '范围',
  claim: '主张',
  contribution: '贡献',
  journal: '目标期刊',
  structure: '结构',
  evidence: '证据',
  other: '其他',
};

export const driftTypeLabels: Record<DriftType, string> = {
  rq_drift: '研究问题漂移',
  contribution_drift: '贡献漂移',
  evidence_drift: '证据缺口',
  causality_drift: '因果越界',
  method_drift: '方法漂移',
  journal_drift: '期刊漂移',
};

export const driftSeverityLabels: Record<DriftSeverity, string> = {
  info: '提示',
  warning: '警告',
  critical: '严重',
};

export const driftFindingStatusLabels: Record<DriftFindingStatus, string> = {
  open: '待处理',
  acknowledged: '已知悉',
  resolved: '已解决',
  dismissed: '已忽略',
};

export const researchEntityTypeLabels: Record<ResearchEntityType, string> = {
  research_project: '研究项目',
  research_charter: '研究章程',
  research_question: '研究问题',
  evidence: '证据',
  claim: '主张',
  research_decision: '决策',
  research_change: '变更',
  drift_finding: '漂移发现',
  manuscript_section: '论文章节',
};

export const researchRelationTypeLabels: Record<ResearchRelationType, string> = {
  supports: '支持',
  partially_supports: '部分支持',
  contradicts: '反驳',
  qualifies: '限定',
  contextualizes: '背景化',
  answers: '回答',
  appears_in: '出现于',
  changes: '改变',
  affects: '影响',
  relates_to: '相关',
};

export const timelineEventTypeLabels: Record<TimelineEventType, string> = {
  decision: '决策',
  change: '变更',
  milestone: '里程碑',
};

/** Fallback to the raw value when a label is missing. */
export function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return labels[value] ?? value;
}

// --- timeline view ---------------------------------------------------------

export interface TimelineDetail {
  /** What changed / what was decided. */
  what: string;
  /** Why it happened, when recorded. */
  why: string | null;
  /** Related objects as display strings. */
  related: string[];
}

export interface TimelineEntryView {
  event: TimelineEvent;
  /** `YYYY-MM-DD` cut from `occurredAt` (UTC); falls back to the raw string. */
  dateLabel: string;
  typeLabel: string;
  detail: TimelineDetail;
}

export interface TimelineSources {
  decisions?: readonly ResearchDecision[];
  changes?: readonly ResearchChange[];
}

/**
 * Merge decisions / changes / milestones into one display list, newest first
 * (`occurredAt` desc, then `createdAt` desc, then `id` asc — deterministic for ties).
 */
export function buildTimelineView(
  events: readonly TimelineEvent[],
  sources: TimelineSources = {},
): TimelineEntryView[] {
  const decisions = sources.decisions ?? [];
  const changes = sources.changes ?? [];
  return events
    .map((event) => {
      const decision = event.sourceId === null ? undefined : decisions.find((entry) => entry.id === event.sourceId);
      const change = event.sourceId === null ? undefined : changes.find((entry) => entry.id === event.sourceId);
      return {
        event,
        dateLabel: dateLabelOf(event.occurredAt),
        typeLabel: labelOf(timelineEventTypeLabels, event.eventType),
        detail: detailOf(event, decision, change),
      };
    })
    .sort(compareTimelineEntries);
}

export function formatRelatedEntities(entities: JsonValue | readonly unknown[] | null | undefined): string[] {
  if (entities === null || entities === undefined) return [];
  if (Array.isArray(entities)) return entities.map((entry) => stringifyValue(entry));
  if (typeof entities === 'object') {
    return Object.entries(entities as Record<string, unknown>).map(([key, value]) => `${key}: ${stringifyValue(value)}`);
  }
  return [];
}

function detailOf(
  event: TimelineEvent,
  decision: ResearchDecision | undefined,
  change: ResearchChange | undefined,
): TimelineDetail {
  if (decision !== undefined) {
    return {
      what: `${decision.title}：${decision.decision}`,
      why: decision.reason,
      related: formatRelatedEntities(decision.relatedEntities),
    };
  }
  if (change !== undefined) {
    return {
      what: `${labelOf(researchChangeTypeLabels, change.changeType)}：${change.before} → ${change.after}`,
      why: change.reason,
      related: formatRelatedEntities(change.relatedEntities),
    };
  }
  return {
    what: event.summary ?? event.title,
    why: null,
    related: formatRelatedEntities(event.relatedEntities),
  };
}

function compareTimelineEntries(first: TimelineEntryView, second: TimelineEntryView): number {
  if (first.event.occurredAt !== second.event.occurredAt) {
    return first.event.occurredAt < second.event.occurredAt ? 1 : -1;
  }
  if (first.event.createdAt !== second.event.createdAt) {
    return first.event.createdAt < second.event.createdAt ? 1 : -1;
  }
  return first.event.id < second.event.id ? -1 : first.event.id > second.event.id ? 1 : 0;
}

function dateLabelOf(occurredAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(occurredAt) ? occurredAt.slice(0, 10) : occurredAt;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// --- drift view ------------------------------------------------------------

export interface DriftGroupView {
  severity: DriftSeverity;
  severityLabel: string;
  findings: DriftFinding[];
}

const SEVERITY_ORDER: readonly DriftSeverity[] = ['critical', 'warning', 'info'];

/** Group findings by severity, ordered critical → warning → info; empty groups are omitted. */
export function groupFindingsBySeverity(findings: readonly DriftFinding[]): DriftGroupView[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    severityLabel: labelOf(driftSeverityLabels, severity),
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

export interface DriftSeverityCounts {
  total: number;
  info: number;
  warning: number;
  critical: number;
}

export function countFindingsBySeverity(findings: readonly DriftFinding[]): DriftSeverityCounts {
  return {
    total: findings.length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    critical: findings.filter((finding) => finding.severity === 'critical').length,
  };
}

/** Status transitions offered by the UI buttons, in display order. */
export const driftFindingStatusActions: readonly DriftFindingStatus[] = ['acknowledged', 'resolved', 'dismissed'];

// --- research map view -----------------------------------------------------

export type MapLayerKey = 'questions' | 'evidence' | 'claims' | 'sections' | 'contribution';

export interface MapNodeView {
  id: string;
  /** RQ1 / C-021 style code; null for evidence, sections and the contribution node. */
  code: string | null;
  title: string;
  /** Short secondary line (type / status / reference / stage). */
  meta: string | null;
  tone: 'default' | 'warn' | 'muted';
}

export interface MapLayerView {
  key: MapLayerKey;
  title: string;
  /** Chinese hint shown when the layer has no nodes. */
  emptyHint: string;
  nodes: MapNodeView[];
}

export interface MapEdgeView {
  id: string;
  relationType: ResearchRelationType;
  relationLabel: string;
  sourceType: ResearchEntityType;
  sourceId: string;
  targetType: ResearchEntityType;
  targetId: string;
  /** e.g. `C-021 回答 RQ1`. */
  text: string;
}

export interface MapViewModel {
  layers: MapLayerView[];
  edges: MapEdgeView[];
  unsupportedClaimIds: readonly string[];
}

const LAYER_TITLES: Record<MapLayerKey, string> = {
  questions: '研究问题',
  evidence: '证据',
  claims: '主张',
  sections: '论文章节',
  contribution: '核心贡献',
};

const LAYER_EMPTY_HINTS: Record<MapLayerKey, string> = {
  questions: '还没有研究问题',
  evidence: '还没有证据',
  claims: '还没有主张',
  sections: '还没有论文章节',
  contribution: '尚未填写 Core Contribution',
};

/**
 * Layered, text-first projection of the research map: questions → evidence → claims → sections →
 * contribution. Layout stays in the UI; this module only decides what each column shows and how an
 * edge reads.
 */
export function buildMapViewModel(map: ResearchMapResponse): MapViewModel {
  const unsupported = new Set(map.unsupportedClaimIds);
  /** Edge labels prefer the human code (C-021) and fall back to a shortened title. */
  const nodeLabels = new Map<string, string>();
  const claimNodes: MapNodeView[] = map.claims.map((claim) => {
    nodeLabels.set(claim.id, claim.claimCode);
    const missing = unsupported.has(claim.id);
    return {
      id: claim.id,
      code: claim.claimCode,
      title: claim.claimText,
      meta: `${labelOf(claimTypeLabels, claim.claimType)} · ${labelOf(claimStatusLabels, claim.status)} · ${missing ? '缺证据支持' : '有证据支持'}`,
      tone: missing ? 'warn' : claim.status === 'dropped' ? 'muted' : 'default',
    };
  });

  const questionNodes: MapNodeView[] = map.questions.map((question) => {
    nodeLabels.set(question.id, question.questionCode);
    return {
      id: question.id,
      code: question.questionCode,
      title: question.questionText,
      meta: labelOf(researchQuestionStatusLabels, question.status),
      tone: question.status === 'dropped' ? 'muted' : 'default',
    };
  });

  const evidenceNodes: MapNodeView[] = map.evidence.map((evidence) => {
    nodeLabels.set(evidence.id, shorten(evidence.title, 24));
    return {
      id: evidence.id,
      code: null,
      title: evidence.title,
      meta: labelOf(evidenceTypeLabels, evidence.type),
      tone: 'default',
    };
  });

  const sectionNodes: MapNodeView[] = map.sections.map((section) => {
    nodeLabels.set(section.id, shorten(section.sectionName, 24));
    return {
      id: section.id,
      code: null,
      title: section.sectionName,
      meta: section.sectionReference,
      tone: 'default',
    };
  });

  const contributionText = map.charter.coreContribution;
  const hasContribution = contributionText !== null && contributionText.trim().length > 0;
  const contributionNode: MapNodeView = {
    id: 'contribution',
    code: null,
    title: hasContribution ? (contributionText as string) : '（尚未填写 Core Contribution）',
    meta: map.charter.currentStage === null
      ? map.charter.workingTitle
      : `${map.charter.workingTitle} · ${map.charter.currentStage}`,
    tone: hasContribution ? 'default' : 'muted',
  };

  const layers: MapLayerView[] = (['questions', 'evidence', 'claims', 'sections', 'contribution'] as const).map((key) => ({
    key,
    title: LAYER_TITLES[key],
    emptyHint: LAYER_EMPTY_HINTS[key],
    nodes:
      key === 'questions'
        ? questionNodes
        : key === 'evidence'
          ? evidenceNodes
          : key === 'claims'
            ? claimNodes
            : key === 'sections'
              ? sectionNodes
              : [contributionNode],
  }));

  const edges: MapEdgeView[] = map.edges.map((edge) => {
    const sourceLabel = edge.sourceId === 'contribution' ? contributionNode.title : nodeLabels.get(edge.sourceId) ?? edge.sourceId;
    const targetLabel = edge.targetId === 'contribution' ? contributionNode.title : nodeLabels.get(edge.targetId) ?? edge.targetId;
    return {
      id: edge.id,
      relationType: edge.relationType,
      relationLabel: labelOf(researchRelationTypeLabels, edge.relationType),
      sourceType: edge.sourceType,
      sourceId: edge.sourceId,
      targetType: edge.targetType,
      targetId: edge.targetId,
      text: `${sourceLabel} ${labelOf(researchRelationTypeLabels, edge.relationType)} ${targetLabel}`,
    };
  });

  return { layers, edges, unsupportedClaimIds: map.unsupportedClaimIds };
}

/** Edges whose target is `nodeId`. */
export function incomingEdges(model: MapViewModel, nodeId: string): MapEdgeView[] {
  return model.edges.filter((edge) => edge.targetId === nodeId);
}

/** Edges whose source is `nodeId`. */
export function outgoingEdges(model: MapViewModel, nodeId: string): MapEdgeView[] {
  return model.edges.filter((edge) => edge.sourceId === nodeId);
}

function shorten(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
