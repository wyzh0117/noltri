/**
 * The env loaders are the boundary between a user's `.env` and a running profile, so a typo has to fail
 * loudly and say what was allowed — a silent fallback to `memory` would put a desktop user's captures in
 * a store that dies with the process.
 */
import { describe, expect, it } from 'vitest';
import { loadStorageDriver, loadAiConfig, loadThresholds } from '../src/env';

describe('STORAGE_DRIVER', () => {
  it('accepts every driver a build can actually open', () => {
    expect(loadStorageDriver({})).toBe('memory');
    expect(loadStorageDriver({ STORAGE_DRIVER: 'memory' })).toBe('memory');
    expect(loadStorageDriver({ STORAGE_DRIVER: 'sqlite' })).toBe('sqlite');
    expect(loadStorageDriver({ STORAGE_DRIVER: 'SQLITE' })).toBe('sqlite');
  });

  it('names the accepted values when the value is not one of them', () => {
    expect(() => loadStorageDriver({ STORAGE_DRIVER: 'postgres' })).toThrow(/STORAGE_DRIVER "postgres"/);
    expect(() => loadStorageDriver({ STORAGE_DRIVER: 'postgres' })).toThrow(/"memory", "sqlite"/);
    expect(() => loadStorageDriver({ STORAGE_DRIVER: '   ' })).toThrow(/STORAGE_DRIVER/);
  });

  it('keeps AI provider selection as strict, so an unset key cannot half-work', () => {
    expect(loadAiConfig({}).driver).toBe('offline');
    expect(loadAiConfig({ AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test' }).apiKey).toBe('sk-test');
    expect(() => loadAiConfig({ AI_PROVIDER: 'anthropic' })).toThrow(/AI_PROVIDER "anthropic"/);
  });

  it('clamps thresholds and never lets the medium bar exceed the high one', () => {
    const tuned = loadThresholds({ CLASSIFY_HIGH_CONFIDENCE: '0.4', CLASSIFY_MEDIUM_CONFIDENCE: '0.9' });
    expect(tuned.highConfidence).toBe(0.4);
    expect(tuned.mediumConfidence).toBeLessThanOrEqual(tuned.highConfidence);
    expect(loadThresholds({ CLASSIFY_HIGH_CONFIDENCE: 'not a number' }).highConfidence).toBeGreaterThan(0);
    expect(loadThresholds({ SIMILARITY_ATTACH_THRESHOLD: '7' }).similarityAttachThreshold).toBe(1);
  });
});
