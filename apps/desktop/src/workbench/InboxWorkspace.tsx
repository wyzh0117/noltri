import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { InboxResponse, TreeNode } from '@noltri/schema';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import InboxPanel from './InboxPanel';
import {
  EMPTY_ROW,
  appendPage,
  assignmentMessage,
  assignPayload,
  nodeOptions,
  statusesForQuery,
  withRowPatch,
  type InboxFilter,
  type InboxRowState,
} from './inbox-model';

const PAGE_SIZE = 20;

export interface InboxWorkspaceProps {
  api: WorkbenchApi;
  /** The full tree: a capture may be filed at any depth, not only under the active domain. */
  nodes: readonly TreeNode[];
  /** Called after anything that changes the tree, so the rail and the detail column catch up. */
  onChanged: () => void;
}

/**
 * State owner for 收件箱. It holds the filter, the accumulated pages and the per-row triage draft, and is
 * the only place in this view that touches the network — InboxPanel just draws the result.
 */
export default function InboxWorkspace({ api, nodes, onChanged }: InboxWorkspaceProps): ReactElement {
  const [filter, setFilter] = useState<InboxFilter>('unfinished');
  const [response, setResponse] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, InboxRowState>>({});
  const [rawTexts, setRawTexts] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const targets = useMemo(() => nodeOptions(nodes), [nodes]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const page = await api.inbox({ status: statusesForQuery(filter), limit: PAGE_SIZE, offset: 0 });
      setResponse(page);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(id: string, patch: Partial<InboxRowState>): void {
    setRows((previous) => ({ ...previous, [id]: withRowPatch(previous[id], patch) }));
  }

  async function toggleText(id: string): Promise<void> {
    const open = !(rows[id]?.open ?? false);
    patchRow(id, { open });
    if (!open || rawTexts[id] !== undefined) return;
    try {
      const source = await api.rawSource(id);
      setRawTexts((previous) => ({ ...previous, [id]: source.rawText }));
    } catch (failure) {
      patchRow(id, { error: describeError(failure) });
    }
  }

  async function retry(id: string): Promise<void> {
    patchRow(id, { busy: true, error: null });
    try {
      const result = await api.retryCapture(id);
      setFeedback(
        result.processingStatus === 'failed'
          ? `重试仍未成功：${result.errorReason ?? '未知原因'}，可继续人工归档。`
          : `重试完成，本次归纳出 ${String(result.items.length)} 条知识点。`,
      );
      onChanged();
      await load();
    } catch (failure) {
      patchRow(id, { error: describeError(failure) });
    } finally {
      patchRow(id, { busy: false });
    }
  }

  async function assign(id: string): Promise<void> {
    const payload = assignPayload(rows[id] ?? EMPTY_ROW);
    if (payload === null) return;
    patchRow(id, { busy: true, error: null });
    try {
      const result = await api.assignSource(id, payload);
      setFeedback(assignmentMessage(result.path.map((segment) => segment.title)));
      onChanged();
      await load();
    } catch (failure) {
      patchRow(id, { error: describeError(failure) });
    } finally {
      patchRow(id, { busy: false });
    }
  }

  async function loadMore(): Promise<void> {
    if (response === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.inbox({
        status: statusesForQuery(filter),
        limit: response.limit,
        offset: response.offset + response.entries.length,
      });
      setResponse((previous) => (previous === null ? next : appendPage(previous, next)));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <InboxPanel
      response={response}
      loading={loading || loadingMore}
      error={error}
      feedback={feedback}
      filter={filter}
      targets={targets}
      rows={rows}
      rawTexts={rawTexts}
      onFilter={(key) => {
        setFeedback(null);
        setFilter(key);
      }}
      onLoadMore={() => void loadMore()}
      onToggleText={(id) => void toggleText(id)}
      onPickTarget={(id, targetId) => patchRow(id, { targetId })}
      onEditDraft={(id, text) => patchRow(id, { draft: text })}
      onRetry={(id) => void retry(id)}
      onAssign={(id) => void assign(id)}
    />
  );
}
