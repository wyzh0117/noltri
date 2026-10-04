'use client';

import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import type { TreeNode } from '@noltri/schema';
import { nodeStatusLabels } from '@noltri/shared';
import type { FlatNode } from '@noltri/shared';

export interface KnowledgeTreeViewProps {
  nodes: readonly TreeNode[];
  flat: readonly FlatNode[];
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  loading: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

/**
 * The knowledge tree drawn with nested lists and CSS connector lines: no canvas, no graph library.
 * Keyboard handling lives on the surrounding column (see Workspace) so ArrowUp/Down/Left/Right/Enter
 * work from the first focusable row.
 */
export default function KnowledgeTreeView({
  nodes,
  flat,
  expanded,
  selectedId,
  loading,
  onToggle,
  onSelect,
}: KnowledgeTreeViewProps): ReactElement {
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selectedId === null) return;
    const frame = frameRef.current;
    if (!frame) return;
    const row = frame.querySelector<HTMLElement>(`[data-node-id="${cssEscape(selectedId)}"]`);
    row?.focus({ preventScroll: false });
  }, [selectedId, flat]);

  if (nodes.length === 0) {
    return (
      <div className="tree-frame" ref={frameRef}>
        <p className="muted-note">{loading ? '正在载入知识树…' : '该知识域暂时没有节点。'}</p>
      </div>
    );
  }

  return (
    <div className="tree-frame" ref={frameRef}>
      <ul className="tree-list tree-list-root" role="tree" aria-label="知识树">
        <TreeBranch
          nodes={nodes}
          depth={0}
          expanded={expanded}
          selectedId={selectedId}
          fallbackTabStopId={flat[0]?.id ?? null}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      </ul>
    </div>
  );
}

interface TreeBranchProps {
  nodes: readonly TreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  fallbackTabStopId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

function TreeBranch({
  nodes,
  depth,
  expanded,
  selectedId,
  fallbackTabStopId,
  onToggle,
  onSelect,
}: TreeBranchProps): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        const children = node.children ?? [];
        const hasChildren = children.length > 0;
        const isOpen = expanded.has(node.id);
        const isSelected = selectedId === node.id;
        return (
          <li key={node.id} className="tree-item" role="none">
            <div
              role="treeitem"
              data-node-id={node.id}
              aria-level={depth + 1}
              aria-selected={isSelected}
              aria-expanded={hasChildren ? isOpen : undefined}
              tabIndex={isSelected || (selectedId === null && node.id === fallbackTabStopId) ? 0 : -1}
              className={isSelected ? 'tree-row tree-row-selected' : 'tree-row'}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={isOpen ? `收起 ${node.title}` : `展开 ${node.title}`}
                  tabIndex={-1}
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onToggle(node.id);
                  }}
                >
                  <span className={isOpen ? 'tree-caret tree-caret-open' : 'tree-caret'} aria-hidden="true" />
                </button>
              ) : (
                <span className="tree-toggle-spacer" aria-hidden="true" />
              )}

              <span className="tree-label">{node.title}</span>

              <span className="tree-meta">
                <span className={node.itemCount === 0 ? 'badge badge-quiet' : 'badge'}>
                  {node.itemCount} 知识点
                </span>
                {hasChildren ? <span className="badge badge-quiet">{children.length} 子节点</span> : null}
                {node.status !== 'active' ? (
                  <span className="badge badge-warn">{nodeStatusLabels[node.status]}</span>
                ) : null}
              </span>
            </div>

            {hasChildren && isOpen ? (
              <ul className="tree-list" role="group">
                <TreeBranch
                  nodes={children}
                  depth={depth + 1}
                  expanded={expanded}
                  selectedId={selectedId}
                  fallbackTabStopId={fallbackTabStopId}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
