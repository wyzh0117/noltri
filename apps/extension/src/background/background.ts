import type { CaptureRequest } from '@noltri/schema';
import {
  isCaptureMessage,
  isOutboxCommand,
  captureResultMessage,
  MESSAGE_CLEAR_OUTBOX,
  MESSAGE_COLLECT_CONTEXT,
  MESSAGE_COLLECT_PAGE_CONTEXT,
  MESSAGE_FLUSH_OUTBOX,
  MESSAGE_OUTBOX_COUNT,
  type CaptureResultMessage,
  type CollectContextReply,
  type CollectPageContextReply,
  type OutboxCountReply,
  type OutboxFlushReply,
} from '../messaging';
import { loadSettings, localArea, syncArea, type ExtensionSettings } from '../settings/storage';
import { ensureDeviceId } from './device-id';
import { requestFromMenuImage, requestFromMenuPage, requestFromMenuSelection, requestFromPillSelection, type CaptureIntent, type CaptureRequestMeta } from '../capture/pipeline';
import { captureIntent, type CaptureOutcome } from '../api/client';
import { createOutbox, disabledOutbox, type Outbox } from '../outbox/outbox';
import { drainOutbox, queueCapture, shouldQueue, type DrainReport } from '../outbox/drain';
import { CAPTURE_IMAGE_MENU_ID, CAPTURE_MENU_ID, CAPTURE_PAGE_MENU_ID, registerCaptureContextMenu } from '../context-menu/register';

interface AcceptedReply {
  readonly accepted: boolean;
}

void registerCaptureContextMenu();
chrome.runtime.onInstalled.addListener(() => {
  void registerCaptureContextMenu();
  void flushOutbox();
});
chrome.runtime.onStartup.addListener(() => {
  void registerCaptureContextMenu();
  // The browser coming back is the moment a queue written before a restart should be tried again.
  void flushOutbox();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if ([CAPTURE_MENU_ID, CAPTURE_PAGE_MENU_ID, CAPTURE_IMAGE_MENU_ID].includes(String(info.menuItemId))) void handleMenuClick(info, tab);
});

/**
 * The service worker is the only place that talks to Knowledge Core: content-script fetches are bound by
 * the page's CORS and cannot rely on the API host permission, so every entry point hands its intent here.
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (reply: AcceptedReply | OutboxCountReply | OutboxFlushReply) => void) => {
    if (isCaptureMessage(message)) {
      sendResponse({ accepted: true });
      void handlePillIntent(message.intent, sender.tab?.id);
      return false;
    }
    if (isOutboxCommand(message, MESSAGE_OUTBOX_COUNT)) {
      void outboxOf()
        .read()
        .then((read) => sendResponse({ count: read.entries.length, enabled: outboxOf().enabled }));
      return true;
    }
    if (isOutboxCommand(message, MESSAGE_FLUSH_OUTBOX)) {
      void flushOutbox().then((report) => sendResponse(report));
      return true;
    }
    if (isOutboxCommand(message, MESSAGE_CLEAR_OUTBOX)) {
      sendResponse({ accepted: true });
      void outboxOf().clear();
      return false;
    }
    return false;
  },
);

async function handlePillIntent(intent: CaptureIntent, tabId: number | undefined): Promise<void> {
  const meta = await requestMeta();
  await sendCapture(requestFromPillSelection(intent, meta), tabId);
}

async function handleMenuClick(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  const meta = await requestMeta();
  let request: CaptureRequest | undefined;
  if (info.menuItemId === CAPTURE_MENU_ID) {
    const selectionText = typeof info.selectionText === 'string' ? info.selectionText : '';
    if (selectionText.length === 0) return;
    const fromPage = await askPageForContext(tabId, selectionText);
    request = requestFromMenuSelection({
      selectionText,
      pageHref: tab?.url ?? '',
      pageTitle: tab?.title ?? '',
      ...(fromPage?.surroundingContext ? { surroundingContext: fromPage.surroundingContext } : {}),
    }, meta);
  } else if (info.menuItemId === CAPTURE_PAGE_MENU_ID) {
    const fromPage = await askPageForCollectionContext(tabId);
    request = requestFromMenuPage({
      pageHref: tab?.url ?? '',
      title: fromPage?.title || tab?.title || '',
      ...(fromPage?.description ? { description: fromPage.description } : {}),
      ...(fromPage?.previewImageUrl ? { previewImageUrl: fromPage.previewImageUrl } : {}),
    }, meta);
  } else if (info.menuItemId === CAPTURE_IMAGE_MENU_ID) {
    const imageHref = typeof info.srcUrl === 'string' ? info.srcUrl : '';
    if (imageHref.length === 0) return;
    const fromPage = await askPageForCollectionContext(tabId, imageHref);
    request = requestFromMenuImage({
      pageHref: tab?.url ?? '',
      pageTitle: fromPage?.title || tab?.title || '',
      imageHref,
      ...(fromPage?.imageAltText ? { imageAltText: fromPage.imageAltText } : {}),
    }, meta);
  }
  if (!request) {
    await broadcast(tabId, {
      ok: false,
      message: '没有读到足够的网页信息。可以先选中一段文字，再收集到知序。',
      retryable: false,
      coreUnreachable: false,
    });
    return;
  }
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

async function askPageForCollectionContext(tabId: number | undefined, imageHref?: string): Promise<CollectPageContextReply | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return await chrome.tabs.sendMessage<Record<string, unknown>, CollectPageContextReply | undefined>(tabId, {
      type: MESSAGE_COLLECT_PAGE_CONTEXT,
      ...(imageHref ? { imageHref } : {}),
    });
  } catch {
    return undefined;
  }
}

async function requestMeta(): Promise<CaptureRequestMeta> {
  return { deviceId: await ensureDeviceId(localArea()) };
}

/**
 * An incognito profile gets no queue. `chrome.storage.local` outlives the session on disk, so promising
 * 「仅保存在扩展待发送队列」 there would keep text the user meant to forget (§16 无痕模式禁用队列).
 */
function outboxOf(): Outbox {
  return chrome.extension?.inIncognitoContext === true ? disabledOutbox() : createOutbox(localArea());
}

async function sendCapture(request: CaptureRequest, tabId: number | undefined): Promise<void> {
  const settings: ExtensionSettings = await loadSettings(syncArea());
  const outcome = await captureIntent(settings, request);
  await broadcast(tabId, await keepOrReport(settings, request, outcome));
  // The Core just answered for this text, so anything queued earlier has a good chance of going through.
  if (outcome.ok) void flushOutbox();
}

/**
 * A refusal the queue may resend is queued; a refusal the Core made on purpose is reported as what it
 * is. Both cases keep the original text — the difference is only whether we promise to try again.
 */
async function keepOrReport(settings: ExtensionSettings, request: CaptureRequest, outcome: CaptureOutcome): Promise<CaptureOutcome> {
  if (outcome.ok) return outcome;
  const outbox = outboxOf();
  if (!shouldQueue(outcome, outbox.enabled)) return outcome;
  const report = await queueCapture(outbox, {
    id: request.requestId,
    request,
    queuedAt: new Date().toISOString(),
    tries: 0,
    lastError: outcome.message,
  });
  return { ...outcome, message: report.message, queued: report.queued };
}

let draining = false;

const EMPTY_DRAIN: DrainReport = { sent: 0, alreadyStored: 0, kept: 0, expired: 0, corrupt: 0, stoppedEarly: true };

/** One drain at a time: two service-worker wakeups resending the same entry would double-file it. */
async function flushOutbox(): Promise<DrainReport> {
  const outbox = outboxOf();
  if (!outbox.enabled || draining) return EMPTY_DRAIN;
  draining = true;
  try {
    const settings = await loadSettings(syncArea());
    return await drainOutbox({ outbox, send: (request) => captureIntent(settings, request) });
  } finally {
    draining = false;
  }
}

async function broadcast(tabId: number | undefined, outcome: CaptureOutcome): Promise<void> {
  if (tabId === undefined) return;
  const message: CaptureResultMessage = captureResultMessage(outcome);
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The capture already succeeded; a page we cannot message just misses the toast.
  }
}
