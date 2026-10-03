'use client';

/**
 * Research workbench (Research Project type): project list / creation on the rail, the §34 minimal
 * success chain as panels — Charter → RQ → Evidence → Claim（关系）→ Section → Research Map →
 * Timeline → Drift Checker → Context Pack. Knowledge-tree behaviour is untouched: this workspace is
 * only reachable through the Project Type switch.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { HealthResponse, ResearchProject, ResearchProjectStatus } from '@noltri/schema';
import TopBar from '../TopBar';
import type { ProjectMode } from '../ProjectTypeSwitch';
import CharterPanel from './CharterPanel';
import QuestionsPanel from './QuestionsPanel';
import EvidencePanel from './EvidencePanel';
import ClaimsPanel from './ClaimsPanel';
import SectionsPanel from './SectionsPanel';
import MapPanel from './MapPanel';
import TimelinePanel from './TimelinePanel';
import DriftPanel from './DriftPanel';
import ContextPackPanel from './ContextPackPanel';
import { BusyButton, Field, FormError, SelectInput, TextArea, TextInput } from './fields';
import { useResearchData } from './useResearchData';
import { apiGet, apiPatch, apiPost, describeError } from '@/lib/client-api';
import { labelOf, researchProjectStatusLabels } from '@/lib/research-view';
import type { SessionStrategy } from '@/lib/cookie';

type PanelKey =
  | 'charter'
  | 'questions'
  | 'evidence'
  | 'claims'
  | 'sections'
  | 'map'
  | 'timeline'
  | 'drift'
  | 'context';

const PANELS: readonly { key: PanelKey; label: string; hint: string }[] = [
  { key: 'charter', label: 'Charter', hint: 'Research Boundary / Claim Boundary / Core Contribution' },
  { key: 'questions', label: '研究问题', hint: 'RQ 是独立实体，可被 Claim 回答' },
  { key: 'evidence', label: 'Evidence', hint: '这份证据为什么与当前研究有关' },
  { key: 'claims', label: 'Claims', hint: '主张 + 证据关系 + 章节归属' },
  { key: 'sections', label: '论文章节', hint: 'section_name / section_reference' },
  { key: 'map', label: 'Research Map', hint: 'RQ → Evidence → Claim → Section → Contribution' },
  { key: 'timeline', label: '时间线', hint: 'Decision / Change / 里程碑（append-only）' },
  { key: 'drift', label: 'Drift', hint: '六类漂移检查与处置' },
  { key: 'context', label: 'Context Pack', hint: '给新 Agent 的紧凑上下文' },
];

const STATUS_CHOICES = (['active', 'archived', 'completed'] as const).map((value) => ({
  value,
  label: labelOf(researchProjectStatusLabels, value),
}));

export interface ResearchWorkspaceProps {
  strategy: SessionStrategy;
  mode?: ProjectMode;
  onSwitchMode?: (mode: ProjectMode) => void;
}

export default function ResearchWorkspace({ strategy, mode, onSwitchMode }: ResearchWorkspaceProps): ReactElement {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKey>('charter');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthProblem, setHealthProblem] = useState<string | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    setLoadingProjects(true);
    try {
      const result = await apiGet<{ projects: ResearchProject[] }>('/api/web/research/projects');
      setProjects(result.projects);
      setProjectsError(null);
    } catch (error) {
      setProjectsError(describeError(error));
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiGet<HealthResponse>('/api/web/health');
        if (!cancelled) {
          setHealth(result);
          setHealthProblem(null);
        }
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setHealthProblem(describeError(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep a valid selection as the list changes (creation, deletion elsewhere, first load).
  useEffect(() => {
    if (projects.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? null);
    }
  }, [projects, selectedId]);

  const { data, loading, error, reload } = useResearchData(selectedId);
  const project = projects.find((entry) => entry.id === selectedId) ?? null;

  async function createProject(): Promise<void> {
    const name = newName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    try {
      const created = await apiPost<ResearchProject>('/api/web/research/projects', {
        name,
        description: newDescription.trim().length > 0 ? newDescription.trim() : null,
      });
      setNewName('');
      setNewDescription('');
      setCreating(false);
      setActionError(null);
      await loadProjects();
      setSelectedId(created.id);
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function patchProjectStatus(status: ResearchProjectStatus): Promise<void> {
    if (project === null) return;
    try {
      await apiPatch<ResearchProject>(`/api/web/research/projects/${encodeURIComponent(project.id)}`, { status });
      setActionError(null);
      await loadProjects();
    } catch (caught) {
      setActionError(describeError(caught));
    }
  }

  return (
    <div className="app-shell">
      {strategy === 'dev-token' ? (
        <div className="dev-banner" role="status">
          当前为本地开发登录，未接入 Supabase Auth
        </div>
      ) : null}

      <TopBar
        strategy={strategy}
        health={health}
        healthProblem={healthProblem}
        mode={mode}
        onSwitchMode={onSwitchMode}
      />

      <div className="workspace">
        <nav className="rail" aria-label="研究项目">
          <div className="column-title">研究项目</div>
          {projectsError !== null ? <p className="error-note">{projectsError}</p> : null}
          {loadingProjects && projects.length === 0 ? (
            <p className="muted-note">正在加载研究项目…</p>
          ) : projects.length === 0 ? (
            <p className="muted-note">还没有研究项目。研究项目用于管理一篇科研文章的完整生命周期。</p>
          ) : (
            <ul className="domain-list">
              {projects.map((entry) => {
                const active = entry.id === selectedId;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`domain-item${active ? ' domain-item-active' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedId(entry.id);
                        setPanel('charter');
                      }}
                    >
                      <span className="domain-title">{entry.name}</span>
                      <span className="domain-count">{labelOf(researchProjectStatusLabels, entry.status)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="inline-row">
            <button type="button" className="btn btn-block" onClick={() => setCreating((value) => !value)}>
              {creating ? '收起新建' : '新建研究项目'}
            </button>
          </div>
          {creating ? (
            <div className="stack">
              <Field label="项目名称">
                <TextInput value={newName} onChange={setNewName} placeholder="例如：冷链物流服务质量研究" />
              </Field>
              <Field label="简要描述（可选）">
                <TextArea value={newDescription} onChange={setNewDescription} rows={2} placeholder="这篇文章要解决什么问题？" />
              </Field>
              <BusyButton busy={busy} busyLabel="正在创建…" label="创建研究项目" onClick={() => void createProject()} disabled={newName.trim().length === 0} />
            </div>
          ) : null}

          <p className="rail-note">
            Research 是 Noltri 新增的项目类型：Question → Evidence → Claim → Manuscript，底层仍是
            Intent → Boundary → Evidence → Decision → Change → History。
          </p>
        </nav>

        <main className="tree-column research-main" aria-label="研究工作台" aria-busy={loading}>
          <div className="tree-caption">
            <span className="column-title column-title-tight">Research 工作台</span>
            {project !== null ? (
              <span className="badge badge-accent">{project.name}</span>
            ) : (
              <span className="badge badge-quiet">未选择项目</span>
            )}
            <span className="column-hint">最小成功链路：Charter → RQ → Evidence → Claim → Map → Drift → Context Pack。</span>
          </div>

          {actionError !== null ? <p className="error-note">{actionError}</p> : null}

          {project === null ? (
            <div className="empty-state">
              <h2 className="empty-title">创建一个研究项目开始</h2>
              <p>研究项目把一篇科研文章的 Charter、研究问题、证据、主张、决策与演化历史放在一起管理。</p>
              <ul className="empty-list">
                <li>
                  先建项目 <span>— 命名你的研究，例如「冷链物流服务质量研究」</span>
                </li>
                <li>
                  填写 Charter <span>— 研究边界、主张边界、核心贡献、方法与目标期刊</span>
                </li>
                <li>
                  走通链路 <span>— RQ → Evidence → Claim → Research Map → Drift → Context Pack</span>
                </li>
              </ul>
            </div>
          ) : (
            <>
              <div className="research-header">
                <div>
                  <h1 className="detail-title">{project.name}</h1>
                  <p className="muted-note">{project.description ?? '（未填写项目描述）'}</p>
                </div>
                <div className="inline-row">
                  <span className="login-label">项目状态</span>
                  <SelectInput
                    value={project.status}
                    choices={STATUS_CHOICES}
                    onChange={(value) => void patchProjectStatus(value as ResearchProjectStatus)}
                  />
                </div>
              </div>

              <div className="panel-nav" role="tablist" aria-label="研究面板">
                {PANELS.map((entry) => {
                  const active = entry.key === panel;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={entry.hint}
                      className={`panel-nav-item${active ? ' panel-nav-item-active' : ''}`}
                      onClick={() => setPanel(entry.key)}
                    >
                      {entry.label}
                    </button>
                  );
                })}
              </div>

              {error !== null ? <p className="error-note">{error}</p> : null}
              {loading ? <p className="muted-note">正在加载研究数据…</p> : null}

              <div className="research-panel">
                {panel === 'charter' ? <CharterPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'questions' ? <QuestionsPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'evidence' ? <EvidencePanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'claims' ? <ClaimsPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'sections' ? <SectionsPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'map' ? <MapPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'timeline' ? <TimelinePanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'drift' ? <DriftPanel projectId={project.id} data={data} onChanged={reload} /> : null}
                {panel === 'context' ? <ContextPackPanel projectId={project.id} data={data} onChanged={reload} /> : null}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
