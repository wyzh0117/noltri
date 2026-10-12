import {
  isCaptureResultMessage,
  isCollectContextMessage,
  isCollectPageContextMessage,
  MESSAGE_CAPTURE,
  type CaptureMessage,
  type CollectContextReply,
  type CollectPageContextReply,
} from './messaging';
import { createOverlayController } from './overlay/controller';
import { createSelectionObserver, type ObserverRules } from './capture/observer';
import { readImageAltText, readPageCollectionContext, readSelectionIntent } from './source/extract';
import { WORKER_SILENT_MESSAGE, offlineFailure, parseCaptureResult, type CaptureOutcome } from './api/client';
import { DEFAULT_SETTINGS, isDomainDisabled, loadSettings, syncArea, type ExtensionSettings } from './settings/storage';

/** The service worker's own request timeout is 20s; this is the page-side safety net for a dead worker. */
const CAPTURE_TIMEOUT_MS = 25_000;

function rulesFor(settings: ExtensionSettings): ObserverRules {
  return {
    minimumLength: settings.minimumSelectionLength,
    autoShow: settings.autoShowButton,
    isDomainDisabled: (hostname: string) => isDomainDisabled(hostname, settings.disabledDomains),
  };
}

function collectContextReply(selectionText: string): CollectContextReply {
  const intent = readSelectionIntent(selectionText);
  return intent?.surroundingContext ? { surroundingContext: intent.surroundingContext } : {};
}

/** No export on purpose: Chrome loads this bundle as a classic content script, so an `export` statement would be a syntax error. */
function start(): void {
  if (!document.body) return;
  let settings: ExtensionSettings = DEFAULT_SETTINGS;

  const controller = createOverlayController(() => sendCapture());
  const observer = createSelectionObserver(
    {
      onShow: (position) => controller.showPill(position),
      onMove: (position) => controller.movePill(position),
      onHide: () => controller.hidePill(),
    },
    rulesFor(settings),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;

  function finish(outcome: CaptureOutcome): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    observer.unfreeze();
    controller.hidePill();
    controller.showResult(outcome);
  }

  function sendCapture(): void {
    const intent = observer.currentIntent();
    if (!intent) {
      controller.setBusy(false);
      return;
    }
    // Freeze the pill while the request is in flight: the selection may already be gone by now,
    // and the captured intent is the one being sent.
    observer.freeze();
    const message: CaptureMessage = { type: MESSAGE_CAPTURE, intent };
    timer = setTimeout(() => finish(offlineFailure(WORKER_SILENT_MESSAGE)), CAPTURE_TIMEOUT_MS);
    chrome.runtime.sendMessage(message, (): void => {
      if (chrome.runtime.lastError) finish(offlineFailure(WORKER_SILENT_MESSAGE));
    });
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (reply: CollectContextReply | CollectPageContextReply) => void) => {
    if (isCaptureResultMessage(message)) {
      const outcome = parseCaptureResult(message);
      if (outcome) finish(outcome);
      return false;
    }
    if (isCollectContextMessage(message)) {
      sendResponse(collectContextReply(message.selectionText));
      return false;
    }
    if (isCollectPageContextMessage(message)) {
      const context = readPageCollectionContext();
      const reply: CollectPageContextReply = {
        ...context,
        ...(message.imageHref ? { imageAltText: readImageAltText(message.imageHref) } : {}),
      };
      sendResponse(reply);
      return false;
    }
    return false;
  });

  const applySettings = (next: ExtensionSettings): void => {
    settings = next;
    observer.setRules(rulesFor(next));
  };

  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== 'sync') return;
    void loadSettings(syncArea()).then(applySettings);
  });

  void loadSettings(syncArea()).then(applySettings);
}

start();
