'use client';

/**
 * Research Timeline (research doc §18–§20): Decisions and Changes are append-only history — new
 * changes are new Change records, never edits — and both flow into the timeline alongside manual
 * milestones. Clicking an entry shows What / Why / Related.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  CreateResearchChangeRequest,
  CreateResearchDecisionRequest,
  CreateTimelineEventRequest,
  ResearchChangeType,
} from '@noltri/schema';
import { BusyButton, Field, FormError, SelectInput, TextArea, TextInput, type Choice } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPost, describeError } from '@/lib/client-api';
import { buildTimelineView, labelOf, researchChangeTypeLabels } from '@/lib/research-view';

const CHANGE_TYPE_CHOICES: readonly Choice[] = (Object.keys(researchChangeTypeLabels) as ResearchChangeType[]).map(
  (value) => ({ value, label: labelOf(researchChangeTypeLabels, value) }),
);

interface MilestoneDraft {
  occurredAt: string;
  title: string;
  summary: string;
}

interface DecisionDraft {
  title: string;
  decision: string;
  reason: string;
  alternatives: string;
  rejectedAlternatives: string;
  impact: string;
}

interface ChangeDraft {
  changeType: ResearchChangeType;
  before: string;
  after: string;
  reason: string;
  impact: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function TimelinePanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [milestone, setMilestone] = useState<MilestoneDraft>({ occurredAt: today(), title: '', summary: '' });
  const [decision, setDecision] = useState<DecisionDraft>({ title: '', decision: '', reason: '', alternatives: '', rejectedAlternatives: '', impact: '' });
  const [change, setChange] = useState<ChangeDraft>({ changeType: 'research_question', before: '', after: '', reason: '', impact: '' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = researchProjectBase(projectId);
  const entries = buildTimelineView(data.timeline, { decisions: data.decisions, changes: data.changes });

  async function run<T>(action: () => Promise<T>, after: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setError(null);
      after();
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  function addMilestone(): void {
    if (milestone.title.trim().length === 0) return;
    const payload: CreateTimelineEventRequest = {
      occurredAt: /^\d{4}-\d{2}-\d{2}$/.test(milestone.occurredAt)
        ? `${milestone.occurredAt}T00:00:00.000Z`
        : milestone.occurredAt,
      title: milestone.title.trim(),
      summary: milestone.summary.trim().length > 0 ? milestone.summary.trim() : null,
    };
    void run(
      () => apiPost(`${base}/timeline`, payload),
      () => setMilestone({ occurredAt: today(), title: '', summary: '' }),
    );
  }

  function addDecision(): void {
    if (decision.title.trim().length === 0 || decision.decision.trim().length === 0) return;
    const payload: CreateResearchDecisionRequest = {
      title: decision.title.trim(),
      decision: decision.decision.trim(),
      reason: decision.reason.trim().length > 0 ? decision.reason.trim() : null,
      alternatives: decision.alternatives.trim().length > 0 ? decision.alternatives.trim() : null,
      rejectedAlternatives: decision.rejectedAlternatives.trim().length > 0 ? decision.rejectedAlternatives.trim() : null,
      impact: decision.impact.trim().length > 0 ? decision.impact.trim() : null,
    };
    void run(
      () => apiPost(`${base}/decisions`, payload),
      () => setDecision({ title: '', decision: '', reason: '', alternatives: '', rejectedAlternatives: '', impact: '' }),
    );
  }

  function addChange(): void {
    if (change.before.trim().length === 0 || change.after.trim().length === 0) return;
    const payload: CreateResearchChangeRequest = {
      changeType: change.changeType,
      before: change.before.trim(),
      after: change.after.trim(),
      reason: change.reason.trim().length > 0 ? change.reason.trim() : null,
      impact: change.impact.trim().length > 0 ? change.impact.trim() : null,
    };
    void run(
      () => apiPost(`${base}/changes`, payload),
      () => setChange({ changeType: 'research_question', before: '', after: '', reason: '', impact: '' }),
    );
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Research Timeline</h2>
        <span className="column-hint">
          Decision / Change 是 append-only 历史：变化用新增 Change 表达，不改旧记录。新记录会自动进入时间线。
        </span>
      </div>

      <details className="form-details">
        <summary className="login-label">记录 Decision（已确认的重要判断）</summary>
        <div className="inline-form">
          <Field label="标题">
            <TextInput value={decision.title} onChange={(value) => setDecision((previous) => ({ ...previous, title: value }))} placeholder="采用 ISM + ANP" />
          </Field>
          <Field label="决策内容">
            <TextArea value={decision.decision} onChange={(value) => setDecision((previous) => ({ ...previous, decision: value }))} rows={2} />
          </Field>
          <Field label="理由">
            <TextArea value={decision.reason} onChange={(value) => setDecision((previous) => ({ ...previous, reason: value }))} rows={2} />
          </Field>
          <Field label="备选方案">
            <TextArea value={decision.alternatives} onChange={(value) => setDecision((previous) => ({ ...previous, alternatives: value }))} rows={2} />
          </Field>
          <Field label="被否决的方案">
            <TextArea value={decision.rejectedAlternatives} onChange={(value) => setDecision((previous) => ({ ...previous, rejectedAlternatives: value }))} rows={2} />
          </Field>
          <Field label="影响">
            <TextArea value={decision.impact} onChange={(value) => setDecision((previous) => ({ ...previous, impact: value }))} rows={2} />
          </Field>
          <div className="inline-row">
            <BusyButton busy={busy} busyLabel="正在记录…" label="记录 Decision" onClick={addDecision} disabled={decision.title.trim().length === 0 || decision.decision.trim().length === 0} />
          </div>
        </div>
      </details>

      <details className="form-details">
        <summary className="login-label">记录 Change（研究设计 / 论文逻辑的变化）</summary>
        <div className="inline-form">
          <Field label="变化类型">
            <SelectInput value={change.changeType} choices={CHANGE_TYPE_CHOICES} onChange={(value) => setChange((previous) => ({ ...previous, changeType: value as ResearchChangeType }))} />
          </Field>
          <Field label="变化前">
            <TextArea value={change.before} onChange={(value) => setChange((previous) => ({ ...previous, before: value }))} rows={2} />
          </Field>
          <Field label="变化后">
            <TextArea value={change.after} onChange={(value) => setChange((previous) => ({ ...previous, after: value }))} rows={2} />
          </Field>
          <Field label="原因">
            <TextArea value={change.reason} onChange={(value) => setChange((previous) => ({ ...previous, reason: value }))} rows={2} />
          </Field>
          <Field label="影响范围">
            <TextArea value={change.impact} onChange={(value) => setChange((previous) => ({ ...previous, impact: value }))} rows={2} placeholder="Introduction / Method / Results…" />
          </Field>
          <div className="inline-row">
            <BusyButton busy={busy} busyLabel="正在记录…" label="记录 Change" onClick={addChange} disabled={change.before.trim().length === 0 || change.after.trim().length === 0} />
          </div>
        </div>
      </details>

      <details className="form-details">
        <summary className="login-label">记录里程碑（milestone）</summary>
        <div className="inline-form">
          <Field label="发生日期">
            <TextInput type="date" value={milestone.occurredAt} onChange={(value) => setMilestone((previous) => ({ ...previous, occurredAt: value }))} />
          </Field>
          <Field label="标题">
            <TextInput value={milestone.title} onChange={(value) => setMilestone((previous) => ({ ...previous, title: value }))} placeholder="投稿 V1" />
          </Field>
          <Field label="摘要（可选）">
            <TextArea value={milestone.summary} onChange={(value) => setMilestone((previous) => ({ ...previous, summary: value }))} rows={2} />
          </Field>
          <div className="inline-row">
            <BusyButton busy={busy} busyLabel="正在记录…" label="记录里程碑" onClick={addMilestone} disabled={milestone.title.trim().length === 0} />
          </div>
        </div>
      </details>

      <FormError message={error} />

      {entries.length === 0 ? (
        <p className="muted-note">时间线还是空的。记录第一条 Decision、Change 或里程碑后，这里会按时间倒序展开。</p>
      ) : (
        <ul className="timeline-list">
          {entries.map((entry) => {
            const open = expandedId === entry.event.id;
            return (
              <li key={entry.event.id} className="timeline-item">
                <button
                  type="button"
                  className="timeline-head"
                  aria-expanded={open}
                  onClick={() => setExpandedId((previous) => (previous === entry.event.id ? null : entry.event.id))}
                >
                  <span className="timeline-date">{entry.dateLabel}</span>
                  <span className={`badge ${entry.event.eventType === 'milestone' ? 'badge-quiet' : 'badge-accent'}`}>{entry.typeLabel}</span>
                  <span className="item-text">{entry.event.title}</span>
                </button>
                {open ? (
                  <div className="timeline-detail">
                    <div>
                      <span className="login-label">What</span>
                      <p className="item-text">{entry.detail.what}</p>
                    </div>
                    <div>
                      <span className="login-label">Why</span>
                      <p className="item-text">{entry.detail.why ?? '（未记录原因）'}</p>
                    </div>
                    <div>
                      <span className="login-label">Related</span>
                      {entry.detail.related.length === 0 ? (
                        <p className="muted-note">（无关联对象）</p>
                      ) : (
                        <ul className="map-edge-list">
                          {entry.detail.related.map((line) => (
                            <li key={line} className="map-edge-line">
                              {line}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
