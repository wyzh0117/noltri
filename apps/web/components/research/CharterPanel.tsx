'use client';

/**
 * Research Charter form (research doc §10): the full field set, with Research Boundary / Claim
 * Boundary / Core Contribution kept visually prominent because Drift Checker reads them.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { CharterRequest } from '@noltri/schema';
import { BusyButton, Field, FormError, TextArea, TextInput } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiPut, describeError } from '@/lib/client-api';

interface CharterDraft {
  workingTitle: string;
  researchTopic: string;
  researchProblem: string;
  researchGap: string;
  researchQuestionsText: string;
  coreContribution: string;
  theoreticalLens: string;
  researchContext: string;
  unitOfAnalysis: string;
  researchMethod: string;
  targetArticleType: string;
  targetJournal: string;
  researchBoundary: string;
  claimBoundary: string;
  currentStage: string;
}

const EMPTY_DRAFT: CharterDraft = {
  workingTitle: '',
  researchTopic: '',
  researchProblem: '',
  researchGap: '',
  researchQuestionsText: '',
  coreContribution: '',
  theoreticalLens: '',
  researchContext: '',
  unitOfAnalysis: '',
  researchMethod: '',
  targetArticleType: '',
  targetJournal: '',
  researchBoundary: '',
  claimBoundary: '',
  currentStage: '',
};

const TEXT_FIELDS: readonly { key: Exclude<keyof CharterDraft, 'workingTitle' | 'targetArticleType' | 'targetJournal' | 'currentStage'>; label: string; hint: string }[] = [
  { key: 'researchTopic', label: 'Research Topic · 研究主题', hint: '一句话说明研究对象与领域。' },
  { key: 'researchProblem', label: 'Research Problem · 研究问题（问题陈述）', hint: '要解决的实际/理论问题。' },
  { key: 'researchGap', label: 'Research Gap · 研究缺口', hint: '已有研究没有覆盖的部分。' },
  { key: 'researchQuestionsText', label: 'Research Questions · 研究问题（文本）', hint: '与「研究问题」面板的 RQ 保持一致。' },
  { key: 'coreContribution', label: 'Core Contribution · 核心贡献', hint: '论文向读者交付的核心增量；Drift Checker 会对照它。' },
  { key: 'theoreticalLens', label: 'Theoretical Lens · 理论视角', hint: '解释证据与结论的理论框架。' },
  { key: 'researchContext', label: 'Research Context · 研究情境', hint: '研究所在的行业/场景/样本情境。' },
  { key: 'unitOfAnalysis', label: 'Unit of Analysis · 分析单元', hint: '分析的基本单位（因素/企业/案例…）。' },
  { key: 'researchMethod', label: 'Research Method · 研究方法', hint: '方法路线（如 ISM + ANP）；方法变化要同步这里。' },
  { key: 'researchBoundary', label: 'Research Boundary · 研究边界', hint: '研究做什么、不做什么（不包含统计因果？）。' },
  { key: 'claimBoundary', label: 'Claim Boundary · 主张边界', hint: '当前证据最多支持到什么程度（ISM 关系 ≠ 统计因果…）。' },
];

export default function CharterPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const charter = data.charter;
  const [draft, setDraft] = useState<CharterDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      charter === null
        ? EMPTY_DRAFT
        : {
            workingTitle: charter.workingTitle,
            researchTopic: charter.researchTopic ?? '',
            researchProblem: charter.researchProblem ?? '',
            researchGap: charter.researchGap ?? '',
            researchQuestionsText: charter.researchQuestionsText ?? '',
            coreContribution: charter.coreContribution ?? '',
            theoreticalLens: charter.theoreticalLens ?? '',
            researchContext: charter.researchContext ?? '',
            unitOfAnalysis: charter.unitOfAnalysis ?? '',
            researchMethod: charter.researchMethod ?? '',
            targetArticleType: charter.targetArticleType ?? '',
            targetJournal: charter.targetJournal ?? '',
            researchBoundary: charter.researchBoundary ?? '',
            claimBoundary: charter.claimBoundary ?? '',
            currentStage: charter.currentStage ?? '',
          },
    );
  }, [charter]);

  function update(key: keyof CharterDraft, value: string): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  async function save(): Promise<void> {
    const workingTitle = draft.workingTitle.trim();
    if (workingTitle.length === 0 || busy) return;
    setBusy(true);
    try {
      const payload: CharterRequest = {
        workingTitle,
        researchTopic: orNull(draft.researchTopic),
        researchProblem: orNull(draft.researchProblem),
        researchGap: orNull(draft.researchGap),
        researchQuestionsText: orNull(draft.researchQuestionsText),
        coreContribution: orNull(draft.coreContribution),
        theoreticalLens: orNull(draft.theoreticalLens),
        researchContext: orNull(draft.researchContext),
        unitOfAnalysis: orNull(draft.unitOfAnalysis),
        researchMethod: orNull(draft.researchMethod),
        targetArticleType: orNull(draft.targetArticleType),
        targetJournal: orNull(draft.targetJournal),
        researchBoundary: orNull(draft.researchBoundary),
        claimBoundary: orNull(draft.claimBoundary),
        currentStage: orNull(draft.currentStage),
      };
      await apiPut(`${researchProjectBase(projectId)}/charter`, payload);
      setError(null);
      setSavedAt(new Date().toISOString());
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Research Charter</h2>
        <span className="column-hint">
          {charter === null ? '尚未填写 Charter；保存后会创建它。' : `最后更新：${charter.updatedAt}`}
        </span>
      </div>

      <div className="form-grid">
        <Field label="Working Title · 工作标题（必填）" hint="文章的暂定标题。">
          <TextInput value={draft.workingTitle} onChange={(value) => update('workingTitle', value)} placeholder="冷链物流服务质量因素的结构关系研究" />
        </Field>
        <Field label="Current Stage · 当前阶段" hint="例如：问题界定 / 方法定稿 / 写作中 / 投稿中。">
          <TextInput value={draft.currentStage} onChange={(value) => update('currentStage', value)} placeholder="方法定稿" />
        </Field>
        <Field label="Target Article Type · 目标文章类型" hint="实证研究 / 方法研究 / 综述…">
          <TextInput value={draft.targetArticleType} onChange={(value) => update('targetArticleType', value)} placeholder="实证研究" />
        </Field>
        <Field label="Target Journal · 目标期刊" hint="更换目标期刊时记得记一条 Change。">
          <TextInput value={draft.targetJournal} onChange={(value) => update('targetJournal', value)} placeholder="International Journal of Production Research" />
        </Field>
        {TEXT_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <TextArea value={draft[field.key]} onChange={(value) => update(field.key, value)} rows={field.key === 'researchBoundary' || field.key === 'claimBoundary' ? 4 : 3} />
          </Field>
        ))}
      </div>

      <FormError message={error} />
      <div className="inline-row">
        <BusyButton busy={busy} busyLabel="正在保存…" label="保存 Charter" onClick={() => void save()} disabled={draft.workingTitle.trim().length === 0} />
        {savedAt !== null ? <span className="muted-note">已保存（{savedAt.slice(0, 19).replace('T', ' ')} UTC）</span> : null}
      </div>
    </section>
  );
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
