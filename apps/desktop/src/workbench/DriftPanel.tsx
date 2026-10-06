import type { ReactElement } from 'react';
import type { DriftFinding, DriftFindingStatus, DriftSummary } from '@noltri/schema';
import { driftFindingStatusLabels, driftSeverityLabels, driftTypeLabels } from '@noltri/shared';
import { findingIsActionable, severityBadgeClass, severityLine, sortFindings } from './research-model';

export interface DriftPanelProps {
  findings: readonly DriftFinding[];
  /** The counts of the last run in this session; `null` until one runs since the project was opened. */
  summary: DriftSummary | null;
  manuscriptText: string;
  busy: boolean;
  error: string | null;
  feedback: string | null;
  onManuscriptText: (value: string) => void;
  onRun: () => void;
  onPatch: (findingId: string, status: DriftFindingStatus) => void;
}

/**
 * 偏移检查 (contract §5): a deterministic rule run, never a model call. The panel draws what the Core
 * returned, keeps 严重 first, and offers the two live moves (确认／解决); 已解决 and 已忽略 stay as 台账,
 * so a status that nobody has to act on no longer grows buttons.
 */
export default function DriftPanel({
  findings,
  summary,
  manuscriptText,
  busy,
  error,
  feedback,
  onManuscriptText,
  onRun,
  onPatch,
}: DriftPanelProps): ReactElement {
  const rows = sortFindings(findings);
  const openCount = findings.filter((finding) => finding.status === 'open').length;

  return (
    <section className="research-panel" aria-label="偏移检查">
      <div className="column-title">偏移检查</div>
      <p className="column-hint">
        六类偏移按确定性规则检查，不调用模型；重跑会把新发现并入仍待处理的条目，不重复建档。
      </p>

      <div className="section">
        <div className="section-head">运行检查</div>
        <label className="charter-field">
          <span className="charter-label">正文摘录（可选）</span>
          <textarea
            className="field-textarea"
            rows={4}
            value={manuscriptText}
            placeholder="粘贴摘要或讨论段落；贴上正文才会同时扫描研究问题偏移与正文里的贡献表述。"
            onChange={(event) => onManuscriptText(event.target.value)}
          />
        </label>
        <div className="inline-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onRun}>
            运行偏移检查
          </button>
          {summary === null ? null : <span className="muted-note">{severityLine(summary)}</span>}
        </div>
      </div>

      <div className="section">
        <div className="section-head">偏移发现（待处理 {openCount} 条）</div>
        {rows.length === 0 ? (
          <p className="muted-note">还没有偏移发现。运行一次检查，或继续往下写。</p>
        ) : (
          <ul className="item-list">
            {rows.map((finding) => (
              <li key={finding.id} className="item-card">
                <div className="inline-row">
                  <span className={severityBadgeClass(finding.severity)}>{driftSeverityLabels[finding.severity]}</span>
                  <span className="badge badge-quiet">{driftTypeLabels[finding.driftType]}</span>
                  <span className="muted-note">{driftFindingStatusLabels[finding.status]}</span>
                </div>
                <p className="item-text">{finding.description}</p>
                {finding.recommendedAction === null ? null : (
                  <p className="muted-note">建议：{finding.recommendedAction}</p>
                )}
                {findingIsActionable(finding) ? (
                  <div className="inline-row">
                    {finding.status === 'open' ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => onPatch(finding.id, 'acknowledged')}>
                        确认
                      </button>
                    ) : null}
                    <button type="button" className="btn" disabled={busy} onClick={() => onPatch(finding.id, 'resolved')}>
                      解决
                    </button>
                  </div>
                ) : null}
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
