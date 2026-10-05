import { z } from 'zod';
import { jsonValueSchema } from './knowledge';
import {
  charterFieldsSchema,
  charterVersionSchema,
  claimSchema,
  claimStatusSchema,
  claimTypeSchema,
  driftFindingSchema,
  driftFindingStatusSchema,
  driftSeveritySchema,
  driftTypeSchema,
  entityRelationSchema,
  evidenceSchema,
  evidenceTypeSchema,
  manuscriptSectionSchema,
  researchChangeSchema,
  researchChangeTypeSchema,
  researchCharterSchema,
  researchDecisionSchema,
  researchEntityRefSchema,
  researchProjectSchema,
  researchQuestionSchema,
  researchRelationTypeSchema,
  researchEntityTypeSchema,
  researchReviewMarkSchema,
  reviewMarkStatusSchema,
  timelineEventSchema,
} from './research';

/**
 * REST contract for `/api/research/*` (research doc §9–§33).
 *
 * Rules shared with the knowledge API: identity comes from credentials only, errors use the
 * frozen envelope from `api.ts`, list responses are wrapped so the contract can grow.
 */

// --- projects --------------------------------------------------------------

export const createResearchProjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
});
export type CreateResearchProjectRequest = z.infer<typeof createResearchProjectRequestSchema>;

export const patchResearchProjectRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  status: researchProjectSchema.shape.status.optional(),
});
export type PatchResearchProjectRequest = z.infer<typeof patchResearchProjectRequestSchema>;

export const researchProjectListResponseSchema = z.object({
  projects: z.array(researchProjectSchema),
});
export type ResearchProjectListResponse = z.infer<typeof researchProjectListResponseSchema>;

// --- charter ---------------------------------------------------------------

export const charterRequestSchema = charterFieldsSchema;
export type CharterRequest = z.infer<typeof charterRequestSchema>;

export const charterResponseSchema = z.object({
  charter: researchCharterSchema.nullable(),
});
export type CharterResponse = z.infer<typeof charterResponseSchema>;

// --- approved baselines and review marks (R06 / R03) ---------------------------------

export const approveCharterRequestSchema = z.object({
  revisionReason: z.string().min(1).max(2000),
  decisionId: z.string().nullable().optional(),
  /**
   * 这次修订动到了哪些对象。批准必须带上理由，而「动到了什么」由调用方点名 —— domain 逐个证明它
   * 属于本项目，不替用户猜哪些论点受影响（猜出来的范围会变成一个没人同意的偏移规则）。
   */
  affectedEntities: z.array(researchEntityRefSchema).max(200).optional(),
});
export type ApproveCharterRequest = z.infer<typeof approveCharterRequestSchema>;

export const charterVersionListResponseSchema = z.object({
  versions: z.array(charterVersionSchema),
});
export type CharterVersionListResponse = z.infer<typeof charterVersionListResponseSchema>;

export const charterBaselineResponseSchema = z.object({
  baseline: charterVersionSchema.nullable(),
});
export type CharterBaselineResponse = z.infer<typeof charterBaselineResponseSchema>;

export const reviewMarkListQuerySchema = z.object({
  status: reviewMarkStatusSchema.optional(),
  entityType: researchEntityTypeSchema.optional(),
  entityId: z.string().min(1).optional(),
});
export type ReviewMarkListQuery = z.infer<typeof reviewMarkListQuerySchema>;

export const reviewMarkListResponseSchema = z.object({
  marks: z.array(researchReviewMarkSchema),
});
export type ReviewMarkListResponse = z.infer<typeof reviewMarkListResponseSchema>;

// --- questions -------------------------------------------------------------

export const createResearchQuestionRequestSchema = z.object({
  questionCode: z.string().min(1).max(50),
  questionText: z.string().min(1).max(4000),
  rationale: z.string().max(4000).nullable().optional(),
  relatedMethod: z.string().max(1000).nullable().optional(),
});
export type CreateResearchQuestionRequest = z.infer<typeof createResearchQuestionRequestSchema>;

export const patchResearchQuestionRequestSchema = z.object({
  questionCode: z.string().min(1).max(50).optional(),
  questionText: z.string().min(1).max(4000).optional(),
  status: researchQuestionSchema.shape.status.optional(),
  rationale: z.string().max(4000).nullable().optional(),
  relatedMethod: z.string().max(1000).nullable().optional(),
});
export type PatchResearchQuestionRequest = z.infer<typeof patchResearchQuestionRequestSchema>;

export const researchQuestionListResponseSchema = z.object({
  questions: z.array(researchQuestionSchema),
});
export type ResearchQuestionListResponse = z.infer<typeof researchQuestionListResponseSchema>;

// --- evidence --------------------------------------------------------------

export const createEvidenceRequestSchema = z.object({
  type: evidenceTypeSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable().optional(),
  sourceReference: z.string().max(1000).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  reliabilityNote: z.string().max(4000).nullable().optional(),
});
export type CreateEvidenceRequest = z.infer<typeof createEvidenceRequestSchema>;

export const patchEvidenceRequestSchema = z.object({
  type: evidenceTypeSchema.optional(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(8000).nullable().optional(),
  sourceReference: z.string().max(1000).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  reliabilityNote: z.string().max(4000).nullable().optional(),
});
export type PatchEvidenceRequest = z.infer<typeof patchEvidenceRequestSchema>;

export const evidenceListQuerySchema = z.object({
  type: evidenceTypeSchema.optional(),
});
export type EvidenceListQuery = z.infer<typeof evidenceListQuerySchema>;

export const evidenceListResponseSchema = z.object({
  evidence: z.array(evidenceSchema),
});
export type EvidenceListResponse = z.infer<typeof evidenceListResponseSchema>;

// --- claims ----------------------------------------------------------------

export const createClaimRequestSchema = z.object({
  claimCode: z.string().min(1).max(50),
  claimText: z.string().min(1).max(8000),
  claimType: claimTypeSchema,
  status: claimStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  boundary: z.string().max(4000).nullable().optional(),
});
export type CreateClaimRequest = z.infer<typeof createClaimRequestSchema>;

export const patchClaimRequestSchema = z.object({
  claimCode: z.string().min(1).max(50).optional(),
  claimText: z.string().min(1).max(8000).optional(),
  claimType: claimTypeSchema.optional(),
  status: claimStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  boundary: z.string().max(4000).nullable().optional(),
});
export type PatchClaimRequest = z.infer<typeof patchClaimRequestSchema>;

export const claimListQuerySchema = z.object({
  status: claimStatusSchema.optional(),
  claimType: claimTypeSchema.optional(),
});
export type ClaimListQuery = z.infer<typeof claimListQuerySchema>;

export const claimListResponseSchema = z.object({
  claims: z.array(claimSchema),
});
export type ClaimListResponse = z.infer<typeof claimListResponseSchema>;

// --- manuscript sections ---------------------------------------------------

export const createSectionRequestSchema = z.object({
  sectionName: z.string().min(1).max(300),
  sectionReference: z.string().max(300).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type CreateSectionRequest = z.infer<typeof createSectionRequestSchema>;

export const patchSectionRequestSchema = z.object({
  sectionName: z.string().min(1).max(300).optional(),
  sectionReference: z.string().max(300).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type PatchSectionRequest = z.infer<typeof patchSectionRequestSchema>;

export const sectionListResponseSchema = z.object({
  sections: z.array(manuscriptSectionSchema),
});
export type SectionListResponse = z.infer<typeof sectionListResponseSchema>;

// --- relations -------------------------------------------------------------

export const createEntityRelationRequestSchema = z.object({
  sourceType: researchEntityTypeSchema,
  sourceId: z.string().min(1),
  relationType: researchRelationTypeSchema,
  targetType: researchEntityTypeSchema,
  targetId: z.string().min(1),
  note: z.string().max(2000).nullable().optional(),
});
export type CreateEntityRelationRequest = z.infer<typeof createEntityRelationRequestSchema>;

export const relationListQuerySchema = z.object({
  sourceType: researchEntityTypeSchema.optional(),
  sourceId: z.string().optional(),
  targetType: researchEntityTypeSchema.optional(),
  targetId: z.string().optional(),
  relationType: researchRelationTypeSchema.optional(),
});
export type RelationListQuery = z.infer<typeof relationListQuerySchema>;

export const relationListResponseSchema = z.object({
  relations: z.array(entityRelationSchema),
});
export type RelationListResponse = z.infer<typeof relationListResponseSchema>;

export const deleteRelationResponseSchema = z.object({
  deleted: z.boolean(),
  id: z.string(),
});
export type DeleteRelationResponse = z.infer<typeof deleteRelationResponseSchema>;

// --- decisions / changes ---------------------------------------------------

export const createResearchDecisionRequestSchema = z.object({
  title: z.string().min(1).max(300),
  decision: z.string().min(1).max(8000),
  reason: z.string().max(8000).nullable().optional(),
  alternatives: z.string().max(8000).nullable().optional(),
  rejectedAlternatives: z.string().max(8000).nullable().optional(),
  impact: z.string().max(8000).nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateResearchDecisionRequest = z.infer<typeof createResearchDecisionRequestSchema>;

export const researchDecisionListResponseSchema = z.object({
  decisions: z.array(researchDecisionSchema),
});
export type ResearchDecisionListResponse = z.infer<typeof researchDecisionListResponseSchema>;

export const createResearchChangeRequestSchema = z.object({
  changeType: researchChangeTypeSchema,
  before: z.string().min(1).max(8000),
  after: z.string().min(1).max(8000),
  reason: z.string().max(8000).nullable().optional(),
  impact: z.string().max(8000).nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateResearchChangeRequest = z.infer<typeof createResearchChangeRequestSchema>;

export const changeListQuerySchema = z.object({
  changeType: researchChangeTypeSchema.optional(),
});
export type ChangeListQuery = z.infer<typeof changeListQuerySchema>;

export const researchChangeListResponseSchema = z.object({
  changes: z.array(researchChangeSchema),
});
export type ResearchChangeListResponse = z.infer<typeof researchChangeListResponseSchema>;

// --- timeline --------------------------------------------------------------

export const createTimelineEventRequestSchema = z.object({
  occurredAt: z.string().min(1),
  title: z.string().min(1).max(300),
  summary: z.string().max(8000).nullable().optional(),
  relatedEntities: jsonValueSchema.optional(),
});
export type CreateTimelineEventRequest = z.infer<typeof createTimelineEventRequestSchema>;

export const timelineListResponseSchema = z.object({
  events: z.array(timelineEventSchema),
});
export type TimelineListResponse = z.infer<typeof timelineListResponseSchema>;

// --- drift -----------------------------------------------------------------

export const driftCheckRequestSchema = z.object({
  /** Optional manuscript excerpt (abstract / discussion). Enables RQ & Contribution drift scanning. */
  manuscriptText: z.string().max(200_000).optional(),
});
export type DriftCheckRequest = z.infer<typeof driftCheckRequestSchema>;

export const driftSummarySchema = z.object({
  total: z.number().int(),
  info: z.number().int(),
  warning: z.number().int(),
  critical: z.number().int(),
});
export type DriftSummary = z.infer<typeof driftSummarySchema>;

export const driftCheckResponseSchema = z.object({
  findings: z.array(driftFindingSchema),
  summary: driftSummarySchema,
});
export type DriftCheckResponse = z.infer<typeof driftCheckResponseSchema>;

export const driftFindingListQuerySchema = z.object({
  status: driftFindingStatusSchema.optional(),
  driftType: driftTypeSchema.optional(),
  severity: driftSeveritySchema.optional(),
});
export type DriftFindingListQuery = z.infer<typeof driftFindingListQuerySchema>;

export const driftFindingListResponseSchema = z.object({
  findings: z.array(driftFindingSchema),
});
export type DriftFindingListResponse = z.infer<typeof driftFindingListResponseSchema>;

export const patchDriftFindingRequestSchema = z.object({
  status: driftFindingStatusSchema,
});
export type PatchDriftFindingRequest = z.infer<typeof patchDriftFindingRequestSchema>;

// --- research map ----------------------------------------------------------

export const researchMapQuestionSchema = z.object({
  id: z.string(),
  questionCode: z.string(),
  questionText: z.string(),
  status: researchQuestionSchema.shape.status,
});

export const researchMapEvidenceSchema = z.object({
  id: z.string(),
  type: evidenceTypeSchema,
  title: z.string(),
});

export const researchMapClaimSchema = z.object({
  id: z.string(),
  claimCode: z.string(),
  claimText: z.string(),
  claimType: claimTypeSchema,
  status: claimStatusSchema,
  /** True when at least one supports / partially_supports relation exists. */
  supported: z.boolean(),
});

export const researchMapSectionSchema = z.object({
  id: z.string(),
  sectionName: z.string(),
  sectionReference: z.string().nullable(),
});

export const researchMapEdgeSchema = z.object({
  id: z.string(),
  sourceType: researchEntityTypeSchema,
  sourceId: z.string(),
  relationType: researchRelationTypeSchema,
  targetType: researchEntityTypeSchema,
  targetId: z.string(),
});

export const researchMapResponseSchema = z.object({
  project: z.object({ id: z.string(), name: z.string(), status: researchProjectSchema.shape.status }),
  charter: z.object({
    workingTitle: z.string(),
    coreContribution: z.string().nullable(),
    researchBoundary: z.string().nullable(),
    claimBoundary: z.string().nullable(),
    currentStage: z.string().nullable(),
  }),
  questions: z.array(researchMapQuestionSchema),
  evidence: z.array(researchMapEvidenceSchema),
  claims: z.array(researchMapClaimSchema),
  sections: z.array(researchMapSectionSchema),
  edges: z.array(researchMapEdgeSchema),
  /** Claims with no supporting evidence — the map shows these as dangling. */
  unsupportedClaimIds: z.array(z.string()),
});
export type ResearchMapResponse = z.infer<typeof researchMapResponseSchema>;

// --- context pack ----------------------------------------------------------

export const contextPackBlockSchema = z.object({
  heading: z.string(),
  body: z.string(),
});
export type ContextPackBlock = z.infer<typeof contextPackBlockSchema>;

export const researchContextPackResponseSchema = z.object({
  markdown: z.string(),
  blocks: z.array(contextPackBlockSchema),
  generatedAt: z.string(),
});
export type ResearchContextPackResponse = z.infer<typeof researchContextPackResponseSchema>;
