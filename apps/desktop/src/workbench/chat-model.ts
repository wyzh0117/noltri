/**
 * Chat transcript rules, kept away from the panel so the two decisions that actually matter — which
 * stored thread belongs to this node and scope, and which stored rows may be shown or replayed — are
 * testable without a DOM.
 */
import type { ChatMessage, Conversation, ConversationMessage, ContextScope } from '@noltri/schema';

/** Core keeps one conversation per (node, scope); when several exist, the most recently active wins. */
export function newestThread(
  conversations: readonly Conversation[],
  nodeId: string,
  scope: ContextScope,
): Conversation | null {
  const matching = conversations
    .filter((row) => row.nodeId === nodeId && row.scope === scope)
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  return matching[0] ?? null;
}

/**
 * A `system` row is Context Engine output, never a turn the user spoke, so it stays out of the replayed
 * history — sending it back as one of our own messages would be a forged turn.
 */
export function toChatTurns(messages: readonly ConversationMessage[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      turns.push({ role: message.role, content: message.content });
    }
  }
  return turns;
}
