'use client';

/**
 * Manuscript sections (research doc §17): V1 only stores section_name / section_reference (+ order),
 * enough for claims to say where they appear without building an editor.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { CreateSectionRequest, ManuscriptSection, PatchSectionRequest } from '@noltri/schema';
import { BusyButton, Field, FormError, TextInput } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPatch, apiPost, describeError } from '@/lib/client-api';

interface SectionDraft {
  sectionName: string;
  sectionReference: string;
  sortOrder: string;
}

const EMPTY_DRAFT: SectionDraft = { sectionName: '', sectionReference: '', sortOrder: '' };

function toDraft(section: ManuscriptSection): SectionDraft {
  return {
    sectionName: section.sectionName,
    sectionReference: section.sectionReference ?? '',
    sortOrder: String(section.sortOrder),
  };
}

export default function SectionsPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [draft, setDraft] = useState<SectionDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SectionDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = researchProjectBase(projectId);
  const ordered = [...data.sections].sort((first, second) => first.sortOrder - second.sortOrder);

  async function create(): Promise<void> {
    if (draft.sectionName.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const payload: CreateSectionRequest = {
        sectionName: draft.sectionName.trim(),
        sectionReference: draft.sectionReference.trim().length > 0 ? draft.sectionReference.trim() : null,
        ...(draft.sortOrder.trim().length > 0 ? { sortOrder: Number(draft.sortOrder) } : {}),
      };
      await apiPost(`${base}/sections`, payload);
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
      const payload: PatchSectionRequest = {
        sectionName: editDraft.sectionName.trim(),
        sectionReference: editDraft.sectionReference.trim().length > 0 ? editDraft.sectionReference.trim() : null,
        sortOrder: editDraft.sortOrder.trim().length > 0 ? Number(editDraft.sortOrder) : undefined,
      };
      await apiPatch(`/api/web/research/sections/${encodeURIComponent(id)}`, payload);
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
        <h2 className="column-title column-title-tight">论文章节（Manuscript Section）</h2>
        <span className="column-hint">只保存章节名与章节引用（如 4.2）；Claim 通过「出现于」指向它们。</span>
      </div>

      <div className="inline-form">
        <Field label="章节名">
          <TextInput value={draft.sectionName} onChange={(value) => setDraft((previous) => ({ ...previous, sectionName: value }))} placeholder="Results" />
        </Field>
        <Field label="章节引用（可选）">
          <TextInput value={draft.sectionReference} onChange={(value) => setDraft((previous) => ({ ...previous, sectionReference: value }))} placeholder="4.2" />
        </Field>
        <Field label="顺序（可选）">
          <TextInput type="number" value={draft.sortOrder} onChange={(value) => setDraft((previous) => ({ ...previous, sortOrder: value }))} placeholder="1" />
        </Field>
        <div className="inline-row">
          <BusyButton busy={busy} busyLabel="正在创建…" label="添加章节" onClick={() => void create()} disabled={draft.sectionName.trim().length === 0} />
        </div>
      </div>

      <FormError message={error} />

      {ordered.length === 0 ? (
        <p className="muted-note">还没有论文章节。添加后即可把 Claim 关联到「出现于」。</p>
      ) : (
        <ul className="card-list">
          {ordered.map((section) => (
            <li key={section.id} className="research-card">
              {editingId === section.id ? (
                <div className="inline-form">
                  <Field label="章节名">
                    <TextInput value={editDraft.sectionName} onChange={(value) => setEditDraft((previous) => ({ ...previous, sectionName: value }))} />
                  </Field>
                  <Field label="章节引用">
                    <TextInput value={editDraft.sectionReference} onChange={(value) => setEditDraft((previous) => ({ ...previous, sectionReference: value }))} />
                  </Field>
                  <Field label="顺序">
                    <TextInput type="number" value={editDraft.sortOrder} onChange={(value) => setEditDraft((previous) => ({ ...previous, sortOrder: value }))} />
                  </Field>
                  <div className="inline-row">
                    <BusyButton busy={busy} busyLabel="正在保存…" label="保存" onClick={() => void saveEdit(section.id)} />
                    <button type="button" className="btn" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="card-head">
                    <span className="badge">#{section.sortOrder}</span>
                    <strong className="item-text">{section.sectionName}</strong>
                    {section.sectionReference !== null ? <span className="badge badge-quiet">{section.sectionReference}</span> : null}
                    <div className="top-bar-spacer" />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setEditingId(section.id);
                        setEditDraft(toDraft(section));
                      }}
                    >
                      编辑
                    </button>
                  </div>
                  <p className="muted-note">
                    {countAppearances(data, section.id)} 条 Claim 关联到此章节
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function countAppearances(data: { relations: readonly { relationType: string; targetId: string }[] }, sectionId: string): number {
  return data.relations.filter((relation) => relation.relationType === 'appears_in' && relation.targetId === sectionId).length;
}
