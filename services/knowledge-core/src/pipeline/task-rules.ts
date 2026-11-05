import { createHash } from 'node:crypto';
import { processingRulesSchema, processingRulesSnapshotSchema, type ProcessingRecord, type ProcessingRulesSnapshot, type RawSource } from '@noltri/schema';
import type { CaptureProcessingPlan } from '@noltri/storage';
import type { CoreDeps } from '../types';

export interface CaptureAnalysis {
  source: RawSource;
  plan: CaptureProcessingPlan;
  deps: CoreDeps;
  phase: ProcessingRecord['phase'];
  cancelled?: boolean;
  acceptedReviewRevision?: number;
}

function appliedRules(deps: CoreDeps): ProcessingRulesSnapshot {
  if (deps.processingRules !== undefined) return deps.processingRules.getAppliedSnapshot();
  // Compatibility for direct unit callers; production always supplies its durable rule store.
  const rules = processingRulesSchema.parse({ thresholds: structuredClone(deps.config.thresholds), extractionInstructions: '', classificationInstructions: '' });
  const contentHash = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  return processingRulesSnapshotSchema.parse({ versionId: `rules-1-${contentHash.slice(0, 12)}`, contentHash, createdAt: new Date().toISOString(), rules });
}

export function taskDeps(deps: CoreDeps, plan: CaptureProcessingPlan | null): CoreDeps {
  return plan?.rulesSnapshot === null || plan === null ? deps : { ...deps, config: { ...deps.config, thresholds: { ...plan.rulesSnapshot.rules.thresholds } } };
}

/** The database reserves identity and source ownership before any provider call, including OCR. */
export async function beginCaptureAnalysis(deps: CoreDeps, source: RawSource, newVersion = false): Promise<CaptureAnalysis> {
  const prior = await deps.repository.getCaptureProcessingPlan(source.userId, source.id);
  const rulesSnapshot = !newVersion && prior?.rulesSnapshot ? prior.rulesSnapshot : appliedRules(deps);
  const plan = await deps.repository.reserveCaptureProcessingPlan({ userId: source.userId, rawSourceId: source.id, expectedReviewRevision: source.reviewRevision, rulesSnapshot,
    ...(newVersion ? { newVersion: true, expectedAnalysisVersion: prior?.analysisVersion ?? 0 } : {}) });
  const analysis: CaptureAnalysis = { source, plan, deps: taskDeps(deps, plan), phase: 'queued' };
  await recordCaptureAnalysis(analysis, 'queued', 'pending');
  return analysis;
}

/** Records are a bounded metadata projection, never task authority or a reason to repeat provider work. */
export async function recordCaptureAnalysis(analysis: CaptureAnalysis, phase: ProcessingRecord['phase'], status: ProcessingRecord['status'], errorCode?: ProcessingRecord['errorCode']): Promise<void> {
  analysis.phase = phase;
  const store = analysis.deps.processingRules;
  const snapshot = analysis.plan.rulesSnapshot;
  if (store === undefined || snapshot === null) return;
  const taskId = `${analysis.source.id}:${analysis.plan.analysisVersion}`;
  try {
    await store.appendRecord({ recordId: taskId, taskId, ruleVersionId: snapshot.versionId, createdAt: analysis.plan.createdAt, updatedAt: new Date().toISOString(), phase, status, ...(errorCode ? { errorCode } : {}) });
  } catch { analysis.deps.logger.warn('processing metadata record unavailable', { code: 'processing_record_failed' }); }
}
