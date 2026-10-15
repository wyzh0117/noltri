/**
 * Step 7 of the pipeline: classification.
 *
 * Candidates are assembled locally (vector neighbours + the knowledge domains at the root) so the
 * model only ever sees a bounded, relevant slice of the library — never a database dump
 * (V1_DEVELOPMENT §14.3). The attach bar comes from configuration, never from a literal here.
 */
import type { ClassificationCandidate, ClassifyInput, ClassifyResult } from '@noltri/ai-provider';
import type { NodeVectorMatch } from '@noltri/storage';
import { knowledgeError } from '@noltri/shared';
import type { CoreDeps } from '../types';
import { callProvider } from './provider';

export interface CandidateNode {
  nodeId: string;
  title: string;
  path: string[];
  score: number;
}

export async function buildCandidates(
  deps: CoreDeps,
  userId: string,
  nodeMatches: NodeVectorMatch[],
): Promise<{ candidates: ClassificationCandidate[]; matched: CandidateNode[] }> {
  const byId = new Map<string, ClassificationCandidate>();
  const matched = new Map<string, CandidateNode>();

  for (const match of nodeMatches) {
    if (byId.has(match.nodeId)) continue;
    byId.set(match.nodeId, {
      id: match.nodeId,
      title: match.title,
      path: match.path.map((segment) => segment.title),
    });
    matched.set(match.nodeId, { nodeId: match.nodeId, title: match.title, path: byId.get(match.nodeId)!.path, score: match.score });
  }

  // Root domains are always offered: a new topic still belongs to an existing area when one fits.
  const roots = await deps.repository.listRootNodes(userId);
  for (const node of roots) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, { id: node.id, title: node.title, path: [node.title], summary: node.summary });
    matched.set(node.id, { nodeId: node.id, title: node.title, path: [node.title], score: 0 });
  }

  const candidates = [...byId.values()].slice(0, deps.config.thresholds.candidateNodeLimit);
  return { candidates, matched: [...matched.values()].slice(0, deps.config.thresholds.candidateNodeLimit) };
}

export interface ClassifyArgs {
  itemText: string;
  suggestedTitle: string;
  candidates: ClassificationCandidate[];
}

export async function classifyPoint(deps: CoreDeps, args: ClassifyArgs): Promise<ClassifyResult> {
  const input: ClassifyInput = {
    itemText: args.itemText,
    suggestedTitle: args.suggestedTitle,
    candidates: args.candidates,
    attachThreshold: deps.config.thresholds.similarityAttachThreshold,
  };
  return await callProvider('classifyKnowledge', deps, () => deps.provider.classifyKnowledge(input));
}

/** A provider that answers "attach" for a node that does not exist must not corrupt the tree. */
export function assertDecisionUsable(_deps: CoreDeps, decision: ClassifyResult): void {
  if (decision.action !== 'attach' && decision.action !== 'create') {
    throw knowledgeError('provider_error', `未知的分类动作 "${String(decision.action)}" / unknown classification action`);
  }
  if (decision.action === 'attach' && typeof decision.nodeId !== 'string') {
    throw knowledgeError('provider_error', '分类结果要求关联节点但没有给出 nodeId / attach without nodeId');
  }
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    throw knowledgeError('provider_error', '分类结果的置信度无效 / invalid classification confidence');
  }
  if (decision.action === 'create' && !(decision.newNodePath?.length || decision.newNodeTitle?.trim())) {
    throw knowledgeError('provider_error', '分类结果没有知识体系路径 / classification path missing');
  }
}
