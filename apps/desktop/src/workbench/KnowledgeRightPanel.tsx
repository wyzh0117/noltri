import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import type { GraphEdge, GraphNode, GraphScope, VaultGraph } from '@noltri/schema';
import { WorkbenchGraph } from './WorkbenchGraph';
import type { GraphOpenIntent } from './WorkbenchGraph';
import { buildAdvancedGraphView } from './workbench-advanced-graph-view';
import { buildSubjectGraphView } from './workbench-semantic-graph-projection';
import type { VaultGraphRenderNode } from './workbench-graph-render-data';
import {
  DEFAULT_RIGHT_PANEL_PREFERENCES,
  RIGHT_TOOL_ORDER,
  readRightPanelPreferences,
  rightPanelPreferencesKey,
  writeRightPanelPreferences,
} from './knowledge-right-panel-state';
import type { RightSection, RightTool } from './knowledge-right-panel-state';
import './knowledge-right-panel.css';

export type { RightSection, RightTool } from './knowledge-right-panel-state';

const TOOL_LABELS: Record<RightTool, string> = {
  outline: '大纲',
  backlinks: '反向链接',
  outgoing: '出链',
  tags: '标签',
  properties: '来源与属性',
};

const SECTION_LABELS: Record<RightSection, string> = { relations: '关系', interpretation: '解读' };
const EMPTY_SEMANTIC_GRAPH = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };

export type RightToolPanels = Record<RightTool, ReactNode>;

export interface KnowledgeRightPanelProps {
  readonly scope: GraphScope | null;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly projectionNodes?: readonly GraphNode[];
  readonly projectionEdges?: readonly GraphEdge[];
  readonly localFocusScope?: GraphScope | null;
  readonly scopeIdentity: string;
  readonly contextNodeId: string;
  readonly selectedNodeId: string | null;
  readonly mode: 'mini' | 'expanded';
  readonly onModeChange: (mode: 'mini' | 'expanded') => void;
  readonly view: 'subject' | 'advanced';
  readonly onViewChange: (view: 'subject' | 'advanced') => void;
  readonly subjectScope: 'local' | 'whole-discipline';
  readonly canEnterWholeDiscipline?: boolean;
  readonly onSubjectScopeChange: (scope: 'local' | 'whole-discipline') => void;
  readonly advancedScope: 'focus' | 'discipline' | 'all';
  readonly onAdvancedScopeChange: (scope: 'focus' | 'discipline' | 'all') => void;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRefresh?: () => void;
  readonly evaluateQuery: (query: string) => Promise<ReadonlySet<string>>;
  readonly onNodeOpen: (node: GraphNode, intent: GraphOpenIntent) => void;
  readonly onAuxiliaryNodeOpen?: (node: VaultGraphRenderNode, intent: GraphOpenIntent) => void;
  readonly onNodeMore?: (node: GraphNode) => void;
  readonly vaultGraph?: VaultGraph | null;
  readonly toolPanels: RightToolPanels;
  readonly interpretationPanel: ReactNode;
  readonly workspaceKey?: string;
  readonly onToolChange?: (tool: RightTool) => void;
  readonly toolRequest?: { readonly tool: RightTool; readonly id: number };
  readonly sectionRequest?: { readonly section: RightSection; readonly id: number };
}

function readPreferences(key: string) {
  return typeof window === 'undefined'
    ? DEFAULT_RIGHT_PANEL_PREFERENCES
    : readRightPanelPreferences(window.localStorage, key);
}

export function KnowledgeRightPanel({
  scope,
  nodes,
  edges,
  projectionNodes,
  projectionEdges,
  localFocusScope,
  scopeIdentity,
  contextNodeId,
  selectedNodeId,
  mode,
  onModeChange,
  view,
  onViewChange,
  subjectScope,
  canEnterWholeDiscipline = false,
  onSubjectScopeChange,
  advancedScope,
  onAdvancedScopeChange,
  loading = false,
  error = null,
  onRefresh,
  evaluateQuery,
  onNodeOpen,
  onAuxiliaryNodeOpen,
  onNodeMore,
  vaultGraph = null,
  toolPanels,
  interpretationPanel,
  workspaceKey = 'default',
  onToolChange,
  toolRequest,
  sectionRequest,
}: KnowledgeRightPanelProps): ReactElement {
  const instanceId = useId();
  const preferencesKey = rightPanelPreferencesKey(workspaceKey);
  const [preferences, setPreferences] = useState(() => readPreferences(preferencesKey));
  const toolRefs = useRef<Partial<Record<RightTool, HTMLButtonElement | null>>>({});
  const relationsRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const projectionGraph = useMemo(() => ({ nodes: projectionNodes ?? nodes, edges: projectionEdges ?? edges }), [projectionNodes, projectionEdges, nodes, edges]);
  const panelProjectionGraph = scope === null && !(view === 'advanced' && advancedScope === 'all')
    ? EMPTY_SEMANTIC_GRAPH
    : projectionGraph;
  const subjectGraph = useMemo(() => buildSubjectGraphView(panelProjectionGraph, scope, subjectScope, localFocusScope), [panelProjectionGraph, scope, subjectScope, localFocusScope]);
  const expanded = mode === 'expanded';
  const advancedGraph = useMemo(() => buildAdvancedGraphView({
    semanticNodes: panelProjectionGraph.nodes,
    semanticEdges: panelProjectionGraph.edges,
    vaultGraph: view === 'advanced' ? vaultGraph : null,
    scope,
    contextNodeId: selectedNodeId ?? contextNodeId,
    advancedScope,
    filters: preferences.advancedFilters,
  }), [panelProjectionGraph, view, vaultGraph, scope, selectedNodeId, contextNodeId, advancedScope, preferences.advancedFilters]);
  const graphNodes = view === 'advanced' ? advancedGraph.nodes : subjectGraph.nodes;
  const graphEdges = view === 'advanced' ? advancedGraph.edges : subjectGraph.edges;

  useEffect(() => {
    setPreferences(readPreferences(preferencesKey));
  }, [preferencesKey]);

  useEffect(() => {
    if (toolRequest === undefined || toolRequest.id <= 0) return;
    updatePreferences({ section: 'relations', tool: toolRequest.tool });
  }, [toolRequest?.id]);

  useEffect(() => {
    if (sectionRequest === undefined || sectionRequest.id <= 0) return;
    updatePreferences({ section: sectionRequest.section });
  }, [sectionRequest?.id]);

  function updatePreferences(patch: Partial<typeof preferences>): void {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== 'undefined') writeRightPanelPreferences(window.localStorage, preferencesKey, next);
      return next;
    });
  }

  function selectTool(tool: RightTool): void {
    updatePreferences({ section: 'relations', tool });
    onToolChange?.(tool);
  }

  function handleToolKeyDown(event: KeyboardEvent<HTMLDivElement>, activeTool: RightTool): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const index = RIGHT_TOOL_ORDER.indexOf(activeTool);
    const next = RIGHT_TOOL_ORDER[(index + direction + RIGHT_TOOL_ORDER.length) % RIGHT_TOOL_ORDER.length]!;
    selectTool(next);
    toolRefs.current[next]?.focus();
  }

  function selectSection(section: RightSection): void {
    updatePreferences({ section });
  }

  function setCompactGraphHeight(height: number): void {
    const containerHeight = relationsRef.current?.clientHeight ?? 0;
    if (containerHeight <= 0) return;
    updatePreferences({ compactGraphHeight: Math.min(0.8, Math.max(0.3, height / containerHeight)) });
  }

  function beginGraphResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || relationsRef.current === null) return;
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: relationsRef.current.querySelector('.knowledge-right-graph')?.getBoundingClientRect().height ?? 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGraphResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (resize === null || resize.pointerId !== event.pointerId) return;
    setCompactGraphHeight(resize.startHeight + event.clientY - resize.startY);
  }

  function endGraphResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleGraphResizeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const graphHeight = relationsRef.current?.querySelector('.knowledge-right-graph')?.getBoundingClientRect().height ?? 0;
    setCompactGraphHeight(graphHeight + (event.key === 'ArrowUp' ? 16 : -16));
  }

  const activeTool = preferences.tool;
  const activeSection = preferences.section;
  const toolPanelId = `${instanceId}-tool-panel`;
  return <section
    className={`knowledge-right-panel${expanded && activeSection === 'relations' ? ' knowledge-right-panel-expanded' : ''}`}
    aria-label="知识关系与工具"
    data-section={activeSection}
    data-mode={mode}
  >
    <nav className="knowledge-right-sections" role="tablist" aria-label="阅读侧栏分区">
      {(['relations', 'interpretation'] as const).map((section) => <button
        key={section}
        type="button"
        role="tab"
        aria-selected={activeSection === section}
        aria-controls={`${instanceId}-${section}`}
        className={activeSection === section ? 'is-active' : ''}
        onClick={() => selectSection(section)}
      >{SECTION_LABELS[section]}</button>)}
    </nav>

    {activeSection === 'relations' ? <div id={`${instanceId}-relations`} ref={relationsRef} className="knowledge-right-relations" role="tabpanel" aria-label="关系工具">
      <section className="knowledge-right-graph" style={!expanded ? { flexBasis: `${preferences.compactGraphHeight * 100}%` } : undefined}>
        <header className="knowledge-right-graph-header">
          <div className="knowledge-right-graph-switches" role="group" aria-label="Graph 类型">
            <button type="button" aria-pressed={view === 'subject'} onClick={() => onViewChange('subject')}>学科图谱</button>
            <button type="button" aria-pressed={view === 'advanced'} onClick={() => onViewChange('advanced')}>高级网络</button>
          </div>
          {view === 'subject' ? <label className="knowledge-right-scope">
            <span>范围</span>
            <select aria-label="学科图范围" value={subjectScope} disabled={scope === null} onChange={(event) => {
              const next = event.currentTarget.value as typeof subjectScope;
              if (next === 'whole-discipline' && !canEnterWholeDiscipline && subjectScope !== 'whole-discipline') return;
              onSubjectScopeChange(next);
            }}>
              <option value="local">当前对象局部图</option>
              <option value="whole-discipline" disabled={!canEnterWholeDiscipline && subjectScope !== 'whole-discipline'}>本学科全部节点</option>
            </select>
          </label> : <label className="knowledge-right-scope">
            <span>范围</span>
            <select aria-label="高级网络范围" value={advancedScope} onChange={(event) => onAdvancedScopeChange(event.currentTarget.value as typeof advancedScope)}>
              <option value="focus">当前对象</option>
              <option value="discipline" disabled={scope === null}>本学科</option>
              <option value="all">全部资料</option>
            </select>
          </label>}
          <button
            type="button"
            className="knowledge-right-expand"
            aria-label={expanded ? '收起 Graph' : '展开 Graph'}
            title={expanded ? '收起 Graph' : '展开 Graph'}
            aria-pressed={expanded}
            onClick={() => onModeChange(expanded ? 'mini' : 'expanded')}
          >{expanded ? '收起' : '展开'}</button>
        </header>
        {scope === null && view === 'subject' ? <p className="knowledge-right-hint" role="status">学科图谱需要先选择一个学科、方向或主题。</p> : null}
        {scope === null && view === 'advanced' && advancedScope !== 'all' ? <p className="knowledge-right-hint" role="status">当前范围需要先选择一个学科、方向或主题；全部资料请切换到“全部资料”。</p> : null}
        {view === 'advanced' ? <div className="knowledge-right-advanced-filters" aria-label="高级网络筛选">
          <label><input type="checkbox" checked={preferences.advancedFilters.showTags} onChange={(event) => updatePreferences({ advancedFilters: { ...preferences.advancedFilters, showTags: event.currentTarget.checked } })} />标签</label>
          <label><input type="checkbox" checked={preferences.advancedFilters.showAttachments} onChange={(event) => updatePreferences({ advancedFilters: { ...preferences.advancedFilters, showAttachments: event.currentTarget.checked } })} />附件</label>
          <label><input type="checkbox" checked={preferences.advancedFilters.showUnresolved} onChange={(event) => updatePreferences({ advancedFilters: { ...preferences.advancedFilters, showUnresolved: event.currentTarget.checked } })} />待建引用</label>
        </div> : null}
        <div className="knowledge-right-graph-canvas">
          <WorkbenchGraph
            nodes={graphNodes}
            edges={graphEdges}
            scopeIdentity={scopeIdentity}
            contextNodeId={contextNodeId}
            selectedNodeId={selectedNodeId}
            mode={mode}
            loading={loading}
            error={error}
            onRefresh={onRefresh}
            evaluateQuery={evaluateQuery}
            onModeChange={onModeChange}
            onNodeOpen={onNodeOpen}
            onAuxiliaryNodeOpen={onAuxiliaryNodeOpen}
            onNodeMore={onNodeMore}
            showModeControls={false}
            graphLabel={view === 'subject' ? '学科语义图谱' : '高级知识网络'}
          />
        </div>
      </section>

      {!expanded ? <div
        className="knowledge-right-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整 Graph 高度"
        aria-valuemin={210}
        aria-valuemax={Math.max(210, (relationsRef.current?.clientHeight ?? 0) - 150)}
        aria-valuenow={Math.round(relationsRef.current?.querySelector('.knowledge-right-graph')?.getBoundingClientRect().height ?? 0)}
        tabIndex={0}
        onPointerDown={beginGraphResize}
        onPointerMove={moveGraphResize}
        onPointerUp={endGraphResize}
        onPointerCancel={endGraphResize}
        onKeyDown={handleGraphResizeKeyDown}
      /> : null}

      {!expanded ? <section className="knowledge-right-tools" aria-label="正文辅助工具">
        <div className="knowledge-right-tool-tabs" role="tablist" aria-label="正文工具" onKeyDown={(event) => handleToolKeyDown(event, activeTool)}>
          {RIGHT_TOOL_ORDER.map((tool) => <button
            key={tool}
            ref={(element) => { toolRefs.current[tool] = element; }}
            type="button"
            role="tab"
            id={`${instanceId}-tool-${tool}`}
            aria-selected={activeTool === tool}
            aria-controls={toolPanelId}
            tabIndex={activeTool === tool ? 0 : -1}
            className={activeTool === tool ? 'is-active' : ''}
            onClick={() => selectTool(tool)}
          >{TOOL_LABELS[tool]}</button>)}
        </div>
        <div id={toolPanelId} className="knowledge-right-tool-panel" role="tabpanel" aria-labelledby={`${instanceId}-tool-${activeTool}`}>
          {toolPanels[activeTool]}
        </div>
      </section> : null}
    </div> : <div id={`${instanceId}-interpretation`} className="knowledge-right-interpretation" role="tabpanel" aria-label="解读">{interpretationPanel}</div>}
  </section>;
}
