import type { ReactElement } from 'react';
import type { InboxEntry, InboxResponse } from '@noltri/schema';
import { processingStatusLabels } from '@noltri/shared';
import {
  EMPTY_ROW,
  assignPayload,
  badgeCounts,
  canAssign,
  canRetry,
  capturedLine,
  filterOption,
  hasMorePages,
  inboxFilterOptions,
  indentOption,
  sourceLine,
  statusBadgeClass,
  type InboxFilter,
  type InboxRowState,
  type NodeOption,
} from './inbox-model';

export interface InboxPanelProps {
  response: InboxResponse | null;
  loading: boolean;
  error: string | null;
  /** Panel-level success line; per-row failures stay on the row that caused them. */
  feedback: string | null;
  filter: InboxFilter;
  targets: readonly NodeOption[];
  rows: Readonly<Record<string, InboxRowState>>;
  rawTexts: Readonly<Record<string, string>>;
  onFilter: (key: InboxFilter) => void;
  onLoadMore: () => void;
  onToggleText: (id: string) => void;
  onPickTarget: (id: string, targetId: string) => void;
  onEditDraft: (id: string, text: string) => void;
  onRetry: (id: string) => void;
  onAssign: (id: string) => void;
}

const EMPTY_TEXT: Record<InboxFilter, string> = {
  all: '还没有任何收录记录。',
  unfinished: '没有需要处理的原文，收件箱是干净的。',
  pending: '没有待整理的原文。',
  processing: '没有正在整理的原文。',
  done: '还没有已归纳的原文。',
  failed: '没有归纳失败的原文。',
};

/**
 * 收件箱 (V1_DEVELOPMENT §08): 待整理原文、来源预览、归纳状态、归档目标、重试和人工处理. It draws only what
 * InboxWorkspace and inbox-model decide, which is what makes the triage rules testable on their own.
 */
export default function InboxPanel({
  response,
  loading,
  error,
  feedback,
  filter,
  targets,
  rows,
  rawTexts,
  onFilter,
  onLoadMore,
  onToggleText,
  onPickTarget,
  onEditDraft,
  onRetry,
  onAssign,
}: InboxPanelProps): ReactElement {
  const entries = response?.entries ?? [];

  return (
    <section className="inbox" aria-label="收件箱">
      <div className="column-title">收件箱</div>

      <div className="inbox-counts" aria-live="polite">
        {response === null ? (
          <span className="muted-note">{loading ? '正在载入收件箱…' : '尚未取得收件箱计数。'}</span>
        ) : (
          badgeCounts(response.counts).map((entry) => (
            <span key={entry.status} className={statusBadgeClass(entry.status)}>
              {entry.label} {entry.value}
            </span>
          ))
        )}
      </div>

      <div className="inbox-filters" role="radiogroup" aria-label="收件箱筛选">
        {inboxFilterOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={filter === option.key}
            className={filter === option.key ? 'scope-btn scope-btn-active' : 'scope-btn'}
            onClick={() => onFilter(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}
      {feedback !== null ? <p className="version-note">{feedback}</p> : null}

      {response !== null && entries.length === 0 && !loading ? (
        <p className="muted-note">{EMPTY_TEXT[filter] ?? EMPTY_TEXT.all}</p>
      ) : null}

      <ul className="inbox-list">
        {entries.map((entry) => (
          <InboxRow
            key={entry.id}
            entry={entry}
            row={rows[entry.id]}
            targets={targets}
            rawText={rawTexts[entry.id] ?? null}
            onToggleText={onToggleText}
            onPickTarget={onPickTarget}
            onEditDraft={onEditDraft}
            onRetry={onRetry}
            onAssign={onAssign}
          />
        ))}
      </ul>

      {response !== null && hasMorePages(response, filter) ? (
        <button type="button" className="btn" onClick={onLoadMore} disabled={loading}>
          加载更多（已显示 {String(entries.length)} 条，筛选「{filterOption(filter).label}」）
        </button>
      ) : null}
    </section>
  );
}

interface InboxRowProps {
  entry: InboxEntry;
  row: InboxRowState | undefined;
  targets: readonly NodeOption[];
  rawText: string | null;
  onToggleText: (id: string) => void;
  onPickTarget: (id: string, targetId: string) => void;
  onEditDraft: (id: string, text: string) => void;
  onRetry: (id: string) => void;
  onAssign: (id: string) => void;
}

function InboxRow({
  entry,
  row,
  targets,
  rawText,
  onToggleText,
  onPickTarget,
  onEditDraft,
  onRetry,
  onAssign,
}: InboxRowProps): ReactElement {
  const state = row ?? EMPTY_ROW;
  const payload = assignPayload(state);

  return (
    <li className="inbox-row">
      <div className="inbox-head">
        <span className={statusBadgeClass(entry.processingStatus)}>
          {processingStatusLabels[entry.processingStatus]}
        </span>
        <span className="inbox-source">{sourceLine(entry)}</span>
        <span className="muted-note">
          {capturedLine(entry.capturedAt)} · {String(entry.rawTextLength)} 字
        </span>
        {entry.sourceUrl !== null ? (
          <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
            来源
          </a>
        ) : null}
      </div>

      <p className="inbox-text">{entry.textPreview}</p>
      {entry.errorReason !== null ? <p className="error-note">归纳失败原因：{entry.errorReason}</p> : null}

      {state.open ? <pre className="inbox-full">{rawText ?? '正在读取原文…'}</pre> : null}

      <div className="inline-row">
        <button type="button" className="btn" onClick={() => onToggleText(entry.id)}>
          {state.open ? '收起原文' : '查看原文'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canRetry(entry.processingStatus) || state.busy}
          onClick={() => onRetry(entry.id)}
        >
          {state.busy ? '处理中…' : '重试归纳'}
        </button>
      </div>

      {canAssign(entry.processingStatus) ? (
        <div className="inbox-assign">
          <select
            className="field-select"
            aria-label={`归档目标 ${entry.id}`}
            value={state.targetId}
            onChange={(event) => onPickTarget(entry.id, event.target.value)}
          >
            <option value="">选择归档节点…</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {`${indentOption(target.depth)}${target.title}`}
              </option>
            ))}
          </select>
          <textarea
            className="field-textarea"
            aria-label={`要归档的文字 ${entry.id}`}
            rows={3}
            value={state.draft}
            placeholder="留空则归档整段原文；也可只写你想保留的那句"
            onChange={(event) => onEditDraft(entry.id, event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={payload === null || state.busy}
            onClick={() => onAssign(entry.id)}
          >
            人工归档
          </button>
        </div>
      ) : (
        <p className="muted-note">正在整理中，稍后可重试或人工归档。</p>
      )}

      {state.error !== null ? <p className="error-note">{state.error}</p> : null}
    </li>
  );
}
