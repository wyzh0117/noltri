'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';

export interface EmptyStateProps {
  onCapture: (text: string) => Promise<string>;
}

/**
 * The first-capture moment for a brand-new user: three entry points explained in one short list, plus
 * a paste fallback so the loop can be closed from the browser alone.
 */
export default function EmptyState({ onCapture }: EmptyStateProps): ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setResult(null);
    const path = await onCapture(trimmed);
    if (path.length > 0) setResult(`已收纳：${path}`);
    setBusy(false);
  }

  return (
    <div className="empty-state">
      <h2 className="empty-title">你的知识树还是空的</h2>
      <p>
        在任何地方选中一段有价值的内容，它就会进入同一条编译流水线：保留原文、提取知识点、归入合适的
        知识节点。之后这里会出现你的知识树。
      </p>
      <ul className="empty-list">
        <li>
          浏览器插件 <span>— 网页选区旁点击「归纳知识点」，或右键「归纳到知识树」</span>
        </li>
        <li>
          桌面 Companion <span>— 在 Codex / Qoder / IDE 等客户端里选中文字；读不到选区时用快捷键或粘贴降级</span>
        </li>
        <li>
          MCP <span>— 对支持 MCP 的 Agent 说「把上面的内容收纳」</span>
        </li>
      </ul>

      <label className="login-label" htmlFor="paste-capture">
        也可以先粘贴一段内容试试
      </label>
      <textarea
        id="paste-capture"
        className="field-textarea"
        value={text}
        placeholder="粘贴一段你认为值得长期保留的知识…"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="inline-row">
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || text.trim().length === 0}>
          {busy ? '正在收录…' : '收录这段内容'}
        </button>
        {result !== null ? <span className="muted-note">{result}</span> : null}
      </div>
    </div>
  );
}
