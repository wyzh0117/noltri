import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { ApiClient, ApiClientError, buildCaptureRequest } from '@noltri/api-client';
import {
  apiErrorCodes,
  captureSourceSchema,
  contextScopeSchema,
  MAX_CAPTURE_TEXT_LENGTH,
  MAX_SURROUNDING_CONTEXT_LENGTH,
  MIN_CAPTURE_TEXT_LENGTH,
  nodeStatusSchema,
  searchModeSchema,
  type ApiErrorCode,
  type CaptureResult,
  type ConfidenceTier,
  type NodeContext,
  type NodeDetail,
  type SearchHit,
  type TreeResponse,
  type TreeNode,
} from '@noltri/schema';
import { isKnowledgeError, knowledgeError } from '@noltri/shared';
import { z } from 'zod';

/**
 * The seven V1 MCP tools. Every handler only talks to Knowledge Core through ApiClient —
 * no storage, no SQL, no local knowledge logic (PROJECT_MASTER 2.3 / 2.6, V1_DEVELOPMENT 13).
 */
export interface ToolRuntime {
  readonly api: ApiClient;
}

export interface ToolSpec<Shape extends ZodRawShapeCompat> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly shape: Shape;
  readonly run: (runtime: ToolRuntime, args: ShapeOutput<Shape>) => Promise<CallToolResult>;
}

function defineTool<Shape extends ZodRawShapeCompat>(spec: ToolSpec<Shape>): ToolSpec<Shape> {
  return spec;
}

const ZH_BY_CODE: Record<ApiErrorCode, string> = {
  invalid_request: '参数不符合 Knowledge Core 契约',
  unauthorized: '未授权：Knowledge Core 拒绝了当前 token，请让用户重新完成连接授权',
  not_found: '目标知识节点不存在',
  conflict: '操作被 Knowledge Core 拒绝（结构冲突）',
  provider_error: 'AI Provider 调用失败，原始材料已安全保存，可稍后重试',
  storage_error: 'Knowledge Core 存储层失败',
  rate_limited: '请求过于频繁，请稍后重试',
  internal_error: 'Knowledge Core 内部错误',
};

function isApiErrorCode(value: string): value is ApiErrorCode {
  return (apiErrorCodes as readonly unknown[]).includes(value);
}

function toCoreError(error: unknown) {
  // A KnowledgeError raised locally (e.g. empty-patch guard) keeps its own code; only upstream
  // failures get mapped.
  if (isKnowledgeError(error)) return error;
  if (error instanceof ApiClientError) {
    const code: ApiErrorCode = isApiErrorCode(error.code) ? error.code : 'internal_error';
    return knowledgeError(code, `${ZH_BY_CODE[code]}（${error.message}）`, error.details);
  }
  if (error instanceof Error) return knowledgeError('internal_error', `Knowledge Core 调用失败（${error.message}）`);
  return knowledgeError('internal_error', 'Knowledge Core 调用失败');
}

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** Tool failures surface as MCP tool errors (isError) so the Agent session never crashes. */
function fail(error: unknown): CallToolResult {
  const issue = toCoreError(error);
  const hint =
    issue.code === 'conflict'
      ? '请向用户说明冲突原因并请其改换目标位置，切勿静默忽略。'
      : '请向用户说明失败原因，不要伪造结果，也不要绕过工具直接读写数据库。';
  return {
    isError: true,
    content: [{ type: 'text', text: `[${issue.code}] ${issue.message}｜${hint}` }],
    structuredContent: { code: issue.code, status: issue.status, message: issue.message },
  };
}

const actionLabel: Record<'created' | 'attached' | 'merged', string> = {
  created: '新建节点',
  attached: '归入已有节点',
  merged: '合并进已有节点',
};

const tierLabel: Record<ConfidenceTier, string> = {
  high: '高置信度（自动归档）',
  medium: '中置信度（已归档，保留建议）',
  low: '低置信度（建议向用户确认应归入哪里）',
};

function describeCapture(result: CaptureResult): string {
  if (result.processingStatus === 'failed') {
    return [
      `原始材料已保存（rawSourceId=${result.rawSourceId}），但 AI 处理未完成，可稍后重试。`,
      ...(result.errorReason ? [`原因：${result.errorReason}`] : []),
    ].join('\n');
  }
  const head = `已收纳 ${result.items.length} 条知识点（rawSourceId=${result.rawSourceId}）：`;
  const lines = result.items.map((item, index) => {
    const path = item.nodePath.length > 0 ? item.nodePath.join(' / ') : '（未归类）';
    return `${index + 1}. ${item.text}\n   归类：${path}\n   动作：${actionLabel[item.action]}｜置信度：${item.confidence.toFixed(2)}｜${tierLabel[item.confidenceTier]}`;
  });
  const footer = result.items.some((item) => item.confidenceTier === 'low')
    ? '存在低置信度归类，请向用户确认这段知识应该放在哪里。'
    : '请向用户复述归类路径以确认归档位置。';
  return [head, ...lines, footer].join('\n');
}

function describeHits(query: string, hits: readonly SearchHit[]): string {
  if (hits.length === 0) return `没有关于「${query}」的知识命中，可以先看知识树或收纳新内容。`;
  const lines = hits.map((hit, index) => {
    const node = hit.nodeId ? `nodeId=${hit.nodeId}` : 'nodeId=（无节点）';
    const item = hit.itemId ? ` itemId=${hit.itemId}` : '';
    const source = hit.source
      ? `｜来源：${hit.source.sourceTitle ?? hit.source.sourceUrl ?? hit.source.sourceType}`
      : '';
    return `${index + 1}. ${hit.title}（score=${hit.score.toFixed(2)}，${hit.matchedBy}）${node}${item}${source}\n   ${hit.text}`;
  });
  return [`关于「${query}」命中 ${hits.length} 条：`, ...lines, '需要更多依据时，请继续 get_knowledge_node 与 get_node_context。'].join(
    '\n',
  );
}

function renderTreeLines(nodes: readonly TreeNode[], prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    lines.push(
      `${prefix}${isLast ? '└── ' : '├── '}${node.title}（${node.itemCount} 条知识 · ${node.childCount} 个子节点 · id=${node.id}）`,
    );
    if (node.children && node.children.length > 0) {
      lines.push(...renderTreeLines(node.children, `${prefix}${isLast ? '    ' : '│   '}`));
    }
  });
  return lines;
}

function describeTree(scopeLabel: string | null, result: TreeResponse): string {
  if (result.nodes.length === 0) return '知识树当前为空，可以用 capture_knowledge 收纳第一条知识。';
  return [
    `${scopeLabel ? `子树 ${scopeLabel}` : '知识树'}（共 ${result.totalNodes} 个节点）：`,
    ...renderTreeLines(result.nodes),
    '节点 id 只能来自这里或 search_knowledge 的结果，不得凭空编造。',
  ].join('\n');
}

function describeDetail(detail: NodeDetail): string {
  const path = detail.path.map((segment) => segment.title).join(' / ');
  const children = detail.children.length > 0 ? detail.children.map((node) => node.title).join('、') : '（无子节点）';
  const related =
    detail.relatedNodes.length > 0
      ? detail.relatedNodes.map((entry) => `${entry.node.title}（${entry.relationType}）`).join('、')
      : '（无相关节点）';
  const items =
    detail.items.length > 0
      ? detail.items
          .map((entry, index) => `${index + 1}. ${entry.item.normalizedText}（置信度 ${entry.item.confidence.toFixed(2)}，${entry.sources.length} 个来源）`)
          .join('\n')
      : '（无知识点）';
  return [
    `节点：${detail.node.title}｜id=${detail.node.id}`,
    `路径：${path || '（顶层）'}`,
    `状态：${detail.node.status}｜类型：${detail.node.nodeType}｜置信度：${detail.node.confidence ?? '—'}`,
    `摘要：${detail.node.summary ?? '（暂无摘要）'}`,
    `统计：知识点 ${detail.stats.itemCount} · 来源 ${detail.stats.sourceCount} · 子节点 ${detail.stats.childCount}`,
    `子节点：${children}`,
    `相关节点：${related}`,
    `知识点：\n${items}`,
  ].join('\n');
}

const nodeIdField = z
  .string()
  .min(1)
  .describe('知识节点 id，必须来自 get_knowledge_tree 或 search_knowledge，不得编造');

export const captureKnowledgeTool = defineTool({
  name: 'capture_knowledge',
  title: '收纳知识点',
  description:
    '把一段内容交给 Knowledge Core：保留原文、提取原子知识并自动归类到知识树。Use when the user asks to save / collect / archive selected text, an answer or a snippet into their 知序 knowledge base. 返回 nodePath 归类结果，必须读回并向用户确认归类位置。身份来自请求 token，本工具绝不接收 userId。',
  shape: {
    text: z
      .string()
      .trim()
      .min(MIN_CAPTURE_TEXT_LENGTH)
      .max(MAX_CAPTURE_TEXT_LENGTH)
      .describe('用户选中或提供的原文，系统完整保留，不会被摘要覆盖'),
    source: captureSourceSchema.describe(
      '来源信息：type 为 web / desktop_app / agent / manual，可带 platform、appName、title、url',
    ),
    surroundingContext: z.string().max(MAX_SURROUNDING_CONTEXT_LENGTH).optional().describe('选区前后的上下文，可选'),
    capturedAt: z.string().min(4).max(64).optional().describe('采集时间 ISO 字符串，省略则由服务端取当前时间'),
  },
  run: async (runtime, args) => {
    try {
      const result = await runtime.api.capture(
        buildCaptureRequest({
          text: args.text,
          source: args.source,
          client: 'mcp',
          ...(args.surroundingContext ? { surroundingContext: args.surroundingContext } : {}),
          ...(args.capturedAt ? { capturedAt: args.capturedAt } : {}),
        }),
      );
      return ok(describeCapture(result), { ...result });
    } catch (error) {
      return fail(error);
    }
  },
});

export const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  title: '搜索知识',
  description:
    '在用户自己的知识库中做语义 + 关键词搜索。Use first when the user asks 「查一下我关于 X 的知识」 or 「有没有收藏过 X」. 命中后应继续 get_knowledge_node 与 get_node_context 再作答。',
  shape: {
    query: z.string().trim().min(1).max(2000).describe('搜索问题或关键词'),
    mode: searchModeSchema.optional().describe('semantic / keyword / hybrid，省略由 Knowledge Core 决定'),
    limit: z.number().int().min(1).max(50).optional().describe('返回条数上限'),
    scopeNodeId: z.string().min(1).optional().describe('限定在某个节点子树内搜索'),
  },
  run: async (runtime, args) => {
    try {
      const result = await runtime.api.search({
        query: args.query,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.scopeNodeId ? { scopeNodeId: args.scopeNodeId } : {}),
      });
      return ok(describeHits(result.query, result.hits), { ...result });
    } catch (error) {
      return fail(error);
    }
  },
});

export const getKnowledgeTreeTool = defineTool({
  name: 'get_knowledge_tree',
  title: '读取知识树',
  description:
    '读取知识树或某个子树，返回缩进文本树与结构化节点。Use when the user asks which domains or branches exist, when picking a scopeNodeId, or before choosing a move target. 节点 id 只能来自这里。',
  shape: {
    rootId: z.string().min(1).optional().describe('子树根节点 id，省略则从顶层开始'),
    depth: z.number().int().min(1).max(6).optional().describe('向下展开层数，省略则由 Knowledge Core 决定'),
  },
  run: async (runtime, args) => {
    try {
      const result = await runtime.api.tree({
        ...(args.rootId ? { rootId: args.rootId } : {}),
        ...(args.depth ? { depth: args.depth } : {}),
      });
      return ok(describeTree(args.rootId ?? null, result), { ...result });
    } catch (error) {
      return fail(error);
    }
  },
});

export const getKnowledgeNodeTool = defineTool({
  name: 'get_knowledge_node',
  title: '读取知识节点',
  description:
    '读取单个知识节点详情：摘要、知识点、来源、子节点、相关节点与统计。Use after search_knowledge returns a nodeId, or when the user points at one node of the tree.',
  shape: { nodeId: nodeIdField },
  run: async (runtime, args) => {
    try {
      const detail = await runtime.api.nodeDetail(args.nodeId);
      return ok(describeDetail(detail), { ...detail });
    } catch (error) {
      return fail(error);
    }
  },
});

export const updateKnowledgeNodeTool = defineTool({
  name: 'update_knowledge_node',
  title: '修改知识节点',
  description:
    '修改节点标题、摘要或状态（active / archived / needs_review）。Use when the user asks to rename, re-summarize, archive or flag a node. 至少提供一个字段；不会删除原始材料。',
  shape: {
    nodeId: nodeIdField,
    title: z.string().trim().min(1).max(200).optional().describe('新的节点标题'),
    summary: z.string().trim().max(4000).optional().describe('新的节点摘要'),
    status: nodeStatusSchema.optional().describe('节点状态：active / archived / needs_review'),
  },
  run: async (runtime, args) => {
    if (args.title === undefined && args.summary === undefined && args.status === undefined) {
      return fail(knowledgeError('invalid_request', 'update_knowledge_node 至少需要 title / summary / status 中的一个字段'));
    }
    try {
      const node = await runtime.api.patchNode(args.nodeId, {
        ...(args.title ? { title: args.title } : {}),
        ...(args.summary ? { summary: args.summary } : {}),
        ...(args.status ? { status: args.status } : {}),
      });
      return ok(`已更新节点「${node.title}」（id=${node.id}，状态=${node.status}）。原始材料与历史版本保持不变。`, {
        ...node,
      });
    } catch (error) {
      return fail(error);
    }
  },
});

export const moveKnowledgeNodeTool = defineTool({
  name: 'move_knowledge_node',
  title: '移动知识节点',
  description:
    '把节点移动到新父节点下（targetParentId 为 null 表示移到顶层）。Use when the user says 这个放错地方了 or 把它挪到 X 下面. 结构冲突与循环由 Knowledge Core 判定，必须以工具错误明确回报，绝不静默吞掉。移动可逆并写入版本记录。',
  shape: {
    nodeId: nodeIdField,
    targetParentId: z.string().min(1).nullable().describe('新的父节点 id；null 表示移动到顶层'),
  },
  run: async (runtime, args) => {
    try {
      const result = await runtime.api.moveNode(args.nodeId, { targetParentId: args.targetParentId, actor: 'mcp' });
      if (result.cycleDetected) {
        return fail(knowledgeError('conflict', 'Knowledge Core 检测到该移动会形成循环，已拒绝执行'));
      }
      const path = result.path.map((segment) => segment.title).join(' / ') || '（顶层）';
      return ok(`已将节点「${result.node.title}」移动到：${path}（版本记录 id=${result.versionRecordId}，可回滚）。`, {
        ...result,
      });
    } catch (error) {
      return fail(error);
    }
  },
});

export const getNodeContextTool = defineTool({
  name: 'get_node_context',
  title: '装载节点上下文',
  description:
    '为 AI 对话装载指定作用域的局部上下文包（markdown）。Use before answering anything about the user\'s own knowledge, so the answer is grounded in their items, ancestors, siblings, related nodes and sources. scope: current_node / section / tree / whole_library —— 默认尽量局部，不要把整个知识库塞进上下文。',
  shape: {
    nodeId: nodeIdField,
    scope: contextScopeSchema.describe('上下文作用域：current_node / section / tree / whole_library'),
    tokenBudget: z
      .number()
      .int()
      .min(500)
      .max(60_000)
      .optional()
      .describe('上下文 token 预算，省略则由 Knowledge Core 按作用域配置'),
  },
  run: async (runtime, args) => {
    try {
      const context: NodeContext = await runtime.api.nodeContext({
        nodeId: args.nodeId,
        scope: args.scope,
        ...(args.tokenBudget ? { tokenBudget: args.tokenBudget } : {}),
      });
      const note = `上下文作用域=${context.scope}，估算 token=${context.estimatedTokens}/${context.tokenBudget}${context.truncated ? '（已截断）' : ''}。请基于以下上下文包回答：\n\n`;
      return ok(`${note}${context.markdown}`, { ...context });
    } catch (error) {
      return fail(error);
    }
  },
});

/** Exactly the seven V1 tools — no database access, no bulk delete, no raw SQL. */
export const V1_TOOL_NAMES: readonly string[] = [
  captureKnowledgeTool,
  searchKnowledgeTool,
  getKnowledgeTreeTool,
  getKnowledgeNodeTool,
  updateKnowledgeNodeTool,
  moveKnowledgeNodeTool,
  getNodeContextTool,
].map((tool) => tool.name);

function toolConfig<S extends ZodRawShapeCompat>(tool: ToolSpec<S>) {
  return { title: tool.title, description: tool.description, inputSchema: tool.shape };
}

/** Registers exactly the seven V1 tools; each callback only forwards to Knowledge Core. */
export function registerKnowledgeTools(server: McpServer, runtime: ToolRuntime): void {
  server.registerTool(captureKnowledgeTool.name, toolConfig(captureKnowledgeTool), (args) =>
    captureKnowledgeTool.run(runtime, args),
  );
  server.registerTool(searchKnowledgeTool.name, toolConfig(searchKnowledgeTool), (args) =>
    searchKnowledgeTool.run(runtime, args),
  );
  server.registerTool(getKnowledgeTreeTool.name, toolConfig(getKnowledgeTreeTool), (args) =>
    getKnowledgeTreeTool.run(runtime, args),
  );
  server.registerTool(getKnowledgeNodeTool.name, toolConfig(getKnowledgeNodeTool), (args) =>
    getKnowledgeNodeTool.run(runtime, args),
  );
  server.registerTool(updateKnowledgeNodeTool.name, toolConfig(updateKnowledgeNodeTool), (args) =>
    updateKnowledgeNodeTool.run(runtime, args),
  );
  server.registerTool(moveKnowledgeNodeTool.name, toolConfig(moveKnowledgeNodeTool), (args) =>
    moveKnowledgeNodeTool.run(runtime, args),
  );
  server.registerTool(getNodeContextTool.name, toolConfig(getNodeContextTool), (args) =>
    getNodeContextTool.run(runtime, args),
  );
}
