import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { unstable_batchedUpdates } from 'react-dom';
import { EditorView } from '@codemirror/view';
import type { NoteInterpretationRequest, NoteInterpretationResponse } from '@noltri/schema';
import type { WorkbenchApi } from '../src/workbench/api';
import { WorkbenchNotes } from '../src/workbench/WorkbenchNotes';
import '../src/workbench/notes-workbench.css';

const noteA = ['# 合成笔记 A', ...Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 段合成正文，用于检查滚动位置与当前编辑缓冲。`)].join('\n\n');
const noteB = '# 合成笔记 B\n\n这是另一篇完全合成的笔记。';
const longNote = 'x'.repeat(20_001);
const emptyNote = '  \n\t  ';
const noteContents = new Map([
  ['Synthetic/A.md', noteA],
  ['Synthetic/B.md', noteB],
  ['Synthetic/Long.md', longNote],
  ['Synthetic/Empty.md', emptyNote],
]);
const ledger: {
  interpretations: Array<{ id: number; request: NoteInterpretationRequest; resolve: (value: NoteInterpretationResponse) => void; reject: (reason: Error) => void }>;
  saves: Array<{ path: string; content: string }>;
  chats: unknown[];
  unexpected: string[];
  nextBehavior: 'resolve' | 'hold' | 'reject';
  nextId: number;
} = { interpretations: [], saves: [], chats: [], unexpected: [], nextBehavior: 'resolve', nextId: 1 };

function noteFile(path: string, content = noteContents.get(path) ?? '') {
  return { path, content, mtime: 1, size: content.length, etag: `synthetic-${path}-${content.length}`, metadata: { frontmatter: { title: path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? path } } };
}

const apiMethods = {
  vaultSnapshot: async () => ({ rootPath: 'Synthetic Vault', files: [...noteContents].map(([path, content]) => ({ path, name: path.split('/').at(-1), kind: 'file' as const, extension: 'md', size: content.length, frontmatter: { title: path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? path } })), revision: 1 }),
  vaultFile: async (path: string) => noteFile(path),
  vaultSettings: async () => ({ newLinkFormat: 'shortest' as const, propertyTypes: {} }),
  vaultMetadata: async (path: string) => ({ path, metadata: noteFile(path).metadata }),
  vaultBacklinks: async () => ({ revision: 1, backlinks: [] }),
  vaultMentions: async () => ({ mentions: [] }),
  vaultHistory: async () => ({ versions: [] }),
  vaultChanges: async () => ({ revision: 1, reset: false, events: [] }),
  vaultDiagnostics: async () => ({ indexing: false, failedFiles: [], queued: 0 }),
  interpretNote: (request: NoteInterpretationRequest): Promise<NoteInterpretationResponse> => {
    const id = ledger.nextId++;
    const behavior = ledger.nextBehavior;
    ledger.nextBehavior = 'resolve';
    return new Promise((resolve, reject) => {
      ledger.interpretations.push({ id, request: structuredClone(request), resolve, reject });
      if (behavior === 'resolve') queueMicrotask(() => resolve({ text: `合成${request.mode}结果：${request.sourceText.slice(0, 32)}`, model: 'synthetic-provider' }));
      if (behavior === 'reject') queueMicrotask(() => reject(new Error('合成 provider 失败')));
    });
  },
  saveVaultFile: async (input: { path: string; content: string }) => {
    ledger.saves.push({ path: input.path, content: input.content });
    noteContents.set(input.path, input.content);
    return noteFile(input.path, input.content);
  },
};
const syntheticApi = new Proxy(apiMethods, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    if (property === 'then') return undefined;
    return (...args: unknown[]) => {
      const name = String(property);
      if (/chat|conversation/iu.test(name)) ledger.chats.push({ name, args });
      else ledger.unexpected.push(name);
      return Promise.resolve({ results: [], events: [], paths: [], versions: [], backlinks: [], mentions: [], revision: 1, reset: false });
    };
  },
}) as unknown as WorkbenchApi;

function Harness() {
  const [mounted, setMounted] = useState(true);
  const [requestedOpen, setRequestedOpen] = useState({ path: 'Synthetic/A.md', intent: { newTab: false, split: false }, id: 1 });
  const requestId = useRef(1);
  const [status, setStatus] = useState('Synthetic API · no external access');
  const rootPath = 'Synthetic Vault';

  const openPath = (path: string): void => {
    requestId.current += 1;
    setRequestedOpen({ path, intent: { newTab: false, split: false }, id: requestId.current });
    setStatus(`opened ${path}`);
  };

  useEffect(() => {
    (window as any).__noteInterpretationHarness = {
      ledger,
      setNextBehavior: (behavior: 'resolve' | 'hold' | 'reject') => { ledger.nextBehavior = behavior; },
      resolve: (id: number, text = `late synthetic result ${id}`) => ledger.interpretations.find((entry) => entry.id === id)?.resolve({ text, model: 'synthetic-provider' }),
      reject: (id: number, message = 'synthetic provider failed') => ledger.interpretations.find((entry) => entry.id === id)?.reject(new Error(message)),
      clear: () => { ledger.interpretations = []; ledger.saves = []; ledger.chats = []; ledger.unexpected = []; ledger.nextBehavior = 'resolve'; },
      getState: () => ({ mounted, requestedOpen, saves: ledger.saves, chats: ledger.chats, unexpected: ledger.unexpected, interpretations: ledger.interpretations.map(({ id, request }) => ({ id, request })) }),
      setStatus,
    };
  }, [mounted, requestedOpen]);

  return <main className="sidebar-harness">
    <header className="sidebar-harness-controls">
      <button type="button" onClick={() => openPath('Synthetic/A.md')}>打开 A</button>
      <button type="button" onClick={() => openPath('Synthetic/B.md')}>切换到 B</button>
      <button type="button" onClick={() => openPath('Synthetic/Long.md')}>打开超长笔记</button>
      <button type="button" onClick={() => openPath('Synthetic/Empty.md')}>打开空笔记</button>
      <button type="button" onClick={() => setMounted((value) => !value)}>{mounted ? '关闭工作台' : '重新打开工作台'}</button>
      <span className="sidebar-harness-status" aria-live="polite">{status}</span>
    </header>
    <section className="sidebar-harness-main" aria-label="合成工作台">
      {mounted ? <WorkbenchNotes
        api={syntheticApi}
        active={true}
        requestedOpen={requestedOpen}
        scopePaths={null}
        scopeTitle={null}
        libraryView="organize"
        tagQuery={null}
        vaultTagCounts={new Map()}
        onContextChange={() => undefined}
        onVaultDocumentsChanged={() => undefined}
      /> : <p>工作台已关闭</p>}
    </section>
    <pre id="replay-output" aria-label="回放结果" />
  </main>;
}

function visibleButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label && item.offsetParent !== null);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`找不到可见按钮：${label}`);
  return button;
}
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${description}`);
}
function check(checks: Array<{ name: string; passed: boolean; detail?: string }>, name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

async function runReplay(): Promise<{ exitCode: number; checks: Array<{ name: string; passed: boolean; detail?: string }>; error?: string }> {
  const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
  const harness = (window as any).__noteInterpretationHarness;
  const writeOutput = (value: unknown): void => { document.querySelector('#replay-output')!.textContent = JSON.stringify(value, null, 2); };
  try {
    await waitFor(() => document.body.textContent?.includes('合成笔记 A') ?? false, 'A 笔记加载');
    visibleButton('解读').click();
    await waitFor(() => document.querySelector('.vault-interpretation-panel') !== null, '打开解读侧栏');
    check(checks, '翻译与通俗解释有明确入口', document.body.textContent?.includes('翻译为简体中文') === true && document.body.textContent?.includes('通俗解释') === true);
    check(checks, '普通笔记点击不触发解读', ledger.interpretations.length === 0);

    harness.clear();
    harness.setNextBehavior('hold');
    const explain = visibleButton('通俗解释');
    unstable_batchedUpdates(() => { explain.click(); explain.click(); });
    await waitFor(() => ledger.interpretations.length > 0, '同步重复调用请求');
    check(checks, '同一批同步重复调用只发出一次请求', ledger.interpretations.length === 1, `actual=${ledger.interpretations.length}`);
    check(checks, '请求期间动作禁用并显示 loading', explain.disabled && document.body.textContent?.includes('正在生成通俗解释') === true);
    for (const request of ledger.interpretations) request.resolve({ text: 'synthetic explanation', model: 'synthetic-provider' });
    await waitFor(() => document.querySelector('.vault-interpretation-result') !== null, '同步请求结果');

    const editorTab = visibleButton('源码');
    editorTab.click();
    await waitFor(() => editorTab.getAttribute('aria-selected') === 'true' && document.querySelector('.cm-content[contenteditable="true"]') !== null, '真实 NotesEditor 源码视图');
    const editor = document.querySelector<HTMLElement>('.cm-content[contenteditable="true"]')!;
    editor.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, `${noteA}\n\n未提交合成编辑`);
    await waitFor(() => document.querySelector('.vault-save-indicator')?.textContent?.includes('未保存') === true && document.body.textContent?.includes('未提交合成编辑') === true, '未提交编辑进入缓冲');
    harness.clear();
    harness.setNextBehavior('hold');
    visibleButton('通俗解释').click();
    await waitFor(() => ledger.interpretations.length === 1, '带草稿的解读请求');
    const draftRequest = ledger.interpretations[0]!.request;
    check(checks, '解读读取 NotesEditor 当前未提交 buffer', draftRequest.sourceText.endsWith('未提交合成编辑'));
    check(checks, '解读没有写笔记或聊天存储', ledger.saves.length === 0 && ledger.chats.length === 0);
    const editorScroller = editor.closest<HTMLElement>('.cm-scroller')!;
    const editorView = EditorView.findFromDOM(editor);
    if (editorView === null) throw new Error('找不到真实 CodeMirror EditorView');
    editorView.dispatch({ selection: { anchor: 20, head: 40 } });
    editorScroller.scrollTop = Math.min(360, editorScroller.scrollHeight);
    const editorScrollBeforeReturn = editorScroller.scrollTop;
    const selectionBeforeReturn = JSON.stringify(editorView.state.selection.ranges.map(({ from, to }) => [from, to]));
    check(checks, '测试前 NotesEditor 有有效选区和滚动位置', selectionBeforeReturn !== '[]' && editorScrollBeforeReturn > 0, `selection=${selectionBeforeReturn}; scroll=${editorScrollBeforeReturn}`);
    const staleDraftId = ledger.interpretations[0]!.id;
    unstable_batchedUpdates(() => {
      editorView.dispatch({ changes: { from: editorView.state.doc.length, insert: '\n\n同笔记内容已更新' } });
      harness.resolve(staleDraftId, 'same note stale response');
    });
    await waitFor(() => document.body.textContent?.includes('同笔记内容已更新') === true && document.querySelector('.vault-interpretation-panel')?.getAttribute('aria-busy') === 'false', '同笔记正文更新并解除旧 loading');
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    check(checks, '同笔记正文更新时迟到结果不会展示', document.querySelector('.vault-interpretation-result') === null && !document.body.textContent?.includes('same note stale response'));
    check(checks, '同笔记旧请求释放后新请求可用', visibleButton('通俗解释').disabled === false);
    harness.setNextBehavior('hold');
    visibleButton('通俗解释').click();
    await waitFor(() => ledger.interpretations.length === 2, '更新正文后的新解读请求');
    check(checks, '连续请求读取同笔记更新后的 buffer', ledger.interpretations[1]!.request.sourceText.endsWith('同笔记内容已更新'));
    const draftId = ledger.interpretations[1]!.id;
    harness.resolve(draftId, 'draft derivative');
    await waitFor(() => document.body.textContent?.includes('draft derivative') === true, '草稿解读结果');
    const returnButton = visibleButton('返回原文');
    check(checks, '返回按钮说明保留当前原文位置', returnButton.getAttribute('aria-label') === '返回当前原文并保留位置');
    returnButton.click();
    await waitFor(() => document.activeElement === editor, '焦点返回 NotesEditor');
    check(checks, '返回原文保留源码模式及 CodeMirror 滚动', document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === '源码' && editorScroller.scrollTop === editorScrollBeforeReturn, `before=${editorScrollBeforeReturn}; after=${editorScroller.scrollTop}`);
    const selectionAfterReturn = JSON.stringify(editorView.state.selection.ranges.map(({ from, to }) => [from, to]));
    check(checks, '返回原文保留 CodeMirror 选区', selectionAfterReturn === selectionBeforeReturn, `before=${selectionBeforeReturn}; after=${selectionAfterReturn}`);
    check(checks, '返回原文仍保留未提交编辑 buffer', document.body.textContent?.includes('未提交合成编辑') === true && document.querySelector('.vault-save-indicator')?.textContent?.includes('未保存') === true);

    const readerTab = visibleButton('阅读');
    readerTab.click();
    await waitFor(() => readerTab.getAttribute('aria-selected') === 'true' && document.querySelector('.vault-reader-scroll') !== null, '阅读视图');
    const reader = document.querySelector<HTMLElement>('.vault-reader-scroll')!;
    reader.scrollTop = Math.min(520, reader.scrollHeight);
    const scrollBeforeReturn = reader.scrollTop;
    returnButton.click();
    await waitFor(() => document.activeElement === reader, '焦点返回 NoteReader');
    check(checks, '返回原文保留阅读模式和当前滚动位置', document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === '阅读' && reader.scrollTop === scrollBeforeReturn, `before=${scrollBeforeReturn}; after=${reader.scrollTop}`);
    check(checks, '返回原文仍保留未提交编辑 buffer', document.body.textContent?.includes('未提交合成编辑') === true);

    harness.clear();
    harness.setNextBehavior('hold');
    visibleButton('翻译为简体中文').click();
    await waitFor(() => ledger.interpretations.length === 1, '切换笔记前的延迟请求');
    const oldId = ledger.interpretations[0]!.id;
    visibleButton('切换到 B').click();
    await waitFor(() => document.body.textContent?.includes('合成笔记 B') === true && document.body.textContent?.includes('正在生成') !== true, '切换到 B 并解除 loading');
    harness.resolve(oldId, 'old note late response');
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    check(checks, '旧笔记迟到响应不串到新笔记', !document.body.textContent?.includes('old note late response') && !document.body.textContent?.includes('本次原文快照：Synthetic/A.md'));
    check(checks, '新笔记按钮不被旧 loading 锁住', visibleButton('翻译为简体中文').disabled === false);

    harness.clear();
    harness.setNextBehavior('hold');
    visibleButton('通俗解释').click();
    await waitFor(() => ledger.interpretations.length === 1, '切换侧栏前的延迟请求');
    const switchedId = ledger.interpretations[0]!.id;
    visibleButton('大纲').click();
    await waitFor(() => document.querySelector('.vault-interpretation-panel') === null, '切出解读面板');
    harness.resolve(switchedId, 'closed panel late response');
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    visibleButton('解读').click();
    await waitFor(() => document.body.textContent?.includes('翻译为简体中文') === true, '重新打开解读面板');
    check(checks, '切出侧栏后迟到响应不复现旧结果或 loading', !document.body.textContent?.includes('closed panel late response') && document.body.textContent?.includes('正在生成') !== true);

    harness.clear();
    harness.setNextBehavior('hold');
    visibleButton('翻译为简体中文').click();
    await waitFor(() => ledger.interpretations.length === 1, '关闭工作台前的延迟请求');
    const closedId = ledger.interpretations[0]!.id;
    visibleButton('关闭工作台').click();
    harness.resolve(closedId, 'unmounted late response');
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    visibleButton('重新打开工作台').click();
    await waitFor(() => document.body.textContent?.includes('合成笔记 B') === true, '重新挂载工作台');
    visibleButton('解读').click();
    await waitFor(() => document.body.textContent?.includes('翻译为简体中文') === true, '重开解读面板');
    check(checks, '关闭侧栏宿主后的迟到响应不更新新实例', !document.body.textContent?.includes('unmounted late response') && document.body.textContent?.includes('正在生成') !== true);

    harness.clear();
    harness.setNextBehavior('reject');
    visibleButton('翻译为简体中文').click();
    await waitFor(() => document.body.textContent?.includes('合成 provider 失败') === true, '合成 provider 失败提示');
    check(checks, '服务失败后显示错误且 loading 解除', !document.body.textContent?.includes('正在生成') && visibleButton('翻译为简体中文').disabled === false);
    check(checks, '错误恢复后再次请求可用', visibleButton('通俗解释').disabled === false);

    harness.clear();
    visibleButton('打开超长笔记').click();
    await waitFor(() => document.body.textContent?.includes('原文超过 20,000 字符上限') === true, '超长内容校验');
    check(checks, '超长输入不会发送请求', visibleButton('翻译为简体中文').disabled && visibleButton('通俗解释').disabled && ledger.interpretations.length === 0);
    visibleButton('打开空笔记').click();
    await waitFor(() => document.body.textContent?.includes('当前笔记没有正文') === true, '空内容校验');
    check(checks, '空输入不会发送请求', visibleButton('翻译为简体中文').disabled && visibleButton('通俗解释').disabled && ledger.interpretations.length === 0);

    const state = harness.getState();
    check(checks, '合成回放没有访问聊天/会话或未登记 API', state.chats.length === 0 && state.unexpected.length === 0, JSON.stringify({ chats: state.chats, unexpected: state.unexpected }));
    const failed = checks.find((item) => !item.passed);
    const result = { exitCode: failed === undefined ? 0 : 1, checks, ...(failed === undefined ? {} : { error: `${failed.name}${failed.detail === undefined ? '' : `: ${failed.detail}`}` }) };
    writeOutput(result);
    return result;
  } catch (cause) {
    const result = { exitCode: 1, checks, error: cause instanceof Error ? cause.message : String(cause) };
    writeOutput(result);
    return result;
  }
}

function attachRunner(): void {
  (window as any).__runNoteInterpretationReplay = runReplay;
}

attachRunner();
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
