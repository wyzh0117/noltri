/**
 * Node AI Conversation (V1_DEVELOPMENT §14).
 *
 * Knowledge Core owns the transcript: the context markdown produced by the Context Engine is the
 * system context handed to the provider, and only the items that were actually placed inside the
 * budget are reported as citations. Clients send the new turn; the server never trusts a client-side
 * copy of history beyond the configured window.
 */
import type { ChatMessage as ProviderChatMessage } from '@noltri/ai-provider';
import type {
  Conversation,
  ConversationMessage,
  ContextScope,
  NodeChatRequest,
  NodeChatResponse,
} from '@noltri/schema';
import { knowledgeError, truncate } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { callProvider } from '../pipeline/provider';
import { buildNodeContext } from './context';

const CONVERSATION_TITLE_MAX = 120;

export async function chat(deps: CoreDeps, actor: ActorContext, request: NodeChatRequest): Promise<NodeChatResponse> {
  const node = await deps.repository.findNode(request.nodeId, actor.userId);
  if (node === null) {
    throw knowledgeError('not_found', `节点 ${request.nodeId} 不存在 / node not found`);
  }

  const conversation = await resolveConversation(deps, actor, request);
  const context = await buildNodeContext(deps, actor, { nodeId: request.nodeId, scope: request.scope });

  const history = await deps.repository.listMessages(conversation.id, actor.userId);
  const question = [...request.messages].reverse().find((message) => message.role === 'user');
  const lastStored = history[history.length - 1];

  // Persist the user turn once: a client that replays its local transcript does not double-write.
  let userTurn: ConversationMessage | null = null;
  if (question !== undefined && !(lastStored !== undefined && lastStored.role === 'user' && lastStored.content === question.content)) {
    userTurn = await deps.repository.addMessage({
      userId: actor.userId,
      conversationId: conversation.id,
      role: 'user',
      content: question.content,
      contextNodeId: request.nodeId,
    });
  }

  const window = history.slice(-deps.config.chatHistoryLimit);
  const messages: ProviderChatMessage[] = [
    ...window.map((message) => ({ role: message.role, content: message.content })),
    ...(userTurn === null ? [] : [{ role: userTurn.role, content: userTurn.content } satisfies ProviderChatMessage]),
  ];

  const result = await callProvider('chat', deps, () =>
    deps.provider.chat({
      messages,
      systemContext: context.markdown,
      scope: request.scope,
    }),
  );

  const answer = result.text.trim().length > 0 ? result.text : '（模型未返回内容）';
  const assistantTurn = await deps.repository.addMessage({
    userId: actor.userId,
    conversationId: conversation.id,
    role: 'assistant',
    content: answer,
    contextNodeId: request.nodeId,
  });
  // addMessage maintains conversation.updated_at in both repositories; the reply is what we return.
  deps.logger.debug('chat turn persisted', {
    conversationId: conversation.id,
    userMessageId: userTurn?.id ?? '(reused)',
    assistantMessageId: assistantTurn.id,
  });

  return {
    conversationId: conversation.id,
    reply: answer,
    context: {
      scope: request.scope,
      usedTokens: context.estimatedTokens,
      citedItemIds: context.items.map((item) => item.id),
    },
  };
}

async function resolveConversation(
  deps: CoreDeps,
  actor: ActorContext,
  request: NodeChatRequest,
): Promise<Conversation> {
  if (request.conversationId !== undefined) {
    const existing = await deps.repository.findConversation(request.conversationId, actor.userId);
    if (existing === null) {
      throw knowledgeError('not_found', `会话 ${request.conversationId} 不存在 / conversation not found`);
    }
    return existing;
  }

  const scope: ContextScope = request.scope;
  const existing = await deps.repository.listConversations(actor.userId, request.nodeId);
  const reusable = existing.find((row) => row.scope === scope && row.nodeId === request.nodeId);
  if (reusable !== undefined) return reusable;

  const node = await deps.repository.findNode(request.nodeId, actor.userId);
  return await deps.repository.createConversation({
    userId: actor.userId,
    nodeId: request.nodeId,
    scope,
    title: node === null ? null : truncate(node.title, CONVERSATION_TITLE_MAX),
  });
}

export async function listConversations(
  deps: CoreDeps,
  actor: ActorContext,
  nodeId?: string,
): Promise<Conversation[]> {
  return await deps.repository.listConversations(actor.userId, nodeId);
}

export async function listMessages(
  deps: CoreDeps,
  actor: ActorContext,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const conversation = await deps.repository.findConversation(conversationId, actor.userId);
  if (conversation === null) {
    throw knowledgeError('not_found', `会话 ${conversationId} 不存在 / conversation not found`);
  }
  return await deps.repository.listMessages(conversationId, actor.userId);
}
