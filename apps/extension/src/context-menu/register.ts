export const CAPTURE_MENU_ID = 'noltri-capture-selection';
export const CAPTURE_MENU_TITLE = '归纳到知识树';

/** V1 §10.3: the right-click entry is the stable fallback for the floating pill. */
export function captureMenuItem(): chrome.contextMenus.CreateProperties {
  return { id: CAPTURE_MENU_ID, title: CAPTURE_MENU_TITLE, contexts: ['selection'] };
}

export async function registerCaptureContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create(captureMenuItem());
}
