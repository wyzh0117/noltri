import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { processingRulesSchema, processingRecordSchema } from '../src/processing-rules';
const rules = { thresholds: DEFAULT_THRESHOLDS, extractionInstructions: '', classificationInstructions: '' };
describe('processing rules contracts', () => {
  it('reuses shared bounds and limits instructions without accepting extra fields', () => {
    expect(processingRulesSchema.parse(rules)).toEqual(rules);
    for (const value of [
      { ...rules, token: 'synthetic' },
      { ...rules, thresholds: { ...DEFAULT_THRESHOLDS, candidateNodeLimit: 201 } },
      { ...rules, thresholds: { ...DEFAULT_THRESHOLDS, token: 'synthetic' } },
      { ...rules, extractionInstructions: 'x'.repeat(4001) },
      { ...rules, classificationInstructions: 'x'.repeat(4001) },
    ]) expect(processingRulesSchema.safeParse(value).success).toBe(false);
  });
  it('orders UTC timestamps exactly across fractional precision without dropping submilliseconds', () => {
    const record = { recordId: 'record-1', taskId: 'task-1', ruleVersionId: 'rules-1-0123456789ab', phase: 'extracting', status: 'running' };
    const cases = [
      ['2026-11-02T00:00:00Z', '2026-11-02T00:00:00.1Z', true],
      ['2026-11-02T00:00:00.1Z', '2026-11-02T00:00:00Z', false],
      ['2026-11-02T00:00:00.1Z', '2026-11-02T00:00:00.100Z', true],
      ['2026-11-02T00:00:00.100Z', '2026-11-02T00:00:00.1Z', true],
      ['2026-11-02T00:00:00.0002Z', '2026-11-02T00:00:00.0001Z', false],
      ['2026-11-02T00:00:00.0001Z', '2026-11-02T00:00:00.0002Z', true],
      ['2026-11-02T00:00:00.9999999999999999999Z', '2026-11-02T00:00:01Z', true],
    ] as const;
    for (const [createdAt, updatedAt, accepted] of cases) {
      expect(processingRecordSchema.safeParse({ ...record, createdAt, updatedAt }).success, `${createdAt} -> ${updatedAt}`).toBe(accepted);
    }
  });
  it('allows only bounded metadata and enumerated errors in records', () => {
    const record = { recordId: 'record-1', taskId: 'task-1', ruleVersionId: 'rules-1-0123456789ab', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', phase: 'extracting', status: 'failed', errorCode: 'extraction_failed' };
    expect(processingRecordSchema.parse(record)).toEqual(record);
    for (const value of [{ ...record, rawText: 'synthetic' }, { ...record, errorCode: 'provider stack' }, { ...record, taskId: '../outside' }, { ...record, recordId: 'a'.repeat(129) }, { ...record, updatedAt: '2026-11-02T00:00:00.' + '1'.repeat(1000) + 'Z' }]) {
      expect(processingRecordSchema.safeParse(value).success).toBe(false);
    }
  });
});


describe('processing rules API contracts', () => {
  it('strictly validates request bodies and safe revision counters', async () => {
    const s = await import('../src/processing-rules');
    const bodies = [
      [s.saveProcessingRulesDraftRequestSchema, { rules, expectedRevision: 0 }],
      [s.applyProcessingRulesRequestSchema, { expectedRevision: 0 }],
      [s.rollbackProcessingRulesRequestSchema, { versionId: 'rules-1-0123456789ab', expectedRevision: 0 }],
    ] as const;
    for (const [schema, body] of bodies) {
      expect(schema.parse(body)).toEqual(body);
      for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) expect(schema.safeParse({ ...body, expectedRevision }).success).toBe(false);
      for (const field of ['token', 'userId', 'path', 'grant']) expect(schema.safeParse({ ...body, [field]: 'synthetic' }).success).toBe(false);
    }
    expect(s.rollbackProcessingRulesRequestSchema.safeParse({ versionId: '../outside', expectedRevision: 0 }).success).toBe(false);
  });
  it('strictly validates bounded response envelopes', async () => {
    const s = await import('../src/processing-rules');
    const draft = { rules, revision: 0 };
    const applied = { versionId: 'rules-1-0123456789ab', contentHash: 'a'.repeat(64), createdAt: '2026-11-02T00:00:00Z', rules };
    const state = { draft, applied, versions: [applied] };
    expect(s.processingRulesStateSchema.parse(state)).toEqual(state);
    expect(s.processingRulesStateSchema.safeParse({ ...state, versions: Array(1001).fill(applied) }).success).toBe(false);
    expect(s.processingRulesStateSchema.safeParse({ ...state, token: 'synthetic' }).success).toBe(false);
    expect(s.applyProcessingRulesResponseSchema.parse({ draft, applied })).toEqual({ draft, applied });
    expect(s.rollbackProcessingRulesResponseSchema.parse({ draft, applied })).toEqual({ draft, applied });
    expect(s.applyProcessingRulesResponseSchema.safeParse({ draft, applied, path: 'synthetic' }).success).toBe(false);
    expect(s.saveProcessingRulesDraftResponseSchema.parse(draft)).toEqual(draft);
    const record = { recordId: 'record-1', taskId: 'task-1', ruleVersionId: applied.versionId, createdAt: applied.createdAt, updatedAt: applied.createdAt, phase: 'completed', status: 'succeeded' };
    expect(s.processingRecordsResponseSchema.parse({ records: [record] })).toEqual({ records: [record] });
    expect(s.processingRecordsResponseSchema.safeParse({ records: Array(501).fill(record) }).success).toBe(false);
    expect(s.processingRecordsResponseSchema.safeParse({ records: [{ ...record, rawText: 'synthetic' }] }).success).toBe(false);
    expect(s.processingRecordsResponseSchema.safeParse({ records: [], path: 'synthetic' }).success).toBe(false);
  });
});
