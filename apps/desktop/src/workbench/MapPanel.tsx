import type { ReactElement } from 'react';
import type { ResearchMapResponse } from '@noltri/schema';
import { claimStatusLabels, evidenceTypeLabels, researchQuestionStatusLabels } from '@noltri/shared';
import { mapIncomingLinks, mapSummaryLine } from './research-model';

export interface MapPanelProps {
  /** `null` while the first load is in flight or before a project is open. */
  map: ResearchMapResponse | null;
  error: string | null;
}

/**
 * 研究地图 (contract §5): the server aggregates the layers and their edges but never lays out the
 * graph — this panel draws the accessible twin of the same edges, one sentence per link, so the list
 * and any future drawing carry the same information (V1_DEVELOPMENT §12).
 */
export default function MapPanel({ map, error }: MapPanelProps): ReactElement {
  if (map === null) {
    return (
      <section className="research-panel" aria-label="研究地图">
        <div className="column-title">研究地图</div>
        <p className="muted-note">正在载入研究地图…</p>
        {error !== null ? <p className="error-note">{error}</p> : null}
      </section>
    );
  }

  const dangling = map.claims.filter((claim) => map.unsupportedClaimIds.includes(claim.id));

  return (
    <section className="research-panel" aria-label="研究地图">
      <div className="column-title">研究地图</div>
      <p className="column-hint">服务端只聚合层与边，不负责排版；下面的列表与图是同一份信息。</p>
      <p className="version-note">{mapSummaryLine(map)}</p>

      {dangling.length === 0 ? null : (
        <p className="version-note">
          未被支撑的论点：{dangling.map((claim) => `${claim.claimCode} ${claim.claimText}`).join('；')} —— 地图上它们是悬空的。
        </p>
      )}

      <div className="section">
        <div className="section-head">研究问题</div>
        {map.questions.length === 0 ? (
          <p className="muted-note">还没有研究问题。</p>
        ) : (
          <ul className="item-list">
            {map.questions.map((question) => (
              <li key={question.id} className="item-card">
                <div className="inline-row">
                  <span className="badge badge-quiet">{question.questionCode}</span>
                  <span className="item-text">{question.questionText}</span>
                  <span className="muted-note">{researchQuestionStatusLabels[question.status]}</span>
                </div>
                {mapIncomingLinks('research_question', question.id, map).map((line, index) => (
                  <p key={`${question.id}-${String(index)}`} className="muted-note">
                    {line}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">证据</div>
        {map.evidence.length === 0 ? (
          <p className="muted-note">还没有证据。</p>
        ) : (
          <ul className="item-list">
            {map.evidence.map((item) => (
              <li key={item.id} className="item-card">
                <div className="inline-row">
                  <span className="item-text">{item.title}</span>
                  <span className="muted-note">{evidenceTypeLabels[item.type]}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">论点</div>
        {map.claims.length === 0 ? (
          <p className="muted-note">还没有论点。</p>
        ) : (
          <ul className="item-list">
            {map.claims.map((claim) => (
              <li key={claim.id} className="item-card">
                <div className="inline-row">
                  <span className="badge badge-quiet">{claim.claimCode}</span>
                  {claim.supported ? (
                    <span className="badge badge-accent">有支撑</span>
                  ) : (
                    <span className="badge badge-warn">未被支撑</span>
                  )}
                  <span className="muted-note">
                    {claimStatusLabels[claim.status]}
                  </span>
                </div>
                <p className="item-text">{claim.claimText}</p>
                {mapIncomingLinks('claim', claim.id, map).map((line, index) => (
                  <p key={`${claim.id}-${String(index)}`} className="muted-note">
                    {line}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">章节</div>
        {map.sections.length === 0 ? (
          <p className="muted-note">还没有章节。</p>
        ) : (
          <ul className="item-list">
            {map.sections.map((section) => (
              <li key={section.id} className="item-card">
                <div className="inline-row">
                  <span className="item-text">{section.sectionName}</span>
                  {section.sectionReference === null ? null : (
                    <span className="muted-note">{section.sectionReference}</span>
                  )}
                </div>
                {mapIncomingLinks('manuscript_section', section.id, map).map((line, index) => (
                  <p key={`${section.id}-${String(index)}`} className="muted-note">
                    {line}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}
    </section>
  );
}
