import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { NodeDetail, TreeNode } from '@noltri/schema';
import { deriveDetail, moveTargetOptions, nodeStatusLabels } from '@noltri/shared';

export interface NodeDetailPanelProps {
  detail: NodeDetail | null;
  error: string | null;
  loading: boolean;
  treeNodes: readonly TreeNode[];
  versionRecordId: string | null;
  onOpenNode: (nodeId: string) => void;
  onRename: (patch: { title?: string; summary?: string }) => Promise<void>;
  onMove: (targetParentId: string | null) => Promise<void>;
  onOpenChat: () => void;
}

const MOVE_TO_ROOT = '__root__';

/**
 * V1 node detail (V1_DEVELOPMENT §17.2): title, summary, knowledge item count, source count, related
 * nodes and 与 AI 讨论 — plus the move control §8/§2.4 requires. Conflicts, gaps, history and inbox
 * indicators are deliberately absent until V2.
 */
export default function NodeDetailPanel({
  detail,
  error,
  loading,
  treeNodes,
  versionRecordId,
  onOpenNode,
  onRename,
  onMove,
  onOpenChat,
}: NodeDetailPanelProps): ReactElement {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>('');

  useEffect(() => {
    setEditingTitle(false);
    setEditingSummary(false);
    setMoveTarget('');
  }, [detail?.node.id]);

  if (loading) return <p className="detail-placeholder">正在载入节点…</p>;

  if (error !== null) {
    return (
      <div>
        <div className="column-title">节点详情</div>
        <p className="error-note">{error}</p>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div>
        <div className="column-title">节点详情</div>
        <p className="detail-placeholder">
          在知识树中选择节点（点击或方向键 + Enter），这里会显示摘要、知识点数量、来源数量与相关节点。
        </p>
      </div>
    );
  }

  const view = deriveDetail(detail);
  const targets = moveTargetOptions(treeNodes, view.id, detail.node.parentId);

  async function saveTitle(): Promise<void> {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (trimmed.length === 0 || trimmed === view.title) return;
    setBusy(true);
    await onRename({ title: trimmed });
    setBusy(false);
  }

  async function saveSummary(): Promise<void> {
    setEditingSummary(false);
    if (summaryDraft === view.summary) return;
    setBusy(true);
    await onRename({ summary: summaryDraft.trim() });
    setBusy(false);
  }

  return (
    <div>
      <div className="detail-breadcrumb">
        {view.breadcrumb.map((segment, index) => (
          <span key={segment.id} className="detail-breadcrumb-item">
            {index > 0 ? <span className="detail-sep">/</span> : null}
            <button type="button" onClick={() => onOpenNode(segment.id)}>
              {segment.title}
            </button>
          </span>
        ))}
      </div>

      <div className="detail-title-row">
        {editingTitle ? (
          <div className="inline-form inline-form-grow">
            <input
              className="field-input"
              value={titleDraft}
              autoFocus
              aria-label="节点标题"
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveTitle();
                if (event.key === 'Escape') setEditingTitle(false);
              }}
            />
            <span className="inline-row">
              <button type="button" className="btn btn-primary" onClick={() => void saveTitle()}>
                保存标题
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(view.title);
                }}
              >
                取消
              </button>
            </span>
          </div>
        ) : (
          <>
            <h2 className="detail-title">{view.title}</h2>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setTitleDraft(view.title);
                setEditingTitle(true);
              }}
            >
              重命名
            </button>
          </>
        )}
      </div>

      {editingSummary ? (
        <div className="inline-form">
          <textarea
            className="field-textarea"
            value={summaryDraft}
            autoFocus
            aria-label="节点摘要"
            onChange={(event) => setSummaryDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditingSummary(false);
            }}
          />
          <span className="inline-row">
            <button type="button" className="btn btn-primary" onClick={() => void saveSummary()}>
              保存摘要
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditingSummary(false);
                setSummaryDraft(view.summary);
              }}
            >
              取消
            </button>
          </span>
        </div>
      ) : (
        <div className="detail-summary">
          {view.hasSummary ? (
            view.summary
          ) : (
            <span className="detail-placeholder">还没有摘要。</span>
          )}
          <button
            type="button"
            className="icon-button summary-edit-button"
            onClick={() => {
              setSummaryDraft(view.summary);
              setEditingSummary(true);
            }}
          >
            {view.hasSummary ? '编辑摘要' : '写摘要'}
          </button>
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <span className="stat-label">知识点数</span>
          <span className="stat-value">{view.itemCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">来源数</span>
          <span className="stat-value">{view.sourceCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">子节点</span>
          <span className="stat-value">{view.childCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">关联节点</span>
          <span className="stat-value">{view.related.length}</span>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={onOpenChat}
        disabled={busy}
      >
        与 AI 讨论
      </button>

      <section className="section section-after-chat">
        <div className="section-head">
          <span>知识点</span>
          <span className="muted-note">{view.items.length} 条</span>
        </div>
        {view.hasItems ? (
          <ul className="item-list">
            {view.items.map((item) => (
              <li key={item.id} className="item-card">
                <p className="item-text">{item.text}</p>
                <div className="item-sources">
                  {item.sources.map((source) =>
                    source.url ? (
                      <a key={source.rawSourceId} href={source.url} target="_blank" rel="noreferrer">
                        {source.label}
                      </a>
                    ) : (
                      <span key={source.rawSourceId}>{source.label}</span>
                    ),
                  )}
                  {item.isAiDerived ? <span className="badge badge-quiet">AI 提炼</span> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-note">该节点暂无知识点，可以作为结构节点继续使用。</p>
        )}
      </section>

      {view.children.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <span>子节点</span>
          </div>
          <ul>
            {view.children.map((child) => (
              <li key={child.id}>
                <button type="button" className="node-link" onClick={() => onOpenNode(child.id)}>
                  {child.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.related.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <span>关联节点</span>
          </div>
          <ul>
            {view.related.map((related) => (
              <li key={`${related.id}-${related.relationType}`}>
                <button type="button" className="node-link" onClick={() => onOpenNode(related.id)}>
                  <span className="node-link-row">
                    <span>{related.title}</span>
                    <span className="relation-tag">{related.relationLabel}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <span>移动</span>
          <span className="muted-note">{nodeStatusLabels[detail.node.status]}</span>
        </div>
        <div className="move-form">
          <select
            className="field-select"
            aria-label="选择新的父节点"
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
          >
            <option value="">选择新的父节点…</option>
            {targets.map((target) => {
              const optionValue = target.id ?? MOVE_TO_ROOT;
              return (
                <option key={optionValue} value={optionValue} disabled={target.disabled}>
                  {`${indent(target.depth)}${target.title}${target.disabled ? '（当前位置）' : ''}`}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            className="btn"
            disabled={moveTarget === '' || busy}
            onClick={() => {
              if (moveTarget === '') return;
              setBusy(true);
              void onMove(moveTarget === MOVE_TO_ROOT ? null : moveTarget).finally(() => setBusy(false));
            }}
          >
            移动节点
          </button>
          {versionRecordId !== null ? (
            <p className="version-note">
              已写入版本记录 <code>{versionRecordId}</code>，该次移动可回退。
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function indent(depth: number): string {
  return '　'.repeat(Math.max(depth, 0));
}
