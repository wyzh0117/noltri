import type { ReactElement } from 'react';
import type { ResearchContextPackResponse } from '@noltri/schema';
import { packMetaLine } from './research-model';

export interface ContextPackPanelProps {
  /** `null` while the first load is in flight or before a project is open. */
  pack: ResearchContextPackResponse | null;
  error: string | null;
}

/**
 * 上下文包 (contract §5): twelve blocks in reading order, produced on demand and minimized — the panel
 * draws them as-is and keeps the raw markdown one fold away, since both carry the same content.
 */
export default function ContextPackPanel({ pack, error }: ContextPackPanelProps): ReactElement {
  if (pack === null) {
    return (
      <section className="research-panel" aria-label="上下文包">
        <div className="column-title">上下文包</div>
        <p className="muted-note">正在载入上下文包…</p>
        {error !== null ? <p className="error-note">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="research-panel" aria-label="上下文包">
      <div className="column-title">上下文包</div>
      <p className="column-hint">按需最小化的快照：区块顺序即阅读顺序，markdown 与区块同内容。</p>
      <p className="version-note">{packMetaLine(pack)}</p>

      <div className="section">
        {pack.blocks.map((block) => (
          <article key={block.heading} className="item-card">
            <div className="section-head">{block.heading}</div>
            <pre className="pack-body">{block.body}</pre>
          </article>
        ))}
      </div>

      <details className="section">
        <summary>Markdown 原文（与上面的区块同内容）</summary>
        <pre className="pack-body">{pack.markdown}</pre>
      </details>

      {error !== null ? <p className="error-note">{error}</p> : null}
    </section>
  );
}
