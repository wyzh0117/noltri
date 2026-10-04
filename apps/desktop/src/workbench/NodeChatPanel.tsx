import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChatMessage, ContextScope, NodeChatResponse, NodeContext } from '@noltri/schema';
import { scopeDescriptions, scopeIsAdvanced, scopeLabels, truncate } from '@noltri/shared';
import { describeError } from './api';
import { newestThread, toChatTurns } from './chat-model';
import type { WorkbenchApi } from './api';

interface ChatEntry extends ChatMessage {
  citations?: string[];
  usedTokens?: number;
}

export interface NodeChatPanelProps {
  api: WorkbenchApi;
  node: { id: string; title: string };
  onClose: () => void;
}

/**
 * Node conversation (V1_DEVELOPMENT §14). It opens from 与 AI 讨论 as an overlay of the detail column
 * instead of a top-level route, so AI chat never becomes a peer menu of the knowledge tree.
 *
 * Unlike the web build, nothing is mirrored into local storage: GET /api/conversations and
 * GET /api/conversations/:id/messages are real Core endpoints, so the transcript is read back from the
 * server and each send carries only the new turn. Citations and token counts come from the reply that
 * this window actually received — Core stores the text, not the citation set.
 */
export default function NodeChatPanel({ api, node, onClose }: NodeChatPanelProps): ReactElement {
  const [scope, setScope] = useState<ContextScope>('current_node');
  const [context, setContext] = useState<NodeContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingContext(true);
    void (async () => {
      try {
        const result = await api.nodeContext({ nodeId: node.id, scope });
        if (cancelled) return;
        setContext(result);
        setContextError(null);
      } catch (failure) {
        if (cancelled) return;
        setContext(null);
        setContextError(describeError(failure));
      } finally {
        if (!cancelled) setLoadingContext(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, node.id, scope]);

  // The thread belongs to (node, scope): Core reuses exactly that row, so the panel reads it back the same way.
  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setConversationId(null);
    void (async () => {
      try {
        const threads = await api.conversations(node.id);
        const latest = newestThread(threads, node.id, scope);
        if (latest === null) return;
        const messages = await api.conversationMessages(latest.id);
        if (cancelled) return;
        setConversationId(latest.id);
        setEntries(toChatTurns(messages));
      } catch {
        // A missing transcript is not a reason to refuse a new question.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, node.id, scope]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);

  const citationLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const item of context?.items ?? []) labels.set(item.id, truncate(item.normalizedText, 46));
    return labels;
  }, [context]);

  async function send(): Promise<void> {
    const content = draft.trim();
    if (content.length === 0 || sending) return;
    setDraft('');
    setSending(true);
    setError(null);
    setEntries((previous) => [...previous, { role: 'user', content }]);
    try {
      const result: NodeChatResponse = await api.chat({
        nodeId: node.id,
        scope,
        ...(conversationId === null ? {} : { conversationId }),
        messages: [{ role: 'user', content }],
      });
      setConversationId(result.conversationId);
      setEntries((previous) => [
        ...previous,
        {
          role: 'assistant',
          content: result.reply,
          citations: result.context.citedItemIds,
          usedTokens: result.context.usedTokens,
        },
      ]);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="chat-overlay" aria-label={`与 AI 讨论 ${node.title}`}>
      <header className="chat-head">
        <div>
          <div className="column-title column-title-tight">与 AI 讨论</div>
          <div className="muted-note">{node.title}</div>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          返回节点详情
        </button>
      </header>

      <div className="chat-scope">
        <div className="scope-grid" role="radiogroup" aria-label="上下文范围">
          {(Object.keys(scopeLabels) as ContextScope[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={scope === option}
              className={scopeClassName(option, scope)}
              onClick={() => setScope(option)}
            >
              {scopeLabels[option]}
              {scopeIsAdvanced[option] ? '（高级）' : ''}
            </button>
          ))}
        </div>
        <p className="muted-note">{scopeDescriptions[scope]}</p>
        <div className="context-meter" aria-live="polite">
          {loadingContext ? <span>正在装载上下文…</span> : null}
          {contextError !== null ? <span className="error-note">{contextError}</span> : null}
          {context !== null ? (
            <>
              <span className="badge badge-accent">已装载上下文 {context.estimatedTokens} tokens</span>
              <span className="muted-note">预算 {context.tokenBudget} · 范围 {scopeLabels[context.scope]}</span>
              {context.truncated ? <span className="badge badge-warn">上下文超出预算，已截断</span> : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="chat-log" ref={logRef}>
        {entries.length === 0 ? (
          <p className="muted-note">围绕这个节点提问，回答只使用上面装载的局部上下文。</p>
        ) : null}
        {entries.map((entry, index) => (
          <div key={`${entry.role}-${index}`} className={entry.role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg'}>
            <p className="chat-bubble">{entry.content}</p>
            {entry.citations && entry.citations.length > 0 ? (
              <div className="chat-cites">
                <span>引用知识点：</span>
                {entry.citations.map((id) => (
                  <span key={id} className="badge">
                    {citationLabels.get(id) ?? id}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.usedTokens !== undefined ? <span className="chat-note">本次使用 {entry.usedTokens} tokens</span> : null}
          </div>
        ))}
        {sending ? <p className="muted-note">AI 正在回答…</p> : null}
        {error !== null ? <p className="error-note">{error}</p> : null}
      </div>

      <footer className="chat-composer">
        <textarea
          className="field-textarea"
          value={draft}
          placeholder="例如：这个节点还缺什么？用一句话解释它。"
          aria-label="消息内容"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="chat-composer-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void send()}
            disabled={sending || draft.trim().length === 0}
          >
            发送
          </button>
          {conversationId !== null ? (
            <span className="chat-note">会话 {truncate(conversationId, 18)} 已保持，可继续讨论</span>
          ) : null}
        </div>
        <p className="chat-note">对话记录由 Knowledge Core 保存在本机存储，切换作用域会读回对应的会话。</p>
      </footer>
    </section>
  );
}

function scopeClassName(option: ContextScope, active: ContextScope): string {
  const parts = ['scope-btn'];
  if (scopeIsAdvanced[option]) parts.push('scope-btn-advanced');
  if (option === active) parts.push('scope-btn-active');
  return parts.join(' ');
}
