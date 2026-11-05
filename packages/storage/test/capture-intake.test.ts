import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createInMemoryRepository } from '../src/in-memory';
import { SqliteRepository } from '../src/sqlite';
import type { CaptureProcessingPlanPoint, KnowledgeRepository } from '../src/types';

interface AssetInput {
  userId: string; sessionId: string; assetId: string; mimeType: string;
  sha256: string; bytes: Uint8Array;
}
interface StoredAsset extends AssetInput { byteLength: number; createdAt: string }
interface BatchItemInput {
  requestId: string; kind: 'text' | 'image' | 'composite'; userOrder: number;
  assetIds: string[]; text?: string;
  derivedAssets?: Array<{ assetId: string; operation: 'rotate' | 'stitch' | 'annotate'; sourceAssetIds: string[]; rotationDegrees?: 90 | 180 | 270; direction?: 'horizontal' | 'vertical'; annotations?: Array<{ type: 'rectangle' | 'arrow' | 'text' | 'pixelate'; x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: 2 | 4 | 6; text?: string; fontSize?: 18 | 24 | 32 }> }>;
  source: { type: 'web' | 'desktop_app' | 'agent' | 'manual' };
  capture: { capturedAt: string; client: 'desktop' | 'extension' | 'web_app' | 'mcp' };
}
interface BatchItem extends BatchItemInput {
  status: 'queued' | 'assets_saved' | 'processing' | 'needs_review' | 'done' | 'failed';
  duplicate: boolean; retryable: boolean; errorReason?: string; rawSourceId?: string; updatedAt: string;
}
interface BatchRecord { userId: string; batchId: string; sessionId: string; payloadHash: string; items: BatchItem[]; createdAt: string; updatedAt: string }
interface CaptureIntakeRepository {
  putCaptureAsset(input: AssetInput): Promise<{ asset: StoredAsset; duplicate: boolean }>;
  getCaptureAsset(userId: string, sessionId: string, assetId: string): Promise<StoredAsset | null>;
  createCaptureBatch(input: { userId: string; batchId: string; sessionId: string; payloadHash: string; items: BatchItemInput[] }): Promise<{ batch: BatchRecord; duplicate: boolean }>;
  listCaptureBatches(userId: string, limit: number): Promise<BatchRecord[]>;
  getCaptureBatch(userId: string, batchId: string): Promise<BatchRecord | null>;
  updateCaptureBatchItem(userId: string, batchId: string, requestId: string, patch: Partial<Pick<BatchItem, 'status' | 'duplicate' | 'retryable' | 'errorReason' | 'rawSourceId'>>): Promise<BatchRecord>;
  claimCaptureBatchItemForRetry(userId: string, batchId: string, requestId: string): Promise<BatchRecord>;
  recoverInterruptedCaptureBatches(): Promise<number>;
}
type StoreFactory = () => { repository: KnowledgeRepository; intake: CaptureIntakeRepository; close: () => Promise<void> };
const directories: string[] = [];
afterAll(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });

function inMemory(): ReturnType<StoreFactory> {
  const repository = createInMemoryRepository();
  return { repository, intake: repository as unknown as CaptureIntakeRepository, close: async () => {} };
}
function nextSqliteFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-capture-intake-'));
  directories.push(dir);
  return path.join(dir, 'profile.sqlite');
}
function sqlite(file = nextSqliteFile()): ReturnType<StoreFactory> {
  const repository = new SqliteRepository({ file });
  return { repository, intake: repository as unknown as CaptureIntakeRepository, close: () => repository.close() };
}
const fixtureBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const image = (userId: string, assetId = 'image-a'): AssetInput => ({
  userId, sessionId: 'session-1', assetId, mimeType: 'image/png',
  sha256: 'a'.repeat(64), bytes: fixtureBytes,
});
const textItem = (requestId: string, userOrder: number): BatchItemInput => ({
  requestId, kind: 'text', userOrder, assetIds: [], text: '这段原文用于验证持久化批次状态。',
  source: { type: 'desktop_app' },
  capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
});
const imageItem: BatchItemInput = {
  requestId: 'request-image', kind: 'image', userOrder: 0, assetIds: ['image-a'],
  source: { type: 'desktop_app' },
  capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
};
const batchInput = (items: BatchItemInput[] = [imageItem, textItem('request-text', 1)]) => ({
  userId: 'capture-intake-user', batchId: 'batch-1', sessionId: 'session-1',
  payloadHash: 'b'.repeat(64), items,
});

for (const [name, factory] of [['memory', inMemory], ['sqlite', sqlite]] as const) {
  describe(`${name} capture intake persistence`, () => {
    it('is idempotent per raw-source point while preserving edits and distinct sources', async () => {
      const { repository, close } = factory();
      const userId = 'capture-point-user';
      try {
        const sourceA = await repository.createRawSource({
          userId, rawText: '合成原文 A', sourceType: 'manual', capturedAt: '2026-10-29T12:00:00.000Z',
        });
        const sourceB = await repository.createRawSource({
          userId, rawText: '合成原文 B', sourceType: 'manual', capturedAt: '2026-10-29T12:00:00.000Z',
        });
        const point = {
          userId, rawSourceId: sourceA.id, normalizedText: '同一来源的提取知识点', summary: '模型摘要',
          confidence: 0.9, capturePointIndex: 0,
        };
        const first = await repository.createKnowledgeItem(point);
        const edited = await repository.updateKnowledgeItem(first.id, userId, {
          normalizedText: '用户修订后的知识点', summary: '人工摘要', status: 'archived',
        });
        const replay = await repository.createKnowledgeItem({ ...point, normalizedText: '重试返回的新候选文本' });
        expect(replay).toEqual(edited);

        const legacy = await repository.createKnowledgeItem({
          userId, rawSourceId: sourceA.id, normalizedText: '升级前已经持久化的提取点',
          summary: '升级前摘要', confidence: 0.8,
        });
        const legacyEdited = await repository.updateKnowledgeItem(legacy.id, userId, {
          summary: '用户修改后的摘要', status: 'archived',
        });
        const adoptedLegacy = await repository.createKnowledgeItem({
          userId, rawSourceId: sourceA.id, normalizedText: '升级前已经持久化的提取点',
          summary: '重试时新摘要', confidence: 0.9, capturePointIndex: 1,
        });
        expect(adoptedLegacy).toEqual(legacyEdited);

        const distinctSource = await repository.createKnowledgeItem({ ...point, rawSourceId: sourceB.id });
        expect(distinctSource.id).not.toBe(first.id);
        expect(distinctSource.normalizedText).toBe(point.normalizedText);
      } finally { await close(); }
    });
    it('freezes point decisions and placements while isolating an explicit new analysis version', async () => {
      const { repository, close } = factory();
      const userId = 'capture-plan-user';
      try {
        const source = await repository.createRawSource({
          userId, rawText: '用于冻结计划状态的合成原文', sourceType: 'manual', capturedAt: '2026-10-29T12:00:00.000Z',
        });
        const point = (text: string): CaptureProcessingPlanPoint => ({
          pointIndex: 0,
          point: { text, summary: null, confidence: 0.9, title: '冻结知识点' },
          embedding: [0.25, 0.75],
          embeddingModel: 'fixture-model',
          decision: null,
          placement: null,
          knowledgeItemId: null,
          status: 'pending',
        });
        let plan = await repository.createCaptureProcessingPlan(userId, source.id, [point('版本一冻结文本')]);
        const decision = {
          strategy: 'create' as const, nodeId: null, path: ['初始分类'], action: 'created' as const,
          linkConfidence: 0.88, nodeConfidence: 0.9, provenanceNodeId: null, relatedNodeId: null,
        };
        plan = await repository.updateCaptureProcessingPlanPoint(userId, source.id, 1, 0, {
          decision, status: 'decision_saved',
        });
        expect(plan.points[0]?.decision).toEqual(decision);
        await expect(repository.updateCaptureProcessingPlanPoint(userId, source.id, 1, 0, {
          decision: { ...decision, path: ['重试新分类'] },
        })).rejects.toMatchObject({ code: 'conflict' });

        const placement = {
          targetNodeId: 'node-one', action: 'created' as const, linkConfidence: 0.88,
          provenanceNodeId: null, relatedNodeId: null,
        };
        plan = await repository.updateCaptureProcessingPlanPoint(userId, source.id, 1, 0, {
          placement, status: 'placement_saved',
        });
        await expect(repository.updateCaptureProcessingPlanPoint(userId, source.id, 1, 0, {
          placement: { ...placement, targetNodeId: 'node-two' },
        })).rejects.toMatchObject({ code: 'conflict' });
        await expect(repository.updateCaptureProcessingPlanPoint(userId, source.id, 1, 0, {
          status: 'pending',
        })).rejects.toMatchObject({ code: 'conflict' });

        const firstItem = await repository.createKnowledgeItem({
          userId, rawSourceId: source.id, normalizedText: '版本一冻结文本', confidence: 0.9,
          capturePointIndex: 0, captureAnalysisVersion: 1,
        });
        const edited = await repository.updateKnowledgeItem(firstItem.id, userId, {
          normalizedText: '用户手动修订版本一', summary: '人工保留', status: 'archived',
        });
        const replay = await repository.createKnowledgeItem({
          userId, rawSourceId: source.id, normalizedText: '重试返回变化文本',
          confidence: 0.7, capturePointIndex: 0, captureAnalysisVersion: 1,
        });
        expect(replay).toEqual(edited);

        const second = await repository.createCaptureProcessingPlanVersion(userId, source.id, [point('明确的新分析文本')]);
        expect(second.analysisVersion).toBe(2);
        const secondItem = await repository.createKnowledgeItem({
          userId, rawSourceId: source.id, normalizedText: '明确的新分析文本',
          confidence: 0.8, capturePointIndex: 0, captureAnalysisVersion: second.analysisVersion,
        });
        expect(secondItem.id).not.toBe(firstItem.id);
        expect(await repository.listKnowledgeItemsForSource(source.id, userId)).toHaveLength(2);
        expect(await repository.getCaptureProcessingPlan(userId, source.id, 1)).toMatchObject({
          analysisVersion: 1,
          points: [{ point: { text: '版本一冻结文本' }, decision, placement }],
        });
      } finally { await close(); }
    });

    it('keeps asset replay idempotent while preserving distinct asset IDs for identical bytes', async () => {
      const { intake, close } = factory();
      try {
        const first = await intake.putCaptureAsset(image('u'));
        const replay = await intake.putCaptureAsset(image('u'));
        const alias = await intake.putCaptureAsset(image('u', 'image-b'));
        expect(first.duplicate).toBe(false);
        expect(replay.duplicate).toBe(true);
        expect(replay.asset.bytes).toEqual(fixtureBytes);
        expect(alias.duplicate).toBe(false);
        expect((await intake.getCaptureAsset('u', 'session-1', 'image-a'))?.assetId).toBe('image-a');
        expect((await intake.getCaptureAsset('u', 'session-1', 'image-b'))?.assetId).toBe('image-b');
        await expect(intake.putCaptureAsset({ ...image('u'), sha256: 'c'.repeat(64), bytes: new Uint8Array([1]) }))
          .rejects.toMatchObject({ code: 'conflict' });
      } finally { await close(); }
    });

    it('stores batch items in user order and replays by batch hash without clearing item state', async () => {
      const { intake, close } = factory();
      try {
        await intake.putCaptureAsset(image('capture-intake-user'));
        const input = batchInput([textItem('request-text', 2), imageItem]);
        const created = await intake.createCaptureBatch(input);
        expect(created.duplicate).toBe(false);
        expect(created.batch.items.map((item) => item.requestId)).toEqual(['request-image', 'request-text']);
        expect(created.batch.items.map((item) => item.status)).toEqual(['assets_saved', 'queued']);
        const changed = await intake.updateCaptureBatchItem('capture-intake-user', 'batch-1', 'request-text', {
          status: 'failed', retryable: true, errorReason: 'temporary', rawSourceId: 'raw-1',
        });
        expect(changed.items[1]).toMatchObject({ status: 'failed', retryable: true, errorReason: 'temporary', rawSourceId: 'raw-1' });
        const replay = await intake.createCaptureBatch(input);
        expect(replay.duplicate).toBe(true);
        expect(replay.batch.items[1]).toMatchObject({ status: 'failed', retryable: true, rawSourceId: 'raw-1' });
        const claimed = await intake.claimCaptureBatchItemForRetry('capture-intake-user', 'batch-1', 'request-text');
        expect(claimed.items[1]).toMatchObject({ status: 'processing', retryable: false });
        await expect(intake.claimCaptureBatchItemForRetry('capture-intake-user', 'batch-1', 'request-text'))
          .rejects.toMatchObject({ code: 'conflict' });
        const replayAfterClaim = await intake.createCaptureBatch(input);
        expect(replayAfterClaim.batch.items[1]).toMatchObject({ status: 'processing', retryable: false });
        await expect(intake.createCaptureBatch({ ...input, payloadHash: 'd'.repeat(64) }))
          .rejects.toMatchObject({ code: 'conflict' });
      } finally { await close(); }
    });

    it('lists only the owner’s recent batches in updated order with a stable tie-break', async () => {
      const { intake, close } = factory();
      try {
        const owner = 'capture-history-owner';
        for (const batchId of ['batch-a', 'batch-c', 'batch-b']) {
          await intake.createCaptureBatch({
            userId: owner,
            batchId,
            sessionId: `session-${batchId}`,
            payloadHash: batchId.padEnd(64, '0'),
            items: [textItem(`request-${batchId}`, 0)],
          });
        }
        await intake.createCaptureBatch({
          userId: 'another-user', batchId: 'batch-z', sessionId: 'session-z',
          payloadHash: 'z'.repeat(64), items: [textItem('request-z', 0)],
        });

        const stored = await Promise.all(['batch-a', 'batch-b', 'batch-c'].map((batchId) => intake.getCaptureBatch(owner, batchId)));
        const expected = stored
          .filter((batch): batch is BatchRecord => batch !== null)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.batchId.localeCompare(left.batchId))
          .map((batch) => batch.batchId);
        expect((await intake.listCaptureBatches(owner, 2)).map((batch) => batch.batchId)).toEqual(expected.slice(0, 2));
        expect((await intake.listCaptureBatches('another-user', 20)).map((batch) => batch.batchId)).toEqual(['batch-z']);
      } finally { await close(); }
    });
  });
}

describe('SQLite capture intake restart recovery', () => {
  it('preserves derived asset provenance when the batch is reopened', async () => {
    const file = nextSqliteFile();
    const first = sqlite(file);
    const input = batchInput([{
      ...imageItem,
      assetIds: ['image-a', 'derived-a'],
      derivedAssets: [{
        assetId: 'derived-a', operation: 'annotate', sourceAssetIds: ['image-a'], rotationDegrees: 90,
        annotations: [{ type: 'rectangle', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, color: '#d64a3b', strokeWidth: 4 }],
      }],
    }]);
    try {
      await first.intake.putCaptureAsset(image(input.userId, 'image-a'));
      await first.intake.putCaptureAsset(image(input.userId, 'derived-a'));
      await first.intake.createCaptureBatch(input);
      await first.close();

      const reopened = sqlite(file);
      try {
        const stored = await reopened.intake.getCaptureBatch(input.userId, input.batchId);
        expect(stored?.items[0]?.derivedAssets).toEqual(input.items[0]?.derivedAssets);
        expect(stored?.items[0]?.assetIds).toEqual(['image-a', 'derived-a']);
      } finally { await reopened.close(); }
    } finally {
      try { await first.close(); } catch {}
    }
  });

  it('persists asset bytes and batch progress, then makes interrupted items retryable after reopen', async () => {
    const file = nextSqliteFile();
    const first = sqlite(file);
    const input = batchInput([textItem('finished-failed', 0), textItem('interrupted', 1)]);
    try {
      await first.intake.putCaptureAsset(image(input.userId));
      await first.intake.createCaptureBatch(input);
      await first.intake.updateCaptureBatchItem(input.userId, input.batchId, 'finished-failed', {
        status: 'failed', retryable: true, errorReason: 'provider down', rawSourceId: 'raw-existing',
      });
      await first.intake.updateCaptureBatchItem(input.userId, input.batchId, 'interrupted', { status: 'processing' });
      await first.close();

      const reopened = sqlite(file);
      try {
        const asset = await reopened.intake.getCaptureAsset(input.userId, input.sessionId, 'image-a');
        expect(asset?.bytes).toEqual(fixtureBytes);
        const beforeRecovery = await reopened.intake.getCaptureBatch(input.userId, input.batchId);
        expect(beforeRecovery?.items[0]).toMatchObject({ status: 'failed', errorReason: 'provider down' });
        expect(beforeRecovery?.items[1].status).toBe('processing');
        expect(await reopened.intake.recoverInterruptedCaptureBatches()).toBe(1);
        const recovered = await reopened.intake.getCaptureBatch(input.userId, input.batchId);
        expect(recovered?.items[1]).toMatchObject({ status: 'failed', retryable: true });
        expect(recovered?.items[0]).toMatchObject({ status: 'failed', errorReason: 'provider down' });
      } finally { await reopened.close(); }
    } finally {
      // The first handle is already closed on the successful path; repeated close must not mask the assertion.
      try { await first.close(); } catch {}
    }
  });
});
