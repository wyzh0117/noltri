/**
 * The V1 §8 Architecture Gate, machine-checked.
 *
 * These assertions are structural: they do not test features, they test that the load-bearing
 * invariants of PROJECT_MASTER survived the implementation — one capture pipeline, RawSource first,
 * no provider/storage leak, MCP behind Knowledge Core, desktop independent of any single Agent, and
 * a data model V2 can extend without being overturned.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaptureClient } from '@noltri/schema';
import { attachItemRecord, captureOf, createNodeRecord, makeHarness, CHINESE_TEXT } from './fakes';

function repoRoot(): string {
  let cursor = process.cwd();
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(join(cursor, 'pnpm-workspace.yaml'))) return cursor;
    cursor = join(cursor, '..');
  }
  return process.cwd();
}

function tsFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) collected.push(full);
  }
  return collected;
}

const ROOT = repoRoot();
const CORE_SRC = join(ROOT, 'services', 'knowledge-core', 'src');

const FORBIDDEN_IN_CORE = ['pg', '@supabase/', 'openai', 'anthropic', '@anthropic-ai/', 'express', 'mysql2', 'redis'];

describe('architecture gate — knowledge core', () => {
  it('imports no storage driver or provider SDK anywhere in src', () => {
    const violations: string[] = [];
    for (const file of tsFilesUnder(CORE_SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_IN_CORE) {
        const pattern = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"][^'"]*${forbidden.replaceAll('/', '\\/')}`);
        if (pattern.test(source)) violations.push(`${file} -> ${forbidden}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('writes RawSource in exactly one place, before any provider call', () => {
    const writers = tsFilesUnder(CORE_SRC).filter((file) => /createRawSource\s*\(/.test(readFileSync(file, 'utf8')));
    expect(writers).toHaveLength(1);
    expect(writers[0]).toContain(join('pipeline', 'capture.ts'));
  });

  it('the same pipeline serves extension, desktop, mcp and web_app captures', async () => {
    const clients: CaptureClient[] = ['extension', 'desktop', 'mcp', 'web_app'];
    for (const client of clients) {
      const harness = makeHarness();
      const result = await harness.core.capture(captureOf(CHINESE_TEXT, client), harness.actor);
      expect(result.processingStatus).toBe('done');
      expect(Object.keys(result).sort()).toEqual(
        ['duplicate', 'items', 'processingStatus', 'rawSourceId', 'requestId', 'stage'].sort(),
      );
      // The unified request is what makes a replay recognisable, so every entry point has to carry it.
      expect(result.requestId.length).toBeGreaterThan(0);
      expect(['completed', 'needs_review']).toContain(result.stage);
      expect(result.duplicate).toBe(false);
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(Object.keys(item).sort()).toEqual(
          ['action', 'confidence', 'confidenceTier', 'knowledgeItemId', 'nodeId', 'nodePath', 'text'].sort(),
        );
      }
    }
  });

  it('desktop capture works with no agent-specific fields at all', async () => {
    const harness = makeHarness();
    const result = await harness.core.capture(
      {
        requestId: 'req-gate-desktop-0001',
        text: CHINESE_TEXT,
        source: { type: 'desktop_app' },
        capture: { capturedAt: '2026-10-02T12:00:00.000Z', client: 'desktop' },
      },
      harness.actor,
    );
    expect(result.processingStatus).toBe('done');
    const rawSource = await harness.repository.findRawSource(result.rawSourceId, harness.actor.userId);
    expect(rawSource?.sourceType).toBe('desktop_app');
    expect(rawSource?.sourceApp).toBeNull();
    // With no install identity the entry point itself scopes the idempotency key.
    expect(rawSource?.clientId).toBe('desktop');
  });

  it('the V2 graph model already exists beside the tree: links and edges are independent of parent_id', async () => {
    const harness = makeHarness();
    const nodeA = await createNodeRecord(harness, '装饰器');
    const nodeB = await createNodeRecord(harness, '闭包');
    const item = await attachItemRecord(harness, nodeA, '装饰器本质上是接受函数并返回函数的高阶函数。');

    await harness.repository.createEdge({
      userId: harness.actor.userId,
      fromNodeId: nodeA,
      toNodeId: nodeB,
      relationType: 'prerequisite_of',
      confidence: 0.7,
      source: 'architecture-gate',
    });

    const nodeARow = await harness.repository.findNode(nodeA, harness.actor.userId);
    expect(nodeARow?.parentId).toBeNull();
    expect((await harness.repository.listEdgesForNode(harness.actor.userId, nodeA)).map((edge) => edge.relationType)).toContain(
      'prerequisite_of',
    );
    expect((await harness.repository.listLinksForItem(item.itemId, harness.actor.userId)).map((link) => link.nodeId)).toEqual([nodeA]);

    await harness.repository.moveNode({ userId: harness.actor.userId, nodeId: nodeA, targetParentId: nodeB, actor: 'gate' });
    const records = await harness.repository.listVersionRecords(harness.actor.userId, nodeA);
    expect(records[0]?.operation).toBe('reparent');
    expect(records[0]?.before).toMatchObject({ parentId: null });
    expect(records[0]?.after).toMatchObject({ parentId: nodeB });
  });
});

describe('architecture gate — mcp server', () => {
  const mcpSrc = join(ROOT, 'services', 'mcp-server', 'src');

  it.skipIf(!existsSync(mcpSrc))('never imports the storage or AI layers — it goes through Knowledge Core only', () => {
    const violations: string[] = [];
    for (const file of tsFilesUnder(mcpSrc)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['@noltri/storage', '@noltri/ai-provider', 'pg', '@supabase/']) {
        if (source.includes(forbidden)) violations.push(`${file} -> ${forbidden}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it.skipIf(!existsSync(mcpSrc))('exposes exactly the seven V1 tools', async () => {
    const toolNames: string[] = [];
    for (const file of tsFilesUnder(mcpSrc)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/name:\s*'(capture_knowledge|search_knowledge|get_knowledge_tree|get_knowledge_node|update_knowledge_node|move_knowledge_node|get_node_context)'/g)) {
        if (!toolNames.includes(match[1])) toolNames.push(match[1]);
      }
    }
    expect(toolNames.sort()).toEqual(
      [
        'capture_knowledge',
        'search_knowledge',
        'get_knowledge_tree',
        'get_knowledge_node',
        'update_knowledge_node',
        'move_knowledge_node',
        'get_node_context',
      ].sort(),
    );
  });
});

describe('architecture gate — storage seam', () => {
  it('the repository factory is the only place a driver is chosen', () => {
    const coreSources = tsFilesUnder(CORE_SRC).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(coreSources).not.toMatch(/driver\s*===?\s*['"](memory|supabase)['"]/);
  });
});
