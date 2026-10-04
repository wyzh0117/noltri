import { useState } from 'react';
import type { ReactElement } from 'react';

export interface EmptyStateProps {
  onCapture: (text: string) => Promise<string>;
  /** Core is on the deterministic offline driver: the loop still closes, but no real model is called. */
  aiIsOffline: boolean;
}

/**
 * The first-capture moment for a brand-new user: the entry points explained in one short list, plus a
 * paste box so the loop can be closed from this window alone.
 */
export default function EmptyState({ onCapture, aiIsOffline }: EmptyStateProps): ReactElement {
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
          桌面 Companion <span>— 选中文字后点悬浮球，或用快捷键 / 粘贴窗口降级</span>
        </li>
        <li>
          浏览器插件 <span>— 网页选区旁点击「归纳知识点」</span>
        </li>
        <li>
          MCP <span>— 对支持 MCP 的 Agent 说「把上面的内容收纳」</span>
        </li>
        <li>
          收件箱 <span>— 待整理或归纳失败的原文，可以在这里重试或人工归档</span>
        </li>
      </ul>

      <label className="empty-label" htmlFor="workbench-paste">
        也可以先粘贴一段内容试试
      </label>
      <textarea
        id="workbench-paste"
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
      {aiIsOffline ? (
        <p className="muted-note">
          当前是「离线 Provider」，没有配置模型密钥。原文仍会完整保存，归纳由本机确定性规则完成；
          不满意时可在收件箱人工归档你想保留的那句。
        </p>
      ) : null}
    </div>
  );
}
