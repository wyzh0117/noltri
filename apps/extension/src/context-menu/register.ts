export const CAPTURE_MENU_ID = 'noltri-capture-selection';
export const CAPTURE_PAGE_MENU_ID = 'noltri-capture-page';
export const CAPTURE_IMAGE_MENU_ID = 'noltri-capture-image';
export const CAPTURE_MENU_TITLE = '收集选中内容到知序';

/** The right-click menu is the fallback when the floating selection button is unavailable. */
export function captureMenuItems(): chrome.contextMenus.CreateProperties[] {
  return [
    { id: CAPTURE_MENU_ID, title: CAPTURE_MENU_TITLE, contexts: ['selection'] },
    { id: CAPTURE_PAGE_MENU_ID, title: '收集此网页到知序', contexts: ['page'] },
    { id: CAPTURE_IMAGE_MENU_ID, title: '收集此图片到知序', contexts: ['image'] },
  ];
}

export async function registerCaptureContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  for (const menu of captureMenuItems()) chrome.contextMenus.create(menu);
}
