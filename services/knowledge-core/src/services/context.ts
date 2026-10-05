/**
 * Conversation Context Engine (V1_DEVELOPMENT §14.3).
 *
 * Context is always localised and always budgeted: the fill order is node → its items → parent chain →
 * children → related → source excerpts, and filling stops the moment `estimateTokens` would exceed the
 * budget. `whole_library` is kept for contract completeness but is deliberately NOT a database dump —
 * it carries root node titles plus the selected node's items, so scope switching never has to page the
 * whole library into a model.
 */
import {
  budgetForScope,
  type ContextScope,
  type KnowledgeItem,
  type KnowledgeNode,
  type NodeContext,
  type NodeContextRequest,
} from '@noltri/schema';
import { estimateTokens, knowledgeError, truncate } from '@noltri/shared';
import { capText, type ActorContext, type CoreDeps } from '../types';

type ContextSource = NodeContext['sources'][number];
type RelatedNode = NodeContext['relatedNodes'][number];

const SCOPE_LABEL: Record<ContextScope, string> = {
  current_node: '当前节点',
  section: '当前章节',
  tree: '当前知识树',
  whole_library: '整个知识库（仅结构总览）',
};

const RELATION_LABEL: Record<string, string> = {
  part_of: '从属于',
  similar_to: '类似于',
  derived_from: '派生自',
  prerequisite_of: '是…的前置',
  contrast_with: '与…对照',
  causes: '导致',
  implements: '实现',
  example_of: '…的示例',
  supports: '支持',
  contradicts: '与…冲突',
};

interface ItemEntry {
  item: KnowledgeItem;
  /**
   * §435: the text this caller is allowed to see — `item.normalizedText`, or the grant's 限制返回片段 cut
   * of it. Assembly uses this, so the markdown, the item list and `estimatedTokens` all describe the
   * same capped context instead of disagreeing with each other.
   */
  snippet: string;
  nodeTitle: string;
  isSelectedNode: boolean;
}

interface Assembled {
  node: KnowledgeNode;
  ancestors: KnowledgeNode[];
  children: KnowledgeNode[];
  relatedNodes: RelatedNode[];
  itemEntries: ItemEntry[];
  sources: ContextSource[];
  structureCaption: string;
}

function sourceLabel(node: { sourceType: string; sourceTitle: string | null; sourceApp: string | null; sourcePlatform: string | null }): string {
  const byType: Record<string, string> = { web: '网页', desktop_app: '桌面客户端', agent: 'Agent', manual: '手动录入' };
  const kind = byType[node.sourceType] ?? node.sourceType;
  const origin = node.sourceTitle ?? node.sourceApp ?? node.sourcePlatform ?? '未标注来源';
  return `来源：${kind} · ${origin}`;
}

export async function buildNodeContext(
  deps: CoreDeps,
  actor: ActorContext,
  request: Pick<NodeContextRequest, 'nodeId' | 'scope'> & { tokenBudget?: number },
): Promise<NodeContext> {
  const { repository } = deps;
  const node = await repository.findNode(request.nodeId, actor.userId);
  if (node === null) {
    throw knowledgeError('not_found', `节点 ${request.nodeId} 不存在 / node not found`);
  }

  const ancestors = await ancestorChain(deps, actor, node);
  const rootNodeId = ancestors.length > 0 ? ancestors[0].id : node.id;
  const assembled = await collectScope(deps, actor, node, ancestors, request.scope);
  const tokenBudget = request.tokenBudget ?? budgetForScope(request.scope, deps.config.scopeBudgets);

  const blocks: string[] = [];
  const items: KnowledgeItem[] = [];
  const sources: ContextSource[] = [];
  let truncated = false;

  /** Fill order is fixed: once a block would cross the budget, nothing further is added. */
  const push = (block: string, onInclude?: () => void): boolean => {
    if (truncated) return false;
    const candidate = blocks.length === 0 ? block : `${blocks.join('\n')}\n${block}`;
    if (blocks.length > 0 && estimateTokens(candidate) > tokenBudget) {
      truncated = true;
      return false;
    }
    blocks.push(block);
    onInclude?.();
    return true;
  };

  // 1. the node itself: never dropped, even when the node block alone already exceeds the budget.
  push(headerOf(request.scope, assembled, node, ancestors));

  // 2. the node's own items, individually, so a tight budget still carries the most valuable ones.
  for (const entry of assembled.itemEntries) {
    push(
      itemLine(entry, assembled.sourcesFor(entry.item)),
      () => {
        // The row keeps its identity and provenance; only the text fields carry the caller's cap.
        items.push({
          ...entry.item,
          normalizedText: entry.snippet,
          summary: entry.item.summary === null ? null : capText(actor, entry.item.summary),
        });
        const source = assembled.sourceByRawId.get(entry.item.rawSourceId);
        if (source !== undefined && !sources.some((row) => row.rawSourceId === source.rawSourceId)) sources.push(source);
      },
    );
  }

  // 3. parent chain, 4. structure, 5. related nodes.
  if (assembled.ancestors.length > 0) {
    push(sectionBlock('上级路径', assembled.ancestors.map((row) => `- ${row.title}`)));
  }
  if (assembled.children.length > 0) {
    push(sectionBlock(assembled.structureCaption, assembled.children.map((row) => `- ${row.title}`)));
  }
  if (assembled.relatedNodes.length > 0) {
    push(
      sectionBlock(
        '相关节点',
        assembled.relatedNodes.map((row) => {
          const relation = RELATION_LABEL[row.relationType] ?? row.relationType;
          return `- ${row.node.title}（${relation}${row.confidence === null ? '' : `，${row.confidence.toFixed(2)}`}）`;
        }),
      ),
    );
  }

  // 6. source excerpts, only for the items that actually made it into the context.
  for (const source of sources) {
    push(sourceBlock(source));
  }

  const markdown = `${blocks.join('\n')}\n`;
  return {
    scope: request.scope,
    rootNodeId,
    node: assembled.node,
    ancestors: assembled.ancestors,
    children: assembled.children,
    relatedNodes: assembled.relatedNodes,
    items,
    sources,
    tokenBudget,
    estimatedTokens: estimateTokens(markdown),
    truncated,
    markdown,
  };
}

function headerOf(scope: ContextScope, assembled: Assembled, node: KnowledgeNode, ancestors: KnowledgeNode[]): string {
  const path = [...ancestors.map((row) => row.title), node.title].join(' › ');
  const lines = [
    `# 知识节点上下文（作用域：${SCOPE_LABEL[scope]}）`,
    `节点：${node.title}`,
    `路径：${path}`,
  ];
  if (node.summary !== null && node.summary.length > 0) lines.push(`摘要：${truncate(node.summary, 400)}`);
  lines.push(
    `类型：${node.nodeType}｜状态：${node.status}｜置信度：${node.confidence === null ? '未标注' : node.confidence.toFixed(2)}`,
  );
  if (assembled.itemEntries.length > 0) lines.push(`知识点总数：${assembled.itemEntries.length}`);
  return lines.join('\n');
}

function itemLine(entry: ItemEntry, sourceText: string): string {
  const suffix = entry.isSelectedNode ? '' : `（属于：${entry.nodeTitle}）`;
  // `snippet` is what the caller may see; `normalizedText` stays the stored row for dedupe and provenance.
  return `- ${entry.snippet}${suffix}${sourceText.length > 0 ? ` ${sourceText}` : ''}`;
}

function sectionBlock(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join('\n');
}

function sourceBlock(source: ContextSource): string {
  const lines = ['## 来源摘录', `- ${source.label}`, `  摘录：${source.excerpt}`];
  if (source.url !== null) lines.push(`  链接：${source.url}`);
  lines.push(`  收纳时间：${source.capturedAt}`);
  return lines.join('\n');
}

async function ancestorChain(deps: CoreDeps, actor: ActorContext, node: KnowledgeNode): Promise<KnowledgeNode[]> {
  const chain: KnowledgeNode[] = [];
  let cursor = node.parentId;
  const guard = new Set<string>([node.id]);
  while (cursor !== null && cursor !== undefined) {
    if (guard.has(cursor)) break;
    guard.add(cursor);
    const parent = await deps.repository.findNode(cursor, actor.userId);
    if (parent === null) break;
    chain.unshift(parent);
    cursor = parent.parentId;
  }
  return chain;
}

async function collectScope(
  deps: CoreDeps,
  actor: ActorContext,
  node: KnowledgeNode,
  ancestors: KnowledgeNode[],
  scope: ContextScope,
): Promise<Assembled & { sourcesFor: (item: KnowledgeItem) => string; sourceByRawId: Map<string, ContextSource> }> {
  const { repository } = deps;
  const allNodes = await repository.listNodes(actor.userId);
  const byId = new Map(allNodes.map((row) => [row.id, row]));
  const childrenOf = (parentId: string): KnowledgeNode[] =>
    allNodes.filter((row) => row.parentId === parentId).sort((first, second) => first.title.localeCompare(second.title, 'zh-Hans-CN'));

  const directChildren = childrenOf(node.id);
  let children: KnowledgeNode[] = directChildren;
  let structureCaption = '下级节点';
  let itemEntries: ItemEntry[] = [];
  let relatedNodes: RelatedNode[] = [];

  const ownItems = await repository.listKnowledgeItemsForNode(node.id, actor.userId);
  itemEntries = ownItems.map((item) => ({
    item,
    snippet: capText(actor, item.normalizedText),
    nodeTitle: node.title,
    isSelectedNode: true,
  }));

  if (scope === 'section') {
    const grandchildren = directChildren.flatMap((child) => childrenOf(child.id));
    children = [...directChildren, ...grandchildren];
    structureCaption = '章节内节点';
    for (const child of directChildren) {
      const childItems = await repository.listKnowledgeItemsForNode(child.id, actor.userId);
      itemEntries = [
        ...itemEntries,
        ...childItems.map((item) => ({
          item,
          snippet: capText(actor, item.normalizedText),
          nodeTitle: child.title,
          isSelectedNode: false,
        })),
      ];
    }
  } else if (scope === 'tree') {
    const treeRoot = ancestors.length > 0 ? ancestors[0] : node;
    children = collectSubtree(treeRoot, childrenOf).filter((row) => row.id !== node.id);
    structureCaption = '本知识树节点总览';
  } else if (scope === 'whole_library') {
    // Structure only, on purpose: this scope must never turn into a full library export.
    children = allNodes.filter((row) => row.parentId === null);
    structureCaption = '知识库顶层领域';
  }

  if (scope === 'current_node' || scope === 'section') {
    relatedNodes = await relatedOf(deps, actor, node);
  }

  const sourceIds = [...new Set(itemEntries.map((entry) => entry.item.rawSourceId))];
  const rawSources = await repository.listRawSourcesByIds(sourceIds, actor.userId);
  const sourceByRawId = new Map<string, ContextSource>(
    rawSources.map((source) => [
      source.id,
      {
        rawSourceId: source.id,
        label: sourceLabel(source),
        excerpt: capText(actor, truncate(source.rawText, 220)),
        url: source.sourceUrl,
        capturedAt: source.capturedAt,
      },
    ]),
  );

  const sources = [...sourceByRawId.values()];
  return {
    node: byId.get(node.id) ?? node,
    ancestors,
    children,
    relatedNodes,
    itemEntries,
    sources,
    structureCaption,
    sourceByRawId,
    sourcesFor: (item: KnowledgeItem): string => {
      const source = sourceByRawId.get(item.rawSourceId);
      return source === undefined ? '' : `（${source.label} · ${source.capturedAt.slice(0, 10)}）`;
    },
  };
}

function collectSubtree(root: KnowledgeNode, childrenOf: (parentId: string) => KnowledgeNode[]): KnowledgeNode[] {
  const collected: KnowledgeNode[] = [root];
  const seen = new Set<string>([root.id]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of childrenOf(current.id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      collected.push(child);
      queue.push(child);
    }
  }
  return collected;
}

/** "High-related" is the configured edge bar, not a per-call literal. */
async function relatedOf(deps: CoreDeps, actor: ActorContext, node: KnowledgeNode): Promise<RelatedNode[]> {
  const edges = await deps.repository.listEdgesForNode(actor.userId, node.id);
  const related: RelatedNode[] = [];
  for (const edge of edges) {
    if (edge.confidence !== null && edge.confidence < deps.config.similarEdgeThreshold) continue;
    const otherId = edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId;
    if (otherId === node.id) continue;
    const other = await deps.repository.findNode(otherId, actor.userId);
    if (other === null || other.status === 'archived') continue;
    if (related.some((row) => row.node.id === other.id && row.relationType === edge.relationType)) continue;
    related.push({ node: other, relationType: edge.relationType, confidence: edge.confidence });
  }
  return related
    .sort((first, second) => (second.confidence ?? 0) - (first.confidence ?? 0))
    .slice(0, deps.config.relatedNodeCap);
}
