/**
 * Node AI Conversation (V1_DEVELOPMENT §14): Knowledge Core owns the transcript, the context markdown
 * is the system context, and citations are exactly the items that fit the budget.
 */
import { describe, expect, it } from 'vitest';
import { nodeChatResponseSchema } from '@noltri/schema';
import { attachItemRecord, createNodeRecord, makeHarness } from './fakes';

const TUPLE = '元组不可变，因此可以作为字典的键使用。';
const LIST = '列表可以随时追加元素，但不能作为字典的键使用。';

async function seedNode() {
  const harness = makeHarness();
  const nodeId = await createNodeRecord(harness, 'Python 数据结构');
  const first = await attachItemRecord(harness, nodeId, TUPLE);
  const second = await attachItemRecord(harness, nodeId, LIST);
  return { harness, nodeId, first, second };
}

describe('node ai conversation', () => {
  it('creates a conversation, persists both turns and cites exactly the context items', async () => {
    const { harness, nodeId, first, second } = await seedNode();

    const response = nodeChatResponseSchema.parse(
      await harness.core.chat(
        { nodeId, scope: 'current_node', messages: [{ role: 'user', content: '这两条知识有什么区别？' }] },
        harness.actor,
      ),
    );

    expect(response.conversationId.length).toBeGreaterThan(0);
    expect(response.context.scope).toBe('current_node');
    expect(response.context.usedTokens).toBeGreaterThan(0);
    expect([...response.context.citedItemIds].sort()).toEqual([first.itemId, second.itemId].sort());
    expect(response.reply.length).toBeGreaterThan(0);

    const systemContext = harness.provider.chatInputs[0]?.systemContext ?? '';
    expect(systemContext).toContain('Python 数据结构');
    expect(systemContext).toContain('路径：Python 数据结构');
    expect(systemContext).toContain(TUPLE);
    expect(systemContext).toContain('来源：');

    const conversations = await harness.core.listConversations(harness.actor, nodeId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.scope).toBe('current_node');

    const messages = await harness.core.listConversationMessages(response.conversationId, harness.actor);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('这两条知识有什么区别？');
  });

  it('reuses the conversation for the same node and scope instead of forking a new one', async () => {
    const { harness, nodeId } = await seedNode();
    const first = nodeChatResponseSchema.parse(
      await harness.core.chat(
        { nodeId, scope: 'current_node', messages: [{ role: 'user', content: '第一条' }] },
        harness.actor,
      ),
    );
    const second = nodeChatResponseSchema.parse(
      await harness.core.chat(
        { nodeId, scope: 'current_node', messages: [{ role: 'user', content: '第二条' }] },
        harness.actor,
      ),
    );

    expect(second.conversationId).toBe(first.conversationId);
    const messages = await harness.core.listConversationMessages(first.conversationId, harness.actor);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.map((message) => message.content)).toEqual(['第一条', expect.any(String), '第二条', expect.any(String)]);
  });

  it('a retried turn after a provider failure does not duplicate the user message', async () => {
    // First attempt: the user turn is persisted, then the model call fails (the realistic retry window).
    const failing = makeHarness({ script: { fail: ['chat'] } });
    const nodeId = await createNodeRecord(failing, '咖啡');
    await attachItemRecord(failing, nodeId, '手冲咖啡的粉水比约一比十五。');
    const replay = { nodeId, scope: 'current_node' as const, messages: [{ role: 'user' as const, content: '帮我总结粉水比' }] };
    await expect(failing.core.chat(replay, failing.actor)).rejects.toMatchObject({ code: 'provider_error' });

    // The outage clears and the client retries the same turn.
    failing.provider.fail.delete('chat');
    const recovered = nodeChatResponseSchema.parse(await failing.core.chat(replay, failing.actor));
    const messages = await failing.core.listConversationMessages(recovered.conversationId, failing.actor);
    expect(messages.filter((message) => message.role === 'user' && message.content === '帮我总结粉水比')).toHaveLength(1);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('an explicit conversationId that does not exist is a not_found, not a silent new conversation', async () => {
    const { harness, nodeId } = await seedNode();
    await expect(
      harness.core.chat(
        { nodeId, scope: 'current_node', conversationId: 'missing-conversation', messages: [{ role: 'user', content: '在吗' }] },
        harness.actor,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a provider chat failure never fabricates an assistant reply', async () => {
    const harness = makeHarness({ script: { fail: ['chat'] } });
    const nodeId = await createNodeRecord(harness, '咖啡');
    await attachItemRecord(harness, nodeId, '手冲咖啡的粉水比约一比十五。');

    await expect(
      harness.core.chat(
        { nodeId, scope: 'current_node', messages: [{ role: 'user', content: '帮我总结' }] },
        harness.actor,
      ),
    ).rejects.toMatchObject({ code: 'provider_error' });

    const conversations = await harness.core.listConversations(harness.actor, nodeId);
    const messages = await harness.core.listConversationMessages(conversations[0]?.id ?? '', harness.actor);
    expect(messages.map((message) => message.role)).toEqual(['user']);
  });

  it('a missing node is a not_found before any provider call', async () => {
    const { harness } = await seedNode();
    const chatCallsBefore = harness.provider.chatInputs.length;
    await expect(
      harness.core.chat(
        { nodeId: 'missing-node', scope: 'current_node', messages: [{ role: 'user', content: '在吗' }] },
        harness.actor,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.provider.chatInputs).toHaveLength(chatCallsBefore);
  });
});
