import { describe, expect, it } from 'vitest';
import { loadCoreConfig } from '../src/config';

describe('model context window', () => {
  it('caps configured scopes at the remaining input window', () => {
    const config = loadCoreConfig({
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'test',
      AI_MODEL_CONTEXT_WINDOW: '10000',
      AI_MODEL_MAX_TOKENS: '3000',
    });
    expect(config.scopeBudgets).toEqual({
      current_node: 2_000,
      section: 5_000,
      tree: 7_000,
      whole_library: 7_000,
    });
  });

  it('does not force a minimum context budget when the model window is too small', () => {
    const config = loadCoreConfig({
      AI_PROVIDER: 'openai',
      AI_API_KEY: 'test',
      AI_MODEL_CONTEXT_WINDOW: '512',
    });
    expect(config.scopeBudgets).toEqual({
      current_node: 0,
      section: 0,
      tree: 0,
      whole_library: 0,
    });
  });
});
