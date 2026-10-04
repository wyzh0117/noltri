'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ChatMessage, NodeChatResponse, NodeContext } from '@noltri/schema';
import { truncate } from '@noltri/shared';
import { apiPost, describeError } from '@/lib/client-api';
import { scopeDescriptions, scopeIsAdvanced, scopeLabels } from '@noltri/shared';
import type { ContextScope } from '@noltri/schema';

const MAX_SENT_MESSAGES = 60;
const STORAGE_PREFIX = 'noltri:chat:';

interface StoredChat {
  conversationId: string | null;
  scope: ContextScope;
  messages: ChatMessage[];
}

interface ChatEntry extends ChatMessage {
  citations?: string[];
  usedTokens?: number;
}

export interface NodeChatPanelProps {
  node: { id: string; title: string };
  onClose: () => void;
}

/**
 * Node conversation (V1_DEVELOPMENT §14). It opens from 与 AI 讨论 as an overlay of the detail column
 * instead of a top-level route, so AI chat never becomes a peer menu of the knowledge tree.
 *
 * Context is loaded from the server (/api/web/node-context); the browser only sends nodeId + scope.
 * The conversationId is persisted so a thread continues, and because GET /api/conversations/:id/messages
 * is not part of the frozen apiRoutes, the transcript itself is persisted client-side.
 */
export default function NodeChatPanel({ node, onClose }: NodeChatPanelProps): ReactElement {
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

  // Restore the stored thread for this node before the first render of the panel body.
  useEffect(() => {
    const stored = readStored(node.id);
    if (stored) {
      setEntries(stored.messages);
      setConversationId(stored.conversationId);
      setScope(stored.scope);
    } else {
      setEntries([]);
      setConversationId(null);
      setScope('current_node');
    }
  }, [node.id]);

  useEffect(() => {
    let cancelled = false;
    setLoadingContext(true);
    void (async () => {
      try {
        const result = await apiPost<NodeContext>('/api/web/node-context', { nodeId: node.id, scope });
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
  }, [node.id, scope]);

  useEffect(() => {
    writeStored(node.id, { conversationId, scope, messages: entries.filter(isPlainMessage) });
  }, [node.id, conversationId, scope, entries]);

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
    const withTurn: ChatMessage[] = [...entries.map(toMessage), { role: 'user', content }];
    const history: ChatMessage[] = withTurn.slice(-MAX_SENT_MESSAGES);
    setDraft('');
    setSending(true);
    setError(null);
    setEntries((previous) => [...previous, { role: 'user', content }]);
    try {
      const result = await apiPost<NodeChatResponse>('/api/web/chat', {
        nodeId: node.id,
        scope,
        ...(conversationId ? { conversationId } : {}),
        messages: history,
      });
      setConversationId(result.conversationId);
      setEntries((previous) => [
        ...previous,
        { role: 'assistant', content: result.reply, citations: result.context.citedItemIds, usedTokens: result.context.usedTokens },
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
          <div className="column-title column-title-tight">
            与 AI 讨论
          </div>
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
              {context.truncated ? (
                <span className="badge badge-warn">上下文超出预算，已截断</span>
              ) : null}
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
          <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || draft.trim().length === 0}>
            发送
          </button>
          {conversationId !== null ? (
            <span className="chat-note">会话 {truncate(conversationId, 18)} 已保持，可继续讨论</span>
          ) : null}
        </div>
        <p className="chat-note">
          对话记录保存在本机浏览器（Knowledge Core 契约未开放按会话读取消息的接口），conversationId
          仍会随每次请求发送以保持同一会话。
        </p>
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

function toMessage(entry: ChatEntry): ChatMessage {
  return { role: entry.role, content: entry.content };
}

function isPlainMessage(entry: ChatEntry): ChatMessage {
  return { role: entry.role, content: entry.content };
}

function readStored(nodeId: string): StoredChat | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${nodeId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<StoredChat>;
    if (!Array.isArray(record.messages)) return null;
    const messages = record.messages.filter(
      (message): message is ChatMessage =>
        typeof message === 'object' &&
        message !== null &&
        typeof message.content === 'string' &&
        (message.role === 'user' || message.role === 'assistant'),
    );
    return {
      conversationId: typeof record.conversationId === 'string' ? record.conversationId : null,
      scope: isScope(record.scope) ? record.scope : 'current_node',
      messages,
    };
  } catch {
    return null;
  }
}

function writeStored(nodeId: string, value: StoredChat): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${nodeId}`, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private mode; the thread simply stays in memory for this session.
  }
}

function isScope(value: unknown): value is ContextScope {
  return value === 'current_node' || value === 'section' || value === 'tree' || value === 'whole_library';
}
