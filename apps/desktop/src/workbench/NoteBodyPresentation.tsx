import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { buildNoteMindmap } from './mindmap-view-model';
import type { NoteMindmapNode } from './mindmap-view-model';
import './mindmap-view.css';

export interface NoteBodyPresentationSlots {
  toggleButton: ReactElement;
  viewport: ReactElement;
  isMindmap: boolean;
  returnToText: () => void;
}

export interface NoteBodyPresentationProps {
  content: string;
  path: string;
  textView: ReactNode;
  onLocate: (sourceOffset: number) => void;
  children: (slots: NoteBodyPresentationSlots) => ReactNode;
}

function displayName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/iu, '') || '当前笔记';
}

function MindmapNode({ node, collapsedIds, onLocate, onToggle }: {
  node: NoteMindmapNode;
  collapsedIds: ReadonlySet<string>;
  onLocate: (sourceOffset: number) => void;
  onToggle: (id: string) => void;
}): ReactElement {
  const collapsed = collapsedIds.has(node.id);
  const hasChildren = node.children.length > 0;
  return <li className={`vault-mindmap-node level-${Math.min(node.level, 6)}`} data-node-id={node.id} data-source-offset={node.sourceOffset}>
    <div className="vault-mindmap-card">
      <button type="button" className="vault-mindmap-title" aria-label={`定位到正文：${node.title || '空标题'}`} onClick={() => onLocate(node.sourceOffset)}>
        <span className="vault-mindmap-level">H{node.level}</span><span>{node.title || '（空标题）'}</span>
      </button>
      {hasChildren ? <button type="button" className="vault-mindmap-collapse" aria-label={`${collapsed ? '展开' : '折叠'} ${node.title || '空标题'}`} aria-expanded={!collapsed} onClick={() => onToggle(node.id)}>{collapsed ? '＋' : '−'}</button> : null}
      {node.body !== '' ? <div className="vault-mindmap-body"><span>正文</span><p>{node.body}</p></div> : null}
    </div>
    {hasChildren && !collapsed ? <ul className="vault-mindmap-children">{node.children.map((child) => <MindmapNode key={child.id} node={child} collapsedIds={collapsedIds} onLocate={onLocate} onToggle={onToggle} />)}</ul> : null}
  </li>;
}

export function NoteMindmapView({ content, path, onLocate }: Pick<NoteBodyPresentationProps, 'content' | 'path' | 'onLocate'>): ReactElement {
  const model = useMemo(() => buildNoteMindmap(content, path), [content, path]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setCollapsed(new Set()); }, [path]);
  const toggle = (id: string): void => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return <div className="vault-mindmap-scroll" aria-label={`${displayName(path)} 标题层级思维导图`} data-testid="note-mindmap">
    <header className="vault-mindmap-heading"><span>标题层级 · 只读</span><h2>{displayName(path)}</h2></header>
    {model.isEmpty ? <p className="vault-mindmap-empty">这篇笔记还没有正文或标题。</p> : <div className="vault-mindmap-tree">
      {model.leadBody !== '' ? <div className="vault-mindmap-lead"><span>开篇正文</span><p>{model.leadBody}</p></div> : null}
      {model.roots.length > 0 ? <ul className="vault-mindmap-roots">{model.roots.map((node) => <MindmapNode key={node.id} node={node} collapsedIds={collapsed} onLocate={onLocate} onToggle={toggle} />)}</ul> : null}
    </div>}
  </div>;
}

export function NoteBodyPresentation({ content, path, textView, onLocate, children }: NoteBodyPresentationProps): ReactElement {
  const [isMindmap, setIsMindmap] = useState(false);
  const toggleButton = <button
    type="button"
    className={`vault-body-view-toggle${isMindmap ? ' is-active' : ''}`}
    aria-label={isMindmap ? '返回笔记正文视图' : '切换为思维导图视图'}
    aria-pressed={isMindmap}
    data-testid="body-view-toggle"
    onClick={() => setIsMindmap((current) => !current)}
  >{isMindmap ? '正文' : '思维导图'}</button>;
  const viewport = <div className={`vault-note-view-stack${isMindmap ? ' is-mindmap' : ''}`} data-current-view={isMindmap ? 'mindmap' : 'text'}>
    <div className={`vault-note-view-layer vault-note-text-layer${isMindmap ? '' : ' is-active'}`} aria-hidden={isMindmap} inert={isMindmap} data-view-layer="text">{textView}</div>
    <div className={`vault-note-view-layer vault-note-mindmap-layer${isMindmap ? ' is-active' : ''}`} aria-hidden={!isMindmap} inert={!isMindmap} data-view-layer="mindmap">
      <NoteMindmapView content={content} path={path} onLocate={(offset) => { setIsMindmap(false); onLocate(offset); }} />
    </div>
  </div>;
  return <>{children({ toggleButton, viewport, isMindmap, returnToText: () => setIsMindmap(false) })}</>;
}
