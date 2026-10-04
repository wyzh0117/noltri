/**
 * Node-chat transcript rules (P2). Knowledge Core owns the conversation rows now, so the two decisions
 * the desktop panel makes from them — which thread to read back, and which stored rows may be replayed
 * to the model — are tested here instead of in a browser.
 */
import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationMessage } from '@noltri/schema';
import { newestThread, toChatTurns } from '../src/workbench/chat-model';

function thread(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    userId: 'u-1',
    nodeId: 'node-tuple',
    scope: 'current_node',
    title: 'Tuple 元组',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: '元组和列表有什么区别？',
    contextNodeId: 'node-tuple',
    createdAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('picking the stored thread', () => {
  it('takes the most recently updated conversation for this node and scope', () => {
    const rows = [
      thread({ id: 'older', updatedAt: '2026-03-01T08:00:00.000Z' }),
      thread({ id: 'newest', updatedAt: '2026-03-04T09:30:00.000Z' }),
      thread({ id: 'middle', updatedAt: '2026-03-02T08:00:00.000Z' }),
    ];
    expect(newestThread(rows, 'node-tuple', 'current_node')?.id).toBe('newest');
  });

  it('never reuses a thread from another node', () => {
    expect(newestThread([thread({ nodeId: 'node-dict' })], 'node-tuple', 'current_node')).toBeNull();
  });

  it('never reuses a thread from another scope', () => {
    expect(newestThread([thread({ scope: 'whole_library' })], 'node-tuple', 'current_node')).toBeNull();
  });

  it('takes the newest row of the requested scope, not the newest row overall', () => {
    const rows = [
      thread({ id: 'node-scope', scope: 'current_node', updatedAt: '2026-03-05T08:00:00.000Z' }),
      thread({ id: 'tree-scope', scope: 'tree', updatedAt: '2026-03-01T08:00:00.000Z' }),
    ];
    expect(newestThread(rows, 'node-tuple', 'tree')?.id).toBe('tree-scope');
  });

  it('never pulls a thread Core stored without a node into the node panel', () => {
    expect(newestThread([thread({ nodeId: null, scope: 'whole_library' })], 'node-tuple', 'whole_library')).toBeNull();
  });

  it('returns null for an empty list instead of inventing a conversation', () => {
    expect(newestThread([], 'node-tuple', 'current_node')).toBeNull();
  });
});

describe('replaying stored messages', () => {
  it('keeps user and assistant turns in the order Core wrote them', () => {
    const turns = toChatTurns([
      message({ role: 'user', content: '第一问' }),
      message({ role: 'assistant', content: '第一答' }),
      message({ role: 'user', content: '第二问' }),
    ]);
    expect(turns.map((turn) => [turn.role, turn.content])).toEqual([
      ['user', '第一问'],
      ['assistant', '第一答'],
      ['user', '第二问'],
    ]);
  });

  it('drops context-engine system rows so they cannot be sent back as spoken turns', () => {
    const turns = toChatTurns([
      message({ role: 'system', content: '以下是检索到的知识卡片……' }),
      message({ role: 'user', content: '真实提问' }),
    ]);
    expect(turns).toEqual([{ role: 'user', content: '真实提问' }]);
  });

  it('carries only role and content into the next request', () => {
    const [only] = toChatTurns([message({ id: 'msg-9', createdAt: '2026-03-01T08:00:00.000Z' })]);
    expect(Object.keys(only ?? {})).toEqual(['role', 'content']);
  });

  it('yields an empty list for a conversation with no stored turns', () => {
    expect(toChatTurns([])).toEqual([]);
  });
});
