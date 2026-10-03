'use client';

/**
 * Drift Checker (research doc §22–§23): paste a manuscript excerpt, run the six deterministic rule
 * families, then triage the findings (acknowledged / resolved / dismissed). V1 calls no model — the
 * rules live in Knowledge Core and this panel only presents and triages them.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { DriftCheckResponse, DriftFinding, DriftFindingStatus } from '@noltri/schema';
import { BusyButton, Field, FormError, TextArea } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPatch, apiPost, describeError } from '@/lib/client-api';
import {
  countFindingsBySeverity,
  driftFindingStatusActions,
  driftFindingStatusLabels,
  driftSeverityLabels,
  driftTypeLabels,
  groupFindingsBySeverity,
  labelOf,
} from '@/lib/research-view';

const STATUS_BUTTON_LABELS: Record<DriftFindingStatus, string> = {
  open: '重新打开',
  acknowledged: '标记已知悉',
  resolved: '标记已解决',
  dismissed: '标记已忽略',
};

const RULE_SUMMARY: readonly string[] = [
  'evidence_drift · 证据缺口：Claim 没有任何 supports / partially_supports 关系。',
  'causality_drift · 因果越界：主张用了强因果词，但支持证据多为非统计类型或缺 Claim Boundary。',
  'rq_drift · 研究问题漂移：正文出现 Charter 与 RQ 列表里没有的新研究问题（需粘贴正文）。',
  'contribution_drift · 贡献漂移：贡献类 Claim 或正文贡献表述与 Core Contribution 重合度过低。',
  'method_drift · 方法漂移：方法已发生 Change，但 Charter 未同步。',
  'journal_drift · 期刊漂移：目标期刊或贡献/范围已变，但 Charter 未同步。',
];

export default function DriftPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [manuscriptText, setManuscriptText] = useState('');
  const [findings, setFindings] = useState<DriftFinding[]>(data.findings);
  const [summary, setSummary] = useState<DriftCheckResponse['summary'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);

  useEffect(() => {
    setFindings(data.findings);
  }, [data.findings]);

  async function runCheck(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const text = manuscriptText.trim();
      const result = await apiPost<DriftCheckResponse>(`${researchProjectBase(projectId)}/drift-check`, {
        ...(text.length > 0 ? { manuscriptText: text } : {}),
      });
      setFindings(result.findings);
      setSummary(result.summary);
      setRanAt(new Date().toISOString());
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function patchStatus(id: string, status: DriftFindingStatus): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await apiPatch<DriftFinding>(`/api/web/research/drift-findings/${encodeURIComponent(id)}`, { status });
      setFindings((previous) => previous.map((finding) => (finding.id === id ? updated : finding)));
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const groups = groupFindingsBySeverity(findings);
  const counts = summary ?? countFindingsBySeverity(findings);

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Drift Checker</h2>
        <span className="column-hint">
          六类确定性规则（V1 不调用模型）。粘贴正文摘要 / 讨论段可以额外检查 RQ 与贡献漂移。
        </span>
      </div>

      <Field label="正文片段（可选）" hint="粘贴摘要、引言或讨论中的一段；留空则只检查项目内部的一致性。">
        <TextArea value={manuscriptText} onChange={setManuscriptText} rows={5} placeholder="粘贴论文正文片段，例如摘要或讨论…" />
      </Field>

      <div className="inline-row">
        <BusyButton busy={busy} busyLabel="正在检查…" label="运行 Drift Checker" onClick={() => void runCheck()} />
        {ranAt !== null ? <span className="muted-note">上次检查：{ranAt.slice(0, 19).replace('T', ' ')} UTC</span> : null}
      </div>

      <FormError message={error} />

      <div className="summary-row">
        <span className="badge">共 {counts.total} 条</span>
        <span className="badge badge-warn">严重 {counts.critical}</span>
        <span className="badge badge-warn">警告 {counts.warning}</span>
        <span className="badge badge-quiet">提示 {counts.info}</span>
      </div>

      {findings.length === 0 ? (
        <p className="muted-note">当前没有 Drift Finding：研究边界、证据与主张之间暂时一致。</p>
      ) : (
        groups.map((group) => (
          <div key={group.severity} className="finding-group">
            <h3 className="column-title column-title-tight">
              {group.severityLabel}（{group.findings.length}）
            </h3>
            <ul className="card-list">
              {group.findings.map((finding) => (
                <li key={finding.id} className={`finding-card finding-${finding.severity}`}>
                  <div className="card-head">
                    <span className={`badge severity-badge-${finding.severity}`}>{labelOf(driftSeverityLabels, finding.severity)}</span>
                    <span className="badge">{labelOf(driftTypeLabels, finding.driftType)}</span>
                    <span className="badge badge-quiet">{labelOf(driftFindingStatusLabels, finding.status)}</span>
                    <div className="top-bar-spacer" />
                    {finding.status !== 'open' ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => void patchStatus(finding.id, 'open')}>
                        重新打开
                      </button>
                    ) : null}
                    {driftFindingStatusActions
                      .filter((status) => status !== finding.status)
                      .map((status) => (
                        <button key={status} type="button" className="btn" disabled={busy} onClick={() => void patchStatus(finding.id, status)}>
                          {STATUS_BUTTON_LABELS[status]}
                        </button>
                      ))}
                  </div>
                  <p className="item-text">{finding.description}</p>
                  {finding.reason !== null ? <p className="muted-note">原因：{finding.reason}</p> : null}
                  {finding.recommendedAction !== null ? <p className="muted-note">建议动作：{finding.recommendedAction}</p> : null}
                  <p className="item-sources">
                    来源：{entityRef(finding.sourceEntityType, finding.sourceEntityId)}
                    {finding.targetEntityId !== null ? ` → 对象：${entityRef(finding.targetEntityType, finding.targetEntityId)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <details className="form-details">
        <summary className="login-label">六类检查规则说明</summary>
        <ul className="empty-list">
          {RULE_SUMMARY.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function entityRef(type: string | null, id: string | null): string {
  if (id === null) return '—';
  return type === null ? id : `${type}(${id})`;
}
