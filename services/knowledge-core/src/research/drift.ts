/**
 * Drift Checker — deterministic rules only (research doc / contract §4).
 *
 * `runDriftChecks` is a **pure function**: it reads its input snapshot and returns finding drafts.
 * No IO, no clock, no id generation — persistence and de-duplication live in the domain wrapper
 * (`index.ts`), which stamps ids/timestamps and skips drafts whose `(driftType, sourceEntityId,
 * targetEntityId)` already has an `open` finding.
 */
import type {
  Claim,
  DriftSeverity,
  DriftType,
  EntityRelation,
  Evidence,
  ResearchChange,
  ResearchCharter,
  ResearchEntityType,
  ResearchQuestion,
} from '@noltri/schema';
import { tokenize } from '@noltri/shared';

/** A finding before it has an identity: the wrapper persists these and adds id/createdAt/status. */
export interface DriftFindingDraft {
  driftType: DriftType;
  severity: DriftSeverity;
  description: string;
  sourceEntityType: ResearchEntityType | null;
  sourceEntityId: string | null;
  targetEntityType: ResearchEntityType | null;
  targetEntityId: string | null;
  reason: string | null;
  recommendedAction: string | null;
}

export interface DriftCheckInput {
  charter: ResearchCharter | null;
  questions: ResearchQuestion[];
  evidence: Evidence[];
  claims: Claim[];
  relations: EntityRelation[];
  changes: ResearchChange[];
  /** Optional manuscript excerpt; without it the rq/contribution manuscript scans are skipped. */
  manuscriptText?: string;
}

/** Stable de-duplication key: contract §4 rule 2. */
export function driftFindingKey(finding: {
  driftType: DriftType;
  sourceEntityId: string | null;
  targetEntityId: string | null;
}): string {
  return `${finding.driftType}|${finding.sourceEntityId ?? ''}|${finding.targetEntityId ?? ''}`;
}

// --- rule patterns (contract §4) -------------------------------------------

/** Contract §4 wording, verbatim (substring semantics on purpose). */
const STRONG_CAUSAL_PATTERN =
  /cause|causes|caused|lead(s)? to|result(s)? in|impact|impacts|determine(s)?|drive(s)?|导致|影响|决定|造成/i;

const WEAKENING_PATTERN =
  /suggest|indicate|association|associat|correlat|not causal|may|might|可能|相关|关联|非因果|不构成因果/i;

/** Evidence types that do not carry statistical weight for a causal claim. */
const NON_STATISTICAL_EVIDENCE: ReadonlySet<string> = new Set([
  'expert_judgement',
  'note',
  'interview',
  'document',
  'external_source',
  'other',
]);

const CONTRIBUTION_SENTENCE_PATTERN = /contribut|贡献/i;

const RQ_CODE_PATTERN = /\bRQ\d+\b/i;
const RQ_START_PATTERN = /^(whether|how|what|why|to what extent)\b/i;
const RQ_CJK_PATTERN = /研究问题|我们是否/;

const SUPPORTING_RELATIONS: ReadonlySet<string> = new Set(['supports', 'partially_supports']);

/** Map relation vocabulary — contract §3 keeps exactly these seven edges. */
export const MAP_RELATION_TYPES: ReadonlySet<string> = new Set([
  'supports',
  'partially_supports',
  'contradicts',
  'qualifies',
  'contextualizes',
  'answers',
  'appears_in',
]);

// --- text helpers (pure; no shared clock/IO) --------------------------------

const SENTENCE_PATTERN = /[^。！？!?；;.\n]+[。！？!?；;.\n]?/g;

export function splitSentencesLoose(text: string): string[] {
  return (text.match(SENTENCE_PATTERN) ?? [])
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/** Lowercased, punctuation/whitespace-free form used for containment matching. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'be', 'been', 'this', 'that', 'these', 'those', 'with', 'as', 'by', 'at', 'from', 'it', 'its',
  'we', 'our', 'their', 'they', 'not', 'no', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'have', 'has', 'had', 'do', 'does', 'did', 'but', 'if', 'than', 'then', 'so', 'such',
  '的', '了', '是', '在', '和', '与', '及', '对', '中', '为', '并', '或', '也', '就', '都', '很',
  '等', '这', '那', '我们', '你', '我', '他', '她', '它们', '一个', '一种',
]);

/** Token overlap after stopword filtering; `|shared| / min(|a|, |b|)` like `@noltri/shared`. */
export function contentTokenOverlap(first: string, second: string): number {
  const toSet = (text: string): Set<string> =>
    new Set(tokenize(text).filter((token) => !STOPWORDS.has(token)));
  const a = toSet(first);
  const b = toSet(second);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

const CONTRIBUTION_OVERLAP_THRESHOLD = 0.2;

// --- rule implementations ---------------------------------------------------

function hasSupportingEvidence(claimId: string, relations: EntityRelation[]): boolean {
  return relations.some(
    (relation) =>
      SUPPORTING_RELATIONS.has(relation.relationType) &&
      relation.targetType === 'claim' &&
      relation.targetId === claimId,
  );
}

function supportingEvidenceOf(claimId: string, relations: EntityRelation[], evidence: Evidence[]): Evidence[] {
  const ids = new Set(
    relations
      .filter(
        (relation) =>
          SUPPORTING_RELATIONS.has(relation.relationType) &&
          relation.targetType === 'claim' &&
          relation.targetId === claimId,
      )
      .map((relation) => relation.sourceId),
  );
  return evidence.filter((item) => ids.has(item.id));
}

/** Rule 1: a claim without supports / partially_supports relations. */
function evidenceDrift(claims: Claim[], relations: EntityRelation[]): DriftFindingDraft[] {
  const drafts: DriftFindingDraft[] = [];
  for (const claim of claims) {
    if (hasSupportingEvidence(claim.id, relations)) continue;
    drafts.push({
      driftType: 'evidence_drift',
      severity: claim.status === 'confirmed' ? 'critical' : 'warning',
      description: `Claim ${claim.claimCode} 没有任何 supports / partially_supports 证据支撑 / claim has no supporting evidence`,
      sourceEntityType: 'claim',
      sourceEntityId: claim.id,
      targetEntityType: null,
      targetEntityId: null,
      reason: '证据-主张支撑关系缺失，主张处于悬空状态 / no supporting evidence relation exists',
      recommendedAction: '补充 Evidence、弱化 Claim 或改为 Future Research',
    });
  }
  return drafts;
}

/** Rule 2: strong causal wording backed only by non-statistical evidence. */
function causalityDrift(claims: Claim[], relations: EntityRelation[], evidence: Evidence[]): DriftFindingDraft[] {
  const drafts: DriftFindingDraft[] = [];
  for (const claim of claims) {
    if (!STRONG_CAUSAL_PATTERN.test(claim.claimText)) continue;
    const supporters = supportingEvidenceOf(claim.id, relations, evidence);
    const nonStatistical = supporters.filter((item) => NON_STATISTICAL_EVIDENCE.has(item.type));
    const noSupport = supporters.length === 0;
    const mostlyNonStatistical =
      supporters.length > 0 && nonStatistical.length * 2 > supporters.length;
    if (!noSupport && !mostlyNonStatistical) continue;

    const boundary = claim.boundary?.trim() ?? '';
    const severity: DriftSeverity =
      boundary.length === 0 ? 'critical' : WEAKENING_PATTERN.test(boundary) ? 'info' : 'warning';

    drafts.push({
      driftType: 'causality_drift',
      severity,
      description: `Claim ${claim.claimCode} 使用强因果表述，但支持证据以非统计类型为主 / causal claim lacks statistical evidence`,
      sourceEntityType: 'claim',
      sourceEntityId: claim.id,
      targetEntityType: null,
      targetEntityId: null,
      reason: noSupport
        ? '该主张没有任何支持证据 / the claim has no supporting evidence'
        : `支持证据中 ${nonStatistical.length}/${supporters.length} 为非统计类型 / most supporting evidence is non-statistical`,
      recommendedAction: '弱化为相关性表述或在 boundary 中限定推断程度（对照 Claim Boundary）',
    });
  }
  return drafts;
}

function isResearchQuestionSignal(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (/[?？]\s*$/.test(trimmed)) return true;
  if (RQ_CODE_PATTERN.test(trimmed)) return true;
  if (RQ_START_PATTERN.test(trimmed)) return true;
  return RQ_CJK_PATTERN.test(trimmed);
}

/** Rule 3: manuscript research questions that no charter/question text answers. */
function rqDrift(
  charter: ResearchCharter | null,
  questions: ResearchQuestion[],
  manuscriptText: string | undefined,
): DriftFindingDraft[] {
  if (manuscriptText === undefined || manuscriptText.trim().length === 0) return [];

  const references: string[] = [];
  if (charter?.researchQuestionsText) references.push(charter.researchQuestionsText);
  for (const question of questions) {
    references.push(question.questionCode, question.questionText);
  }
  const normalizedReferences = references.map(normalizeForMatch).filter((value) => value.length > 0);

  const drafts: DriftFindingDraft[] = [];
  for (const sentence of splitSentencesLoose(manuscriptText)) {
    if (!isResearchQuestionSignal(sentence)) continue;
    const normalized = normalizeForMatch(sentence);
    const matched =
      normalized.length === 0 ||
      normalizedReferences.some(
        (reference) => reference.includes(normalized) || normalized.includes(reference),
      );
    if (matched) continue;
    drafts.push({
      driftType: 'rq_drift',
      severity: 'warning',
      description: `正文出现未登记的研究问题：「${sentence.trim()}」 / manuscript question is not registered`,
      sourceEntityType: 'research_charter',
      sourceEntityId: charter?.id ?? null,
      targetEntityType: null,
      targetEntityId: null,
      reason: '正文研究问题与 Charter / 已登记 Research Question 不匹配 / no normalized containment match',
      recommendedAction: '将该问题登记到 Charter 或 Research Questions，或修订正文表述',
    });
  }
  return drafts;
}

/** Rule 4: contribution claims / manuscript contribution wording detached from the charter. */
function contributionDrift(
  charter: ResearchCharter | null,
  claims: Claim[],
  manuscriptText: string | undefined,
): DriftFindingDraft[] {
  const coreContribution = charter?.coreContribution?.trim() ?? '';
  const drafts: DriftFindingDraft[] = [];

  for (const claim of claims) {
    if (claim.claimType !== 'contribution') continue;
    const overlap = contentTokenOverlap(claim.claimText, coreContribution);
    if (coreContribution.length > 0 && overlap >= CONTRIBUTION_OVERLAP_THRESHOLD) continue;
    drafts.push({
      driftType: 'contribution_drift',
      severity: coreContribution.length === 0 ? 'critical' : 'warning',
      description: `Claim ${claim.claimCode}（contribution）与 Charter 的 Core Contribution 脱节 / contribution claim diverges from the charter`,
      sourceEntityType: 'claim',
      sourceEntityId: claim.id,
      targetEntityType: charter === null ? null : 'research_charter',
      targetEntityId: charter?.id ?? null,
      reason:
        coreContribution.length === 0
          ? 'Charter 的 Core Contribution 为空 / core contribution is empty'
          : `token 重合率 ${overlap.toFixed(2)} < ${CONTRIBUTION_OVERLAP_THRESHOLD}`,
      recommendedAction: '对齐 Core Contribution 表述，或改写 Claim / 更新 Charter',
    });
  }

  if (manuscriptText !== undefined && manuscriptText.trim().length > 0) {
    const sentences = splitSentencesLoose(manuscriptText).filter((sentence) =>
      CONTRIBUTION_SENTENCE_PATTERN.test(sentence),
    );
    if (sentences.length > 0) {
      const overlap = contentTokenOverlap(sentences.join('\n'), coreContribution);
      if (coreContribution.length === 0 || overlap < CONTRIBUTION_OVERLAP_THRESHOLD) {
        drafts.push({
          driftType: 'contribution_drift',
          severity: coreContribution.length === 0 ? 'critical' : 'warning',
          description: `正文贡献表述与 Charter 的 Core Contribution 脱节：「${sentences[0]!.trim()}」 / manuscript contribution wording diverges from the charter`,
          sourceEntityType: 'research_charter',
          sourceEntityId: charter?.id ?? null,
          targetEntityType: null,
          targetEntityId: null,
          reason:
            coreContribution.length === 0
              ? 'Charter 的 Core Contribution 为空 / core contribution is empty'
              : `token 重合率 ${overlap.toFixed(2)} < ${CONTRIBUTION_OVERLAP_THRESHOLD}`,
          recommendedAction: '对齐正文贡献表述与 Charter 的 Core Contribution',
        });
      }
    }
  }

  return drafts;
}

function isAfter(change: ResearchChange, charter: ResearchCharter): boolean {
  return new Date(change.createdAt).getTime() > new Date(charter.updatedAt).getTime();
}

/** Rule 5: method changed after the charter was last touched. */
function methodDrift(charter: ResearchCharter | null, changes: ResearchChange[]): DriftFindingDraft[] {
  if (charter === null) return [];
  return changes
    .filter((change) => change.changeType === 'method' && isAfter(change, charter))
    .map((change) => ({
      driftType: 'method_drift' as const,
      severity: 'warning' as const,
      description: `研究方法已变更（${change.before} → ${change.after}）但 Charter 未同步 / method changed while the charter is stale`,
      sourceEntityType: 'research_change' as const,
      sourceEntityId: change.id,
      targetEntityType: 'research_charter' as const,
      targetEntityId: charter.id,
      reason: '方法已变而 Charter 的 Research Method / RQ / Boundary 未同步 / charter predates the method change',
      recommendedAction: '同步更新 Charter 的 Research Method、Research Questions 与 Boundary',
    }));
}

/** Rule 6: journal pivots, or contribution/scope changes after a journal was picked. */
function journalDrift(charter: ResearchCharter | null, changes: ResearchChange[]): DriftFindingDraft[] {
  if (charter === null) return [];
  const drafts: DriftFindingDraft[] = [];
  for (const change of changes) {
    if (!isAfter(change, charter)) continue;
    const journalPivot = change.changeType === 'journal';
    const retargeted =
      (charter.targetJournal ?? '').trim().length > 0 &&
      (change.changeType === 'contribution' || change.changeType === 'scope');
    if (!journalPivot && !retargeted) continue;
    drafts.push({
      driftType: 'journal_drift',
      severity: 'warning',
      description: journalPivot
        ? `目标期刊已变更（${change.before} → ${change.after}）但 Charter 未同步 / journal changed while the charter is stale`
        : `面向目标期刊的 ${change.changeType} 变更（${change.before} → ${change.after}）未同步到 Charter / contribution or scope changed for the target journal while the charter is stale`,
      sourceEntityType: 'research_change',
      sourceEntityId: change.id,
      targetEntityType: 'research_charter',
      targetEntityId: charter.id,
      reason: '期刊相关变更晚于 Charter 更新时间 / journal-related change postdates the charter',
      recommendedAction: '同步更新 Charter 的 Target Journal、Core Contribution 与 Research Boundary',
    });
  }
  return drafts;
}

/**
 * Deterministic drift rules 1–6 over a plain snapshot. Pure: same input, same drafts.
 * De-duplication against previously persisted findings happens in the domain wrapper.
 */
export function runDriftChecks(input: DriftCheckInput): DriftFindingDraft[] {
  return [
    ...evidenceDrift(input.claims, input.relations),
    ...causalityDrift(input.claims, input.relations, input.evidence),
    ...rqDrift(input.charter, input.questions, input.manuscriptText),
    ...contributionDrift(input.charter, input.claims, input.manuscriptText),
    ...methodDrift(input.charter, input.changes),
    ...journalDrift(input.charter, input.changes),
  ];
}
