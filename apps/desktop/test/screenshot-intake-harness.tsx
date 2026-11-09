import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CaptureAssetMime, CaptureBatchStatus } from '@noltri/schema';
import type { IntakeApi } from '../src/workbench/intake-session';
import { IntakeWindow } from '../src/workbench/IntakeWindow';
import type { IntakeActivation } from '../src/workbench/screenshot-entry';

const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const pngBinary = atob(pngData);
const pngBytes = Uint8Array.from(pngBinary, (value) => value.charCodeAt(0));
const pngMime: CaptureAssetMime = 'image/png';
const now = '2026-11-01T08:00:00.000Z';

function imageFile(name: string): File {
  return new File([pngBytes], name, { type: pngMime });
}

function savedBatch(batchId: string, sessionId: string, assetId: string, createdAt: string): CaptureBatchStatus {
  const items: CaptureBatchStatus['items'] = batchId === 'batch-a'
    ? [
      {
        requestId: 'a-later',
        kind: 'image',
        userOrder: 2,
        assetIds: ['original-a-2', 'derived-a'],
        derivedAssets: [{ assetId: 'derived-a', operation: 'stitch', sourceAssetIds: ['original-a', 'original-a-2'], direction: 'horizontal' }],
        status: 'assets_saved',
        duplicate: false,
        retryable: false,
        updatedAt: createdAt,
      },
      { requestId: 'a-text', kind: 'text', userOrder: 1, assetIds: [], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: createdAt },
      { requestId: 'a-first', kind: 'image', userOrder: 0, assetIds: [assetId], status: 'assets_saved', duplicate: false, retryable: false, updatedAt: createdAt },
    ]
    : [{
      requestId: batchId + '-image',
      kind: 'image',
      userOrder: 0,
      assetIds: [assetId],
      status: 'assets_saved',
      duplicate: false,
      retryable: false,
      updatedAt: createdAt,
    }];
  return {
    batchId,
    sessionId,
    createdAt,
    updatedAt: createdAt,
    items,
  };
}

interface HeldAssetRead {
  batchId: string;
  assetId: string;
  resolve: (value: Awaited<ReturnType<NonNullable<IntakeApi['readCaptureAsset']>>>) => void;
}

const ledger: {
  clipboardReads: number;
  captures: number;
  captureRequestIds: string[];
  listReads: number;
  assetReads: Array<{ batchId: string; assetId: string }>;
  submissions: number;
  uploads: number;
  failedList: boolean;
  failedAssetId: string | null;
  heldAssetId: string | null;
  heldAssetReads: HeldAssetRead[];
  createdUrls: string[];
  revokedUrls: string[];
  coalesced: number;
  rejectNextCapture: boolean;
  throwNextCapture: boolean;
  holdNextCapture: boolean;
  releaseHeldCapture: (() => void) | null;
} = {
  clipboardReads: 0,
  captures: 0,
  captureRequestIds: [],
  listReads: 0,
  assetReads: [],
  submissions: 0,
  uploads: 0,
  failedList: false,
  failedAssetId: null,
  heldAssetId: null,
  heldAssetReads: [],
  createdUrls: [],
  revokedUrls: [],
  coalesced: 0,
  rejectNextCapture: false,
  throwNextCapture: false,
  holdNextCapture: false,
  releaseHeldCapture: null,
};

const originalCreateObjectURL = URL.createObjectURL.bind(URL);
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob: Blob): string => {
  const url = originalCreateObjectURL(blob);
  ledger.createdUrls.push(url);
  return url;
};
URL.revokeObjectURL = (url: string): void => {
  ledger.revokedUrls.push(url);
  originalRevokeObjectURL(url);
};

const batchA = savedBatch('batch-a', 'session-a', 'original-a', '2026-11-01T09:00:00.000Z');
const batchB = savedBatch('batch-b', 'session-b', 'original-b', '2026-10-31T09:00:00.000Z');

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function assetResult(batchId: string, assetId: string) {
  const bytes = pngBytes.slice();
  return {
    asset: {
      assetId,
      sessionId: batchId === 'batch-a' ? 'session-a' : 'session-b',
      mimeType: pngMime,
      byteLength: bytes.byteLength,
      sha256: await digest(bytes),
      createdAt: now,
    },
    bytes,
  };
}

const api: IntakeApi = {
  uploadCaptureAsset: async (input) => {
    ledger.uploads += 1;
    return { duplicate: false, asset: { assetId: input.assetId, sessionId: input.sessionId, mimeType: input.mimeType, byteLength: input.bytes.byteLength, sha256: input.sha256, createdAt: now } };
  },
  createCaptureBatch: async (request) => {
    ledger.submissions += 1;
    return { duplicate: false, batch: { batchId: request.batchId, sessionId: request.sessionId, items: [], createdAt: now, updatedAt: now } };
  },
  getCaptureBatchStatus: async (batchId) => batchId === batchA.batchId ? batchA : batchB,
  retryCaptureBatchItem: async (batchId) => batchId === batchA.batchId ? batchA : batchB,
  listCaptureBatches: async () => {
    ledger.listReads += 1;
    if (ledger.failedList) throw new Error('synthetic list denial');
    return { batches: [batchA, batchB] };
  },
  readCaptureAsset: (batchId, assetId) => {
    ledger.assetReads.push({ batchId, assetId });
    if (ledger.failedAssetId === assetId) return Promise.reject(new Error('synthetic asset denial'));
    if (ledger.heldAssetId === assetId) {
      return new Promise((resolve) => ledger.heldAssetReads.push({ batchId, assetId, resolve }));
    }
    return assetResult(batchId, assetId);
  },
};

function Harness() {
  const [activation, setActivation] = useState<IntakeActivation | null>(null);
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState('synthetic clipboard/API only · no Tauri or external API');
  const activeRequest = useRef<string | null>(null);
  const intakeBusy = useRef(false);
  const nextRequest = useRef(1);
  const [activationError, setActivationError] = useState<{ requestId: string; message: string } | null>(null);

  function activate(action: Exclude<IntakeActivation['action'], 'selectedText'>): void {
    const requestId = 'browser-' + nextRequest.current++;
    acceptActivation({ action, requestId });
  }

  function acceptActivation(request: IntakeActivation): void {
    if (activeRequest.current !== null || intakeBusy.current) {
      ledger.coalesced += 1;
      setStatus('duplicate activation coalesced');
      setActivationError({ requestId: request.requestId, message: '收集窗口正在处理上一项操作；未启动新的截图。' });
      return;
    }
    setActivationError(null);
    activeRequest.current = request.requestId;
    setActivation(request);
  }

  function fireShortcut(requestId: string): void {
    acceptActivation({ action: 'capture', requestId });
  }

  function complete(requestId: string): void {
    if (activeRequest.current !== requestId) return;
    activeRequest.current = null;
    setActivation(null);
  }

  useEffect(() => {
    (window as unknown as { __screenshotIntakeHarness: unknown }).__screenshotIntakeHarness = {
      ledger,
      runReplay,
      fireShortcut,
      releaseHeldCapture: () => ledger.releaseHeldCapture?.(),
      releaseHeldAsset: async () => {
        const held = ledger.heldAssetReads.splice(0);
        for (const read of held) read.resolve(await assetResult(read.batchId, read.assetId));
        ledger.heldAssetId = null;
      },
      getState: () => ({
        activation,
        open,
        clipboardReads: ledger.clipboardReads,
        captures: ledger.captures,
        captureRequestIds: [...ledger.captureRequestIds],
        listReads: ledger.listReads,
        assetReads: ledger.assetReads,
        submissions: ledger.submissions,
        uploads: ledger.uploads,
        heldAssetReads: ledger.heldAssetReads.length,
        createdUrls: [...ledger.createdUrls],
        revokedUrls: [...ledger.revokedUrls],
      }),
    };
  }, [activation, open]);

  return <main className="library-shell harness-shell" data-theme="light">
    <header className="harness-controls">
      <button type="button" onClick={() => activate('openIntake')}>测试：显式打开并读取剪贴板</button>
      <button type="button" onClick={() => activate('capture')}>测试：触发截图快捷键</button>
      <button type="button" onClick={() => { activate('capture'); activate('capture'); }}>测试：重复截图请求</button>
      <button type="button" onClick={() => setOpen(true)}>重新打开收集窗口</button>
      <span className="harness-status" aria-live="polite">{status}</span>
    </header>
    {open ? <IntakeWindow
      api={api}
      paths={[]}
      onClose={() => setOpen(false)}
      onPersisted={() => setStatus('synthetic batch submitted')}
      onBusyChange={(busy) => { intakeBusy.current = busy; }}
      screenshotAdapter={{
        capture: async (requestId) => {
          ledger.captures += 1;
          ledger.captureRequestIds.push(requestId);
          if (ledger.holdNextCapture) {
            ledger.holdNextCapture = false;
            await new Promise<void>((resolve) => { ledger.releaseHeldCapture = resolve; });
          }
          if (ledger.throwNextCapture) {
            ledger.throwNextCapture = false;
            throw new Error('synthetic capture exception');
          }
          const image = ledger.rejectNextCapture
            ? new File([new Uint8Array([0])], 'rejected-capture.png', { type: pngMime })
            : imageFile('synthetic-capture.png');
          ledger.rejectNextCapture = false;
          return { status: 'captured', image, clipboardCopied: false };
        },
      }}
      clipboardAdapter={{
        snapshot: async () => {
          ledger.clipboardReads += 1;
          return { status: 'available', text: '合成剪贴板原文用于验证自动导入。', image: imageFile('synthetic-clipboard.png') };
        },
      }}
      activation={activation}
      activationError={activationError}
      shortcutStatus={{ screenshot: 'registered', openIntake: 'registered' }}
      onRequestActivation={acceptActivation}
      onActivationComplete={complete}
    /> : <p>收集窗口已关闭。</p>}
    <pre id="harness-result" aria-label="回放结果" />
  </main>;
}

function check(checks: Array<{ name: string; passed: boolean; detail?: string }>, name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error('等待超时：' + description);
}

function batchButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.intake-saved-batch-list button')];
}

function assetButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.intake-saved-assets > li button')];
}

async function runReplay(): Promise<{ exitCode: number; checks: Array<{ name: string; passed: boolean; detail?: string }>; error?: string }> {
  const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
  const write = (value: unknown): void => { document.querySelector('#harness-result')!.textContent = JSON.stringify(value, null, 2); };
  try {
    await waitFor(() => document.querySelector<HTMLButtonElement>('.harness-controls button') !== null, 'React harness mount');
    ledger.clipboardReads = 0;
    ledger.captures = 0;
    ledger.captureRequestIds = [];
    ledger.listReads = 0;
    ledger.assetReads = [];
    ledger.submissions = 0;
    ledger.uploads = 0;
    ledger.heldAssetReads = [];
    ledger.createdUrls = [];
    ledger.revokedUrls = [];
    ledger.coalesced = 0;
    ledger.failedList = false;
    ledger.failedAssetId = null;
    ledger.heldAssetId = null;
    ledger.throwNextCapture = false;
    ledger.holdNextCapture = false;
    ledger.releaseHeldCapture = null;

    document.querySelector<HTMLButtonElement>('.harness-controls button')!.click();
    await waitFor(() => ledger.clipboardReads === 1 && document.querySelectorAll('.intake-image-row').length === 1, 'explicit clipboard import');
    await waitFor(() => {
      const preview = document.querySelector<HTMLImageElement>('.intake-annotation-stage img');
      return preview !== null && preview.complete && preview.naturalWidth > 0;
    }, 'annotation preview decodes the imported image');
    await waitFor(() => document.querySelector<HTMLButtonElement>('.intake-capture-screen')?.disabled === false, 'clipboard import completes');
    const text = document.querySelector<HTMLTextAreaElement>('#intake-original-text')?.value ?? '';
    check(checks, 'explicit panel open snapshots clipboard once and imports text/image', ledger.clipboardReads === 1 && text.includes('合成剪贴板原文'));
    check(checks, 'imported image decodes in the annotation editor preview', document.querySelector<HTMLImageElement>('.intake-annotation-stage img')?.naturalWidth === 1);

    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => ledger.captures === 1 && document.querySelectorAll('.intake-image-row').length === 2, 'screenshot append');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'first capture activation completes');
    check(checks, 'screenshot appends to the same queue without a second clipboard read', ledger.clipboardReads === 1 && ledger.captures === 1);
    check(checks, 'screenshot with clipboardCopied=false is still admitted', document.body.textContent?.includes('复制到剪贴板失败') === true);

    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => ledger.captures === 2 && document.querySelectorAll('.intake-image-row').length === 3, 'capture again after the first request completes');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'second capture activation completes');
    check(checks, 'a later button click after screenshot success starts a fresh request and appends another image', ledger.clipboardReads === 1 && ledger.captures === 2 && document.querySelectorAll('.intake-image-row').length === 3);
    check(checks, 'button-generated request IDs reach the capture adapter unchanged', ledger.captureRequestIds.length === 2 && ledger.captureRequestIds.every((requestId) => requestId.startsWith('ui-')));

    const fireShortcut = (window as unknown as { __screenshotIntakeHarness: { fireShortcut: (requestId: string) => void } }).__screenshotIntakeHarness.fireShortcut;
    fireShortcut('intake-hotkey-after-success');
    fireShortcut('intake-hotkey-duplicate');
    await waitFor(() => ledger.captures === 3 && document.querySelectorAll('.intake-image-row').length === 4, 'global activation after the later button capture');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'global capture activation completes');
    check(checks, 'a global activation after button success is accepted and duplicate delivery is coalesced', ledger.coalesced === 1 && ledger.captures === 3 && ledger.clipboardReads === 1);
    check(checks, 'global hotkey request ID reaches the capture adapter unchanged', ledger.captureRequestIds[2] === 'intake-hotkey-after-success');
    check(checks, 'screenshot does not infer a webpage source', document.querySelector<HTMLSelectElement>('#intake-source-type')?.value === 'manual' && document.querySelector<HTMLInputElement>('#intake-source-url')?.value === '');

    const imageCountBeforeBusyCapture = document.querySelectorAll('.intake-image-row').length;
    ledger.holdNextCapture = true;
    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => ledger.releaseHeldCapture !== null, 'hold screenshot callback');
    fireShortcut('intake-hotkey-during-capture');
    await waitFor(() => document.querySelector('.intake-capture-notice')?.textContent?.includes('未启动新的截图') === true, 'visible busy feedback for a hotkey intercepted during capture');
    const releaseHeldCapture = ledger.releaseHeldCapture as (() => void) | null;
    releaseHeldCapture?.();
    ledger.releaseHeldCapture = null;
    await waitFor(() => document.querySelectorAll('.intake-image-row').length === imageCountBeforeBusyCapture + 1, 'held capture enqueued after release');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'held screenshot activation completes');
    check(checks, 'hotkey busy rejection is visible and the active screenshot still enqueues', document.querySelectorAll('.intake-image-row').length === imageCountBeforeBusyCapture + 1);

    ledger.throwNextCapture = true;
    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => [...document.querySelectorAll('.intake-error')].some((error) => error.textContent?.includes('synthetic capture exception') === true), 'capture exception shown');
    await waitFor(() => document.querySelector<HTMLButtonElement>('.intake-capture-screen')?.disabled === false, 'busy state released after capture exception');
    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => document.querySelectorAll('.intake-image-row').length === imageCountBeforeBusyCapture + 2, 'capture retry after exception');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'capture retry activation completes');
    check(checks, 'capture exception releases busy state and a later retry succeeds', document.querySelectorAll('.intake-image-row').length === imageCountBeforeBusyCapture + 2);

    ledger.rejectNextCapture = true;
    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => document.querySelector('.intake-pending-screenshot strong')?.textContent === 'rejected-capture.png', 'retain rejected capture');
    const files = new DataTransfer();
    for (let index = 0; index < 96; index += 1) files.items.add(imageFile('capacity-' + index + '.png'));
    const input = document.querySelector<HTMLInputElement>('[aria-label="添加图片文件"]')!;
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.intake-image-row').length === 99, 'fill the active batch while the screenshot stays pending');
    await waitFor(() => input.disabled === false, 'capacity image validation completes');
    const clipboardReadsBeforeBlockedOpen = ledger.clipboardReads;
    document.querySelector<HTMLButtonElement>('.harness-controls button')!.click();
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'blocked open activation acknowledgement');
    await waitFor(() => document.querySelector('.intake-capture-notice')?.textContent?.includes('待处理图片已保留') === true, 'pending screenshot open guard notice');
    check(checks, 'explicit open with a pending original and full queue preserves the original and does not read clipboard',
      ledger.clipboardReads === clipboardReadsBeforeBlockedOpen
        && document.querySelector('.intake-pending-screenshot strong')?.textContent === 'rejected-capture.png'
        && document.body.textContent?.includes('待处理图片已保留') === true);
    check(checks, 'blocked open leaves the current panel unlocked after activation acknowledgement',
      document.querySelector<HTMLTextAreaElement>('#intake-original-text')?.disabled === false);
    document.querySelector<HTMLButtonElement>('.harness-controls button')!.click();
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'second blocked open acknowledgement');
    check(checks, 'a later explicit open is accepted by the coordinator but also preserves pending data without a clipboard read',
      ledger.clipboardReads === clipboardReadsBeforeBlockedOpen
        && document.querySelector('.intake-pending-screenshot strong')?.textContent === 'rejected-capture.png');
    document.querySelector<HTMLButtonElement>('.intake-pending-screenshot button:last-child')!.click();
    await waitFor(() => document.querySelector('.intake-pending-screenshot') === null, 'discard retained malformed synthetic capture');

    const historyButton = document.querySelector<HTMLButtonElement>('.intake-history-button')!;
    ledger.failedList = true;
    historyButton.click();
    await waitFor(() => document.body.textContent?.includes('synthetic list denial') === true, 'list rejection shown');
    check(checks, 'list rejection is visible in the read-only viewer', document.querySelector('.intake-saved-batches') !== null);
    document.querySelector<HTMLButtonElement>('.intake-saved-heading button:nth-child(2)')!.click();
    await waitFor(() => document.querySelector<HTMLTextAreaElement>('#intake-original-text')?.value.includes('合成剪贴板原文') === true, 'return to the same draft');
    check(checks, 'opening and closing the saved viewer retains the current draft', document.querySelectorAll('.intake-image-row').length === 99);
    ledger.failedList = false;
    historyButton.click();
    await waitFor(() => batchButtons().length === 2, 'saved batch list loads');

    batchButtons()[1]!.click();
    await waitFor(() => document.querySelector('.intake-saved-batch-detail') !== null, 'select second batch');
    ledger.failedAssetId = 'original-b';
    assetButtons()[0]!.click();
    await waitFor(() => document.body.textContent?.includes('synthetic asset denial') === true, 'asset rejection shown');
    check(checks, 'asset rejection is visible without a submit call', ledger.submissions === 0 && ledger.uploads === 0);
    ledger.failedAssetId = null;

    const beforeSavedPreview = ledger.createdUrls.length;
    batchButtons()[1]!.click();
    assetButtons()[0]!.click();
    await waitFor(() => document.querySelector('.intake-saved-preview img') !== null, 'saved asset preview');
    const secondBatchUrl = document.querySelector<HTMLImageElement>('.intake-saved-preview img')!.src;
    check(checks, 'saved original preview is read-only and does not resubmit', ledger.submissions === 0 && ledger.uploads === 0);
    document.querySelector<HTMLButtonElement>('.intake-saved-assets button')!.click();
    await waitFor(() => document.querySelector('.intake-saved-preview img') === null, 'hide preview');
    check(checks, 'hiding preview revokes its object URL', ledger.createdUrls.length === beforeSavedPreview + 1 && ledger.revokedUrls.includes(secondBatchUrl));

    batchButtons()[0]!.click();
    await waitFor(() => buildVisibleAssociationText().includes('来源：第 1 张 → 第 2 张'), 'select first batch with derived source association');
    check(checks, 'saved batch displays originals and derived source association in userOrder order',
      buildVisibleAssociationText().includes('原图 1') && buildVisibleAssociationText().includes('原图 2')
        && buildVisibleAssociationText().includes('拼接派生图') && buildVisibleAssociationText().includes('来源：第 1 张 → 第 2 张'));
    ledger.heldAssetId = 'original-a';
    assetButtons()[0]!.click();
    await waitFor(() => ledger.heldAssetReads.length === 1, 'hold first batch asset');
    batchButtons()[1]!.click();
    await waitFor(() => batchButtons()[1]?.getAttribute('aria-pressed') === 'true', 'switch to second batch');
    assetButtons()[0]!.click();
    await waitFor(() => document.querySelector('.intake-saved-preview img') !== null, 'load second batch while first read is pending');
    const visibleBatchBUrl = document.querySelector<HTMLImageElement>('.intake-saved-preview img')!.src;
    const urlsBeforeLateRead = ledger.createdUrls.length;
    const late = (window as unknown as { __screenshotIntakeHarness: { releaseHeldAsset: () => Promise<void> } }).__screenshotIntakeHarness.releaseHeldAsset;
    await late();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    check(checks, 'late binary from a previously selected batch cannot replace the current preview or create a URL',
      document.querySelector<HTMLImageElement>('.intake-saved-preview img')?.src === visibleBatchBUrl && ledger.createdUrls.length === urlsBeforeLateRead);

    document.querySelector<HTMLButtonElement>('.intake-saved-heading button:nth-child(2)')!.click();
    await waitFor(() => document.querySelector('.intake-saved-batches') === null, 'return from batch history');
    ledger.heldAssetId = 'original-a';
    document.querySelector<HTMLButtonElement>('.intake-history-button')!.click();
    await waitFor(() => batchButtons().length === 2, 'reopen batch history');
    batchButtons()[0]!.click();
    await waitFor(() => document.querySelector('.intake-saved-batch-detail') !== null, 'select batch before closing panel');
    assetButtons()[0]!.click();
    await waitFor(() => ledger.heldAssetReads.length === 1, 'hold asset before closing panel');
    const urlCountBeforeClose = ledger.createdUrls.length;
    document.querySelector<HTMLButtonElement>('[aria-label="关闭收集窗口"]')!.click();
    await waitFor(() => document.querySelector('.intake-window') === null, 'close intake panel');
    await (window as unknown as { __screenshotIntakeHarness: { releaseHeldAsset: () => Promise<void> } }).__screenshotIntakeHarness.releaseHeldAsset();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    check(checks, 'late binary after panel close is discarded without creating a URL', ledger.createdUrls.length === urlCountBeforeClose);
    check(checks, 'closing the saved viewer revoked its active preview URL', ledger.revokedUrls.includes(visibleBatchBUrl));
    check(checks, 'no saved batch preview path invokes upload or submit', ledger.uploads === 0 && ledger.submissions === 0);

    const capturesBeforeReopen = ledger.captures;
    document.querySelector<HTMLButtonElement>('.harness-controls button:nth-child(4)')!.click();
    await waitFor(() => document.querySelector('.intake-window') !== null, 'reopen the intake window');
    document.querySelector<HTMLButtonElement>('.intake-capture-screen')!.click();
    await waitFor(() => ledger.captures === capturesBeforeReopen + 1 && document.querySelectorAll('.intake-image-row').length === 1, 'capture after close and reopen');
    await waitFor(() => (window as unknown as { __screenshotIntakeHarness: { getState: () => { activation: IntakeActivation | null } } }).__screenshotIntakeHarness.getState().activation === null, 'reopened capture activation completes');
    check(checks, 'closing and reopening does not leave stale activation or busy state', ledger.captures === capturesBeforeReopen + 1 && document.querySelectorAll('.intake-image-row').length === 1);
    document.querySelector<HTMLButtonElement>('[aria-label="关闭收集窗口"]')!.click();
  } catch (error) {
    const result = { exitCode: 1, checks, error: error instanceof Error ? error.message : String(error) };
    write(result);
    return result;
  }
  const result = { exitCode: checks.every((entry) => entry.passed) ? 0 : 1, checks };
  write(result);
  return result;
}

function buildVisibleAssociationText(): string {
  return document.querySelector('.intake-saved-batch-detail')?.textContent ?? '';
}

(window as unknown as { __screenshotIntakeHarness: unknown }).__screenshotIntakeHarness = { ledger, runReplay };
createRoot(document.getElementById('root')!).render(<Harness />);
if (new URLSearchParams(window.location.search).get('autoplay') === '1') {
  window.addEventListener('load', () => {
    void runReplay().then((result) => {
      document.documentElement.dataset.replayExit = String(result.exitCode);
      document.title = 'Screenshot Intake harness result ' + result.exitCode;
    });
  }, { once: true });
}
