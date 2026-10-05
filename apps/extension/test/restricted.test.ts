import { describe, expect, it } from 'vitest';
import { describeRestrictedPage, restrictionOf, restrictedReasonForHref } from '../src/capture/restricted';

const CASES: readonly (readonly [string, string | undefined])[] = [
  ['https://example.com/article', undefined],
  ['http://127.0.0.1:8787/inbox', undefined],
  ['https://sub.example.com/path?x=1#y', undefined],
  ['chrome://extensions/', 'browser_page'],
  ['chrome://settings/searchEngines', 'browser_page'],
  ['edge://newtab/', 'browser_page'],
  ['brave://brave-ui', 'browser_page'],
  ['about:blank', 'browser_page'],
  ['chrome-search://local-ntp/local-ntp.html', 'browser_page'],
  ['devtools://devtools/bundled/inspector.html', 'browser_page'],
  ['view-source:https://example.com', 'browser_page'],
  ['https://chromewebstore.google.com/detail/noltri/abcdef', 'web_store'],
  ['https://chrome.google.com/webstore/detail/noltri/abcdef', 'web_store'],
  ['https://microsoftedge.microsoft.com/addons/detail/noltri/abcdef', 'web_store'],
  ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', 'pdf_viewer'],
  ['moz-extension://1b2c-3d4f/pdfjs/web/viewer.html', 'pdf_viewer'],
  ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/home.html', 'other_extension'],
  ['file:///Users/youngi/notes.md', 'local_file'],
  ['data:text/plain,hello', 'unsupported_scheme'],
  ['blob:https://example.com/1f2e3d4c', 'unsupported_scheme'],
  ['not-a-url', 'unsupported_scheme'],
  ['', 'unsupported_scheme'],
];

describe('§10.4 restricted pages are named, not silently skipped', () => {
  it.each(CASES)('classifies %s as %s', (href, expected) => {
    expect(restrictedReasonForHref(href)).toBe(expected);
  });

  it('keeps ordinary http and https pages usable', () => {
    expect(restrictionOf('https://example.com')).toBeUndefined();
  });

  it('every restricted page carries a reason and a way out the user performs', () => {
    for (const href of ['chrome://extensions/', 'file:///tmp/x.md', 'https://chromewebstore.google.com/detail/a/b']) {
      const info = restrictionOf(href);
      expect(info).toBeDefined();
      const text = describeRestrictedPage(info as never);
      expect(text).toContain(info?.message);
      expect(text.length).toBeGreaterThan(info?.message.length ?? 0);
      expect(text).not.toContain('未连接');
    }
  });

  it('points a file page at the file-access setting instead of the clipboard', () => {
    expect(restrictionOf('file:///tmp/x.md')?.fallback).toContain('文件 URL');
  });

  it('never tells the user to let the extension paste for them', () => {
    for (const [href] of CASES) {
      const info = restrictionOf(href);
      if (!info) continue;
      expect(describeRestrictedPage(info)).toContain('复制');
    }
  });
});
