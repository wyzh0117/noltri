/**
 * Research Map — the aggregated layer graph (contract §3).
 *
 * Pure assembly over a repository snapshot: `questions → evidence → claims → sections →
 * charter.coreContribution`. The server never lays the graph out — the UI does. Edges are limited to
 * the map vocabulary and the (evidence→claim / claim→question / claim→section) triples.
 */
import type {
  Claim,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchCharter,
  ResearchMapResponse,
  ResearchProject,
  ResearchQuestion,
} from '@noltri/schema';
import { MAP_RELATION_TYPES } from './drift';

export interface ResearchMapInput {
  project: ResearchProject;
  charter: ResearchCharter | null;
  questions: ResearchQuestion[];
  evidence: Evidence[];
  claims: Claim[];
  sections: ManuscriptSection[];
  relations: EntityRelation[];
}

const SUPPORTING_RELATIONS: ReadonlySet<string> = new Set(['supports', 'partially_supports']);

/** Only evidence→claim, claim→research_question and claim→manuscript_section triples draw an edge. */
function isMapEdge(relation: EntityRelation): boolean {
  if (!MAP_RELATION_TYPES.has(relation.relationType)) return false;
  const { sourceType, targetType } = relation;
  return (
    (sourceType === 'evidence' && targetType === 'claim') ||
    (sourceType === 'claim' && targetType === 'research_question') ||
    (sourceType === 'claim' && targetType === 'manuscript_section')
  );
}

export function buildResearchMap(input: ResearchMapInput): ResearchMapResponse {
  const { project, charter, questions, evidence, claims, sections, relations } = input;
  const mapRelations = relations.filter(isMapEdge);

  const supportedClaimIds = new Set(
    mapRelations
      .filter(
        (relation) =>
          SUPPORTING_RELATIONS.has(relation.relationType) &&
          relation.sourceType === 'evidence' &&
          relation.targetType === 'claim',
      )
      .map((relation) => relation.targetId),
  );

  return {
    project: { id: project.id, name: project.name, status: project.status },
    charter: {
      workingTitle: charter?.workingTitle ?? '',
      coreContribution: charter?.coreContribution ?? null,
      researchBoundary: charter?.researchBoundary ?? null,
      claimBoundary: charter?.claimBoundary ?? null,
      currentStage: charter?.currentStage ?? null,
    },
    questions: questions.map((question) => ({
      id: question.id,
      questionCode: question.questionCode,
      questionText: question.questionText,
      status: question.status,
    })),
    evidence: evidence.map((item) => ({ id: item.id, type: item.type, title: item.title })),
    claims: claims.map((claim) => ({
      id: claim.id,
      claimCode: claim.claimCode,
      claimText: claim.claimText,
      claimType: claim.claimType,
      status: claim.status,
      supported: supportedClaimIds.has(claim.id),
    })),
    sections: sections.map((section) => ({
      id: section.id,
      sectionName: section.sectionName,
      sectionReference: section.sectionReference,
    })),
    edges: mapRelations.map((relation) => ({
      id: relation.id,
      sourceType: relation.sourceType,
      sourceId: relation.sourceId,
      relationType: relation.relationType,
      targetType: relation.targetType,
      targetId: relation.targetId,
    })),
    unsupportedClaimIds: claims
      .filter((claim) => !supportedClaimIds.has(claim.id))
      .map((claim) => claim.id),
  };
}
