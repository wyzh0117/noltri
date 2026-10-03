'use client';

/**
 * Claims and their explicit relations (research doc §15–§17): evidence → claim (supports /
 * partially_supports / contradicts / qualifies / contextualizes), claim → RQ (answers) and
 * claim → section (appears_in). Relations are created and deleted here; the map only visualises them.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  ClaimStatus,
  ClaimType,
  CreateClaimRequest,
  CreateEntityRelationRequest,
  EntityRelation,
  PatchClaimRequest,
  ResearchEntityType,
  ResearchRelationType,
} from '@noltri/schema';
import { BusyButton, Field, FormError, SelectInput, TextArea, TextInput, type Choice } from './fields';
import { researchProjectBase, type ResearchData, type ResearchPanelProps } from './useResearchData';
import { apiDelete, apiPatch, apiPost, describeError } from '@/lib/client-api';
import {
  claimStatusLabels,
  claimTypeLabels,
  labelOf,
  researchRelationTypeLabels,
} from '@/lib/research-view';

const CLAIM_TYPE_CHOICES: readonly Choice[] = (Object.keys(claimTypeLabels) as ClaimType[]).map((value) => ({
  value,
  label: labelOf(claimTypeLabels, value),
}));

const CLAIM_STATUS_CHOICES: readonly Choice[] = (Object.keys(claimStatusLabels) as ClaimStatus[]).map((value) => ({
  value,
  label: labelOf(claimStatusLabels, value),
}));

/** Relation kinds the workbench offers, each with fixed endpoint semantics. */
const RELATION_CHOICES: readonly Choice[] = [
  { value: 'supports', label: '证据 支持 主张' },
  { value: 'partially_supports', label: '证据 部分支持 主张' },
  { value: 'contradicts', label: '证据 反驳 主张' },
  { value: 'qualifies', label: '证据 限定 主张' },
  { value: 'contextualizes', label: '证据 背景化 主张' },
  { value: 'answers', label: '主张 回答 研究问题' },
  { value: 'appears_in', label: '主张 出现于 论文章节' },
];

const EVIDENCE_TO_CLAIM: readonly ResearchRelationType[] = ['supports', 'partially_supports', 'contradicts', 'qualifies', 'contextualizes'];

interface ClaimDraft {
  claimCode: string;
  claimText: string;
  claimType: ClaimType;
  status: ClaimStatus;
  confidence: string;
  boundary: string;
}

const EMPTY_CLAIM: ClaimDraft = { claimCode: '', claimText: '', claimType: 'empirical', status: 'draft', confidence: '0.5', boundary: '' };

export default function ClaimsPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [draft, setDraft] = useState<ClaimDraft>(EMPTY_CLAIM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ClaimDraft>(EMPTY_CLAIM);
  const [relationKind, setRelationKind] = useState<ResearchRelationType>('supports');
  const [evidenceId, setEvidenceId] = useState('');
  const [claimId, setClaimId] = useState('');
  const [questionId, setQuestionId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = researchProjectBase(projectId);

  async function createClaim(): Promise<void> {
    if (draft.claimCode.trim().length === 0 || draft.claimText.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const payload: CreateClaimRequest = {
        claimCode: draft.claimCode.trim(),
        claimText: draft.claimText.trim(),
        claimType: draft.claimType,
        status: draft.status,
        confidence: toConfidence(draft.confidence),
        boundary: draft.boundary.trim().length > 0 ? draft.boundary.trim() : null,
      };
      await apiPost(`${base}/claims`, payload);
      setDraft(EMPTY_CLAIM);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveClaimEdit(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const payload: PatchClaimRequest = {
        claimCode: editDraft.claimCode.trim(),
        claimText: editDraft.claimText.trim(),
        claimType: editDraft.claimType,
        status: editDraft.status,
        confidence: toConfidence(editDraft.confidence),
        boundary: editDraft.boundary.trim().length > 0 ? editDraft.boundary.trim() : null,
      };
      await apiPatch(`/api/web/research/claims/${encodeURIComponent(id)}`, payload);
      setEditingId(null);
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createRelation(): Promise<void> {
    if (busy) return;
    const payload = relationPayload();
    if (payload === null) {
      setError('请先选择关系两端的实体。');
      return;
    }
    setBusy(true);
    try {
      await apiPost(`${base}/relations`, payload);
      setNote('');
      setError(null);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  function relationPayload(): CreateEntityRelationRequest | null {
    const trimmedNote = note.trim();
    const common = { relationType: relationKind, note: trimmedNote.length > 0 ? trimmedNote : null };
    if (EVIDENCE_TO_CLAIM.includes(relationKind)) {
      if (evidenceId === '' || claimId === '') return null;
      return { ...common, sourceType: 'evidence', sourceId: evidenceId, targetType: 'claim', targetId: claimId };
    }
    if (relationKind === 'answers') {
      if (claimId === '' || questionId === '') return null;
      return { ...common, sourceType: 'claim', sourceId: claimId, targetType: 'research_question', targetId: questionId };
    }
    if (sectionId === '' || claimId === '') return null;
    return { ...common, sourceType: 'claim', sourceId: claimId, targetType: 'manuscript_section', targetId: sectionId };
  }

  async function deleteRelation(relation: EntityRelation): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await apiDelete(`/api/web/research/relations/${encodeURIComponent(relation.id)}`);
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
        <h2 className="column-title column-title-tight">Claims（主张）</h2>
        <span className="column-hint">主张要可被支持、限制或反驳；建议写明 Claim Boundary。</span>
      </div>

      <div className="inline-form">
        <Field label="编号">
          <TextInput value={draft.claimCode} onChange={(value) => setDraft((previous) => ({ ...previous, claimCode: value }))} placeholder="C-021" />
        </Field>
        <Field label="主张内容">
          <TextArea value={draft.claimText} onChange={(value) => setDraft((previous) => ({ ...previous, claimText: value }))} rows={2} placeholder="可靠性相关因素在 ISM 模型中处于较高结构层级。" />
        </Field>
        <Field label="类型">
          <SelectInput value={draft.claimType} choices={CLAIM_TYPE_CHOICES} onChange={(value) => setDraft((previous) => ({ ...previous, claimType: value as ClaimType }))} />
        </Field>
        <Field label="状态">
          <SelectInput value={draft.status} choices={CLAIM_STATUS_CHOICES} onChange={(value) => setDraft((previous) => ({ ...previous, status: value as ClaimStatus }))} />
        </Field>
        <Field label="置信度（0–1）">
          <TextInput type="number" value={draft.confidence} onChange={(value) => setDraft((previous) => ({ ...previous, confidence: value }))} placeholder="0.5" />
        </Field>
        <Field label="Claim Boundary（可选）" hint="当前证据最多支持到什么程度。">
          <TextArea value={draft.boundary} onChange={(value) => setDraft((previous) => ({ ...previous, boundary: value }))} rows={2} placeholder="结构层级 ≠ 统计因果" />
        </Field>
        <div className="inline-row">
          <BusyButton
            busy={busy}
            busyLabel="正在创建…"
            label="创建 Claim"
            onClick={() => void createClaim()}
            disabled={draft.claimCode.trim().length === 0 || draft.claimText.trim().length === 0}
          />
        </div>
      </div>

      <FormError message={error} />

      {data.claims.length === 0 ? (
        <p className="muted-note">还没有 Claim。先创建一条主张，再把证据连上来。</p>
      ) : (
        <ul className="card-list">
          {data.claims.map((claim) => {
            const relations = data.relations.filter(
              (relation) => relation.sourceId === claim.id || relation.targetId === claim.id,
            );
            return (
              <li key={claim.id} className="research-card">
                {editingId === claim.id ? (
                  <div className="inline-form">
                    <Field label="编号">
                      <TextInput value={editDraft.claimCode} onChange={(value) => setEditDraft((previous) => ({ ...previous, claimCode: value }))} />
                    </Field>
                    <Field label="主张内容">
                      <TextArea value={editDraft.claimText} onChange={(value) => setEditDraft((previous) => ({ ...previous, claimText: value }))} rows={2} />
                    </Field>
                    <Field label="类型">
                      <SelectInput value={editDraft.claimType} choices={CLAIM_TYPE_CHOICES} onChange={(value) => setEditDraft((previous) => ({ ...previous, claimType: value as ClaimType }))} />
                    </Field>
                    <Field label="状态">
                      <SelectInput value={editDraft.status} choices={CLAIM_STATUS_CHOICES} onChange={(value) => setEditDraft((previous) => ({ ...previous, status: value as ClaimStatus }))} />
                    </Field>
                    <Field label="置信度（0–1）">
                      <TextInput type="number" value={editDraft.confidence} onChange={(value) => setEditDraft((previous) => ({ ...previous, confidence: value }))} />
                    </Field>
                    <Field label="Claim Boundary">
                      <TextArea value={editDraft.boundary} onChange={(value) => setEditDraft((previous) => ({ ...previous, boundary: value }))} rows={2} />
                    </Field>
                    <div className="inline-row">
                      <BusyButton busy={busy} busyLabel="正在保存…" label="保存" onClick={() => void saveClaimEdit(claim.id)} />
                      <button type="button" className="btn" onClick={() => setEditingId(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="card-head">
                      <span className="badge">{claim.claimCode}</span>
                      <span className="badge badge-quiet">{labelOf(claimTypeLabels, claim.claimType)}</span>
                      <span className="badge badge-accent">{labelOf(claimStatusLabels, claim.status)}</span>
                      <span className="muted-note">置信度 {claim.confidence.toFixed(2)}</span>
                      <div className="top-bar-spacer" />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setEditingId(claim.id);
                          setEditDraft({
                            claimCode: claim.claimCode,
                            claimText: claim.claimText,
                            claimType: claim.claimType,
                            status: claim.status,
                            confidence: String(claim.confidence),
                            boundary: claim.boundary ?? '',
                          });
                        }}
                      >
                        编辑
                      </button>
                    </div>
                    <p className="item-text">{claim.claimText}</p>
                    {claim.boundary !== null ? <p className="muted-note">边界：{claim.boundary}</p> : null}
                    {relations.length > 0 ? (
                      <ul className="relation-list">
                        {relations.map((relation) => (
                          <li key={relation.id} className="node-link-row">
                            <span className="relation-tag">{labelOf(researchRelationTypeLabels, relation.relationType)}</span>
                            <span className="item-text">
                              {entityLabel(data, relation.sourceType, relation.sourceId)} → {entityLabel(data, relation.targetType, relation.targetId)}
                            </span>
                            {relation.note !== null ? <span className="muted-note">{relation.note}</span> : null}
                            <button type="button" className="btn" onClick={() => void deleteRelation(relation)}>
                              删除
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted-note">这条主张还没有任何关系：没有证据支持时 Drift Checker 会给出「证据缺口」。</p>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="section-head">
        <h3 className="column-title column-title-tight">关系管理</h3>
        <span className="column-hint">Evidence → Claim、Claim → RQ、Claim → Section；重复创建同一关系是幂等的。</span>
      </div>
      <div className="inline-form">
        <Field label="关系类型">
          <SelectInput value={relationKind} choices={RELATION_CHOICES} onChange={(value) => setRelationKind(value as ResearchRelationType)} />
        </Field>
        {EVIDENCE_TO_CLAIM.includes(relationKind) ? (
          <>
            <Field label="证据">
              <SelectInput value={evidenceId} choices={data.evidence.map((entry) => ({ value: entry.id, label: entry.title }))} placeholder="选择证据" onChange={setEvidenceId} />
            </Field>
            <Field label="主张">
              <SelectInput value={claimId} choices={data.claims.map((entry) => ({ value: entry.id, label: `${entry.claimCode} ${entry.claimText}` }))} placeholder="选择主张" onChange={setClaimId} />
            </Field>
          </>
        ) : relationKind === 'answers' ? (
          <>
            <Field label="主张">
              <SelectInput value={claimId} choices={data.claims.map((entry) => ({ value: entry.id, label: `${entry.claimCode} ${entry.claimText}` }))} placeholder="选择主张" onChange={setClaimId} />
            </Field>
            <Field label="研究问题">
              <SelectInput value={questionId} choices={data.questions.map((entry) => ({ value: entry.id, label: `${entry.questionCode} ${entry.questionText}` }))} placeholder="选择 RQ" onChange={setQuestionId} />
            </Field>
          </>
        ) : (
          <>
            <Field label="主张">
              <SelectInput value={claimId} choices={data.claims.map((entry) => ({ value: entry.id, label: `${entry.claimCode} ${entry.claimText}` }))} placeholder="选择主张" onChange={setClaimId} />
            </Field>
            <Field label="论文章节">
              <SelectInput value={sectionId} choices={data.sections.map((entry) => ({ value: entry.id, label: entry.sectionReference === null ? entry.sectionName : `${entry.sectionName} · ${entry.sectionReference}` }))} placeholder="选择章节" onChange={setSectionId} />
            </Field>
          </>
        )}
        <Field label="备注（可选）">
          <TextInput value={note} onChange={setNote} placeholder="为什么这样关联？" />
        </Field>
        <div className="inline-row">
          <BusyButton busy={busy} busyLabel="正在建立…" label="建立关系" onClick={() => void createRelation()} />
        </div>
      </div>
    </section>
  );
}

function toConfidence(value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0.5;
  return Math.min(1, Math.max(0, parsed));
}

function entityLabel(data: ResearchData, type: ResearchEntityType, id: string): string {
  if (type === 'claim') return data.claims.find((entry) => entry.id === id)?.claimCode ?? id;
  if (type === 'research_question') return data.questions.find((entry) => entry.id === id)?.questionCode ?? id;
  if (type === 'evidence') return data.evidence.find((entry) => entry.id === id)?.title ?? id;
  if (type === 'manuscript_section') return data.sections.find((entry) => entry.id === id)?.sectionName ?? id;
  return id;
}
