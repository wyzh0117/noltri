import { afterEach, expect, it, vi } from 'vitest';
import { createSelectionObserver } from '../src/capture/observer';

vi.mock('../src/source/extract', () => ({ readSelectionIntent: () => ({ text: 'synthetic selection', source: { type: 'web' } }) }));
vi.mock('../src/overlay/shadow-host', () => ({ isInsideOwnUi: () => false, ownUiHosts: () => [] }));

afterEach(() => vi.unstubAllGlobals());

it('shows a new keyboard selection after a completed capture hides the pill', () => {
  const rect = { top: 100, left: 100, width: 180, height: 20 };
  const selection = { toString: () => 'synthetic selection', rangeCount: 1, anchorNode: null, getRangeAt: () => ({ getBoundingClientRect: () => rect }) };
  vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, getSelection: () => selection, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('location', { href: 'https://example.test/fixture' });
  const handlers = { onShow: vi.fn(), onMove: vi.fn(), onHide: vi.fn() };
  const observer = createSelectionObserver(handlers, { minimumLength: 8, autoShow: true, isDomainDisabled: () => false });
  observer.refresh();
  observer.freeze();
  observer.unfreeze();
  observer.hide();
  observer.refresh();
  expect(handlers.onShow).toHaveBeenCalledTimes(2);
  expect(handlers.onMove).not.toHaveBeenCalled();
  expect(handlers.onHide).toHaveBeenCalledOnce();
});
