import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  CharterVersion,
  Claim,
  DriftFinding,
  DriftFindingStatus,
  DriftSummary,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchContextPackResponse,
  ResearchDecision,
  ResearchMapResponse,
  ResearchProject,
  ResearchQuestion,
  ResearchReferenceMatch,
  ResearchRelationType,
  ResearchReviewMark,
  TimelineEvent,
} from '@noltri/schema';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import ResearchOverviewPanel from './ResearchOverviewPanel';
import CharterPanel from './CharterPanel';
import QuestionPanel from './QuestionPanel';
import EvidencePanel, { type ReferenceQuery } from './EvidencePanel';
import ClaimPanel, { type RelationDraft } from './ClaimPanel';
import TimelinePanel from './TimelinePanel';
import DriftPanel from './DriftPanel';
import MapPanel from './MapPanel';
import ContextPackPanel from './ContextPackPanel';
import {
  approvalEntities,
  approvalIsSendable,
  approvalPayload,
  draftFrom,
  draftPayload,
  emptyDraft,
  impactOptions,
  relationMode,
  relationPayload,
  severityLine,
  type CharterDraft,
} from './research-model';

type ResearchView = 'overview' | 'charter' | 'questions' | 'evidence' | 'claims' | 'timeline' | 'drift' | 'map' | 'pack';

const VIEW_LABELS: Record<ResearchView, string> = {
  overview: '研究总览',
  charter: '章程与边界',
  questions: '研究问题',
  evidence: '证据工作台',
  claims: '论点与章节',
  timeline: '决策与时间线',
  drift: '偏移检查',
  map: '研究地图',
  pack: '上下文包',
};

const VIEW_ORDER: readonly ResearchView[] = [
  'overview',
  'charter',
  'questions',
  'evidence',
  'claims',
  'timeline',
  'drift',
  'map',
  'pack',
];

interface ProjectData {
  readonly charter: ResearchCharter | null;
  readonly baseline: CharterVersion | null;
  readonly versions: readonly CharterVersion[];
  readonly questions: readonly ResearchQuestion[];
  readonly evidence: readonly Evidence[];
  readonly claims: readonly Claim[];
  readonly sections: readonly ManuscriptSection[];
  readonly relations: readonly EntityRelation[];
  readonly marks: readonly ResearchReviewMark[];
  readonly decisions: readonly ResearchDecision[];
  readonly changes: readonly ResearchChange[];
  readonly events: readonly TimelineEvent[];
  readonly findings: readonly DriftFinding[];
}

const EMPTY_RELATION: RelationDraft = {
  modeKey: 'evidence_claim',
  relationType: 'supports',
  sourceId: '',
  targetId: '',
};

export interface ResearchWorkspaceProps {
  api: WorkbenchApi;
}

/**
 * State owner for 研究工作台 (P5-D + P6): it holds which project is open, one loaded snapshot of that
 * project's objects, and the form state of every write — the panels only draw. 偏移检查 folds into the
 * snapshot (its findings list is as cheap as any other list); 研究地图 and 上下文包 are aggregates the
 * server builds on demand, so they load when their view opens instead of on every reload.
 */
export default function ResearchWorkspace({ api }: ResearchWorkspaceProps): ReactElement {
  const [view, setView] = useState<ResearchView>('overview');
  const [projects, setProjects] = useState<readonly ResearchProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [data, setData] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [draft, setDraft] = useState<CharterDraft>(() => emptyDraft());
  const [impactSelected, setImpactSelected] = useState<Record<string, boolean>>({});
  const [revisionReason, setRevisionReason] = useState('');
  const [referenceQuery, setReferenceQuery] = useState<ReferenceQuery>({ nodeId: '', rawSourceId: '' });
  const [referenceResult, setReferenceResult] = useState<readonly ResearchReferenceMatch[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [relationDraft, setRelationDraft] = useState<RelationDraft>(EMPTY_RELATION);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [manuscriptText, setManuscriptText] = useState('');
  const [driftSummary, setDriftSummary] = useState<DriftSummary | null>(null);
  const [map, setMap] = useState<ResearchMapResponse | null>(null);
  const [pack, setPack] = useState<ResearchContextPackResponse | null>(null);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    setManuscriptText('');
    setDriftSummary(null);
    setMap(null);
    setPack(null);
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.researchProjects();
        if (cancelled) return;
        setProjects(list);
        setError(null);
        setActiveProjectId((previous) => previous ?? list[0]?.id ?? null);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken]);

  useEffect(() => {
    if (activeProjectId === null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [
          charter,
          baseline,
          versions,
          questions,
          evidence,
          claims,
          sections,
          relations,
          marks,
          decisions,
          changes,
          events,
          findings,
        ] = await Promise.all([
          api.researchCharter(activeProjectId),
          api.researchCharterBaseline(activeProjectId),
          api.researchCharterVersions(activeProjectId),
          api.researchQuestions(activeProjectId),
          api.researchEvidence(activeProjectId),
          api.researchClaims(activeProjectId),
          api.researchSections(activeProjectId),
          api.researchRelations(activeProjectId),
          api.researchReviewMarks(activeProjectId),
          api.researchDecisions(activeProjectId),
          api.researchChanges(activeProjectId),
          api.researchTimeline(activeProjectId),
          api.researchDriftFindings(activeProjectId),
        ]);
        if (cancelled) return;
        setData({
          charter,
          baseline,
          versions,
          questions,
          evidence,
          claims,
          sections,
          relations,
          marks,
          decisions,
          changes,
          events,
          findings,
        });
        setDraft(draftFrom(charter));
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeProjectId, reloadToken]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  useEffect(() => {
    if (activeProjectId === null || view !== 'map') return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.researchMap(activeProjectId);
        if (!cancelled) {
          setMap(result);
          setError(null);
        }
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeProjectId, view, reloadToken]);

  useEffect(() => {
    if (activeProjectId === null || view !== 'pack') return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.researchContextPack(activeProjectId);
        if (!cancelled) {
          setPack(result);
          setError(null);
        }
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeProjectId, view, reloadToken]);

  const impacts = useMemo(
    () =>
      data === null
        ? []
        : impactOptions(data.claims, data.evidence, data.questions, data.sections),
    [data],
  );

  async function saveCharter(): Promise<void> {
    const payload = draftPayload(draft);
    if (activeProjectId === null || payload === null) return;
    setBusy(true);
    try {
      await api.saveResearchCharter(activeProjectId, payload);
      setFeedback('章程草稿已保存。');
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function approveCharter(): Promise<void> {
    if (activeProjectId === null || !approvalIsSendable(revisionReason)) return;
    setBusy(true);
    try {
      const version = await api.approveResearchCharter(
        activeProjectId,
        approvalPayload(revisionReason, approvalEntities(impactSelected, impacts)),
      );
      setFeedback(`已批准 v${String(version.version)}：${version.revisionReason}`);
      setRevisionReason('');
      setImpactSelected({});
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function clearMark(markId: string): Promise<void> {
    setBusy(true);
    try {
      await api.clearResearchReviewMark(markId);
      setFeedback('这条标记已复核。对对象本身的改动仍由你另行决定。');
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createRelation(): Promise<void> {
    if (activeProjectId === null) return;
    const payload = relationPayload(relationMode(relationDraft.modeKey), relationDraft.sourceId, relationDraft.relationType, relationDraft.targetId);
    setBusy(true);
    try {
      await api.createResearchRelation(activeProjectId, payload);
      setFeedback('关系已写入。');
      setError(null);
      setRelationDraft((previous) => ({ ...previous, sourceId: '', targetId: '' }));
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRelation(relationId: string): Promise<void> {
    setBusy(true);
    try {
      await api.deleteResearchRelation(relationId);
      setFeedback('关系已删除。');
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function checkReferences(): Promise<void> {
    const nodeId = referenceQuery.nodeId.trim();
    const rawSourceId = referenceQuery.rawSourceId.trim();
    if (nodeId === '' && rawSourceId === '') return;
    setChecking(true);
    try {
      const matches = await api.researchReferences({
        ...(nodeId === '' ? {} : { nodeId }),
        ...(rawSourceId === '' ? {} : { rawSourceId }),
      });
      setReferenceResult(matches);
      setError(null);
    } catch (failure) {
      setReferenceResult(null);
      setError(describeError(failure));
    } finally {
      setChecking(false);
    }
  }

  async function runDriftCheck(): Promise<void> {
    if (activeProjectId === null) return;
    setBusy(true);
    try {
      const text = manuscriptText.trim();
      const result = await api.researchDriftCheck(activeProjectId, text === '' ? {} : { manuscriptText: text });
      setDriftSummary(result.summary);
      setFeedback(`偏移检查完成：${severityLine(result.summary)}。`);
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function patchFinding(findingId: string, status: DriftFindingStatus): Promise<void> {
    setBusy(true);
    try {
      await api.patchResearchDriftFinding(findingId, { status });
      setFeedback(status === 'resolved' ? '这条偏移已解决，记录仍留在台账里。' : '这条偏移已确认；处理结果仍由你决定。');
      setError(null);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createProject(): Promise<void> {
    const name = newProjectName.trim();
    if (name === '') return;
    setBusy(true);
    try {
      const description = newProjectDescription.trim();
      const project = await api.createResearchProject({ name, description: description === '' ? null : description });
      setNewProjectName('');
      setNewProjectDescription('');
      setFeedback(`已新建项目：${project.name}`);
      setError(null);
      setActiveProjectId(project.id);
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="research-shell">
      <nav className="workbench-tabs" aria-label="研究工作台导航">
        {VIEW_ORDER.map((option) => (
          <button
            key={option}
            type="button"
            className={view === option ? 'workbench-tab workbench-tab-active' : 'workbench-tab'}
            aria-current={view === option}
            onClick={() => setView(option)}
          >
            {VIEW_LABELS[option]}
          </button>
        ))}
        {loading ? <span className="workbench-tab-note">正在载入研究项目…</span> : null}
      </nav>

      <div className="workbench-column">
        {view === 'overview' ? (
          <ResearchOverviewPanel
            projects={projects}
            activeProject={activeProject}
            counts={{
              questions: data?.questions.length ?? 0,
              evidence: data?.evidence.length ?? 0,
              claims: data?.claims.length ?? 0,
              sections: data?.sections.length ?? 0,
              relations: data?.relations.length ?? 0,
            }}
            marks={data?.marks ?? []}
            newProjectName={newProjectName}
            newProjectDescription={newProjectDescription}
            busy={busy}
            error={error}
            feedback={feedback}
            onPickProject={setActiveProjectId}
            onNewProjectName={setNewProjectName}
            onNewProjectDescription={setNewProjectDescription}
            onCreateProject={() => void createProject()}
            onClearMark={(markId) => void clearMark(markId)}
          />
        ) : null}

        {view === 'charter' ? (
          <CharterPanel
            draft={draft}
            baseline={data?.baseline ?? null}
            versions={data?.versions ?? []}
            impactOptions={impacts}
            impactSelected={impactSelected}
            revisionReason={revisionReason}
            busy={busy}
            error={error}
            feedback={feedback}
            onField={(field, value) => setDraft((previous) => ({ ...previous, [field]: value }))}
            onRevisionReason={setRevisionReason}
            onToggleImpact={(key) => setImpactSelected((previous) => ({ ...previous, [key]: previous[key] !== true }))}
            onSave={() => void saveCharter()}
            onApprove={() => void approveCharter()}
          />
        ) : null}

        {view === 'questions' ? <QuestionPanel questions={data?.questions ?? []} /> : null}

        {view === 'evidence' ? (
          <EvidencePanel
            evidence={data?.evidence ?? []}
            marks={data?.marks ?? []}
            query={referenceQuery}
            referenceResult={referenceResult}
            checking={checking}
            error={error}
            onQuery={(field, value) => setReferenceQuery((previous) => ({ ...previous, [field]: value }))}
            onCheck={() => void checkReferences()}
          />
        ) : null}

        {view === 'claims' ? (
          <ClaimPanel
            claims={data?.claims ?? []}
            evidence={data?.evidence ?? []}
            questions={data?.questions ?? []}
            sections={data?.sections ?? []}
            relations={data?.relations ?? []}
            draft={relationDraft}
            busy={busy}
            error={error}
            feedback={feedback}
            onMode={(key) =>
              setRelationDraft({
                modeKey: key,
                relationType: relationMode(key).types[0] ?? 'supports',
                sourceId: '',
                targetId: '',
              })
            }
            onType={(relationType: ResearchRelationType) => setRelationDraft((previous) => ({ ...previous, relationType }))}
            onSource={(id) => setRelationDraft((previous) => ({ ...previous, sourceId: id }))}
            onTarget={(id) => setRelationDraft((previous) => ({ ...previous, targetId: id }))}
            onCreateRelation={() => void createRelation()}
            onDeleteRelation={(relationId) => void deleteRelation(relationId)}
          />
        ) : null}

        {view === 'timeline' ? (
          <TimelinePanel decisions={data?.decisions ?? []} changes={data?.changes ?? []} events={data?.events ?? []} />
        ) : null}

        {view === 'drift' ? (
          <DriftPanel
            findings={data?.findings ?? []}
            summary={driftSummary}
            manuscriptText={manuscriptText}
            busy={busy}
            error={error}
            feedback={feedback}
            onManuscriptText={setManuscriptText}
            onRun={() => void runDriftCheck()}
            onPatch={(findingId, status) => void patchFinding(findingId, status)}
          />
        ) : null}

        {view === 'map' ? <MapPanel map={map} error={error} /> : null}

        {view === 'pack' ? <ContextPackPanel pack={pack} error={error} /> : null}
      </div>
    </div>
  );
}
