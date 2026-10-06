import type { ReactElement } from 'react';
import type {
  Claim,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchRelationType,
  ResearchQuestion,
} from '@noltri/schema';
import { researchEntityTypeLabels, researchRelationLabel } from '@noltri/shared';
import {
  RELATION_MODES,
  claimEvidenceLinks,
  claimIsSupported,
  claimLine,
  relationIsSendable,
  relationMode,
  sectionClaims,
  type RelationMode,
} from './research-model';

export interface RelationDraft {
  readonly modeKey: RelationMode['key'];
  readonly relationType: ResearchRelationType;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface ClaimPanelProps {
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  questions: readonly ResearchQuestion[];
  sections: readonly ManuscriptSection[];
  relations: readonly EntityRelation[];
  draft: RelationDraft;
  busy: boolean;
  error: string | null;
  feedback: string | null;
  onMode: (key: RelationMode['key']) => void;
  onType: (relationType: ResearchRelationType) => void;
  onSource: (id: string) => void;
  onTarget: (id: string) => void;
  onCreateRelation: () => void;
  onDeleteRelation: (relationId: string) => void;
}

interface SourceOption {
  readonly id: string;
  readonly label: string;
}

function sourceOptions(mode: RelationMode, claims: readonly Claim[], evidence: readonly Evidence[]): readonly SourceOption[] {
  if (mode.sourceType === 'evidence') return evidence.map((row) => ({ id: row.id, label: row.title }));
  return claims.map((claim) => ({ id: claim.id, label: `${claim.claimCode} ${claim.claimText}` }));
}

function targetOptions(
  mode: RelationMode,
  claims: readonly Claim[],
  questions: readonly ResearchQuestion[],
  sections: readonly ManuscriptSection[],
): readonly SourceOption[] {
  if (mode.targetType === 'claim') return claims.map((claim) => ({ id: claim.id, label: `${claim.claimCode} ${claim.claimText}` }));
  if (mode.targetType === 'research_question') {
    return questions.map((row) => ({ id: row.id, label: `${row.questionCode} ${row.questionText}` }));
  }
  return sections.map((row) => ({ id: row.id, label: row.sectionName }));
}

/**
 * 论点与章节 (V1_DEVELOPMENT §13「论点」「章节」+ R02): the 关系 form only offers the three shapes the
 * vocabulary admits (证据→论点、论点→问题、论点→章节), and the kind list inside a shape comes from the same
 * table the domain enforces — a reversed or invented edge is not constructible here, not merely rejected later.
 */
export default function ClaimPanel({
  claims,
  evidence,
  questions,
  sections,
  relations,
  draft,
  busy,
  error,
  feedback,
  onMode,
  onType,
  onSource,
  onTarget,
  onCreateRelation,
  onDeleteRelation,
}: ClaimPanelProps): ReactElement {
  const mode = relationMode(draft.modeKey);
  const sources = sourceOptions(mode, claims, evidence);
  const targets = targetOptions(mode, claims, questions, sections);
  const sendable = relationIsSendable(draft.sourceId, draft.targetId);

  const names = new Map<string, string>();
  for (const claim of claims) names.set(claim.id, claim.claimCode);
  for (const row of evidence) names.set(row.id, row.title);
  for (const row of questions) names.set(row.id, row.questionCode);
  for (const row of sections) names.set(row.id, row.sectionName);
  const nameOf = (id: string): string => names.get(id) ?? id;

  return (
    <section className="research-panel" aria-label="论点与章节">
      <div className="column-title">论点与章节</div>

      <div className="section">
        <div className="section-head">关系写入（R02 方向受约束）</div>
        <div className="inline-form">
          <select
            className="field-select"
            aria-label="关系形状"
            value={draft.modeKey}
            onChange={(event) => onMode(event.target.value as RelationMode['key'])}
          >
            {RELATION_MODES.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="field-select"
            aria-label="关系类型"
            value={draft.relationType}
            onChange={(event) => onType(event.target.value as ResearchRelationType)}
          >
            {mode.types.map((relationType) => (
              <option key={relationType} value={relationType}>
                {researchRelationLabel(relationType)}
              </option>
            ))}
          </select>
          <select
            className="field-select inline-form-grow"
            aria-label="来源"
            value={draft.sourceId}
            onChange={(event) => onSource(event.target.value)}
          >
            <option value="">来源（{researchEntityTypeLabels[mode.sourceType]}）…</option>
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="field-select inline-form-grow"
            aria-label="目标"
            value={draft.targetId}
            onChange={(event) => onTarget(event.target.value)}
          >
            <option value="">目标（{researchEntityTypeLabels[mode.targetType]}）…</option>
            {targets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={!sendable || busy} onClick={onCreateRelation}>
            写入关系
          </button>
        </div>
        {sendable ? null : <p className="muted-note">来源和目标都要选，才构成一条可写入的关系。</p>}
      </div>

      <div className="section">
        <div className="section-head">论点</div>
        {claims.length === 0 ? (
          <p className="muted-note">这个项目还没有论点。</p>
        ) : (
          <ul className="item-list">
            {claims.map((claim) => {
              const links = claimEvidenceLinks(claim.id, relations, evidence);
              const supported = claimIsSupported(claim.id, relations);
              return (
                <li key={claim.id} className="item-card">
                  <div className="inline-row">
                    <span className="badge badge-quiet">{claim.claimCode}</span>
                    <span className="muted-note">{claimLine(claim)}</span>
                    {supported ? (
                      <span className="badge badge-accent">有支撑</span>
                    ) : (
                      <span className="badge badge-warn">未被支撑</span>
                    )}
                  </div>
                  <p className="item-text">{claim.claimText}</p>
                  {claim.boundary === null ? null : <p className="muted-note">边界：{claim.boundary}</p>}
                  {links.length === 0 ? (
                    <p className="muted-note">证据关系：还没有。</p>
                  ) : (
                    <p className="muted-note">
                      证据关系：
                      {links.map((link) => `${researchRelationLabel(link.relationType)}「${link.title}」`).join('、')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">章节</div>
        {sections.length === 0 ? (
          <p className="muted-note">这个项目还没有章节。</p>
        ) : (
          <ul className="item-list">
            {sections.map((section) => {
              const linked = sectionClaims(section.id, relations, claims);
              return (
                <li key={section.id} className="item-card">
                  <div className="inline-row">
                    <span className="badge badge-quiet">#{section.sortOrder}</span>
                    <span className="item-text">{section.sectionName}</span>
                    {section.sectionReference === null ? null : (
                      <span className="muted-note">{section.sectionReference}</span>
                    )}
                  </div>
                  {linked.length === 0 ? (
                    <p className="muted-note">还没有论点安排进这一章。</p>
                  ) : (
                    <p className="muted-note">
                      论点：{linked.map((claim) => `${claim.claimCode} ${claim.claimText}`).join('、')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">现有关系</div>
        {relations.length === 0 ? (
          <p className="muted-note">这个项目还没有任何关系。</p>
        ) : (
          <ul className="item-list">
            {relations.map((relation) => (
              <li key={relation.id} className="item-card">
                <div className="inline-row">
                  <span className="badge">{researchRelationLabel(relation.relationType)}</span>
                  <span className="muted-note">
                    {researchEntityTypeLabels[relation.sourceType]}「{nameOf(relation.sourceId)}」→{' '}
                    {researchEntityTypeLabels[relation.targetType]}「{nameOf(relation.targetId)}」
                  </span>
                  <button type="button" className="btn" disabled={busy} onClick={() => onDeleteRelation(relation.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}
      {feedback !== null ? <p className="version-note">{feedback}</p> : null}
    </section>
  );
}
