import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { ApiClient, ApiClientError } from '@noltri/api-client';
import {
  createLibraryItemInputSchema,
  itemRelationKindSchema,
  type LibraryItem,
  type TreeNode,
  type TreeResponse,
} from '@noltri/schema';
import { isKnowledgeError, truncate } from '@noltri/shared';
import { z } from 'zod';

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

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(error: unknown): CallToolResult {
  const code = error instanceof ApiClientError
    ? error.code
    : isKnowledgeError(error)
      ? error.code
      : 'internal_error';
  const message = error instanceof Error ? error.message : 'Knowledge Core 调用失败';
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}` }],
    structuredContent: { code, ...(error instanceof ApiClientError ? { status: error.status } : {}), message },
  };
}

function itemLine(item: LibraryItem): string {
  const path = item.subjectPath.length > 0 ? item.subjectPath.join(' / ') : '待整理';
  const source = item.source.title ?? item.source.url ?? item.source.appName ?? item.source.type;
  const status = item.aiStatus === 'ready'
    ? '已整理'
    : item.aiStatus === 'failed'
      ? '原文已保存，AI 处理失败'
      : '原文已保存，等待整理';
  return `${status}：${item.kind}｜${path}｜来源：${source}｜id=${item.id}`;
}

export const saveKnowledgeTool = defineTool({
  name: 'save_knowledge',
  title: '保存知识',
  description:
    '把网页、Agent 回答或论文摘录保存到知序。原文与出处先写入本机库，再尝试 AI 摘要和学科归类；AI 不可用时仍会留下待整理条目。Use when the user asks to save or collect text. 不要代用户补造出处。',
  shape: createLibraryItemInputSchema.shape,
  run: async (runtime, args) => {
    try {
      const { item } = await runtime.api.createItem(args);
      return ok(itemLine(item), { item });
    } catch (error) {
      return fail(error);
    }
  },
});

export const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  title: '搜索知识',
  description: '按关键词搜索全部未归档资料，包含尚未整理的原文；显示研究方向和出处。Use before answering from the user’s saved knowledge.',
  shape: {
    query: z.string().trim().min(1).max(200).describe('要查找的主题或词语'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回条数'),
  },
  run: async (runtime, args) => {
    try {
      const result = await runtime.api.listItems({
        query: args.query,
        limit: args.limit ?? 12,
      });
      const items = result.items.map((item) => ({
        id: item.id,
        title: item.source.title ?? item.researchPoint ?? item.summary ?? '未命名资料',
        kind: item.kind,
        subjectPath: item.subjectPath,
        aiStatus: item.aiStatus,
        source: item.source,
        excerpt: truncate(item.researchPoint ?? item.summary ?? item.content, 500),
      }));
      const lines = result.items.map((item, index) => {
        const hit = items[index];
        return hit ? `- ${itemLine(item)}\n  ${hit.title}：${hit.excerpt}` : '';
      });
      return ok(lines.length ? lines.join('\n') : '没有找到相关资料。', { query: args.query, items });
    } catch (error) {
      return fail(error);
    }
  },
});

function treeLines(nodes: readonly TreeNode[], prefix = ''): string[] {
  return nodes.flatMap((node) => [
    `${prefix}${node.title}（${node.itemCount}）`,
    ...treeLines(node.children ?? [], `${prefix}  `),
  ]);
}

export const getKnowledgeTreeTool = defineTool({
  name: 'get_knowledge_tree',
  title: '读取知识树',
  description: '读取本机知识库按学科和研究方向形成的分类树。Use to see existing branches before suggesting a category.',
  shape: { rootId: z.string().min(1).optional(), depth: z.number().int().min(1).max(6).optional() },
  run: async (runtime, args) => {
    try {
      const tree: TreeResponse = await runtime.api.tree({
        ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
        ...(args.depth === undefined ? {} : { depth: args.depth }),
      });
      return ok(tree.nodes.length ? treeLines(tree.nodes).join('\n') : '知识树当前为空。', { ...tree });
    } catch (error) {
      return fail(error);
    }
  },
});

export const getKnowledgeItemTool = defineTool({
  name: 'get_knowledge_item',
  title: '读取已保存资料',
  description: '按保存时返回的 id 读取完整原文、AI 摘要、学科路径和出处。Use to compare or quote a saved item.',
  shape: { itemId: z.string().trim().min(1).max(200).describe('save_knowledge 或搜索结果返回的条目 id') },
  run: async (runtime, args) => {
    try {
      const item = await runtime.api.item(args.itemId);
      return ok(itemLine(item), { item });
    } catch (error) {
      return fail(error);
    }
  },
});

export const relateKnowledgeTool = defineTool({
  name: 'relate_knowledge',
  title: '关联两条资料',
  description: '把两条资料标记为相互支持、相互矛盾或相关，方便横向比较。Use only when the user asks to connect saved items.',
  shape: {
    itemId: z.string().trim().min(1).max(200),
    targetId: z.string().trim().min(1).max(200),
    relation: itemRelationKindSchema,
  },
  run: async (runtime, args) => {
    try {
      const { relation } = await runtime.api.createItemRelation(args.itemId, {
        targetId: args.targetId,
        relation: args.relation,
      });
      return ok(`已建立关联：${relation.targetId}（${relation.relation}）`, { relation });
    } catch (error) {
      return fail(error);
    }
  },
});

export const removeKnowledgeRelationTool = defineTool({
  name: 'remove_knowledge_relation',
  title: '移除资料关联',
  description: '移除两条资料之间的关联。此操作不删除资料。Use when the user asks to unlink saved items.',
  shape: {
    itemId: z.string().trim().min(1).max(200),
    targetId: z.string().trim().min(1).max(200),
  },
  run: async (runtime, args) => {
    try {
      await runtime.api.deleteItemRelation(args.itemId, args.targetId);
      return ok('已移除两条资料之间的关联。', { ok: true });
    } catch (error) {
      return fail(error);
    }
  },
});

export const LIBRARY_TOOL_NAMES = [
  saveKnowledgeTool,
  searchKnowledgeTool,
  getKnowledgeTreeTool,
  getKnowledgeItemTool,
  relateKnowledgeTool,
  removeKnowledgeRelationTool,
].map((tool) => tool.name);

function toolConfig<S extends ZodRawShapeCompat>(tool: ToolSpec<S>) {
  return { title: tool.title, description: tool.description, inputSchema: tool.shape };
}

export function registerKnowledgeTools(server: McpServer, runtime: ToolRuntime): void {
  server.registerTool(saveKnowledgeTool.name, toolConfig(saveKnowledgeTool), (args) => saveKnowledgeTool.run(runtime, args));
  server.registerTool(searchKnowledgeTool.name, toolConfig(searchKnowledgeTool), (args) => searchKnowledgeTool.run(runtime, args));
  server.registerTool(getKnowledgeTreeTool.name, toolConfig(getKnowledgeTreeTool), (args) => getKnowledgeTreeTool.run(runtime, args));
  server.registerTool(getKnowledgeItemTool.name, toolConfig(getKnowledgeItemTool), (args) => getKnowledgeItemTool.run(runtime, args));
  server.registerTool(relateKnowledgeTool.name, toolConfig(relateKnowledgeTool), (args) => relateKnowledgeTool.run(runtime, args));
  server.registerTool(removeKnowledgeRelationTool.name, toolConfig(removeKnowledgeRelationTool), (args) =>
    removeKnowledgeRelationTool.run(runtime, args),
  );
}
