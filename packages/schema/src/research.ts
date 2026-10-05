import { z } from 'zod';
import { jsonValueSchema } from './knowledge';

/**
 * Research Domain contracts (Noltri Research V1).
 *
 * Research is a Project Type extension on top of the common layer, not a second system:
 * entities follow the same shape discipline as `knowledge.ts` (id / userId / timestamps,
 * explicit enums, create-input schemas without identity fields — identity always comes from
 * credentials on the server side).
 */

// --- enums -----------------------------------------------------------------

export const researchProjectStatusSchema = z.enum(['active', 'archived', 'completed']);
export type ResearchProjectStatus = z.infer<typeof researchProjectStatusSchema>;

export const researchQuestionStatusSchema = z.enum(['open', 'answered', 'revised', 'dropped']);
export type ResearchQuestionStatus = z.infer<typeof researchQuestionStatusSchema>;

export const evidenceTypeSchema = z.enum([
  'literature',
  'dataset',
  'analysis_result',
  'figure',
  'table',
  'interview',
  'expert_judgement',
  'document',
  'note',
  'external_source',
  'other',
]);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export const claimTypeSchema = z.enum([
  'descriptive',
  'empirical',
  'methodological',
  'interpretive',
  'theoretical',
  'contribution',
  'limitation',
]);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimStatusSchema = z.enum(['draft', 'proposed', 'confirmed', 'revised', 'dropped']);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const researchChangeTypeSchema = z.enum([
  'research_question',
  'method',
  'scope',
  'claim',
  'contribution',
  'journal',
  'structure',
  'evidence',
  'other',
]);
export type ResearchChangeType = z.infer<typeof researchChangeTypeSchema>;

export const driftTypeSchema = z.enum([
  'rq_drift',
  'contribution_drift',
  'evidence_drift',
  'causality_drift',
  'method_drift',
  'journal_drift',
]);
export type DriftType = z.infer<typeof driftTypeSchema>;

export const driftSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type DriftSeverity = z.infer<typeof driftSeveritySchema>;

export const driftFindingStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);
export type DriftFindingStatus = z.infer<typeof driftFindingStatusSchema>;

export const researchEntityTypeSchema = z.enum([
  'research_project',
  'research_charter',
  'research_question',
  'evidence',
  'claim',
  'research_decision',
  'research_change',
  'drift_finding',
  'manuscript_section',
]);
export type ResearchEntityType = z.infer<typeof researchEntityTypeSchema>;

/**
 * Generic relation vocabulary (one `entity_relations` table — see research doc §27):
 * evidence→claim: supports / partially_supports / contradicts / qualifies / contextualizes;
 * claim→question: answers; claim→section: appears_in; decision/change→anything: changes / affects.
 */
export const researchRelationTypeSchema = z.enum([
  'supports',
  'partially_supports',
  'contradicts',
  'qualifies',
  'contextualizes',
  'answers',
  'appears_in',
  'changes',
  'affects',
  'relates_to',
]);
export type ResearchRelationType = z.infer<typeof researchRelationTypeSchema>;

/**
 * R02：哪些关系算「有证据支撑」，全项目只在这里说一次。地图的悬挂判定、漂移检查与上下文包都读这份表，
 * 不再各自重复 `supports || partially_supports`——反证、限定与背景三种关系都是证据关系，但都不算支撑。
 */
export const SUPPORTING_RELATION_TYPES: readonly ResearchRelationType[] = [
  'supports',
  'partially_supports',
];

/** The five kinds an Evidence may point at a Claim with. Any other pair is a malformed edge. */
export const EVIDENCE_TO_CLAIM_RELATION_TYPES: readonly ResearchRelationType[] = [
  'supports',
  'partially_supports',
  'contradicts',
  'qualifies',
  'contextualizes',
];

/** Which endpoint types one relation kind may join. */
export interface RelationPairing {
  readonly sourceTypes: readonly ResearchEntityType[];
  readonly targetTypes: readonly ResearchEntityType[];
}

/**
 * R02 的另一半：关系类型的方向属于它的含义，不是调用方的自由裁量。`supports` 读作「证据支撑论点」，
 * 反向的一条边不是弱一点的论断而是写错了的边；`answers`、`appears_in` 同理。开发文档 §13「证据作用类型」
 * 只规定了五种证据关系，其余方向的约束由研究地图的读法反推：地图按 RQ → Evidence → Claim → Section 走，
 * 一条 claim→evidence 的 supports 会让那条路径走向反了。
 *
 * Frozen because the same arrays are the domain's rejection messages and zod's own enum options: a
 * consumer that sorted one in place would quietly change what every client is allowed to write.
 */
const RESEARCH_ENTITY_TYPES: readonly ResearchEntityType[] = Object.freeze([...researchEntityTypeSchema.options]);

const EVIDENCE_TO_CLAIM: RelationPairing = Object.freeze({
  sourceTypes: Object.freeze(['evidence'] as const),
  targetTypes: Object.freeze(['claim'] as const),
});

const DECISION_TO_ANY: RelationPairing = Object.freeze({
  sourceTypes: Object.freeze(['research_decision', 'research_change'] as const),
  targetTypes: RESEARCH_ENTITY_TYPES,
});

export const RELATION_PAIRINGS: Readonly<Record<ResearchRelationType, RelationPairing>> = Object.freeze({
  supports: EVIDENCE_TO_CLAIM,
  partially_supports: EVIDENCE_TO_CLAIM,
  contradicts: EVIDENCE_TO_CLAIM,
  qualifies: EVIDENCE_TO_CLAIM,
  contextualizes: EVIDENCE_TO_CLAIM,
  answers: Object.freeze({ sourceTypes: ['claim'], targetTypes: ['research_question'] } as const),
  appears_in: Object.freeze({ sourceTypes: ['claim'], targetTypes: ['manuscript_section'] } as const),
  changes: DECISION_TO_ANY,
  affects: DECISION_TO_ANY,
  relates_to: Object.freeze({ sourceTypes: RESEARCH_ENTITY_TYPES, targetTypes: RESEARCH_ENTITY_TYPES } as const),
});

export const timelineEventTypeSchema = z.enum(['decision', 'change', 'milestone']);
export type TimelineEventType = z.infer<typeof timelineEventTypeSchema>;

export const timelineSourceSchema = z.enum(['research_decision', 'research_change', 'manual']);
export type TimelineSource = z.infer<typeof timelineSourceSchema>;

// --- entities --------------------------------------------------------------

export const researchProjectSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: researchProjectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResearchProject = z.infer<typeof researchProjectSchema>;

export const researchCharterSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  workingTitle: z.string(),
  researchTopic: z.string().nullable(),
  researchProblem: z.string().nullable(),
  researchGap: z.string().nullable(),
  researchQuestionsText: z.string().nullable(),
  coreContribution: z.string().nullable(),
  theoreticalLens: z.string().nullable(),
  researchContext: z.string().nullable(),
  unitOfAnalysis: z.string().nullable(),
  researchMethod: z.string().nullable(),
  targetArticleType: z.string().nullable(),
  targetJournal: z.string().nullable(),
  researchBoundary: z.string().nullable(),
  claimBoundary: z.string().nullable(),
  currentStage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResearchCharter = z.infer<typeof researchCharterSchema>;

export const researchQuestionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  questionCode: z.string(),
  questionText: z.string(),
  status: researchQuestionStatusSchema,
  rationale: z.string().nullable(),
  relatedMethod: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResearchQuestion = z.infer<typeof researchQuestionSchema>;

export const evidenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  type: evidenceTypeSchema,
  title: z.string(),
  description: z.string().nullable(),
  sourceReference: z.string().nullable(),
  sourceLocation: z.string().nullable(),
  reliabilityNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const claimSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  claimCode: z.string(),
  claimText: z.string(),
  claimType: claimTypeSchema,
  status: claimStatusSchema,
  confidence: z.number().min(0).max(1),
  boundary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Claim = z.infer<typeof claimSchema>;

export const manuscriptSectionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  sectionName: z.string(),
  sectionReference: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManuscriptSection = z.infer<typeof manuscriptSectionSchema>;

export const entityRelationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  sourceType: researchEntityTypeSchema,
  sourceId: z.string(),
  relationType: researchRelationTypeSchema,
  targetType: researchEntityTypeSchema,
  targetId: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type EntityRelation = z.infer<typeof entityRelationSchema>;

/** Decisions are append-only history objects (research doc §18): never rewritten, only superseded. */
export const researchDecisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  title: z.string(),
  decision: z.string(),
  reason: z.string().nullable(),
  alternatives: z.string().nullable(),
  rejectedAlternatives: z.string().nullable(),
  impact: z.string().nullable(),
  relatedEntities: jsonValueSchema,
  createdAt: z.string(),
});
export type ResearchDecision = z.infer<typeof researchDecisionSchema>;

export const researchChangeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  changeType: researchChangeTypeSchema,
  before: z.string(),
  after: z.string(),
  reason: z.string().nullable(),
  impact: z.string().nullable(),
  relatedEntities: jsonValueSchema,
  createdAt: z.string(),
});
export type ResearchChange = z.infer<typeof researchChangeSchema>;

export const driftFindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  driftType: driftTypeSchema,
  severity: driftSeveritySchema,
  description: z.string(),
  sourceEntityType: researchEntityTypeSchema.nullable(),
  sourceEntityId: z.string().nullable(),
  targetEntityType: researchEntityTypeSchema.nullable(),
  targetEntityId: z.string().nullable(),
  reason: z.string().nullable(),
  recommendedAction: z.string().nullable(),
  status: driftFindingStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriftFinding = z.infer<typeof driftFindingSchema>;

export const timelineEventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  eventType: timelineEventTypeSchema,
  occurredAt: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  sourceType: timelineSourceSchema.nullable(),
  sourceId: z.string().nullable(),
  relatedEntities: jsonValueSchema,
  createdAt: z.string(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

// --- create inputs (no identity fields: userId/projectId are set server-side
//     at the storage layer, never parsed from a request body) ----------------

export const createResearchProjectInputSchema = z.object({
  userId: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
});
export type CreateResearchProjectInput = z.infer<typeof createResearchProjectInputSchema>;

export const charterFieldsSchema = z.object({
  workingTitle: z.string().min(1).max(300),
  researchTopic: z.string().max(4000).nullable().optional(),
  researchProblem: z.string().max(4000).nullable().optional(),
  researchGap: z.string().max(4000).nullable().optional(),
  researchQuestionsText: z.string().max(4000).nullable().optional(),
  coreContribution: z.string().max(4000).nullable().optional(),
  theoreticalLens: z.string().max(4000).nullable().optional(),
  researchContext: z.string().max(4000).nullable().optional(),
  unitOfAnalysis: z.string().max(4000).nullable().optional(),
  researchMethod: z.string().max(4000).nullable().optional(),
  targetArticleType: z.string().max(300).nullable().optional(),
  targetJournal: z.string().max(300).nullable().optional(),
  researchBoundary: z.string().max(4000).nullable().optional(),
  claimBoundary: z.string().max(4000).nullable().optional(),
  currentStage: z.string().max(300).nullable().optional(),
});
export type CharterFields = z.infer<typeof charterFieldsSchema>;

export const upsertCharterInputSchema = charterFieldsSchema.extend({
  userId: z.string(),
  projectId: z.string(),
});
export type UpsertCharterInput = z.infer<typeof upsertCharterInputSchema>;

// --- approved charter baselines and review marks (R06 / R03) ----------------

/**
 * The field names a baseline can record, read off the draft's own shape so a new charter field cannot
 * be added without also becoming a name the diff may report.
 */
export const CHARTER_FIELD_NAMES = Object.keys(charterFieldsSchema.shape).sort() as (keyof CharterFields)[];
export const charterFieldNameSchema = z.enum(CHARTER_FIELD_NAMES as [string, ...string[]]);
export type CharterFieldName = z.infer<typeof charterFieldNameSchema>;

/** One end of a relation to something the user says a revision touched. */
export const researchEntityRefSchema = z.object({
  entityType: researchEntityTypeSchema,
  entityId: z.string().min(1),
});
export type ResearchEntityRef = z.infer<typeof researchEntityRefSchema>;

/**
 * R06（开发文档 §13「不可变批准版本＋当前草稿」）：一次批准 = 当时草稿的整份快照 + 相对上一基线变了哪些字段。
 * `previousVersion === null` 说的是「没有可对比的上一版」，不是「什么都没变」—— 第一版基线的
 * `changedFields` 因此是空表，而不是「14 个字段全改了」。
 */
export const charterVersionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  version: z.number().int().positive(),
  previousVersion: z.number().int().positive().nullable(),
  charter: researchCharterSchema,
  changedFields: z.array(charterFieldNameSchema),
  revisionReason: z.string(),
  decisionId: z.string().nullable(),
  approvedAt: z.string(),
});
export type CharterVersion = z.infer<typeof charterVersionSchema>;

/**
 * 什么把一条对象标成「需要复核」。`charter_baseline` 是新批准的章程基线（R06）；
 * `source_archived` 是它引用的知识对象被归档／移走了（R03）。两条都是「别装作这条绑定还有效」。
 */
export const reviewMarkRaisedBySchema = z.enum(['charter_baseline', 'source_archived']);
export type ReviewMarkRaisedBy = z.infer<typeof reviewMarkRaisedBySchema>;

export const reviewMarkStatusSchema = z.enum(['pending', 'cleared']);
export type ReviewMarkStatus = z.infer<typeof reviewMarkStatusSchema>;

/**
 * R03／R06 的「影响对象被标记」。单独一张表，而不是在 question／evidence／claim／section 各加两列：
 * 同一批对象会被不同的原因标记，而「处理完」的记录必须留着（开发文档 §14：批准新章程后保留旧结果与
 * 时间线，不能删除旧警告制造「从未偏移」的假象）。
 */
export const researchReviewMarkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  entityType: researchEntityTypeSchema,
  entityId: z.string(),
  reason: z.string(),
  raisedBy: reviewMarkRaisedBySchema,
  charterVersion: z.number().int().positive().nullable(),
  status: reviewMarkStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResearchReviewMark = z.infer<typeof researchReviewMarkSchema>;

export const createCharterVersionInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  previousVersion: z.number().int().positive().nullable(),
  charter: researchCharterSchema,
  changedFields: z.array(charterFieldNameSchema),
  revisionReason: z.string().min(1).max(2000),
  decisionId: z.string().nullable(),
});
export type CreateCharterVersionInput = z.infer<typeof createCharterVersionInputSchema>;

export const createReviewMarkInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  entityType: researchEntityTypeSchema,
  entityId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  raisedBy: reviewMarkRaisedBySchema,
  charterVersion: z.number().int().positive().nullable().optional(),
});
export type CreateReviewMarkInput = z.infer<typeof createReviewMarkInputSchema>;


export const createResearchQuestionInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  questionCode: z.string().min(1).max(50),
  questionText: z.string().min(1).max(4000),
  status: researchQuestionStatusSchema.optional(),
  rationale: z.string().max(4000).nullable().optional(),
  relatedMethod: z.string().max(1000).nullable().optional(),
});
export type CreateResearchQuestionInput = z.infer<typeof createResearchQuestionInputSchema>;

export const createEvidenceInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  type: evidenceTypeSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable().optional(),
  sourceReference: z.string().max(1000).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  reliabilityNote: z.string().max(4000).nullable().optional(),
});
export type CreateEvidenceInput = z.infer<typeof createEvidenceInputSchema>;

export const createClaimInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  claimCode: z.string().min(1).max(50),
  claimText: z.string().min(1).max(8000),
  claimType: claimTypeSchema,
  status: claimStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  boundary: z.string().max(4000).nullable().optional(),
});
export type CreateClaimInput = z.infer<typeof createClaimInputSchema>;

export const createManuscriptSectionInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  sectionName: z.string().min(1).max(300),
  sectionReference: z.string().max(300).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type CreateManuscriptSectionInput = z.infer<typeof createManuscriptSectionInputSchema>;

export const createEntityRelationInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  sourceType: researchEntityTypeSchema,
  sourceId: z.string().min(1),
  relationType: researchRelationTypeSchema,
  targetType: researchEntityTypeSchema,
  targetId: z.string().min(1),
  note: z.string().max(2000).nullable().optional(),
});
export type CreateEntityRelationInput = z.infer<typeof createEntityRelationInputSchema>;

export const createResearchDecisionInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  title: z.string().min(1).max(300),
  decision: z.string().min(1).max(8000),
  reason: z.string().max(8000).nullable().optional(),
  alternatives: z.string().max(8000).nullable().optional(),
  rejectedAlternatives: z.string().max(8000).nullable().optional(),
  impact: z.string().max(8000).nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateResearchDecisionInput = z.infer<typeof createResearchDecisionInputSchema>;

export const createResearchChangeInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  changeType: researchChangeTypeSchema,
  before: z.string().min(1).max(8000),
  after: z.string().min(1).max(8000),
  reason: z.string().max(8000).nullable().optional(),
  impact: z.string().max(8000).nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateResearchChangeInput = z.infer<typeof createResearchChangeInputSchema>;

export const createDriftFindingInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  driftType: driftTypeSchema,
  severity: driftSeveritySchema,
  description: z.string().min(1).max(8000),
  sourceEntityType: researchEntityTypeSchema.nullable().optional(),
  sourceEntityId: z.string().nullable().optional(),
  targetEntityType: researchEntityTypeSchema.nullable().optional(),
  targetEntityId: z.string().nullable().optional(),
  reason: z.string().max(8000).nullable().optional(),
  recommendedAction: z.string().max(8000).nullable().optional(),
});
export type CreateDriftFindingInput = z.infer<typeof createDriftFindingInputSchema>;

export const createTimelineEventInputSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  eventType: timelineEventTypeSchema,
  occurredAt: z.string(),
  title: z.string().min(1).max(300),
  summary: z.string().max(8000).nullable().optional(),
  sourceType: timelineSourceSchema.nullable().optional(),
  sourceId: z.string().nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateTimelineEventInput = z.infer<typeof createTimelineEventInputSchema>;

export type Nullable<T> = { [K in keyof T]: T[K] | null | undefined };
