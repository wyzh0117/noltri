import type { CaptureRequest } from '@noltri/schema';
import {
  isCaptureMessage,
  MESSAGE_CAPTURE_RESULT,
  MESSAGE_COLLECT_CONTEXT,
  type CaptureResultMessage,
  type CollectContextReply,
} from '../messaging';
import { loadSettings, localArea, syncArea, type ExtensionSettings } from '../settings/storage';
import { ensureDeviceId } from './device-id';
import { requestFromMenuSelection, requestFromPillSelection, type CaptureIntent, type CaptureRequestMeta } from '../capture/pipeline';
import { captureIntent, type CaptureOutcome } from '../api/client';
import { CAPTURE_MENU_ID, registerCaptureContextMenu } from '../context-menu/register';

interface AcceptedReply {
  readonly accepted: boolean;
}

void registerCaptureContextMenu();
chrome.runtime.onInstalled.addListener(() => {
  void registerCaptureContextMenu();
});
chrome.runtime.onStartup.addListener(() => {
  void registerCaptureContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CAPTURE_MENU_ID) void handleMenuClick(info, tab);
});

/**
 * The service worker is the only place that talks to Knowledge Core: content-script fetches are bound by
 * the page's CORS and cannot rely on the API host permission, so every entry point hands its intent here.
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (reply: AcceptedReply) => void) => {
    if (!isCaptureMessage(message)) return false;
    sendResponse({ accepted: true });
    void handlePillIntent(message.intent, sender.tab?.id);
    return false;
  },
);

async function handlePillIntent(intent: CaptureIntent, tabId: number | undefined): Promise<void> {
  const meta = await requestMeta();
  await sendCapture(requestFromPillSelection(intent, meta), tabId);
}

async function handleMenuClick(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const selectionText = typeof info.selectionText === 'string' ? info.selectionText : '';
  if (selectionText.length === 0) return;
  const tabId = tab?.id;
  const fromPage = await askPageForContext(tabId, selectionText);
  const meta = await requestMeta();
  const request = requestFromMenuSelection(
    {
      selectionText,
      pageHref: tab?.url ?? '',
      pageTitle: tab?.title ?? '',
      ...(fromPage?.surroundingContext ? { surroundingContext: fromPage.surroundingContext } : {}),
    },
    meta,
  );
  await sendCapture(request, tabId);
}

async function askPageForContext(tabId: number | undefined, selectionText: string): Promise<CollectContextReply | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return await chrome.tabs.sendMessage<Record<string, unknown>, CollectContextReply | undefined>(tabId, {
      type: MESSAGE_COLLECT_CONTEXT,
      selectionText,
    });
  } catch {
    // Frames without our content script (chrome://, web store) simply have no surrounding context.
    return undefined;
  }
}

async function requestMeta(): Promise<CaptureRequestMeta> {
  return { deviceId: await ensureDeviceId(localArea()) };
}

async function sendCapture(request: CaptureRequest, tabId: number | undefined): Promise<void> {
  const settings: ExtensionSettings = await loadSettings(syncArea());
  const outcome = await captureIntent(settings, request);
  await broadcast(tabId, outcome);
}

async function broadcast(tabId: number | undefined, outcome: CaptureOutcome): Promise<void> {
  if (tabId === undefined) return;
  const message: CaptureResultMessage = {
    type: MESSAGE_CAPTURE_RESULT,
    ok: outcome.ok,
    ...(outcome.ok ? { result: outcome.result } : { message: outcome.message }),
  };
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The capture already succeeded; a page we cannot message just misses the toast.
  }
}
