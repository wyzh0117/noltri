import type { ReactElement } from 'react';
import type { CharterVersion } from '@noltri/schema';
import {
  CHARTER_FIELD_LABELS,
  CHARTER_FIELD_ORDER,
  approvalEntities,
  approvalIsSendable,
  approvalPayload,
  baselineLine,
  changedFieldLabels,
  draftPayload,
  impactKey,
  type CharterDraft,
  type ImpactOption,
} from './research-model';

export interface CharterPanelProps {
  draft: CharterDraft;
  baseline: CharterVersion | null;
  versions: readonly CharterVersion[];
  impactOptions: readonly ImpactOption[];
  impactSelected: Readonly<Record<string, boolean>>;
  revisionReason: string;
  busy: boolean;
  error: string | null;
  feedback: string | null;
  onField: (field: keyof CharterDraft, value: string) => void;
  onRevisionReason: (value: string) => void;
  onToggleImpact: (key: string) => void;
  onSave: () => void;
  onApprove: () => void;
}

/**
 * 章程与边界 (V1_DEVELOPMENT §13「研究章程」): the 15-field draft, the 批准 that freezes it as an immutable
 * baseline (R06), and the objects the approver says this revision touched. 批准 is a second, separate act —
 * saving the draft does not move the baseline, which is precisely what makes 偏移检查 meaningful.
 */
export default function CharterPanel({
  draft,
  baseline,
  versions,
  impactOptions,
  impactSelected,
  revisionReason,
  busy,
  error,
  feedback,
  onField,
  onRevisionReason,
  onToggleImpact,
  onSave,
  onApprove,
}: CharterPanelProps): ReactElement {
  const payload = draftPayload(draft);
  const entities = approvalEntities(impactSelected, impactOptions);
  const approvalReady = approvalIsSendable(revisionReason);

  return (
    <section className="research-panel" aria-label="章程与边界">
      <div className="column-title">章程与边界</div>
      <p className="column-hint">保存写草稿，批准把当前草稿冻结成新基线；批准必须写清这版改了什么。</p>

      <p className="version-note">当前基线：{baselineLine(baseline)}</p>

      <div className="charter-grid">
        {CHARTER_FIELD_ORDER.map((field) => (
          <label key={field} className="charter-field">
            <span className="charter-label">
              {CHARTER_FIELD_LABELS[field]}
              {field === 'workingTitle' ? <span className="badge badge-accent">必填</span> : null}
            </span>
            <textarea
              className="field-textarea"
              rows={2}
              aria-label={CHARTER_FIELD_LABELS[field]}
              value={draft[field]}
              onChange={(event) => onField(field, event.target.value)}
            />
          </label>
        ))}
      </div>

      <div className="inline-row">
        <button type="button" className="btn btn-primary" disabled={payload === null || busy} onClick={onSave}>
          保存草稿
        </button>
        {payload === null ? <span className="muted-note">工作标题不能为空，否则保存无从进行。</span> : null}
      </div>

      <div className="section">
        <div className="section-head">批准这一版</div>
        <textarea
          className="field-textarea"
          rows={2}
          aria-label="修订理由"
          placeholder="这次修订动了什么、为什么（必填）"
          value={revisionReason}
          onChange={(event) => onRevisionReason(event.target.value)}
        />
        <p className="muted-note">
          点名这次修订影响到的对象（可留空）。被点到的对象会被 Core 标上「待复核」，不会自动改动内容。
        </p>
        {impactOptions.length === 0 ? (
          <p className="muted-note">这个项目还没有论点、证据、问题或章节可点名。</p>
        ) : (
          <ul className="charter-impact">
            {impactOptions.map((option) => (
              <li key={impactKey(option)}>
                <label className="charter-impact-row">
                  <input
                    type="checkbox"
                    checked={impactSelected[impactKey(option)] === true}
                    onChange={() => onToggleImpact(impactKey(option))}
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="inline-row">
          <button type="button" className="btn btn-primary" disabled={!approvalReady || busy} onClick={onApprove}>
            批准并冻结基线
          </button>
          <span className="muted-note">
            将点名 {entities.length} 个对象；理由：
            {revisionReason.trim() === '' ? '（尚未填写）' : approvalPayload(revisionReason, entities).revisionReason}
          </span>
        </div>
      </div>

      <div className="section">
        <div className="section-head">基线历史</div>
        {versions.length === 0 ? (
          <p className="muted-note">还没有任何批准过的基线。</p>
        ) : (
          <ul className="item-list">
            {[...versions].reverse().map((version) => (
              <li key={version.id} className="item-card">
                <div className="inline-row">
                  <span className="badge badge-quiet">v{version.version}</span>
                  <span className="muted-note">{version.approvedAt.slice(0, 16).replace('T', ' ')}</span>
                  {version.previousVersion === null ? (
                    <span className="badge badge-accent">首个基线</span>
                  ) : (
                    <span className="muted-note">上一版 v{version.previousVersion}</span>
                  )}
                </div>
                <p className="item-text">{version.revisionReason}</p>
                <p className="muted-note">
                  {version.changedFields.length === 0
                    ? '字段无变化（首个基线的 changedFields 是空表，不是「全部字段都改了」）。'
                    : `变化字段：${changedFieldLabels(version.changedFields).join('、')}`}
                </p>
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
