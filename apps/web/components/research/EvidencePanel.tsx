'use client';

/**
 * Evidence (research doc §14): the point is not a literature database but why this source matters to
 * the current research — description, source reference and reliability note all editable in place.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { CreateEvidenceRequest, Evidence, EvidenceType, PatchEvidenceRequest } from '@noltri/schema';
import { BusyButton, Field, FormError, SelectInput, TextArea, TextInput, type Choice } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPatch, apiPost, describeError } from '@/lib/client-api';
import { evidenceTypeLabels, labelOf } from '@/lib/research-view';

const TYPE_CHOICES: readonly Choice[] = (Object.keys(evidenceTypeLabels) as EvidenceType[]).map((value) => ({
  value,
  label: labelOf(evidenceTypeLabels, value),
}));

interface EvidenceDraft {
  type: EvidenceType;
  title: string;
  description: string;
  sourceReference: string;
  sourceLocation: string;
  reliabilityNote: string;
}

const EMPTY_DRAFT: EvidenceDraft = {
  type: 'literature',
  title: '',
  description: '',
  sourceReference: '',
  sourceLocation: '',
  reliabilityNote: '',
};

function toDraft(evidence: Evidence): EvidenceDraft {
  return {
    type: evidence.type,
    title: evidence.title,
    description: evidence.description ?? '',
    sourceReference: evidence.sourceReference ?? '',
    sourceLocation: evidence.sourceLocation ?? '',
    reliabilityNote: evidence.reliabilityNote ?? '',
  };
}

export default function EvidencePanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [filter, setFilter] = useState<string>('');
  const [draft, setDraft] = useState<EvidenceDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EvidenceDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = researchProjectBase(projectId);
  const visible = filter === '' ? data.evidence : data.evidence.filter((evidence) => evidence.type === filter);

  async function create(): Promise<void> {
    if (draft.title.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const payload: CreateEvidenceRequest = {
        type: draft.type,
        title: draft.title.trim(),
        description: orNull(draft.description),
        sourceReference: orNull(draft.sourceReference),
        sourceLocation: orNull(draft.sourceLocation),
        reliabilityNote: orNull(draft.reliabilityNote),
      };
      await apiPost(`${base}/evidence`, payload);
      setDraft(EMPTY_DRAFT);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const payload: PatchEvidenceRequest = {
        type: editDraft.type,
        title: editDraft.title.trim(),
        description: orNull(editDraft.description),
        sourceReference: orNull(editDraft.sourceReference),
        sourceLocation: orNull(editDraft.sourceLocation),
        reliabilityNote: orNull(editDraft.reliabilityNote),
      };
      await apiPatch(`/api/web/research/evidence/${encodeURIComponent(id)}`, payload);
      setEditingId(null);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Evidence（证据）</h2>
        <span className="column-hint">重点不是文献库，而是这份证据为什么与当前研究有关。</span>
      </div>

      <div className="inline-form">
        <Field label="类型">
          <SelectInput value={draft.type} choices={TYPE_CHOICES} onChange={(value) => setDraft((previous) => ({ ...previous, type: value as EvidenceType }))} />
        </Field>
        <Field label="标题">
          <TextInput value={draft.title} onChange={(value) => setDraft((previous) => ({ ...previous, title: value }))} placeholder="德尔菲专家评分（第 2 轮）" />
        </Field>
        <Field label="说明：为什么与本研究有关">
          <TextArea value={draft.description} onChange={(value) => setDraft((previous) => ({ ...previous, description: value }))} rows={2} />
        </Field>
        <Field label="来源引用（可选）">
          <TextInput value={draft.sourceReference} onChange={(value) => setDraft((previous) => ({ ...previous, sourceReference: value }))} placeholder="作者 / 文献 / 数据集" />
        </Field>
        <Field label="来源位置（可选）">
          <TextInput value={draft.sourceLocation} onChange={(value) => setDraft((previous) => ({ ...previous, sourceLocation: value }))} placeholder="p.12 表 3 / 附录 B" />
        </Field>
        <Field label="可靠性说明（可选）">
          <TextArea value={draft.reliabilityNote} onChange={(value) => setDraft((previous) => ({ ...previous, reliabilityNote: value }))} rows={2} placeholder="样本量、专家一致性、局限…" />
        </Field>
        <div className="inline-row">
          <BusyButton busy={busy} busyLabel="正在导入…" label="导入 Evidence" onClick={() => void create()} disabled={draft.title.trim().length === 0} />
        </div>
      </div>

      <FormError message={error} />

      <div className="inline-row">
        <span className="login-label">按类型筛选</span>
        <SelectInput value={filter} choices={TYPE_CHOICES} placeholder="全部类型" onChange={setFilter} />
        <span className="muted-note">{visible.length} / {data.evidence.length} 条证据</span>
      </div>

      {visible.length === 0 ? (
        <p className="muted-note">没有符合条件的证据。导入第一条 Evidence 后，Claim 就可以引用它。</p>
      ) : (
        <ul className="card-list">
          {visible.map((evidence) => (
            <li key={evidence.id} className="research-card">
              {editingId === evidence.id ? (
                <div className="inline-form">
                  <Field label="类型">
                    <SelectInput value={editDraft.type} choices={TYPE_CHOICES} onChange={(value) => setEditDraft((previous) => ({ ...previous, type: value as EvidenceType }))} />
                  </Field>
                  <Field label="标题">
                    <TextInput value={editDraft.title} onChange={(value) => setEditDraft((previous) => ({ ...previous, title: value }))} />
                  </Field>
                  <Field label="说明">
                    <TextArea value={editDraft.description} onChange={(value) => setEditDraft((previous) => ({ ...previous, description: value }))} rows={2} />
                  </Field>
                  <Field label="来源引用">
                    <TextInput value={editDraft.sourceReference} onChange={(value) => setEditDraft((previous) => ({ ...previous, sourceReference: value }))} />
                  </Field>
                  <Field label="来源位置">
                    <TextInput value={editDraft.sourceLocation} onChange={(value) => setEditDraft((previous) => ({ ...previous, sourceLocation: value }))} />
                  </Field>
                  <Field label="可靠性说明">
                    <TextArea value={editDraft.reliabilityNote} onChange={(value) => setEditDraft((previous) => ({ ...previous, reliabilityNote: value }))} rows={2} />
                  </Field>
                  <div className="inline-row">
                    <BusyButton busy={busy} busyLabel="正在保存…" label="保存" onClick={() => void saveEdit(evidence.id)} />
                    <button type="button" className="btn" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="card-head">
                    <span className="badge">{labelOf(evidenceTypeLabels, evidence.type)}</span>
                    <strong className="item-text">{evidence.title}</strong>
                    <div className="top-bar-spacer" />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setEditingId(evidence.id);
                        setEditDraft(toDraft(evidence));
                      }}
                    >
                      编辑
                    </button>
                  </div>
                  {evidence.description !== null ? <p className="item-text">{evidence.description}</p> : null}
                  <p className="item-sources">
                    {evidence.sourceReference ?? '未填写来源'}
                    {evidence.sourceLocation !== null ? ` · ${evidence.sourceLocation}` : ''}
                  </p>
                  {evidence.reliabilityNote !== null ? <p className="muted-note">可靠性：{evidence.reliabilityNote}</p> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
