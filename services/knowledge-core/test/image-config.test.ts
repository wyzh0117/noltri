import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@noltri/shared';
import { loadCoreConfig } from '../src/config';
import { buildHandler } from '../src/http';
describe('explicit image model opt-in', () => {
 it('bounds the model setting and leaves absence off', () => {
  expect(loadCoreConfig({}).imageRecognitionModel).toBeUndefined();
  expect(loadCoreConfig({ AI_IMAGE_RECOGNITION_MODEL: '  synthetic-model  ' }).imageRecognitionModel).toBe('synthetic-model');

 });
 it.each(['x'.repeat(201), 'bad\nmodel'])('rejects a model identifier outside its bounds', value => { expect(() => loadCoreConfig({ AI_IMAGE_RECOGNITION_MODEL: value })).toThrow(); });
 it.each([undefined, 'synthetic-model'])('constructs the host with only an explicit opt-in (%s)', async model => {
  const dir = await mkdtemp(join(tmpdir(), 'image-config-'));
  const loaded = loadCoreConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_CHAT_MODEL: 'vision-looking-name', ...(model ? { AI_IMAGE_RECOGNITION_MODEL: model } : {}) });
  const bundle = await buildHandler({ ...loaded, storage: { driver: 'sqlite', sqliteFile: ':memory:' }, sqliteFile: ':memory:', dataDir: dir, vaultDir: join(dir, 'vault'), grantFile: '' }, { logger: silentLogger, vaultRootPath: join(dir, 'vault'), vaultDataDir: dir });
  try { expect(bundle.provider.capabilities.imageRecognition === true).toBe(model !== undefined); }
  finally { await bundle.close(); await rm(dir, { recursive: true, force: true }); }
 });
});
