import { describe, expect, it } from 'vitest';
import { captureRequestSchema, type CaptureRequest } from '@noltri/schema';
import { requestFromMenuImage, requestFromMenuPage, requestFromMenuSelection, requestFromPillSelection } from '../src/capture/pipeline';
import { buildSource } from '../src/source/extract';
import { buildExtensionCaptureRequest } from '../src/capture/build-request';

const CAPTURED_AT = '2026-10-03T09:30:00.000Z';
const META = { deviceId: 'device-01', capturedAt: CAPTURED_AT };
const TEXT = 'Tuple 是不可变序列，因此可以作为字典的键。';
const HREF = 'https://docs.example.com/python/tuple';
const TITLE = 'Python Tuple 文档';
const CONTEXT = '关于序列的说明：不可变对象可以安全地作为字典键使用。';

/**
 * The contract test that matters: the floating pill and the right-click menu are two different ways to
 * reach the same page data, and they must produce one identical `CaptureRequest` — one pipeline entry,
 * no second implementation on the client side (§2.3).
 */
describe('one capture pipeline for both entry points', () => {
  const pill = requestFromPillSelection({ text: TEXT, source: buildSource({ href: HREF, title: TITLE }), surroundingContext: CONTEXT }, META);
  const menu = requestFromMenuSelection({ selectionText: TEXT, pageHref: HREF, pageTitle: TITLE, surroundingContext: CONTEXT }, META);

  it('both payloads validate against the frozen captureRequestSchema', () => {
    expect(captureRequestSchema.safeParse(pill).success).toBe(true);
    expect(captureRequestSchema.safeParse(menu).success).toBe(true);
  });

  it('the two entry points produce the same idempotent request', () => {
    expect(menu).toEqual(pill);
    expect(pill.requestId.length).toBeGreaterThanOrEqual(8);
  });

  it('capture.client is "extension" for both paths', () => {
    expect(pill.capture.client).toBe('extension');
    expect(menu.capture.client).toBe('extension');
  });

  it('carries the contract fields the Knowledge Core pipeline expects', () => {
    expect(pill).toEqual({
      requestId: pill.requestId,
      text: TEXT,
      surroundingContext: CONTEXT,
      source: { type: 'web', platform: 'docs.example.com', title: TITLE, url: HREF },
      capture: { capturedAt: CAPTURED_AT, client: 'extension', deviceId: 'noltri-library-item-v1' },
      library: { kind: 'knowledge' },
    });
  });

  it('a queue hands its stored key back so a resend stays one capture', () => {
    const first = buildExtensionCaptureRequest({ text: TEXT, source: buildSource({ href: HREF, title: TITLE }) }, META);
    const resent = buildExtensionCaptureRequest(
      { text: TEXT, source: buildSource({ href: HREF, title: TITLE }) },
      { ...META, requestId: first.requestId },
    );
    expect(resent.requestId).toBe(first.requestId);
    expect(captureRequestSchema.parse(resent)).toEqual(first);
  });

  it('omits surroundingContext instead of sending an empty string', () => {
    const request = buildExtensionCaptureRequest({ text: TEXT, source: buildSource({ href: HREF, title: TITLE }) }, META);
    expect('surroundingContext' in request).toBe(false);
    expect(captureRequestSchema.safeParse(request).success).toBe(true);
  });

  it('normalizes a multi-line selection so the core receives knowledge text', () => {
    const request: CaptureRequest = buildExtensionCaptureRequest(
      { text: '  - 元组不可变\n  - 可作字典键  ', source: buildSource({ href: HREF, title: TITLE }) },
      META,
    );
    expect(request.text).toBe('元组不可变 可作字典键');
    expect(captureRequestSchema.safeParse(request).success).toBe(true);
  });

  it('a too-short selection is refused by the shared schema rather than sent', () => {
    const request = buildExtensionCaptureRequest({ text: '太短', source: buildSource({ href: HREF, title: TITLE }) }, META);
    const parsed = captureRequestSchema.safeParse(request);
    expect(parsed.success).toBe(false);
  });

  it('the manual paste fallback stays inside the same contract with client "extension"', () => {
    const request = buildExtensionCaptureRequest({ text: TEXT, source: buildSource({ href: '', title: '', type: 'manual' }) }, META);
    expect(captureRequestSchema.safeParse(request).success).toBe(true);
    expect(request.source).toEqual({ type: 'manual', appName: '知序 Noltri 扩展' });
    expect(request.capture.client).toBe('extension');
  });

  it('collects only declared page text and an HTTPS Open Graph preview', () => {
    const request = requestFromMenuPage({
      pageHref: HREF,
      title: TITLE,
      description: '介绍 Python 元组的不可变特性和常见用法。',
      previewImageUrl: 'https://cdn.example.com/python-tuple.png',
    }, META);
    expect(request?.library).toEqual({ kind: 'web_page', previewImageUrl: 'https://cdn.example.com/python-tuple.png' });
    expect(request?.source.url).toBe(HREF);
    expect(request?.text).toBe('介绍 Python 元组的不可变特性和常见用法。');
    expect(captureRequestSchema.safeParse(request).success).toBe(true);
  });

  it('collects one selected image with its alt text and ignores a non-HTTPS preview URL', () => {
    const request = requestFromMenuImage({
      pageHref: HREF,
      pageTitle: TITLE,
      imageHref: 'http://cdn.example.com/tuple.png',
      imageAltText: 'Python 元组结构示意图',
    }, META);
    expect(request?.library).toEqual({ kind: 'image' });
    expect(request?.text).toContain('Python 元组结构示意图');
    expect(request?.source.url).toBe(HREF);
    expect(captureRequestSchema.safeParse(request).success).toBe(true);
  });

  it('refuses browser-internal pages and image URLs as collection sources', () => {
    expect(requestFromMenuPage({ pageHref: 'chrome://settings', title: '浏览器设置' }, META)).toBeUndefined();
    expect(requestFromMenuImage({ pageHref: HREF, pageTitle: TITLE, imageHref: 'file:///tmp/photo.png' }, META)).toBeUndefined();
  });
});
