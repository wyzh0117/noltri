/**
 * Pure decisions behind the 研究工作台 (P5-D). What a 章程 field is called in Chinese, how a 出处 reads when
 * the object behind it may already be archived, and which 论点 count as 未被支撑 — all of it computed here so
 * the panels stay draw-only and these rules can be tested without a WebView or a running Core.
 *
 * The rules this file deliberately does not restate: which relations count as 支持
 * (`SUPPORTING_RELATION_TYPES`) and which 端点 pairs a relation kind may join (`RELATION_PAIRINGS`). Those
 * live with the schema, where the domain's own refusals read them.
 */
import {
  CHARTER_FIELD_NAMES,
  EVIDENCE_TO_CLAIM_RELATION_TYPES,
  SUPPORTING_RELATION_TYPES,
  claimStatusSchema,
  claimTypeSchema,
  evidenceTypeSchema,
  researchQuestionStatusSchema,
  researchRelationTypeSchema,
  type ApproveCharterRequest,
  type CharterFieldName,
  type CharterFields,
  type CharterVersion,
  type Claim,
  type ClaimStatus,
  type ClaimType,
  type CreateEntityRelationRequest,
  type EntityRelation,
  type Evidence,
  type EvidenceType,
  type ManuscriptSection,
  type ResearchCharter,
  type ResearchEntityRef,
  type ResearchEntityType,
  type ResearchProject,
  type ResearchQuestion,
  type ResearchQuestionStatus,
  type ResearchReferenceMatch,
  type ResearchRelationType,
  type ResearchReviewMark,
  type TimelineEvent,
} from '@noltri/schema';
import {
  claimStatusLabels,
  claimTypeLabels,
  evidenceLocationOriginLabels,
  researchEntityTypeLabels,
  researchProjectStatusLabels,
  reviewMarkRaisedByLabels,
  timelineEventTypeLabels,
} from '@noltri/shared';

/** The choices a form offers, straight from the enums, so a new server-side value cannot silently miss the UI. */
export const QUESTION_STATUSES: readonly ResearchQuestionStatus[] = [...researchQuestionStatusSchema.options];
export const CLAIM_STATUSES: readonly ClaimStatus[] = [...claimStatusSchema.options];
export const CLAIM_TYPES: readonly ClaimType[] = [...claimTypeSchema.options];
export const EVIDENCE_TYPES: readonly EvidenceType[] = [...evidenceTypeSchema.options];
export const RELATION_TYPES: readonly ResearchRelationType[] = [...researchRelationTypeSchema.options];

/** `2026-03-01T08:00:00.000Z` → `2026-03-01 08:00`, the same stamp 收件箱 rows carry. */
export function stamp(iso: string): string {
  const trimmed = iso.trim();
  if (trimmed.length < 16) return trimmed;
  return `${trimmed.slice(0, 10)} ${trimmed.slice(11, 16)}`;
}

export function projectLine(project: ResearchProject): string {
  return `${project.name} · ${researchProjectStatusLabels[project.status]}`;
}

// --- 章程 -------------------------------------------------------------------

export const CHARTER_FIELD_LABELS: Record<CharterFieldName, string> = {
  workingTitle: '工作标题',
  researchTopic: '研究主题',
  researchProblem: '研究问题',
  researchGap: '研究缺口',
  researchQuestionsText: '研究问题陈述',
  coreContribution: '核心贡献',
  theoreticalLens: '理论视角',
  researchContext: '研究情境',
  unitOfAnalysis: '分析单位',
  researchMethod: '研究方法',
  targetArticleType: '目标文章类型',
  targetJournal: '目标期刊',
  researchBoundary: '研究边界',
  claimBoundary: '论点边界',
  currentStage: '当前阶段',
};

/** The one required field first, then the rest in a stable order (the schema keeps its names sorted). */
export const CHARTER_FIELD_ORDER: readonly CharterFieldName[] = [
  'workingTitle',
  ...CHARTER_FIELD_NAMES.filter((field) => field !== 'workingTitle'),
];

export type CharterDraft = Record<CharterFieldName, string>;

/** An empty form for a project that has no 章程 yet. Every field starts blank, `workingTitle` included. */
export function emptyDraft(): CharterDraft {
  const draft = {} as CharterDraft;
  for (const field of CHARTER_FIELD_NAMES) draft[field] = '';
  return draft;
}

/** A field the user cleared goes back as `null`: 未填写 is not the same answer as 写了空字符串. */
export function draftFrom(charter: ResearchCharter | null): CharterDraft {
  const draft = emptyDraft();
  if (charter === null) return draft;
  for (const field of CHARTER_FIELD_NAMES) draft[field] = charter[field] ?? '';
  return draft;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `null` when 工作标题 is blank — the one field the server insists on, and the only reason a save is not
 * sendable. Writing the 15 keys out rather than spreading a bag is what makes a 章程 field added upstream
 * show up here as a compile error instead of being dropped from every save.
 */
export function draftPayload(draft: Readonly<CharterDraft>): CharterFields | null {
  const workingTitle = draft.workingTitle.trim();
  if (workingTitle === '') return null;
  return {
    workingTitle,
    researchTopic: blankToNull(draft.researchTopic),
    researchProblem: blankToNull(draft.researchProblem),
    researchGap: blankToNull(draft.researchGap),
    researchQuestionsText: blankToNull(draft.researchQuestionsText),
    coreContribution: blankToNull(draft.coreContribution),
    theoreticalLens: blankToNull(draft.theoreticalLens),
    researchContext: blankToNull(draft.researchContext),
    unitOfAnalysis: blankToNull(draft.unitOfAnalysis),
    researchMethod: blankToNull(draft.researchMethod),
    targetArticleType: blankToNull(draft.targetArticleType),
    targetJournal: blankToNull(draft.targetJournal),
    researchBoundary: blankToNull(draft.researchBoundary),
    claimBoundary: blankToNull(draft.claimBoundary),
    currentStage: blankToNull(draft.currentStage),
  };
}

/** Labels for the fields a 批准 changed, for the version history line. */
export function changedFieldLabels(fields: readonly CharterFieldName[]): readonly string[] {
  return fields.map((field) => CHARTER_FIELD_LABELS[field]);
}

export function baselineLine(version: CharterVersion | null): string {
  if (version === null) return '尚未批准任何基线，偏移检查没有可对照的版本。';
  return `v${String(version.version)} · ${stamp(version.approvedAt)} · ${version.revisionReason}`;
}

export interface ImpactOption {
  readonly type: ResearchEntityType;
  readonly id: string;
  readonly label: string;
}

const IMPACT_LABEL_CHARS = 40;

/** What 批准 may name as 受影响: the objects a 章程 revision is able to invalidate. */
export function impactOptions(
  claims: readonly Claim[],
  evidence: readonly Evidence[],
  questions: readonly ResearchQuestion[],
  sections: readonly ManuscriptSection[],
): readonly ImpactOption[] {
  const shorten = (text: string): string => (text.length > IMPACT_LABEL_CHARS ? `${text.slice(0, IMPACT_LABEL_CHARS)}…` : text);
  return [
    ...claims.map((claim) => ({ type: 'claim' as const, id: claim.id, label: `${claim.claimCode} ${shorten(claim.claimText)}` })),
    ...evidence.map((row) => ({ type: 'evidence' as const, id: row.id, label: row.title })),
    ...questions.map((row) => ({
      type: 'research_question' as const,
      id: row.id,
      label: `${row.questionCode} ${shorten(row.questionText)}`,
    })),
    ...sections.map((row) => ({ type: 'manuscript_section' as const, id: row.id, label: row.sectionName })),
  ];
}

export function impactKey(option: ImpactOption): string {
  return `${option.type}:${option.id}`;
}

/** Ids the approver ticked, as the refs the request carries. Nothing ticked means 「这条修订不动任何对象」. */
export function approvalEntities(
  selected: Readonly<Record<string, boolean>>,
  options: readonly ImpactOption[],
): readonly ResearchEntityRef[] {
  return options
    .filter((option) => selected[impactKey(option)] === true)
    .map((option) => ({ entityType: option.type, entityId: option.id }));
}

export function approvalPayload(reason: string, entities: readonly ResearchEntityRef[]): ApproveCharterRequest {
  return { revisionReason: reason.trim(), affectedEntities: [...entities] };
}

export function approvalIsSendable(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 2000;
}

// --- 复核标记 ----------------------------------------------------------------

export function pendingMarks(marks: readonly ResearchReviewMark[]): readonly ResearchReviewMark[] {
  return marks.filter((mark) => mark.status === 'pending');
}

/** Why the object is marked: which baseline, or which archived 出处 (the reason itself carries the name). */
export function markLine(mark: ResearchReviewMark): string {
  const origin = reviewMarkRaisedByLabels[mark.raisedBy];
  const version = mark.charterVersion === null ? '' : ` v${String(mark.charterVersion)}`;
  return `${researchEntityTypeLabels[mark.entityType]} · ${origin}${version}`;
}

// --- 研究问题 ----------------------------------------------------------------

export function openQuestions(questions: readonly ResearchQuestion[]): readonly ResearchQuestion[] {
  return questions.filter((question) => question.status === 'open');
}

// --- 证据 -------------------------------------------------------------------

/**
 * How the 出处 reads. The manual 定位 is shown as the user wrote it; the typed pointers are labelled as
 * pointers, and a pointer whose origin was never recorded says so instead of pretending someone typed it.
 */
export function evidenceProvenanceLines(evidence: Evidence): readonly string[] {
  const lines: string[] = [];
  const locator = [evidence.sourceReference, evidence.sourceLocation].filter((part): part is string => part !== null);
  if (locator.length > 0) lines.push(locator.join(' · '));

  const pointers: string[] = [];
  if (evidence.nodeId !== null) pointers.push(`知识节点 ${evidence.nodeId}`);
  if (evidence.rawSourceId !== null) pointers.push(`收录原文 ${evidence.rawSourceId}`);
  if (pointers.length > 0) {
    const origin = evidence.locationOrigin === null ? '出处指针' : evidenceLocationOriginLabels[evidence.locationOrigin];
    lines.push(`${origin} · ${pointers.join(' / ')}`);
  }
  return lines;
}

export interface ProjectReferences {
  readonly projectId: string;
  readonly projectName: string;
  readonly evidenceTitles: readonly string[];
  readonly claimCount: number;
}

/** 「归档这个出处会动到什么」 grouped by the project that cites it — the read R03 asks for before archiving. */
export function groupReferences(matches: readonly ResearchReferenceMatch[]): readonly ProjectReferences[] {
  const byProject = new Map<string, { projectName: string; evidenceTitles: string[]; claimIds: Set<string> }>();
  for (const match of matches) {
    const entry = byProject.get(match.projectId) ?? { projectName: match.projectName, evidenceTitles: [], claimIds: new Set<string>() };
    entry.evidenceTitles.push(match.evidenceTitle);
    for (const claimId of match.claimIds) entry.claimIds.add(claimId);
    byProject.set(match.projectId, entry);
  }
  return [...byProject.entries()].map(([projectId, entry]) => ({
    projectId,
    projectName: entry.projectName,
    evidenceTitles: entry.evidenceTitles,
    claimCount: entry.claimIds.size,
  }));
}

export function referenceSummary(matches: readonly ResearchReferenceMatch[]): string {
  if (matches.length === 0) return '没有任何研究项目引用这个出处，可以安全归档。';
  const projects = groupReferences(matches);
  const claims = projects.reduce((total, project) => total + project.claimCount, 0);
  return `被 ${String(projects.length)} 个研究项目引用：${String(matches.length)} 条证据、${String(claims)} 个论点会被标记待复核。`;
}

// --- 论点与章节 --------------------------------------------------------------

export function claimLine(claim: Claim): string {
  return `${claim.claimCode} · ${claimTypeLabels[claim.claimType]} · ${claimStatusLabels[claim.status]}`;
}

export function claimIsSupported(claimId: string, relations: readonly EntityRelation[]): boolean {
  return relations.some(
    (relation) =>
      relation.targetType === 'claim' && relation.targetId === claimId && SUPPORTING_RELATION_TYPES.includes(relation.relationType),
  );
}

/** 论点 with no 支持／部分支持 edge — the 证据工作台 flags these before any drift check ever runs. */
export function unsupportedClaims(claims: readonly Claim[], relations: readonly EntityRelation[]): readonly Claim[] {
  return claims.filter((claim) => !claimIsSupported(claim.id, relations));
}

export interface EvidenceLink {
  readonly relationType: ResearchRelationType;
  readonly title: string;
}

/** Every edge pointing at one 论点: a 反证 is as much a link as a 支持, and 限定 is not 支持 (R02). */
export function claimEvidenceLinks(
  claimId: string,
  relations: readonly EntityRelation[],
  evidence: readonly Evidence[],
): readonly EvidenceLink[] {
  const titles = new Map(evidence.map((row) => [row.id, row.title]));
  return relations
    .filter(
      (relation) => relation.targetType === 'claim' && relation.targetId === claimId && relation.sourceType === 'evidence',
    )
    .map((relation) => ({ relationType: relation.relationType, title: titles.get(relation.sourceId) ?? relation.sourceId }));
}

export function sectionClaims(
  sectionId: string,
  relations: readonly EntityRelation[],
  claims: readonly Claim[],
): readonly Claim[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  return relations
    .filter(
      (relation) =>
        relation.relationType === 'appears_in' && relation.targetType === 'manuscript_section' && relation.targetId === sectionId,
    )
    .map((relation) => byId.get(relation.sourceId))
    .filter((claim): claim is Claim => claim !== undefined);
}

export interface RelationMode {
  readonly key: 'evidence_claim' | 'claim_question' | 'claim_section';
  readonly label: string;
  readonly sourceType: ResearchEntityType;
  readonly targetType: ResearchEntityType;
  readonly types: readonly ResearchRelationType[];
}

/**
 * The three shapes the 工作台 writes. The user picks a mode and a kind inside it, which is how the form
 * keeps R02's direction honest without asking anyone to remember `RELATION_PAIRINGS`.
 */
export const RELATION_MODES: readonly RelationMode[] = [
  { key: 'evidence_claim', label: '证据 → 论点', sourceType: 'evidence', targetType: 'claim', types: EVIDENCE_TO_CLAIM_RELATION_TYPES },
  { key: 'claim_question', label: '论点 → 研究问题', sourceType: 'claim', targetType: 'research_question', types: ['answers'] },
  { key: 'claim_section', label: '论点 → 章节', sourceType: 'claim', targetType: 'manuscript_section', types: ['appears_in'] },
];

export function relationMode(key: RelationMode['key']): RelationMode {
  const mode = RELATION_MODES.find((candidate) => candidate.key === key);
  if (mode === undefined) throw new Error(`unknown relation mode ${key}`);
  return mode;
}

export function relationPayload(
  mode: RelationMode,
  sourceId: string,
  relationType: ResearchRelationType,
  targetId: string,
): CreateEntityRelationRequest {
  return { sourceType: mode.sourceType, sourceId: sourceId.trim(), relationType, targetType: mode.targetType, targetId: targetId.trim() };
}

export function relationIsSendable(sourceId: string, targetId: string): boolean {
  return sourceId.trim() !== '' && targetId.trim() !== '';
}

// --- 时间线 ------------------------------------------------------------------

export interface TimelineRow {
  readonly id: string;
  readonly when: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly summary: string | null;
}

/** The server already orders the feed by `occurredAt` descending, so this only shapes it for drawing. */
export function timelineRows(events: readonly TimelineEvent[]): readonly TimelineRow[] {
  return events.map((event) => ({
    id: event.id,
    when: stamp(event.occurredAt),
    typeLabel: timelineEventTypeLabels[event.eventType],
    title: event.title,
    summary: event.summary,
  }));
}
