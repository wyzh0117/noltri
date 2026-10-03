/**
 * Public surface of Knowledge Core (domain only).
 *
 * HTTP adapters live behind the `@noltri/knowledge-core/http` subpath so a browser or MCP bundle can
 * import the logic without ever pulling in a server.
 */
export { createKnowledgeCore, type KnowledgeCore, type KnowledgeCoreOptions } from './core';
export { loadCoreConfig, CORE_DEFAULTS, CORE_PACKAGE_NAME, type CoreConfig } from './config';
export {
  clamp01,
  roundConfidence,
  ERROR_REASON_MAX_CHARS,
  MAX_NODE_PATH_DEPTH,
  MAX_NODE_TITLE_CHARS,
  type ActorContext,
  type CoreDeps,
} from './types';
export { runCapture, retryCapture } from './pipeline/capture';
export { validateCaptureRequest, sourceLabelFor, errorReasonOf } from './pipeline/validate';
export { normalizePoints, type NormalizedPoint } from './pipeline/normalize';
export { findSimilarForPoint, type PointSimilarity } from './pipeline/similarity';
export { buildCandidates, classifyPoint, type CandidateNode } from './pipeline/classify';
export { persistPoint, resolveNodeChain, sanitizePath, type EmbedSeed, type ResolvedNode } from './pipeline/persist';
export { asProviderError, callProvider, isProviderFailure } from './pipeline/provider';
export { getTree, MAX_TREE_DEPTH } from './services/tree';
export { getNodeDetail, patchNode, type RelatedNodeView } from './services/node';
export { moveNode } from './services/move';
export { search } from './services/search';
export { buildNodeContext } from './services/context';
export { chat, listConversations, listMessages } from './services/conversation';
