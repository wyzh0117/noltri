/**
 * Move Engine (V1_DEVELOPMENT §8 POST /api/nodes/:id/move).
 *
 * The repository owns the transaction: cycle detection plus its own VersionRecord. Core only maps
 * the result onto the frozen response shape, and a rejected move must surface as HTTP 409 so the UI
 * can undo nothing and lose nothing (PROJECT_MASTER §2.4).
 */
import type { MoveNodeRequest, MoveNodeResponse } from '@noltri/schema';
import { isKnowledgeError, knowledgeError } from '@noltri/shared';
import type { MoveNodeRecordResult, PathSegment } from '@noltri/storage';
import type { ActorContext, CoreDeps } from '../types';

export async function moveNode(
  deps: CoreDeps,
  actor: ActorContext,
  nodeId: string,
  request: MoveNodeRequest,
): Promise<MoveNodeResponse> {
  const node = await deps.repository.findNode(nodeId, actor.userId);
  if (node === null) {
    throw knowledgeError('not_found', `节点 ${nodeId} 不存在 / node not found`);
  }

  try {
    const result: MoveNodeRecordResult = await deps.repository.moveNode({
      userId: actor.userId,
      nodeId,
      targetParentId: request.targetParentId,
      actor: request.actor ?? actor.actor,
      ...(request.relationType === undefined ? {} : { relationType: request.relationType }),
    });

    const path: PathSegment[] = result.path;
    return { node: result.node, versionRecordId: result.versionRecordId, path, cycleDetected: false };
  } catch (error) {
    // A cycle (or moving a node into itself) is a conflict, never an internal error.
    if (isKnowledgeError(error) && error.code === 'conflict') {
      throw knowledgeError('conflict', error.message, { cycleDetected: true, nodeId });
    }
    throw error;
  }
}
