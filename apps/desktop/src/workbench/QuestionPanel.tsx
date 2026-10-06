import type { ReactElement } from 'react';
import type { ResearchQuestion } from '@noltri/schema';
import { researchQuestionStatusLabels } from '@noltri/shared';
import { openQuestions } from './research-model';

export interface QuestionPanelProps {
  questions: readonly ResearchQuestion[];
}

function statusClass(status: ResearchQuestion['status']): string {
  if (status === 'open') return 'badge badge-accent';
  if (status === 'dropped') return 'badge badge-quiet';
  return 'badge';
}

/**
 * RQ 清单: 研究问题 and nothing else. Reads only — creating and re-statusing an RQ is a §13 workflow that
 * P5-E's demo script exercises; this panel's job is to show what the project is actually asking.
 */
export default function QuestionPanel({ questions }: QuestionPanelProps): ReactElement {
  const rows = [...questions].sort((left, right) => left.questionCode.localeCompare(right.questionCode));
  const open = openQuestions(questions);

  return (
    <section className="research-panel" aria-label="研究问题">
      <div className="column-title">研究问题</div>
      <p className="column-hint">
        共 {questions.length} 条，其中 {open.length} 条仍是 open —— 只有 open 的问题会被后续阶段当作待回答。
      </p>

      {rows.length === 0 ? (
        <p className="muted-note">这个项目还没有研究问题。</p>
      ) : (
        <ul className="item-list">
          {rows.map((question) => (
            <li key={question.id} className="item-card">
              <div className="inline-row">
                <span className="badge badge-quiet">{question.questionCode}</span>
                <span className={statusClass(question.status)}>{researchQuestionStatusLabels[question.status]}</span>
              </div>
              <p className="item-text">{question.questionText}</p>
              {question.rationale === null ? null : <p className="muted-note">理由：{question.rationale}</p>}
              {question.relatedMethod === null ? null : <p className="muted-note">相关方法：{question.relatedMethod}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
