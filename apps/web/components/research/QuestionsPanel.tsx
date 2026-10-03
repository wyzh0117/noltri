'use client';

/**
 * Research Questions (research doc §13): RQs are first-class entities, not free text in the charter,
 * so claims can answer them and the map can show them.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  CreateResearchQuestionRequest,
  PatchResearchQuestionRequest,
  ResearchQuestion,
  ResearchQuestionStatus,
} from '@noltri/schema';
import { BusyButton, Field, FormError, SelectInput, TextArea, TextInput } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPatch, apiPost, describeError } from '@/lib/client-api';
import { labelOf, researchQuestionStatusLabels } from '@/lib/research-view';

const STATUS_CHOICES = (['open', 'answered', 'revised', 'dropped'] as const).map((value) => ({
  value,
  label: labelOf(researchQuestionStatusLabels, value),
}));

interface QuestionDraft {
  questionCode: string;
  questionText: string;
  rationale: string;
  relatedMethod: string;
}

const EMPTY_DRAFT: QuestionDraft = { questionCode: '', questionText: '', rationale: '', relatedMethod: '' };

export default function QuestionsPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<QuestionDraft>(EMPTY_DRAFT);
  const [editStatus, setEditStatus] = useState<ResearchQuestionStatus>('open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = researchProjectBase(projectId);

  function update(key: keyof QuestionDraft, value: string): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  async function create(): Promise<void> {
    if (draft.questionCode.trim().length === 0 || draft.questionText.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const payload: CreateResearchQuestionRequest = {
        questionCode: draft.questionCode.trim(),
        questionText: draft.questionText.trim(),
        rationale: draft.rationale.trim().length > 0 ? draft.rationale.trim() : null,
        relatedMethod: draft.relatedMethod.trim().length > 0 ? draft.relatedMethod.trim() : null,
      };
      await apiPost(`${base}/questions`, payload);
      setDraft(EMPTY_DRAFT);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(question: ResearchQuestion): void {
    setEditingId(question.id);
    setEditDraft({
      questionCode: question.questionCode,
      questionText: question.questionText,
      rationale: question.rationale ?? '',
      relatedMethod: question.relatedMethod ?? '',
    });
    setEditStatus(question.status);
  }

  async function saveEdit(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const payload: PatchResearchQuestionRequest = {
        questionCode: editDraft.questionCode.trim(),
        questionText: editDraft.questionText.trim(),
        status: editStatus,
        rationale: editDraft.rationale.trim().length > 0 ? editDraft.rationale.trim() : null,
        relatedMethod: editDraft.relatedMethod.trim().length > 0 ? editDraft.relatedMethod.trim() : null,
      };
      await apiPatch(`/api/web/research/questions/${encodeURIComponent(id)}`, payload);
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
        <h2 className="column-title column-title-tight">研究问题（Research Question）</h2>
        <span className="column-hint">建议命名 RQ1 / RQ2；Claim 通过「回答」关系指向它们。</span>
      </div>

      <div className="inline-form">
        <Field label="编号">
          <TextInput value={draft.questionCode} onChange={(value) => update('questionCode', value)} placeholder="RQ1" />
        </Field>
        <Field label="研究问题">
          <TextArea value={draft.questionText} onChange={(value) => update('questionText', value)} rows={2} placeholder="How are service-quality factors structurally organized…?" />
        </Field>
        <Field label="理由（可选）">
          <TextArea value={draft.rationale} onChange={(value) => update('rationale', value)} rows={2} placeholder="为什么这个问题重要？" />
        </Field>
        <Field label="相关方法（可选）">
          <TextInput value={draft.relatedMethod} onChange={(value) => update('relatedMethod', value)} placeholder="ISM 建模 / ANP 权重" />
        </Field>
        <div className="inline-row">
          <BusyButton
            busy={busy}
            busyLabel="正在创建…"
            label="建立研究问题"
            onClick={() => void create()}
            disabled={draft.questionCode.trim().length === 0 || draft.questionText.trim().length === 0}
          />
        </div>
      </div>

      <FormError message={error} />

      {data.questions.length === 0 ? (
        <p className="muted-note">还没有研究问题。先建立 RQ1，后续 Claim 会回答它。</p>
      ) : (
        <ul className="card-list">
          {data.questions.map((question) => (
            <li key={question.id} className="research-card">
              {editingId === question.id ? (
                <div className="inline-form">
                  <Field label="编号">
                    <TextInput
                      value={editDraft.questionCode}
                      onChange={(value) => setEditDraft((previous) => ({ ...previous, questionCode: value }))}
                    />
                  </Field>
                  <Field label="研究问题">
                    <TextArea
                      value={editDraft.questionText}
                      onChange={(value) => setEditDraft((previous) => ({ ...previous, questionText: value }))}
                      rows={2}
                    />
                  </Field>
                  <Field label="状态">
                    <SelectInput value={editStatus} choices={STATUS_CHOICES} onChange={(value) => setEditStatus(value as ResearchQuestionStatus)} />
                  </Field>
                  <Field label="理由">
                    <TextArea value={editDraft.rationale} onChange={(value) => setEditDraft((previous) => ({ ...previous, rationale: value }))} rows={2} />
                  </Field>
                  <Field label="相关方法">
                    <TextInput value={editDraft.relatedMethod} onChange={(value) => setEditDraft((previous) => ({ ...previous, relatedMethod: value }))} />
                  </Field>
                  <div className="inline-row">
                    <BusyButton busy={busy} busyLabel="正在保存…" label="保存" onClick={() => void saveEdit(question.id)} />
                    <button type="button" className="btn" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="card-head">
                    <span className="badge">{question.questionCode}</span>
                    <span className={`badge ${question.status === 'open' ? 'badge-accent' : 'badge-quiet'}`}>
                      {labelOf(researchQuestionStatusLabels, question.status)}
                    </span>
                    <span className="muted-note">更新于 {question.updatedAt.slice(0, 10)}</span>
                    <div className="top-bar-spacer" />
                    <button type="button" className="btn" onClick={() => startEdit(question)}>
                      编辑
                    </button>
                  </div>
                  <p className="item-text">{question.questionText}</p>
                  {question.rationale !== null ? <p className="muted-note">理由：{question.rationale}</p> : null}
                  {question.relatedMethod !== null ? <p className="muted-note">相关方法：{question.relatedMethod}</p> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
