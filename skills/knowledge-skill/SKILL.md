---
name: noltri-knowledge
description: Use the user's 知序 Noltri knowledge base through the noltri-knowledge MCP server — capture new knowledge points, search what they already saved, read the knowledge tree and node details, organize nodes, and load grounded context before answering from their own library. Use when the user asks to 收纳/保存/归档 content, or asks what they already know about a topic.
---

# 知序 Noltri Knowledge Skill

This skill guides an MCP host through the `noltri-knowledge` tools. The user's knowledge
base lives in Knowledge Core; every tool talks to it over HTTP and resolves the user from
the request token — **no tool ever accepts a `userId` argument**.

## Tool map (V1, exactly seven)

| Tool | When to use |
| --- | --- |
| `capture_knowledge` | The user asks to save / 收纳 / 归档 selected text, an answer, or a snippet. |
| `search_knowledge` | The user asks what they already have on a topic. Try this before answering from memory. |
| `get_knowledge_tree` | The user asks which domains/branches exist, or you need a target node id. |
| `get_knowledge_node` | You have a `nodeId` and need its summary, items, sources, children, related nodes. |
| `update_knowledge_node` | Rename, re-summarize, archive, or flag a node (at least one field). |
| `move_knowledge_node` | The user says a node is misplaced. `targetParentId: null` moves it to top level. |
| `get_node_context` | Before answering from the user's own library: loads a scope-limited markdown context pack. |

## Ground rules

1. **Node ids only from tools.** Never invent a `nodeId`; take it from `get_knowledge_tree`
   or `search_knowledge` output.
2. **Stay local in scope.** Default `get_node_context` to `current_node` or `section`;
   reserve `whole_library` for questions that genuinely span the entire library.
3. **Report capture results honestly.** `capture_knowledge` returns the placement
   (`created` / `attached` / `merged`), path, and confidence tier. Read it back to the user.
   For `low` confidence tiers, ask the user to confirm where the knowledge belongs.
4. **Surface failures; never fake success.** Tool results with `isError: true` (e.g. a
   move that would create a cycle) must be explained to the user, not retried blindly or
   hidden. Never bypass the tools to write to the database directly.
5. **Raw material is immutable.** Capture preserves the original text; tools never rewrite
   or delete a user's RawSource.
