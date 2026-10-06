import type { ReactElement } from 'react';
import type { Evidence, ResearchReferenceMatch, ResearchReviewMark } from '@noltri/schema';
import { evidenceTypeLabels } from '@noltri/shared';
import { evidenceProvenanceLines, groupReferences, referenceSummary } from './research-model';

export interface ReferenceQuery {
  readonly nodeId: string;
  readonly rawSourceId: string;
}

export interface EvidencePanelProps {
  evidence: readonly Evidence[];
  marks: readonly ResearchReviewMark[];
  query: ReferenceQuery;
  /** The answer to the last 引用检查, or `null` before one has been run. */
  referenceResult: readonly ResearchReferenceMatch[] | null;
  checking: boolean;
  error: string | null;
  onQuery: (field: keyof ReferenceQuery, value: string) => void;
  onCheck: () => void;
}

/**
 * 证据工作台 (V1_DEVELOPMENT §13「证据」): every 证据 with the 出处 it was read from, plus the R03 check
 * —「归档这个出处会动到什么」— run against a 知识节点 or 收录原文 before anyone archives it. A 证据 whose
 * 出处 object was archived keeps its pointer and shows the 待复核标记; nothing is silently re-pointed.
 */
export default function EvidencePanel({
  evidence,
  marks,
  query,
  referenceResult,
  checking,
  error,
  onQuery,
  onCheck,
}: EvidencePanelProps): ReactElement {
  const markByEvidence = new Map(marks.map((mark) => [mark.entityId, mark]));
  const canCheck = query.nodeId.trim() !== '' || query.rawSourceId.trim() !== '';
  const grouped = referenceResult === null ? null : groupReferences(referenceResult);

  return (
    <section className="research-panel" aria-label="证据工作台">
      <div className="column-title">证据工作台</div>

      <div className="section">
        <div className="section-head">引用检查（R03）</div>
        <p className="column-hint">
          归档一个知识节点或收录原文前，先查它被哪些研究项目引用。至少填一个 id；两个都填时按「同时指向两者」查。
        </p>
        <div className="inline-form">
          <input
            className="field-input inline-form-grow"
            aria-label="知识节点 id"
            placeholder="知识节点 id（nodeId）"
            value={query.nodeId}
            onChange={(event) => onQuery('nodeId', event.target.value)}
          />
          <input
            className="field-input inline-form-grow"
            aria-label="收录原文 id"
            placeholder="收录原文 id（rawSourceId）"
            value={query.rawSourceId}
            onChange={(event) => onQuery('rawSourceId', event.target.value)}
          />
          <button type="button" className="btn" disabled={!canCheck || checking} onClick={onCheck}>
            {checking ? '检查中…' : '检查引用'}
          </button>
        </div>

        {referenceResult === null ? null : (
          <>
            <p className="version-note">{referenceSummary(referenceResult)}</p>
            {grouped === null ? null : (
              <ul className="item-list">
                {grouped.map((project) => (
                  <li key={project.projectId} className="item-card">
                    <div className="inline-row">
                      <span className="badge badge-warn">{project.projectName}</span>
                      <span className="muted-note">{project.claimCount} 个论点会收到复核标记</span>
                    </div>
                    <p className="item-text">证据：{project.evidenceTitles.join('、')}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="section">
        <div className="section-head">证据清单</div>
        {evidence.length === 0 ? (
          <p className="muted-note">这个项目还没有证据。</p>
        ) : (
          <ul className="item-list">
            {evidence.map((row) => {
              const mark = markByEvidence.get(row.id);
              const lines = evidenceProvenanceLines(row);
              return (
                <li key={row.id} className="item-card">
                  <div className="inline-row">
                    <span className="badge badge-quiet">{evidenceTypeLabels[row.type]}</span>
                    <span className="item-text">{row.title}</span>
                    {mark === undefined ? null : <span className="badge badge-warn">待复核</span>}
                  </div>
                  {row.description === null ? null : <p className="muted-note">{row.description}</p>}
                  {lines.length === 0 ? (
                    <p className="muted-note">没有记录出处。</p>
                  ) : (
                    <p className="muted-note">出处：{lines.join(' ｜ ')}</p>
                  )}
                  {mark === undefined ? null : <p className="error-note">复核原因：{mark.reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}
    </section>
  );
}
