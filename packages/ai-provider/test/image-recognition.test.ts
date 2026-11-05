import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider, type OpenAiProviderOptions } from '../src/openai';
import type { AiProtocol, AiProviderConfig } from '@noltri/shared';
import type { AIProvider, ImageRecognitionResult, RecognizeImageInput } from '../src/types';
import * as packageApi from '../src/index';

// Valid encoded 1×1 white RGB PNG; all chunks have CRCs and IDAT contains a zlib scanline.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = (): RecognizeImageInput => ({ bytes: new Uint8Array(Buffer.from(PNG_BASE64, 'base64')), mimeType: 'image/png' });
const CONFIG: AiProviderConfig = {
  driver: 'openai', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '',
  chatModel: 'ordinary-chat', embedModel: 'embed-test', embeddingDim: 3, timeoutMs: 100, temperature: 0.2,
};
const RESULT: ImageRecognitionResult = {
  text: 'A = B + ?', confidence: 0.72,
  blocks: [{ kind: 'formula', text: 'A = B + ?', region: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 } }],
  uncertainRegions: [{ reason: 'final symbol is blurred', text: '?', region: { x: 0.8, y: 0.2, width: 0.1, height: 0.3 } }],
};
function provider(options: OpenAiProviderOptions = {}, protocol: AiProtocol = 'openai-completions') {
  return new OpenAiCompatibleProvider({ ...CONFIG, protocol }, { maxRetries: 0, backoffBaseMs: 1, ...options });
}
function mockCompletion(payload: unknown, statuses: number[] = []) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const status = statuses[calls.length - 1] ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status });
    return new Response(JSON.stringify({
      id: 'synthetic-completion', object: 'chat.completion', created: 0, model: 'explicit-image-model',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
    }), { status: 200 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('opt-in image recognition transport', () => {
  // Removing explicit capability/model selection must break this transport contract.
  it('uses the explicit image model and inline original bytes in chat completions', async () => {
    const calls = mockCompletion(RESULT);
    const enabled = provider({ imageRecognitionModel: 'explicit-image-model' });
    expect(enabled.capabilities.imageRecognition).toBe(true);
    const input = image();
    const before = Uint8Array.from(input.bytes);
    expect(await enabled.recognizeImage(input)).toEqual(RESULT);
    expect(input.bytes).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:1/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ model: 'explicit-image-model', response_format: { type: 'json_object' } });
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: expect.stringContaining('uncertainRegions') },
      { role: 'user', content: [
        { type: 'text', text: expect.stringContaining('JSON') },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ] },
    ]);
  });
  // Characterize the shared JSON fallback: it must retain image bytes and model selection.
  it('retains the image when JSON-mode response_format is rejected', async () => {
    const calls = mockCompletion(RESULT, [400, 200]);
    expect(await provider({ imageRecognitionModel: 'explicit-image-model' }).recognizeImage(image())).toEqual(RESULT);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]?.body.response_format).toBeUndefined();
    for (const call of calls) {
      expect(call.body.model).toBe('explicit-image-model');
      expect(call.body.messages).toEqual([
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: [
          { type: 'text', text: expect.any(String) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ] },
      ]);
    }
  });

  it('uses shared retry handling for a rate-limited image request', async () => {
    const calls = mockCompletion(RESULT, [429, 200]);
    expect(await provider({ imageRecognitionModel: 'explicit-image-model', maxRetries: 1 }).recognizeImage(image())).toEqual(RESULT);
    expect(calls).toHaveLength(2);
  });
});

describe('image recognition boundaries', () => {
  // Inferring vision from chat model names or ignoring protocol must cause a failure.
  it.each([undefined, '', '   '])('does not opt in from a generic chat model (option %s)', async (imageRecognitionModel) => {
    const calls = mockCompletion(RESULT);
    const disabled = new OpenAiCompatibleProvider({ ...CONFIG, chatModel: 'vision-looking-chat' }, { imageRecognitionModel });
    expect(disabled.capabilities.imageRecognition).not.toBe(true);
    await expect(disabled.recognizeImage(image())).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/unavailable/i) });
    expect(calls).toHaveLength(0);
  });

  it.each<AiProtocol>(['openai-responses', 'anthropic-messages'])('rejects unsupported %s before sending anything', async (protocol) => {
    const calls = mockCompletion(RESULT);
    const unsupported = provider({ imageRecognitionModel: 'explicit-image-model' }, protocol);
    expect(unsupported.capabilities.imageRecognition).not.toBe(true);
    await expect(unsupported.recognizeImage(image())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  // Missing validation would send invalid bytes/types and silently trust malformed model data.
  it.each([
    { bytes: new Uint8Array(), mimeType: 'image/png' },
    { bytes: new Uint8Array(20 * 1024 * 1024 + 1), mimeType: 'image/png' },
    { bytes: image().bytes, mimeType: 'image/svg+xml' },
    { bytes: image().bytes, mimeType: 'image/jpeg' },
    { bytes: 'https://example.invalid/image.png', mimeType: 'image/png' },
  ])('rejects invalid request %# without transport', async (invalid) => {
    const calls = mockCompletion(RESULT);
    await expect(provider({ imageRecognitionModel: 'explicit-image-model' }).recognizeImage(invalid as RecognizeImageInput))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  const malformed = [
    null,
    { ...RESULT, confidence: 1.1 },
    { ...RESULT, text: 'x'.repeat(20_001) },
    { ...RESULT, blocks: Array.from({ length: 101 }, () => ({ kind: 'paragraph', text: 'text' })) },
    { ...RESULT, blocks: [{ kind: 'unknown', text: 'text' }] },
    { ...RESULT, blocks: [{ kind: 'code', text: 'x'.repeat(20_001) }] },
    { ...RESULT, uncertainRegions: Array.from({ length: 101 }, () => ({ reason: 'blurred' })) },
    { ...RESULT, uncertainRegions: [{ reason: '' }] },
    { ...RESULT, uncertainRegions: [{ reason: 'x'.repeat(1001) }] },
    { ...RESULT, uncertainRegions: [{ reason: 'blurred', text: 'x'.repeat(20_001) }] },
    { ...RESULT, assetId: 'invented-source', url: 'https://invented.invalid' },
    { ...RESULT, blocks: [{ kind: 'image', text: '', url: 'https://invented.invalid' }] },
    ...[
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 1.1, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0, height: 0.5 },
      { x: 0.8, y: 0, width: 0.3, height: 0.5 },
      { x: 0, y: 0.8, width: 0.5, height: 0.3 },
    ].map((region) => ({ ...RESULT, blocks: [{ kind: 'paragraph', text: 'text', region }] })),
    { ...RESULT, uncertainRegions: [{ reason: 'blurred', region: { x: 0, y: 0, width: 2, height: 1 } }] },
    { ...RESULT, text: 'a'.repeat(20_000), blocks: Array.from({ length: 5 }, () => ({ kind: 'paragraph', text: 'b'.repeat(20_000) })) },
  ];
  it.each(malformed)('rejects malformed or excessive model output %#', async (payload) => {
    mockCompletion(payload);
    const input = image();
    const before = Uint8Array.from(input.bytes);
    await expect(provider({ imageRecognitionModel: 'explicit-image-model' }).recognizeImage(input))
      .rejects.toMatchObject({ code: 'provider_error' });
    expect(input.bytes).toEqual(before);
  });

  it('retains wholly unreadable content with no invented transcription', async () => {
    const unreadable = { text: '', confidence: 0, blocks: [{ kind: 'image', text: '' }], uncertainRegions: [{ reason: 'unreadable' }] };
    mockCompletion(unreadable);
    expect(await provider({ imageRecognitionModel: 'explicit-image-model' }).recognizeImage(image())).toEqual(unreadable);
  });
});

describe('optional provider recognition helper', () => {
  // Missing optional methods must remain a supported text-only provider shape.
  it('reports offline/text-only providers as unavailable rather than making up text', async () => {
    const calls = mockCompletion(RESULT);
    const legacy: AIProvider = packageApi.createOfflineProvider();
    expect(packageApi.recognizeImage).toBeTypeOf('function');
    await expect(packageApi.recognizeImage(legacy, image())).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/unavailable/i) });
    expect(calls).toHaveLength(0);
  });

  it('requires both an explicit capability and an implementation', async () => {
    expect(packageApi.recognizeImage).toBeTypeOf('function');
    const missingMethod = packageApi.createOfflineProvider();
    missingMethod.capabilities.imageRecognition = true;
    await expect(packageApi.recognizeImage(missingMethod, image())).rejects.toMatchObject({ code: 'invalid_request' });
    const missingCapability = Object.assign(packageApi.createOfflineProvider(), { recognizeImage: async () => RESULT });
    await expect(packageApi.recognizeImage(missingCapability, image())).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('validates custom provider results and protects caller bytes from mutation', async () => {
    expect(packageApi.recognizeImage).toBeTypeOf('function');
    const custom = Object.assign(packageApi.createOfflineProvider(), {
      recognizeImage: async (input: RecognizeImageInput) => { input.bytes.fill(0); return RESULT; },
    });
    custom.capabilities.imageRecognition = true;
    const input = image();
    const before = Uint8Array.from(input.bytes);
    expect(await packageApi.recognizeImage(custom, input)).toEqual(RESULT);
    expect(input.bytes).toEqual(before);
    custom.recognizeImage = async () => ({ ...RESULT, confidence: Number.NaN });
    await expect(packageApi.recognizeImage(custom, image())).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('passes explicit model options through the public provider factory', async () => {
    mockCompletion(RESULT);
    const configured = packageApi.createProvider(CONFIG, { imageRecognitionModel: 'explicit-image-model' });
    expect(configured.capabilities.imageRecognition).toBe(true);
    expect(await packageApi.recognizeImage(configured, image())).toEqual(RESULT);
  });
});
