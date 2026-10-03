'use client';

/**
 * Research Context Pack (research doc §33): a compact, copyable markdown brief so a new Agent can
 * understand the project without re-reading its whole history.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ResearchContextPackResponse } from '@noltri/schema';
import { BusyButton, FormError } from './fields';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiGet, describeError } from '@/lib/client-api';

export default function ContextPackPanel({ projectId }: ResearchPanelProps): ReactElement {
  const [pack, setPack] = useState<ResearchContextPackResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);

  async function generate(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await apiGet<ResearchContextPackResponse>(`${researchProjectBase(projectId)}/context-pack`);
      setPack(result);
      setError(null);
      setCopyState(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyMarkdown(): Promise<void> {
    if (pack === null) return;
    try {
      if (navigator.clipboard === undefined) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(pack.markdown);
      setCopyState('已复制到剪贴板，可直接粘贴给新的 Agent。');
    } catch {
      setCopyState('当前浏览器不支持自动复制，请在下方文本中手动选择复制。');
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Research Context Pack</h2>
        <span className="column-hint">项目 / RQ / 核心贡献 / 边界 / 方法 / 已确认主张 / 关键证据 / 决策 / 变更 / 遗留问题 / 漂移警告。</span>
      </div>

      <div className="inline-row">
        <BusyButton busy={busy} busyLabel="正在生成…" label={pack === null ? '生成 Context Pack' : '重新生成'} onClick={() => void generate()} />
        {pack !== null ? (
          <button type="button" className="btn" onClick={() => void copyMarkdown()}>
            一键复制 markdown
          </button>
        ) : null}
        {pack !== null ? <span className="muted-note">生成于 {pack.generatedAt.slice(0, 19).replace('T', ' ')} UTC</span> : null}
      </div>

      <FormError message={error} />
      {copyState !== null ? <p className="muted-note">{copyState}</p> : null}

      {pack === null ? (
        <p className="muted-note">还没有生成 Context Pack。生成后会得到一份可以随身携带的项目上下文。</p>
      ) : (
        <>
          <ul className="card-list">
            {pack.blocks.map((block) => (
              <li key={block.heading} className="pack-block">
                <div className="card-head">
                  <strong className="item-text">{block.heading}</strong>
                </div>
                <p className="item-text">{block.body}</p>
              </li>
            ))}
          </ul>
          <div className="map-edge-group">
            <div className="login-label">完整 markdown</div>
            <pre className="pack-markdown">{pack.markdown}</pre>
          </div>
        </>
      )}
    </section>
  );
}
