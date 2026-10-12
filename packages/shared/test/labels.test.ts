/**
 * Label completeness. Every map here is keyed by a schema enum, so a new enum value must arrive with a
 * Chinese label before the UI stops showing the raw token — the failure this test turns into a build
 * failure. Written as one rule per map plus the exact 收件箱 wording the desktop panel renders.
 */
import { describe, expect, it } from 'vitest';
import {
  captureActionSchema,
  contextScopeSchema,
  edgeRelationSchema,
  nodeStatusSchema,
  processingStatusSchema,
  searchHitSchema,
  sourceTypeSchema,
} from '@noltri/schema';
import {
  captureActionLabels,
  matchedByLabels,
  nodeStatusLabels,
  processingStatusLabels,
  relationLabel,
  relationLabels,
  scopeDescriptions,
  scopeIsAdvanced,
  scopeLabels,
  sourceTypeLabels,
} from '../src/labels';

function keysOf<T extends { options: readonly string[] }>(schema: T): string[] {
  return [...schema.options];
}

const MAPS: readonly (readonly [string, Readonly<Record<string, string>>, readonly string[]])[] = [
  ['processingStatusLabels', processingStatusLabels, keysOf(processingStatusSchema)],
  ['sourceTypeLabels', sourceTypeLabels, keysOf(sourceTypeSchema)],
  ['nodeStatusLabels', nodeStatusLabels, keysOf(nodeStatusSchema)],
  ['captureActionLabels', captureActionLabels, keysOf(captureActionSchema)],
  ['relationLabels', relationLabels, keysOf(edgeRelationSchema)],
  ['scopeLabels', scopeLabels, keysOf(contextScopeSchema)],
  ['scopeDescriptions', scopeDescriptions, keysOf(contextScopeSchema)],
  ['matchedByLabels', matchedByLabels, [...searchHitSchema.shape.matchedBy.options]],
];

describe('label maps cover their schema enums', () => {
  it.each(MAPS)('%s has exactly one entry per enum value', (_name, map, enumValues) => {
    expect(Object.keys(map).sort()).toEqual([...enumValues].sort());
  });

  it.each(MAPS)('%s leaves nothing empty', (_name, map) => {
    for (const [key, label] of Object.entries(map)) {
      expect(label.trim().length, key).toBeGreaterThan(0);
    }
  });

  it.each(MAPS)('%s never shows a snake_case enum token to the user', (_name, map) => {
    for (const [key, label] of Object.entries(map)) {
      // 'needs_review' must read 待核实; a label that still carries the underscore means a missing entry.
      expect(label, key).not.toMatch(/_/);
    }
  });
});

describe('收件箱 and scope wording', () => {
  it('names the four capture states the way the desktop badges render them', () => {
    expect(processingStatusLabels).toEqual({
      pending: '待整理',
      processing: '整理中',
      done: '已归纳',
      failed: '归纳失败',
    });
  });

  it('names the four capture sources the way the source line renders them', () => {
    expect(sourceTypeLabels).toEqual({
      web: '网页',
      desktop_app: '桌面应用',
      agent: 'Agent',
      manual: '手动粘贴',
    });
  });

  it('flags only 整个知识库 as an advanced scope, and describes every scope', () => {
    expect(Object.keys(scopeIsAdvanced)).toEqual(keysOf(contextScopeSchema));
    expect(scopeIsAdvanced.whole_library).toBe(true);
    for (const scope of keysOf(contextScopeSchema).filter((value) => value !== 'whole_library')) {
      expect(scopeIsAdvanced[scope as keyof typeof scopeIsAdvanced], scope).toBe(false);
    }
  });
});

describe('relationLabel', () => {
  it('translates a known relation', () => {
    expect(relationLabel('part_of')).toBe('属于');
  });

  it('passes an unknown token through instead of throwing or blanking', () => {
    expect(relationLabel('derived_from_v2')).toBe('derived_from_v2');
  });
});
