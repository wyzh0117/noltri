import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@noltri/schema';
import { captureOf, makeHarness, testConfig, type Harness } from './fakes';
import { createRequestHandler } from '../src/http/router';
import { buildHandler } from '../src/http';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function handlerOf(harness: Harness) {
  return createRequestHandler({ core: harness.core, config: harness.config });
}
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
function requestHeaders(sessionId: string, hash: string): Record<string, string> {
  return { 'content-type': 'image/png', 'x-noltri-session-id': sessionId, 'x-noltri-content-sha256': hash };
}
function batchRequest(batchId = 'batch-1') {
  return {
    batchId,
    sessionId: 'session-1',
    items: [
      {
        requestId: 'request-image', kind: 'image', userOrder: 0, assetIds: ['asset-one'],
        source: { type: 'desktop_app' }, capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'device-one' },
      },
      {
        requestId: 'request-fail-once', kind: 'text', userOrder: 1, assetIds: [],
        text: '这条内容用于触发一次性失败后再次重试。', source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'device-one' },
      },
      {
        requestId: 'request-good', kind: 'text', userOrder: 2, assetIds: [],
        text: '另一条独立收集应该成功并保留原始顺序。', source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'device-one' },
      },
    ],
  };
}

describe('capture assets and batches HTTP contract', () => {
  it('reuses partially persisted points after restart and preserves user edits and archive state', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-partial-point-retry-'));
    const sqliteFile = path.join(dir, 'profile.sqlite');
    const pointA = '持久化点 A 描述本地知识记录中的第一项独立事实。';
    const pointB = '持久化点 B 描述本地知识记录中的第二项独立事实。';
    const pointC = '持久化点 C 描述首次计划中稍后处理的第三项事实。';
    let extractionAttempt = 0;
    const pointScript = () => {
      extractionAttempt += 1;
      const items = extractionAttempt === 1
        ? [
            { text: pointA, summary: '原始摘要 A', confidence: 0.9, suggestedTitle: '事实 A' },
            { text: pointB, summary: '原始摘要 B', confidence: 0.9, suggestedTitle: '事实 B' },
            { text: pointC, summary: '原始摘要 C', confidence: 0.9, suggestedTitle: '事实 C' },
          ]
        : [
            { text: pointC, summary: '重试改变后的 C', confidence: 0.7, suggestedTitle: '新标题 C' },
            { text: pointB, summary: '重试改变后的 B', confidence: 0.7, suggestedTitle: '新标题 B' },
            { text: '重试新增 D 且遗漏 A，不应改变首次冻结计划。', confidence: 0.8, suggestedTitle: '候选 D' },
          ];
      return { items };
    };
    const body = {
      batchId: 'partial-point-batch', sessionId: 'session-1',
      items: [{
        requestId: 'partial-point-request', kind: 'text', userOrder: 0, assetIds: [],
        text: '这段合成原文用于验证三个知识点在部分写入后的恢复。',
        source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'partial-point-device' },
      }],
    };
    const firstStore = new SqliteRepository({ file: sqliteFile });
    let firstStoreOpen = true;
    const first = makeHarness({ repository: firstStore, script: {
      classify: (input) => ({
        action: 'create', newNodePath: [input.itemText === pointA ? '初次分类 A' : '初次分类 B'],
        confidence: 0.93, reason: '固定初始放置用于重试回归',
      }),
    } });
    first.provider.extractKnowledge = async () => pointScript();
    const linkItem = first.repository.linkItemToNode.bind(first.repository);
    let failPointBLink = true;
    first.repository.linkItemToNode = async (input) => {
      const item = await first.repository.findKnowledgeItem(input.itemId, first.actor.userId);
      if (failPointBLink && item?.normalizedText === pointB) {
        failPointBLink = false;
        throw new Error('scripted persistence interruption after item insert');
      }
      return linkItem(input);
    };

    try {
      const submitted = await handlerOf(first)(new Request('http://core.local/api/capture/batches', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(submitted.status).toBe(200);
      const failed = await jsonOf(submitted) as { batch: { items: Array<{ status: string; rawSourceId?: string }> } };
      expect(failed.batch.items[0]?.status).toBe('failed');
      const rawSourceId = failed.batch.items[0]?.rawSourceId;
      expect(rawSourceId).toBeTruthy();
      const beforeRestart = await first.repository.listKnowledgeItemsForSource(rawSourceId!, first.actor.userId);
      expect(beforeRestart.map((item) => item.normalizedText)).toEqual([pointA, pointB]);
      expect(await first.repository.listLinksForItem(beforeRestart[1]!.id, first.actor.userId)).toEqual([]);
      expect(first.provider.classifyInputs).toHaveLength(2);
      const initialNodeA = await first.repository.findNodeByTitle(first.actor.userId, '初次分类 A', null);
      const initialNodeB = await first.repository.findNodeByTitle(first.actor.userId, '初次分类 B', null);
      expect(initialNodeA).not.toBeNull();
      expect(initialNodeB).not.toBeNull();

      await first.repository.updateKnowledgeItem(beforeRestart[0]!.id, first.actor.userId, {
        normalizedText: '用户手动修订后的 A', summary: '保留的人工摘要', status: 'archived',
      });
      await firstStore.close();
      firstStoreOpen = false;

      const secondStore = new SqliteRepository({ file: sqliteFile });
      const second = makeHarness({ repository: secondStore, script: {
        extract: () => ({ items: pointScript().items }),
        classify: (input) => ({
          action: 'create',
          newNodePath: input.itemText === pointC ? ['首次快照中的 C 分类'] : ['错误的重试分类', input.itemText],
          confidence: 0.99,
          reason: '不得改写已有冻结决策',
        }),
      } });
      try {
        const retry = await handlerOf(second)(new Request(
          'http://core.local/api/capture/batches/partial-point-batch/items/partial-point-request/retry',
          { method: 'POST' },
        ));
        expect(retry.status).toBe(200);
        const retried = await jsonOf(retry) as { items: Array<{ status: string; rawSourceId?: string }> };
        expect(retried.items[0]?.status).not.toBe('failed');
        expect(retried.items[0]?.rawSourceId).toBe(rawSourceId);

        const afterRestart = await second.repository.listKnowledgeItemsForSource(rawSourceId!, second.actor.userId);
        expect(afterRestart).toHaveLength(3);
        expect(afterRestart.map((item) => item.normalizedText).sort()).toEqual([
          '用户手动修订后的 A', pointB, pointC,
        ].sort());
        expect(afterRestart.map((item) => item.id)).toEqual(expect.arrayContaining(beforeRestart.map((item) => item.id)));
        const itemA = afterRestart.find((item) => item.normalizedText === '用户手动修订后的 A')!;
        const itemB = afterRestart.find((item) => item.id === beforeRestart.find((item) => item.normalizedText === pointB)!.id)!;
        expect(itemA).toMatchObject({ summary: '保留的人工摘要', status: 'archived' });
        expect(await second.repository.listKnowledgeItemsForSource(rawSourceId!, second.actor.userId))
          .not.toContainEqual(expect.objectContaining({ normalizedText: '重试新增 D 且遗漏 A，不应改变首次冻结计划。' }));
        expect(extractionAttempt).toBe(1);
        expect(second.provider.extractInputs).toHaveLength(0);
        expect(second.provider.classifyInputs).toHaveLength(1);
        expect(second.provider.classifyInputs[0]?.itemText).toBe(pointC);
        const linksA = await second.repository.listLinksForItem(itemA.id, second.actor.userId);
        const linksB = await second.repository.listLinksForItem(itemB.id, second.actor.userId);
        expect(linksA.map((link) => link.nodeId)).toEqual([initialNodeA!.id]);
        expect(linksB.map((link) => link.nodeId)).toEqual([initialNodeB!.id]);
        expect(await second.repository.findNodeByTitle(second.actor.userId, '错误的重试分类', null)).toBeNull();
        expect(await second.repository.findNodeByTitle(second.actor.userId, '首次快照中的 C 分类', null)).not.toBeNull();
      } finally {
        await secondStore.close();
      }
    } finally {
      if (firstStoreOpen) await firstStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freezes an empty extraction result before completing the source', async () => {
    const harness = makeHarness();
    let extractionCalls = 0;
    harness.provider.extractKnowledge = async () => {
      extractionCalls += 1;
      return { items: [] };
    };
    const finish = harness.repository.finishCaptureProcessing.bind(harness.repository);
    let failCompletionOnce = true;
    harness.repository.finishCaptureProcessing = async (input) => {
      if (input.status === 'done' && failCompletionOnce) {
        failCompletionOnce = false;
        throw new Error('scripted interruption after empty plan persistence');
      }
      return finish(input);
    };

    const request = captureOf('合成空抽取结果应冻结，避免重试重新分析。', 'desktop', {}, 'empty-plan-request');
    await expect(harness.core.capture(request, harness.actor)).rejects.toThrow('scripted interruption');
    const source = await harness.repository.findRawSourceByIdempotencyKey(harness.actor.userId, 'desktop', 'empty-plan-request');
    expect(source).not.toBeNull();
    const retried = await harness.core.retryCapture(source!.id, harness.actor);
    expect(retried.processingStatus).toBe('done');
    expect(retried.items).toEqual([]);
    expect(extractionCalls).toBe(1);
    expect(await harness.repository.listKnowledgeItemsForSource(source!.id, harness.actor.userId)).toEqual([]);
  });

  it('creates a separate snapshot and point identity for explicit reanalysis', async () => {
    const harness = makeHarness();
    let extractionCalls = 0;
    harness.provider.extractKnowledge = async () => {
      extractionCalls += 1;
      return { items: [{ text: '显式重新分析生成的合成候选。', confidence: 0.85, suggestedTitle: '新分析候选' }] };
    };
    const original = await harness.core.capture(
      captureOf('显式重分析测试的合成原文。', 'desktop', {}, 'reanalyze-request'),
      harness.actor,
    );
    const originalPlan = await harness.repository.getCaptureProcessingPlan(harness.actor.userId, original.rawSourceId);
    expect(originalPlan?.analysisVersion).toBe(1);
    const oldItem = (await harness.repository.listKnowledgeItemsForSource(original.rawSourceId, harness.actor.userId))[0]!;

    const reanalyzed = await harness.core.reanalyzeCapture(original.rawSourceId, harness.actor);
    const newPlan = await harness.repository.getCaptureProcessingPlan(harness.actor.userId, original.rawSourceId);
    const items = await harness.repository.listKnowledgeItemsForSource(original.rawSourceId, harness.actor.userId);
    expect(reanalyzed.processingStatus).toBe('done');
    expect(newPlan?.analysisVersion).toBe(2);
    expect(extractionCalls).toBe(2);
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === oldItem.id)).toEqual(oldItem);
    expect(items.find((item) => item.id !== oldItem.id)?.normalizedText).toBe('显式重新分析生成的合成候选。');
  });

  it('holds a legacy partial source for review when it has no frozen plan', async () => {
    const harness = makeHarness();
    const source = await harness.repository.createRawSource({
      userId: harness.actor.userId, rawText: '旧版失败采集的合成原文。', sourceType: 'desktop_app',
      capturedAt: '2026-10-29T12:00:00.000Z', requestId: 'legacy-partial-request', clientId: 'desktop',
    });
    await harness.repository.updateRawSourceProcessing(source.id, harness.actor.userId, 'failed', '旧版处理中断');
    const node = await harness.repository.createNode({
      userId: harness.actor.userId, title: '旧版已有分类', parentId: null, nodeType: 'topic', confidence: 0.8,
    });
    const existing = await harness.repository.createKnowledgeItem({
      userId: harness.actor.userId, rawSourceId: source.id, normalizedText: '旧版已写入的点位。',
      summary: '用户摘要', confidence: 0.8, capturePointIndex: 0,
    });
    await harness.repository.linkItemToNode({
      userId: harness.actor.userId, itemId: existing.id, nodeId: node.id, relationType: 'primary', confidence: 0.8,
    });
    let extractionCalls = 0;
    harness.provider.extractKnowledge = async () => {
      extractionCalls += 1;
      return { items: [{ text: '不能安全映射的新候选。', confidence: 0.9 }] };
    };

    const result = await harness.core.retryCapture(source.id, harness.actor);
    expect(result).toMatchObject({ processingStatus: 'pending', stage: 'saved' });
    expect(result.errorReason).toContain('冻结');
    expect(extractionCalls).toBe(0);
    expect(await harness.repository.listKnowledgeItemsForSource(source.id, harness.actor.userId)).toEqual([existing]);
    expect(await harness.repository.listLinksForItem(existing.id, harness.actor.userId)).toMatchObject([
      { nodeId: node.id, relationType: 'primary' },
    ]);
    expect(await harness.repository.findRawSource(source.id, harness.actor.userId)).toMatchObject({ processingStatus: 'pending' });
  });

  it('keeps offline saved items in needs-review state across service restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-offline-capture-restart-'));
    const sqliteFile = path.join(dir, 'profile.sqlite');
    const base = testConfig();
    const config = {
      ...base,
      ai: { ...base.ai, driver: 'offline' as const },
      storage: { driver: 'sqlite' as const, sqliteFile },
      sqliteFile,
      dataDir: dir,
      vaultDir: path.join(dir, 'vault'),
    };
    const body = {
      batchId: 'offline-pending-batch', sessionId: 'session-1',
      items: [{
        requestId: 'offline-pending-request', kind: 'text', userOrder: 0, assetIds: [],
        text: '离线模式会保留原文等待人工整理，这不是处理中断。',
        source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
      }],
    };
    const first = await buildHandler(config, { vaultRootPath: path.join(dir, 'vault'), vaultDataDir: dir });
    try {
      expect(first.provider.id).toBe('offline');
      const submitted = await first.handle(new Request('http://core.local/api/capture/batches', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(submitted.status).toBe(200);
      const firstStatus = await jsonOf(submitted) as { batch: { items: Array<Record<string, unknown>> } };
      expect(firstStatus.batch.items[0]).toMatchObject({ status: 'needs_review', retryable: false });
      await first.close();

      const second = await buildHandler(config, { vaultRootPath: path.join(dir, 'vault'), vaultDataDir: dir });
      try {
        const status = await second.handle(new Request('http://core.local/api/capture/batches/offline-pending-batch'));
        expect(status.status).toBe(200);
        const recovered = await jsonOf(status) as { items: Array<Record<string, unknown>> };
        expect(recovered.items[0]).toMatchObject({ status: 'needs_review', retryable: false });
        expect(recovered.items[0]?.errorReason).toBeUndefined();
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('normalizes asset/session IDs before persistence and returns IDs usable by a batch', async () => {
    const harness = makeHarness();
    const handle = handlerOf(harness);
    const upload = await handle(new Request('http://core.local/api/capture/assets/%20asset-one', {
      method: 'PUT', headers: requestHeaders(' session-1 ', sha256(pngBytes)), body: pngBytes,
    }));
    expect(upload.status).toBe(200);
    const uploaded = await jsonOf(upload) as { asset: { assetId: string; sessionId: string } };
    expect(uploaded.asset).toMatchObject({ assetId: 'asset-one', sessionId: 'session-1' });
    expect(await harness.repository.getCaptureAsset(harness.actor.userId, uploaded.asset.sessionId, uploaded.asset.assetId))
      .toMatchObject({ assetId: 'asset-one', sessionId: 'session-1' });

    const batch = await handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId: 'normalized-asset-batch', sessionId: uploaded.asset.sessionId,
        items: [{
          requestId: 'normalized-asset-request', kind: 'image', userOrder: 0, assetIds: [uploaded.asset.assetId],
          source: { type: 'desktop_app' },
          capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'device-one' },
        }],
      }),
    }));
    expect(batch.status).toBe(200);
    expect(await jsonOf(batch)).toMatchObject({ batch: { items: [{ status: 'assets_saved', assetIds: ['asset-one'] }] } });
  });

  it('rejects invalid asset and session IDs before persisting any asset', async () => {
    const cases = [
      { pathId: '%20%2Fasset-one', sessionId: 'session-1' },
      { pathId: 'asset-two', sessionId: 'session/invalid' },
    ];
    for (const testCase of cases) {
      const harness = makeHarness();
      const response = await handlerOf(harness)(new Request(`http://core.local/api/capture/assets/${testCase.pathId}`, {
        method: 'PUT', headers: requestHeaders(testCase.sessionId, sha256(pngBytes)), body: pngBytes,
      }));
      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await jsonOf(response)).error.code).toBe('invalid_request');
      expect(harness.timeline.filter((entry) => entry.call === 'putCaptureAsset')).toHaveLength(0);
    }
  });
  it('validates binary MIME/hash headers, stores original bytes idempotently, and does not dedupe different asset IDs', async () => {
    const harness = makeHarness();
    const handle = handlerOf(harness);
    const hash = sha256(pngBytes);
    const put = (assetId: string, bytes = pngBytes, contentType = 'image/png', suppliedHash = sha256(bytes)) =>
      handle(new Request(`http://core.local/api/capture/assets/${assetId}`, {
        method: 'PUT', headers: { ...requestHeaders('session-1', suppliedHash), 'content-type': contentType }, body: bytes,
      })).then(async (response) => ({ response, body: await jsonOf(response) }));

    const first = await put('asset-one');
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false, asset: { assetId: 'asset-one', sessionId: 'session-1', mimeType: 'image/png', sha256: hash, byteLength: pngBytes.byteLength } });
    expect(JSON.stringify(first.body)).not.toContain('137,80,78,71');

    const replay = await put('asset-one');
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ duplicate: true, asset: { assetId: 'asset-one', sha256: hash } });

    const alias = await put('asset-two');
    expect(alias.body).toMatchObject({ duplicate: false, asset: { assetId: 'asset-two', sha256: hash } });

    const wrongHash = await put('asset-one', new Uint8Array([1, 2, 3]), 'image/png', 'f'.repeat(64));
    expect(wrongHash.response.status).toBe(400);
    expect(apiErrorSchema.parse(wrongHash.body).error.code).toBe('invalid_request');

    const wrongMime = await put('asset-bad-mime', pngBytes, 'image/jpeg');
    expect(wrongMime.response.status).toBe(400);
    expect(apiErrorSchema.parse(wrongMime.body).error.code).toBe('invalid_request');
  });

  it('stores derivative provenance in batch status and binds it into replay identity', async () => {
    const harness = makeHarness();
    const handle = handlerOf(harness);
    const assetIds = ['original-one', 'original-two', 'rotated-one', 'stitched-one-two', 'annotated-one'];
    for (const assetId of assetIds) {
      const response = await handle(new Request(`http://core.local/api/capture/assets/${assetId}`, {
        method: 'PUT', headers: requestHeaders('derived-session', sha256(pngBytes)), body: pngBytes,
      }));
      expect(response.status).toBe(200);
    }
    const payload = {
      batchId: 'derived-batch', sessionId: 'derived-session',
      items: [
        {
          requestId: 'image-one', kind: 'image', userOrder: 0,
          assetIds: ['original-one', 'rotated-one', 'stitched-one-two', 'annotated-one'],
          derivedAssets: [
            { assetId: 'rotated-one', operation: 'rotate', sourceAssetIds: ['original-one'], rotationDegrees: 90 },
            { assetId: 'stitched-one-two', operation: 'stitch', sourceAssetIds: ['original-one', 'original-two'], direction: 'horizontal' },
            { assetId: 'annotated-one', operation: 'annotate', sourceAssetIds: ['original-one'], rotationDegrees: 90, annotations: [{ type: 'rectangle', x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.8, color: '#d64a3b', strokeWidth: 4 }] },
          ],
          source: { type: 'desktop_app' },
          capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
        },
        {
          requestId: 'image-two', kind: 'image', userOrder: 1, assetIds: ['original-two'],
          source: { type: 'desktop_app' },
          capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
        },
        {
          requestId: 'text-capture-0001', kind: 'text', userOrder: 2, assetIds: [],
          text: '这是一次合成文本提交，用于确认带派生图的批次 replay 不会重复写入知识。',
          source: { type: 'desktop_app' },
          capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' },
        },
      ],
    };
    const submit = () => handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));

    const first = await submit();
    expect(first.status).toBe(200);
    const firstBody = await jsonOf(first) as { duplicate: boolean; batch: { items: Array<Record<string, unknown>> } };
    expect(firstBody.batch.items[0]?.derivedAssets).toEqual(payload.items[0].derivedAssets);
    expect(firstBody.batch.items[0]?.assetIds).toEqual(payload.items[0].assetIds);
    const refreshed = await handle(new Request('http://core.local/api/capture/batches/derived-batch'));
    expect(refreshed.status).toBe(200);
    const refreshedBody = await jsonOf(refreshed) as { items: Array<Record<string, unknown>> };
    expect(refreshedBody.items[0]?.derivedAssets).toEqual(payload.items[0].derivedAssets);
    expect(harness.provider.extractInputs).toHaveLength(1);
    const replay = await submit();
    expect(await jsonOf(replay)).toMatchObject({ duplicate: true });
    expect(harness.provider.extractInputs).toHaveLength(1);

    payload.items[0].derivedAssets![1]!.direction = 'vertical';
    const changed = await submit();
    expect(changed.status).toBe(409);
    expect(apiErrorSchema.parse(await jsonOf(changed)).error.code).toBe('conflict');
  });

  it('persists all batch items before AI, isolates partial failure, retries one item, and replays without rerunning successes', async () => {
    const harness = makeHarness();
    const originalExtract = harness.provider.extractKnowledge.bind(harness.provider);
    let failOnce = true;
    let failedAttempts = 0;
    let goodAttempts = 0;
    harness.provider.extractKnowledge = async (input) => {
      const serialized = JSON.stringify(input);
      if (serialized.includes('一次性失败')) {
        failedAttempts += 1;
        if (failOnce) { failOnce = false; throw new Error('temporary scripted provider failure'); }
      }
      if (serialized.includes('独立收集')) goodAttempts += 1;
      return originalExtract(input);
    };
    const handle = handlerOf(harness);
    const imageResponse = await handle(new Request('http://core.local/api/capture/assets/asset-one', {
      method: 'PUT',
      headers: requestHeaders('session-1', sha256(pngBytes)),
      body: pngBytes,
    }));
    expect(imageResponse.status).toBe(200);

    const payload = batchRequest();
    const response = await handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(200);
    const submitted = await jsonOf(response) as { duplicate: boolean; batch: { items: Array<Record<string, unknown>> } };
    expect(submitted.duplicate).toBe(false);
    expect(submitted.batch.items.map((item) => item.requestId)).toEqual(['request-image', 'request-fail-once', 'request-good']);
    expect(submitted.batch.items.map((item) => item.status)).toEqual(['assets_saved', 'failed', 'needs_review']);
    expect(submitted.batch.items[1]).toMatchObject({ retryable: true, duplicate: false });
    expect(submitted.batch.items[2]).toMatchObject({ retryable: false });
    expect(harness.timeline.findIndex((entry) => entry.call === 'createCaptureBatch'))
      .toBeLessThan(harness.timeline.findIndex((entry) => entry.kind === 'ai'));

    const goodBefore = submitted.batch.items[2]?.rawSourceId;
    const retry = await handle(new Request('http://core.local/api/capture/batches/batch-1/items/request-fail-once/retry', { method: 'POST' }));
    expect(retry.status).toBe(200);
    const retried = await jsonOf(retry) as { items: Array<Record<string, unknown>> };
    expect(retried.items[1]).toMatchObject({ status: 'needs_review', retryable: false });
    expect(retried.items[2]?.rawSourceId).toBe(goodBefore);
    expect(failedAttempts).toBe(2);
    expect(goodAttempts).toBe(1);
    const duplicateRetry = await handle(new Request('http://core.local/api/capture/batches/batch-1/items/request-fail-once/retry', { method: 'POST' }));
    expect(duplicateRetry.status).toBe(409);

    const replay = await handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    expect(replay.status).toBe(200);
    expect(await jsonOf(replay)).toMatchObject({ duplicate: true });
    expect(failedAttempts).toBe(2);
    expect(goodAttempts).toBe(1);

    const conflictPayload = batchRequest();
    conflictPayload.items[1]!.text = '更换原文不能覆写同一批次。';
    const conflict = await handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(conflictPayload),
    }));
    expect(conflict.status).toBe(409);
    expect(apiErrorSchema.parse(await conflict.json()).error.code).toBe('conflict');
  });

  it('keeps distinct collection request IDs as distinct raw sources even when text bytes match', async () => {
    const harness = makeHarness();
    const handle = handlerOf(harness);
    const sameText = '相同的原文可以由用户有意收集两次并保留为独立来源。';
    const body = {
      batchId: 'batch-duplicates', sessionId: 'session-1',
      items: ['request-a', 'request-b'].map((requestId, userOrder) => ({
        requestId, kind: 'text', userOrder, assetIds: [], text: sameText,
        source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop', deviceId: 'device-one' },
      })),
    };
    const response = await handle(new Request('http://core.local/api/capture/batches', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    const result = await jsonOf(response) as { batch: { items: Array<{ rawSourceId: string }> } };
    expect(result.batch.items[0]?.rawSourceId).not.toBe(result.batch.items[1]?.rawSourceId);
    expect(harness.provider.extractInputs.filter((input) => JSON.stringify(input).includes(sameText))).toHaveLength(2);
  });

  it('marks interrupted work retryable during service restart and exposes the recovered status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noltri-batch-restart-'));
    const sqliteFile = path.join(dir, 'profile.sqlite');
    const config = {
      ...testConfig(),
      storage: { driver: 'sqlite' as const, sqliteFile },
      sqliteFile,
      dataDir: dir,
      vaultDir: path.join(dir, 'vault'),
    };
    const item = {
      requestId: 'interrupted-request', kind: 'text' as const, userOrder: 0, assetIds: [],
      text: '服务重新启动之后，原文和失败状态仍应保留并可重试。',
      source: { type: 'desktop_app' as const },
      capture: { capturedAt: '2026-10-29T12:00:00.000Z', client: 'desktop' as const, deviceId: 'restart-device' },
    };
    const first = await buildHandler(config, { vaultRootPath: path.join(dir, 'vault'), vaultDataDir: dir });
    try {
      await first.repository.createCaptureBatch({
        userId: config.devUser, batchId: 'restart-batch', sessionId: 'restart-session',
        payloadHash: 'e'.repeat(64), items: [item],
      });
      await first.repository.updateCaptureBatchItem(config.devUser, 'restart-batch', item.requestId, { status: 'processing' });
    } finally {
      await first.close();
    }

    try {
      const second = await buildHandler(config, { vaultRootPath: path.join(dir, 'vault'), vaultDataDir: dir });
      try {
        const response = await second.handle(new Request('http://core.local/api/capture/batches/restart-batch'));
        expect(response.status).toBe(200);
        const status = await jsonOf(response) as { items: Array<Record<string, unknown>> };
        expect(status.items[0]).toMatchObject({
          requestId: 'interrupted-request', status: 'failed', retryable: true,
          errorReason: '服务重启期间采集处理被中断，可重试原项目',
        });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
