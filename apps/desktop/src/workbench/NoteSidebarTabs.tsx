import { useEffect, useRef, type ReactElement } from 'react';

const relationPanels = ['graph', 'outline', 'tags', 'properties', 'backlinks', 'mentions', 'history'] as const;
type RelationPanel = typeof relationPanels[number];
export type NotePanel = RelationPanel | 'interpretation';
const labels: Record<RelationPanel, string> = { graph: '图谱', outline: '大纲', tags: '标签', properties: '属性', backlinks: '反链', mentions: '提及', history: '历史' };

export function NoteSidebarTabs({ panel, onSelect, hasGraph = false }: { panel: NotePanel; onSelect: (panel: NotePanel) => void; hasGraph?: boolean }): ReactElement {
  const lastRelation = useRef<RelationPanel>(panel === 'interpretation' ? 'outline' : panel);
  useEffect(() => { if (panel !== 'interpretation') lastRelation.current = panel; }, [panel]);
  const interpreting = panel === 'interpretation';
  return <>
    <nav className="vault-sidebar-sections" aria-label="阅读侧栏分区">
      <button type="button" className={!interpreting ? 'is-active' : ''} onClick={() => onSelect(lastRelation.current === 'graph' && !hasGraph ? 'outline' : lastRelation.current)} aria-pressed={!interpreting}>关系</button>
      <button type="button" className={interpreting ? 'is-active' : ''} onClick={() => onSelect('interpretation')} aria-pressed={interpreting}>解读</button>
    </nav>
    {!interpreting ? <div className="vault-organize-tabs" role="group" aria-label="关系工具">{relationPanels.filter(item => item !== 'graph' || hasGraph).map((item) => <button type="button" key={item} className={panel === item ? 'is-active' : ''} onClick={() => onSelect(item)} aria-pressed={panel === item}>{labels[item]}</button>)}</div> : null}
  </>;
}
