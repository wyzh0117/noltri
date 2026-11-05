import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NoteInterpretationPanel} from ${JSON.stringify(fileURLToPath(new URL('./NoteInterpretationPanel.tsx', import.meta.url)))};
let root,calls,waiters,opts,content,path,returns,safety;
const reportSafety=safe=>safety.push(safe);
const api={interpretNote:async request=>{calls.push(structuredClone(request));if(opts.delay)return await new Promise(resolve=>waiters.push(resolve));return {text:'原文只说明元组不可变。',model:'synthetic-question'};}};
function render(){root.render(<><textarea aria-label="synthetic source draft" defaultValue="Unsaved source draft."/><NoteInterpretationPanel api={api} onUpdateSafetyChange={reportSafety} content={content} path={path} onReturnToSource={()=>{returns++;document.querySelector('[aria-label="synthetic source draft"]').focus({preventScroll:true});}}/></>);}
window.harness={
 mount(o={}){root?.unmount();opts=o;content=o.content??'Unsaved source draft.';path='Inbox/Example.md';calls=[];waiters=[];returns=0;safety=[];root=createRoot(document.getElementById('root'));render();},
 edit(value){const el=document.querySelector('[aria-label="原文问题"]');if(!el)throw Error('Missing question input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 click(label){const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===label||el.getAttribute('aria-label')===label);if(!button)throw Error('Missing action '+label);button.click();},
 source(value,nextPath='Inbox/Example.md'){content=value;path=nextPath;render();},
 resolve(text,index=0){const [resolve]=waiters.splice(index,1);if(!resolve)throw Error('No pending question');resolve({text,model:'synthetic-question'});},
 unmount(){root?.unmount();root=undefined;},safety:()=>safety,
 state(){return {calls,returns,content,safety,text:document.body.innerText,question:document.querySelector('[aria-label="原文问题"]')?.value,questionDisabled:[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='根据原文回答')?.disabled,sourceDraft:document.querySelector('[aria-label="synthetic source draft"]').value};}
};
`;

let chrome: ChildProcess | undefined;
let profile: string | undefined;
let socket: WebSocket | undefined;
let session: string;
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
function cdp(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate<T = any>(expression: string): Promise<T> {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 3_000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw Error('Timed out waiting for isolated question UI: ' + JSON.stringify(value!));
}
const state = () => evaluate<any>('window.harness.state()');
const edit = (question: string) => evaluate(`window.harness.edit(${JSON.stringify(question)})`);
const click = (label: string) => evaluate(`window.harness.click(${JSON.stringify(label)})`);
async function mount(options: object = {}) {
  await evaluate(`window.harness.mount(${JSON.stringify(options)})`);
  await until(state, value => value.text.includes('通俗解释'));
}

describe('explicit source-grounded question React flow', () => {
  beforeAll(async () => {
    const binary = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
    if (!binary) throw Error('Installed Chrome/Chromium required for isolated React tests.');
    const bundle = await build({ stdin: { contents: harness, loader: 'tsx', resolveDir: fileURLToPath(new URL('../..', import.meta.url)) }, bundle: true, write: false, jsx: 'automatic', format: 'iife', loader: { '.css': 'empty' } });
    profile = await mkdtemp(join(tmpdir(), 'noltri-note-question-test-'));
    chrome = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--proxy-server=http://127.0.0.1:9', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const port = await until(async () => { try { return (await readFile(join(profile!, 'DevToolsActivePort'), 'utf8')).split('\n'); } catch { return []; } }, value => value.length >= 2, 10_000);
    socket = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(Error('Cannot connect owned headless test process')); });
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (!message.id) return; const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(Error(message.error.message)); else waiter?.resolve(message.result); };
    const target = await cdp('Target.createTarget', { url: 'about:blank' });
    session = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await cdp('Page.setDocumentContent', { frameId: (await cdp('Page.getFrameTree', {}, session)).frameTree.frame.id, html: '<!doctype html><div id="root"></div>' }, session);
    await evaluate(bundle.outputFiles[0]!.text);
  }, 20_000);
  afterAll(async () => {
    socket?.close();
    if (chrome?.exitCode === null) { const exited = new Promise<void>(resolve => chrome!.once('exit', () => resolve())); chrome.kill('SIGTERM'); await exited; }
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  it('does not call on mount or typing, blocks an empty question and submits the exact question only on click', async () => {
    await mount();
    expect((await state()).calls).toEqual([]);
    expect((await state()).questionDisabled).toBe(true);
    await edit('  ');
    await click('根据原文回答');
    expect((await state()).calls).toEqual([]);
    await edit('  What stays fixed?  ');
    await until(state, value => value.questionDisabled === false);
    expect((await state()).calls).toEqual([]);
    await click('根据原文回答');
    const result = await until(state, value => value.text.includes('原文只说明元组不可变。'));
    expect(result.calls).toEqual([{ mode: 'question', sourceText: 'Unsaved source draft.', question: '  What stays fixed?  ' }]);
    expect(result.text).toContain('本次问题：');
    expect(result.text).toContain('What stays fixed?');
    expect(result.question).toBe('  What stays fixed?  ');
    await click('返回原文');
    const returned = await state();
    expect(returned.returns).toBe(1);
    expect(returned.sourceDraft).toBe('Unsaved source draft.');
  });

  it('invalidates a pending answer when question intent changes, including changing back to the old text', async () => {
    await mount({ delay: true });
    await edit('First question?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 1);
    await edit('Second question?'); await edit('First question?');
    await evaluate('window.harness.resolve("Stale first answer")');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect((await state()).text).not.toContain('Stale first answer');
    expect((await state()).question).toBe('First question?');
    expect((await state()).calls).toHaveLength(1);
  });

  it('keeps a new submitted question separate from an older response and never relabels the answer after editing', async () => {
    await mount({ delay: true });
    await edit('First question?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 1);
    await edit('Second question?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 2);
    await evaluate('window.harness.resolve("Stale first answer")');
    await evaluate('window.harness.resolve("Second source answer")');
    const result = await until(state, value => value.text.includes('Second source answer'));
    expect(result.text).toContain('Second question?');
    expect(result.text).not.toContain('Stale first answer');
    await edit('Third question?');
    await until(state, value => !value.text.includes('Second source answer'));
    expect((await state()).calls).toHaveLength(2);
  });

  it.each(['body', 'path'])('drops late results on a source %s change and preserves the unsubmitted question draft', async (kind) => {
    await mount({ delay: true });
    await edit('What stays fixed?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 1);
    await evaluate(`window.harness.source(${JSON.stringify(kind === 'body' ? 'New source.' : 'Unsaved source draft.')},${JSON.stringify(kind === 'path' ? 'Inbox/Other.md' : 'Inbox/Example.md')})`);
    await evaluate('window.harness.resolve("Stale source answer")');
    await new Promise(resolve => setTimeout(resolve, 60));
    const result = await state();
    expect(result.text).not.toContain('Stale source answer');
    expect(result.question).toBe('What stays fixed?');
    expect(result.calls).toHaveLength(1);
    expect(result.sourceDraft).toBe('Unsaved source draft.');
  });

  it('reports a question draft unsafe until successfully submitted, preserves completed safety when clearing a result, and releases on unmount', async () => {
    await mount();
    await until(state, value => value.safety.at(-1) === true);
    await edit('What stays fixed?');
    await until(state, value => value.safety.at(-1) === false);
    await click('根据原文回答');
    await until(state, value => value.text.includes('原文只说明元组不可变。') && value.safety.at(-1) === true);
    await click('清除结果');
    expect((await state()).safety.at(-1)).toBe(true);
    await evaluate('window.harness.source("New current source.")');
    await until(state, value => value.safety.at(-1) === false);
    expect((await state()).question).toBe('What stays fixed?');
    await evaluate('window.harness.unmount()');
    const reports = await evaluate<boolean[]>('window.harness.safety()');
    expect(reports.at(-1)).toBe(true);
    expect(reports.every(value => typeof value === 'boolean')).toBe(true);
  });

  it('keeps an invalidated pending request unsafe after clearing the question until its actual completion', async () => {
    await mount({ delay: true });
    await edit('What stays fixed?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 1);
    await edit('');
    const pending = await until(state, value => value.question === '');
    expect(pending.safety.at(-1)).toBe(false);
    await evaluate('window.harness.resolve("Discard this answer")');
    const settled = await until(state, value => value.safety.at(-1) === true);
    expect(settled.text).not.toContain('Discard this answer');
  });

  it('does not report safe when a newer answer completes before an older invalidated request', async () => {
    await mount({ delay: true });
    await edit('First question?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 1);
    await edit('Second question?'); await click('根据原文回答');
    await until(state, value => value.calls.length === 2);
    await evaluate('window.harness.resolve("Second answer",1)');
    const newResult = await until(state, value => value.text.includes('Second answer'));
    expect(newResult.safety.at(-1)).toBe(false);
    await evaluate('window.harness.resolve("Old answer")');
    const settled = await until(state, value => value.safety.at(-1) === true);
    expect(settled.text).toContain('Second answer');
    expect(settled.text).not.toContain('Old answer');
    await edit('Changed after completion?');
    await until(state, value => value.safety.at(-1) === false);
  });

});
