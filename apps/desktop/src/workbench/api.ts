/**
 * The workbench speaks to Knowledge Core through the same typed client the extension uses. This is the
 * replacement for the web app's Next.js layer: no server action, no cookie, no SSR session — the base
 * URL and the bearer token come from the Rust settings store, and `clientHint: 'desktop'` is what ends
 * up on every version record.
 */
import { ApiClient } from '@noltri/api-client';

/**
 * Derived from `ApiClient` rather than restated: if a method is renamed upstream this fails to compile
 * instead of quietly keeping a stale mirror of the surface the workbench depends on.
 */
export type WorkbenchApi = Pick<
  ApiClient,
  | 'health'
  | 'tree'
  | 'nodeDetail'
  | 'patchNode'
  | 'moveNode'
  | 'capture'
  | 'search'
  | 'nodeContext'
  | 'chat'
  | 'inbox'
  | 'rawSource'
  | 'assignSource'
  | 'retryCapture'
  | 'conversations'
  | 'conversationMessages'
  | 'researchProjects'
  | 'createResearchProject'
  | 'researchCharter'
  | 'saveResearchCharter'
  | 'approveResearchCharter'
  | 'researchCharterVersions'
  | 'researchCharterBaseline'
  | 'researchReviewMarks'
  | 'clearResearchReviewMark'
  | 'researchReferences'
  | 'researchQuestions'
  | 'researchEvidence'
  | 'researchClaims'
  | 'researchSections'
  | 'researchRelations'
  | 'createResearchRelation'
  | 'deleteResearchRelation'
  | 'researchDecisions'
  | 'researchChanges'
  | 'researchTimeline'
  | 'researchDriftCheck'
  | 'researchDriftFindings'
  | 'patchResearchDriftFinding'
  | 'researchMap'
  | 'researchContextPack'
>;

export interface WorkbenchEndpoint {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
}

export function createWorkbenchApi(endpoint: WorkbenchEndpoint): WorkbenchApi {
  return new ApiClient({
    baseUrl: endpoint.apiBaseUrl,
    ...(endpoint.apiToken.trim() === '' ? {} : { token: endpoint.apiToken.trim() }),
    clientHint: 'desktop',
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '发生未知错误。';
}

/** True when Core runs the offline AI driver: 收件箱 manual triage is then the only path into the tree. */
export function aiIsOffline(health: { aiProvider: string } | null): boolean {
  return health?.aiProvider === 'offline';
}
