/**
 * Research Context Pack — pure assembly of the §33 block list (contract §5).
 *
 * No IO and no clock: the caller gathers the snapshot and stamps `generatedAt`. `markdown` is the
 * same content as `blocks` joined in order, so the UI can render either form.
 */
import type {
  Claim,
  DriftFinding,
  EntityRelation,
  Evidence,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchProject,
  ResearchQuestion,
} from '@noltri/schema';
import type { ContextPackBlock } from '@noltri/schema';

export interface ContextPackInput {
  project: ResearchProject;
  charter: ResearchCharter | null;
  questions: ResearchQuestion[];
  claims: Claim[];
  evidence: Evidence[];
  relations: EntityRelation[];
  decisions: ResearchDecision[];
  changes: ResearchChange[];
  /** Findings with `status='open'` — the only ones the pack warns about. */
  openFindings: DriftFinding[];
}

const EMPTY = '（未填写）';
const SUPPORTING_RELATIONS: ReadonlySet<string> = new Set(['supports', 'partially_supports']);

function lines(items: string[]): string {
  return items.length === 0 ? EMPTY : items.map((item) => `- ${item}`).join('\n');
}

function byCreatedAtDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * The twelve §5 blocks in contract order. `markdown` is produced from the very same strings so the
 * two representations can never disagree.
 */
export function buildContextPack(input: ContextPackInput): { blocks: ContextPackBlock[]; markdown: string } {
  const { project, charter, questions, claims, evidence, relations, decisions, changes, openFindings } = input;

  const confirmedClaims = claims.filter((claim) => claim.status === 'confirmed');
  const confirmedClaimIds = new Set(confirmedClaims.map((claim) => claim.id));
  const keyEvidenceIds = new Set(
    relations
      .filter(
        (relation) =>
          SUPPORTING_RELATIONS.has(relation.relationType) &&
          relation.targetType === 'claim' &&
          confirmedClaimIds.has(relation.targetId),
      )
      .map((relation) => relation.sourceId),
  );
  const keyEvidence = evidence.filter((item) => keyEvidenceIds.has(item.id));

  const openQuestions = questions.filter((question) => question.status === 'open');
  const relatedMethods = Array.from(
    new Set(questions.map((question) => question.relatedMethod?.trim()).filter((value): value is string => !!value)),
  );
  const currentMethod = [charter?.researchMethod?.trim() ?? '', ...relatedMethods]
    .filter((value) => value.length > 0)
    .join('；');

  const blocks: ContextPackBlock[] = [
    {
      heading: 'PROJECT',
      body: `${project.name}${charter?.currentStage ? `（${charter.currentStage}）` : ''}`,
    },
    {
      heading: 'Current Research Question',
      body: lines(questions.map((question) => `[${question.questionCode}] ${question.questionText}（${question.status}）`)),
    },
    { heading: 'Core Contribution', body: charter?.coreContribution?.trim() || EMPTY },
    { heading: 'Research Boundary', body: charter?.researchBoundary?.trim() || EMPTY },
    { heading: 'Claim Boundary', body: charter?.claimBoundary?.trim() || EMPTY },
    { heading: 'Current Method', body: currentMethod.length > 0 ? currentMethod : EMPTY },
    {
      heading: 'Confirmed Claims',
      body: lines(confirmedClaims.map((claim) => `[${claim.claimCode}] ${claim.claimText}`)),
    },
    {
      heading: 'Key Evidence',
      body: lines(keyEvidence.map((item) => `${item.title}（${item.type}）`)),
    },
    {
      heading: 'Important Decisions',
      body: lines(byCreatedAtDesc(decisions).slice(0, 5).map((decision) => `${decision.title}：${decision.decision}`)),
    },
    {
      heading: 'Recent Changes',
      body: lines(byCreatedAtDesc(changes).slice(0, 5).map((change) => `${change.changeType}：${change.before} → ${change.after}`)),
    },
    {
      heading: 'Open Issues',
      body: `开放研究问题 ${openQuestions.length} 条；未处理 drift findings ${openFindings.length} 条 / ${openQuestions.length} open RQ(s), ${openFindings.length} open finding(s)`,
    },
    {
      heading: 'Current Drift Warnings',
      body: lines(openFindings.map((finding) => `[${finding.severity}] ${finding.description}`)),
    },
  ];

  const markdown = blocks.map((block) => `## ${block.heading}\n${block.body}`).join('\n\n');
  return { blocks, markdown };
}
