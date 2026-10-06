import type { ReactElement } from 'react';
import type { ResearchChange, ResearchDecision, TimelineEvent } from '@noltri/schema';
import { researchChangeTypeLabels } from '@noltri/shared';
import { stamp, timelineRows } from './research-model';

export interface TimelinePanelProps {
  decisions: readonly ResearchDecision[];
  changes: readonly ResearchChange[];
  events: readonly TimelineEvent[];
}

/**
 * 决策-时间线 (V1_DEVELOPMENT §18): 决策 and 变更 are append-only history — the panel shows them, it never
 * offers an edit. 时间线的行由服务端按 occurredAt 降序排好，这里只负责画。
 */
export default function TimelinePanel({ decisions, changes, events }: TimelinePanelProps): ReactElement {
  const rows = timelineRows(events);

  return (
    <section className="research-panel" aria-label="决策与时间线">
      <div className="column-title">决策与时间线</div>

      <div className="section">
        <div className="section-head">时间线</div>
        {rows.length === 0 ? (
          <p className="muted-note">这个项目还没有时间线事件。</p>
        ) : (
          <ul className="item-list">
            {rows.map((row) => (
              <li key={row.id} className="item-card">
                <div className="inline-row">
                  <span className="badge badge-quiet">{row.typeLabel}</span>
                  <span className="item-text">{row.title}</span>
                  <span className="muted-note">{row.when}</span>
                </div>
                {row.summary === null ? null : <p className="muted-note">{row.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">决策（只增不改）</div>
        {decisions.length === 0 ? (
          <p className="muted-note">这个项目还没有记录决策。</p>
        ) : (
          <ul className="item-list">
            {decisions.map((decision) => (
              <li key={decision.id} className="item-card">
                <div className="inline-row">
                  <span className="item-text">{decision.title}</span>
                  <span className="muted-note">{stamp(decision.createdAt)}</span>
                </div>
                <p className="item-text">{decision.decision}</p>
                {decision.reason === null ? null : <p className="muted-note">理由：{decision.reason}</p>}
                {decision.alternatives === null ? null : <p className="muted-note">备选：{decision.alternatives}</p>}
                {decision.rejectedAlternatives === null ? null : (
                  <p className="muted-note">被否掉的备选：{decision.rejectedAlternatives}</p>
                )}
                {decision.impact === null ? null : <p className="muted-note">影响：{decision.impact}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <div className="section-head">变更（只增不改）</div>
        {changes.length === 0 ? (
          <p className="muted-note">这个项目还没有记录变更。</p>
        ) : (
          <ul className="item-list">
            {changes.map((change) => (
              <li key={change.id} className="item-card">
                <div className="inline-row">
                  <span className="badge badge-quiet">{researchChangeTypeLabels[change.changeType]}</span>
                  <span className="muted-note">{stamp(change.createdAt)}</span>
                </div>
                <p className="item-text">
                  {change.before} → {change.after}
                </p>
                {change.reason === null ? null : <p className="muted-note">理由：{change.reason}</p>}
                {change.impact === null ? null : <p className="muted-note">影响：{change.impact}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
