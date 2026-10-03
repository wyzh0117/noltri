'use client';

/**
 * Loads every Research Domain list a workbench panel needs in one round trip set, so the panels stay
 * presentational and a single `reload` keeps charter / RQ / evidence / claim / relation state in sync.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  Claim,
  DriftFinding,
  EntityRelation,
  Evidence,
  ManuscriptSection,
  ResearchChange,
  ResearchCharter,
  ResearchDecision,
  ResearchQuestion,
  TimelineEvent,
} from '@noltri/schema';
import { apiGet, describeError } from '@/lib/client-api';

export interface ResearchData {
  charter: ResearchCharter | null;
  questions: ResearchQuestion[];
  evidence: Evidence[];
  claims: Claim[];
  sections: ManuscriptSection[];
  relations: EntityRelation[];
  decisions: ResearchDecision[];
  changes: ResearchChange[];
  timeline: TimelineEvent[];
  findings: DriftFinding[];
}

export interface ResearchDataState {
  data: ResearchData;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Common props for every research panel: the selected project, its loaded lists and a refresh. */
export interface ResearchPanelProps {
  projectId: string;
  data: ResearchData;
  onChanged: () => void;
}

const EMPTY_DATA: ResearchData = {
  charter: null,
  questions: [],
  evidence: [],
  claims: [],
  sections: [],
  relations: [],
  decisions: [],
  changes: [],
  timeline: [],
  findings: [],
};

export function researchProjectBase(projectId: string): string {
  return `/api/web/research/projects/${encodeURIComponent(projectId)}`;
}

export function useResearchData(projectId: string | null): ResearchDataState {
  const [data, setData] = useState<ResearchData>(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (projectId === null) {
      setData(EMPTY_DATA);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const base = researchProjectBase(projectId);
        const [charter, questions, evidence, claims, sections, relations, decisions, changes, timeline, findings] =
          await Promise.all([
            apiGet<{ charter: ResearchCharter | null }>(`${base}/charter`),
            apiGet<{ questions: ResearchQuestion[] }>(`${base}/questions`),
            apiGet<{ evidence: Evidence[] }>(`${base}/evidence`),
            apiGet<{ claims: Claim[] }>(`${base}/claims`),
            apiGet<{ sections: ManuscriptSection[] }>(`${base}/sections`),
            apiGet<{ relations: EntityRelation[] }>(`${base}/relations`),
            apiGet<{ decisions: ResearchDecision[] }>(`${base}/decisions`),
            apiGet<{ changes: ResearchChange[] }>(`${base}/changes`),
            apiGet<{ events: TimelineEvent[] }>(`${base}/timeline`),
            apiGet<{ findings: DriftFinding[] }>(`${base}/drift-findings`),
          ]);
        if (cancelled) return;
        setData({
          charter: charter.charter,
          questions: questions.questions,
          evidence: evidence.evidence,
          claims: claims.claims,
          sections: sections.sections,
          relations: relations.relations,
          decisions: decisions.decisions,
          changes: changes.changes,
          timeline: timeline.events,
          findings: findings.findings,
        });
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(describeError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  return { data, loading, error, reload };
}
