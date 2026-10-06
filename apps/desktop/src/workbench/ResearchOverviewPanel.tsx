import type { ReactElement } from 'react';
import type { ResearchProject, ResearchReviewMark } from '@noltri/schema';
import { reviewMarkRaisedByLabels } from '@noltri/shared';
import { markLine, pendingMarks, projectLine, stamp } from './research-model';

export interface ResearchOverviewCounts {
  readonly questions: number;
  readonly evidence: number;
  readonly claims: number;
  readonly sections: number;
  readonly relations: number;
}

export interface ResearchOverviewPanelProps {
  projects: readonly ResearchProject[];
  activeProject: ResearchProject | null;
  counts: ResearchOverviewCounts;
  marks: readonly ResearchReviewMark[];
  newProjectName: string;
  newProjectDescription: string;
  busy: boolean;
  error: string | null;
  feedback: string | null;
  onPickProject: (projectId: string) => void;
  onNewProjectName: (value: string) => void;
  onNewProjectDescription: (value: string) => void;
  onCreateProject: () => void;
  onClearMark: (markId: string) => void;
}

/**
 * 研究总览 (V1_DEVELOPMENT §13「研究项目」): which project is open, what it already holds, and the
 * 待复核标记 that R03 ／ R06 raised. A 标记 is cleared here — never silently by the system.
 */
export default function ResearchOverviewPanel({
  projects,
  activeProject,
  counts,
  marks,
  newProjectName,
  newProjectDescription,
  busy,
  error,
  feedback,
  onPickProject,
  onNewProjectName,
  onNewProjectDescription,
  onCreateProject,
  onClearMark,
}: ResearchOverviewPanelProps): ReactElement {
  const open = pendingMarks(marks);

  return (
    <section className="research-panel" aria-label="研究总览">
      <div className="column-title">研究总览</div>

      <div className="inline-row">
        <select
          className="field-select"
          aria-label="选择研究项目"
          value={activeProject?.id ?? ''}
          onChange={(event) => onPickProject(event.target.value)}
        >
          <option value="">选择研究项目…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {projectLine(project)}
            </option>
          ))}
        </select>
      </div>

      {activeProject === null ? (
        <p className="muted-note">还没有打开任何研究项目。可以在下方新建一个，或先在 Core 里准备好数据。</p>
      ) : (
        <>
          <p className="version-note">
            {activeProject.name} · 创建于 {stamp(activeProject.createdAt)}
            {activeProject.description === null ? '' : ` · ${activeProject.description}`}
          </p>

          <div className="stats">
            <div className="stat">
              <span className="stat-label">研究问题</span>
              <span className="stat-value">{counts.questions}</span>
            </div>
            <div className="stat">
              <span className="stat-label">证据</span>
              <span className="stat-value">{counts.evidence}</span>
            </div>
            <div className="stat">
              <span className="stat-label">论点</span>
              <span className="stat-value">{counts.claims}</span>
            </div>
            <div className="stat">
              <span className="stat-label">章节</span>
              <span className="stat-value">{counts.sections}</span>
            </div>
            <div className="stat">
              <span className="stat-label">关系</span>
              <span className="stat-value">{counts.relations}</span>
            </div>
          </div>

          <div className="section">
            <div className="section-head">待复核标记</div>
            {open.length === 0 ? (
              <p className="muted-note">没有待复核的对象。</p>
            ) : (
              <ul className="item-list">
                {open.map((mark) => (
                  <li key={mark.id} className="item-card">
                    <div className="inline-row">
                      <span className="badge badge-warn">{markLine(mark)}</span>
                      <span className="muted-note">
                        {reviewMarkRaisedByLabels[mark.raisedBy]} · {stamp(mark.createdAt)}
                      </span>
                      <button type="button" className="btn" disabled={busy} onClick={() => onClearMark(mark.id)}>
                        标记已复核
                      </button>
                    </div>
                    <p className="item-text">{mark.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted-note">「已复核」只清掉这条标记；引用对象本身没有被系统改动，改不改由你决定。</p>
          </div>
        </>
      )}

      {error !== null ? <p className="error-note">{error}</p> : null}
      {feedback !== null ? <p className="version-note">{feedback}</p> : null}

      <div className="section">
        <div className="section-head">新建研究项目</div>
        <div className="inline-form">
          <input
            className="field-input inline-form-grow"
            aria-label="项目名称"
            placeholder="项目名称"
            value={newProjectName}
            onChange={(event) => onNewProjectName(event.target.value)}
          />
          <input
            className="field-input inline-form-grow"
            aria-label="项目描述"
            placeholder="一句话描述（可留空）"
            value={newProjectDescription}
            onChange={(event) => onNewProjectDescription(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || newProjectName.trim() === ''}
            onClick={onCreateProject}
          >
            新建项目
          </button>
        </div>
      </div>
    </section>
  );
}
