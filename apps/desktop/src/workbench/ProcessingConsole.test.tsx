import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessingConsole, type ProcessingConsoleApi } from './ProcessingConsole';

it('server-renders the independent management shell without making API calls',()=>{
  const html=renderToStaticMarkup(<ProcessingConsole api={{processingRules(){throw Error('SSR must not fetch')},processingRecords(){throw Error('SSR must not fetch')},saveProcessingRulesDraft(){throw Error('SSR must not save')},applyProcessingRules(){throw Error('SSR must not apply')},rollbackProcessingRules(){throw Error('SSR must not rollback')}} satisfies ProcessingConsoleApi}/>);
  expect(html).toContain('aria-label="处理规则与记录"');
  expect(html).toContain('aria-label="处理记录"');
  expect(html).toContain('关闭此窗口');
  expect(html).toContain('aria-label="运行诊断"');
  expect(html).toContain('运行诊断尚未读取');
});

const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProcessingConsole} from ${JSON.stringify(fileURLToPath(new URL('./ProcessingConsole.tsx', import.meta.url)))};
const rules=()=>({thresholds:{highConfidence:.75,mediumConfidence:.55,similarityAttachThreshold:.82,similaritySearchLimit:8,candidateNodeLimit:40,minNewNodeItemCount:1},extractionInstructions:'Saved extraction',classificationInstructions:'Saved classification'});
const snapshot=(n,r=rules())=>({versionId:'rules-'+n+'-abcdef123456',contentHash:'a'.repeat(64),createdAt:'2026-11-02T00:00:00Z',rules:structuredClone(r)});
let root,state,calls,opts,release;
async function mutate(kind,req){calls.push([kind,structuredClone(req)]);if(opts.delay)await new Promise(r=>{release=r});if(opts.stale){opts.stale=false;state.draft.revision=7;state.draft.rules.extractionInstructions='Remote edit';throw Object.assign(Error('secret request payload'),{status:409,code:'processing_rules_revision_conflict'});}if(opts.failure){opts.failure=false;throw Error('raw capture secret API key');}if(req.expectedRevision!==state.draft.revision)throw Error('wrong revision');}
const api={
 processingRules:async()=>{calls.push(['load']);if(opts.loadError){opts.loadError=false;throw Error('raw capture secret API key');}return structuredClone(state)},
 saveProcessingRulesDraft:async req=>{await mutate('save',req);state.draft={revision:state.draft.revision+1,rules:structuredClone(req.rules)};return structuredClone(state.draft)},
 applyProcessingRules:async req=>{await mutate('apply',req);state.applied=snapshot(3,state.draft.rules);state.versions.unshift(state.applied);return structuredClone({draft:state.draft,applied:state.applied})},
 rollbackProcessingRules:async req=>{await mutate('rollback',req);const old=state.versions.find(v=>v.versionId===req.versionId);state.applied=snapshot(4,old.rules);state.draft={revision:state.draft.revision+1,rules:structuredClone(old.rules)};state.versions.unshift(state.applied);return structuredClone({draft:state.draft,applied:state.applied})},
 processingRecords:async()=>{calls.push(['records']);if(opts.recordsError){opts.recordsError=false;throw Error('raw capture secret API key');}return {records:opts.empty?[]:[{recordId:'record-one',taskId:'task-one',ruleVersionId:'rules-1-abcdef123456',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:01:00Z',phase:'extracting',status:'failed',errorCode:'extraction_failed',rawText:'raw capture secret',image:'private-image',apiKey:'API key'}]}}
};
window.harness={
 mount(o={}){root?.unmount();opts=o;calls=[];release=undefined;const applied=snapshot(2);const older=snapshot(1,{...rules(),extractionInstructions:'Old extraction'});state={draft:{revision:5,rules:rules()},applied,versions:[applied,older]};if(o.inactiveThreshold!==undefined)state.draft.rules.thresholds.minNewNodeItemCount=o.inactiveThreshold;root=createRoot(document.getElementById('root'));root.render(<ProcessingConsole api={api} getRuntimeDiagnostics={async()=>{calls.push(['diagnostics']);if(opts.diagnosticsDelay)await new Promise(r=>release=r);if(opts.diagnosticsError){opts.diagnosticsError=false;throw Error('/private/profile secret-token');}return {appPid:opts.unknownDiagnostics?'secret-token':321,generation:2,mode:opts.unknownDiagnostics?'secret-token':opts.external?'external':'managed',status:opts.unknownDiagnostics?'secret-token':'managed',shutdownConfirmed:false,children:opts.external?[]:[{role:opts.unknownDiagnostics?'secret-token':'core',pid:654,generation:2,state:opts.unknownDiagnostics?'secret-token':'running',exitCode:null,exitSignal:null,killOutcome:opts.unknownDiagnostics?'secret-token':null,argv:'private argv secret-token'}],environment:'private environment secret-token'};}}/>);},
 click(t){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t||b.getAttribute('aria-label')===t);if(!b)throw Error('Missing button '+t);b.click()},
 edit(label,value){const el=document.querySelector('[aria-label="'+label+'"]');if(!el)throw Error('Missing field '+label);Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))},
 value:label=>document.querySelector('[aria-label="'+label+'"]').value,
 disabled:t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t)?.disabled,
 release(){opts.delay=false;release?.()},calls:()=>calls,text:()=>document.body.innerText
};
`;
let server: Server;
let chrome: ChildProcess;
let profile: string;
let socket: WebSocket;
let sessionId: string;
let requestId = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function cdp(method: string, params: object = {}, session?: string): Promise<any> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate<T = any>(expression: string): Promise<T> {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
  return response.result.value;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 2_000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw new Error('Timed out waiting for component state: ' + JSON.stringify(value!));
}

const text=()=>evaluate<string>('window.harness.text()');
const calls=()=>evaluate<any[]>('window.harness.calls()');
const click=(label:string)=>evaluate(`window.harness.click(${JSON.stringify(label)})`);
const edit=(label:string,value:string)=>evaluate(`window.harness.edit(${JSON.stringify(label)},${JSON.stringify(value)})`);
const value=(label:string)=>evaluate<string>(`window.harness.value(${JSON.stringify(label)})`);
const disabled=(label:string)=>evaluate<boolean>(`window.harness.disabled(${JSON.stringify(label)})`);
async function mount(options:object={}){await evaluate(`window.harness.mount(${JSON.stringify(options)})`);await until(text,t=>t.includes('草稿修订')||t.includes('无法加载规则'));}
describe('ProcessingConsole real React management flow',()=>{
  beforeAll(async () => {
    const binary = process.env.CHROME_BIN ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    ].find(existsSync);
    if (!binary) throw new Error('ProcessingConsole interaction tests require installed Chrome/Chromium; set CHROME_BIN.');
    const bundle = await build({ stdin: { contents: harness, loader: 'tsx', resolveDir: fileURLToPath(new URL('../..', import.meta.url)) }, bundle: true, write: false, jsx: 'automatic', format: 'esm', loader: { '.css': 'empty' } });
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><div id="root"></div><script type="module" src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = await mkdtemp(join(tmpdir(), 'noltri-processing-console-test-'));
    chrome = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const port = await until(async () => { try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); } catch { return []; } }, value => value.length >= 2, 10_000);
    socket = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(Error('Unable to connect isolated headless Chrome')); });
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(Error(message.error.message)); else waiter?.resolve(message.result);
    };
    const target = await cdp('Target.createTarget', { url: 'about:blank' });
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await cdp('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, sessionId);
    await until(() => evaluate<boolean>('!!window.harness'), Boolean, 5_000);
  }, 20_000);
  afterAll(async () => {
    if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => undefined);
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await new Promise<void>(resolve => { chrome.once('exit', () => resolve()); setTimeout(resolve, 2_000).unref(); });
    }
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    if (profile) await rm(profile, { recursive: true, force: true });
  });


  it('refreshes owned runtime diagnostics only on request and renders allowlisted metadata',async()=>{
    await mount(); expect((await calls()).filter(c=>c[0]==='diagnostics')).toHaveLength(0);
    expect(await text()).toContain('运行诊断尚未读取');await click('刷新运行诊断');await until(text,t=>t.includes('321'));
    for(const s of ['654','managed','running'])expect(await text()).toContain(s);
    for(const s of ['private argv','private environment','secret-token'])expect(await text()).not.toContain(s);
    expect((await calls()).filter(c=>c[0]==='diagnostics')).toHaveLength(1);
  });
  it('keeps diagnostic failures generic, serializes refresh and shows empty external ownership',async()=>{
    await mount({diagnosticsError:true});await click('刷新运行诊断');await until(text,t=>t.includes('无法读取运行诊断'));expect(await text()).not.toContain('secret-token');
    await click('刷新运行诊断');await until(text,t=>t.includes('654'));
    await mount({external:true,diagnosticsDelay:true});await evaluate("window.harness.click('刷新运行诊断');window.harness.click('刷新运行诊断')");
    expect((await calls()).filter(c=>c[0]==='diagnostics')).toHaveLength(1);await evaluate('window.harness.release()');await until(text,t=>t.includes('无自有子进程'));
  });
  it('maps unknown diagnostic enum and numeric values to generic labels',async()=>{
    await mount({unknownDiagnostics:true});await click('刷新运行诊断');await until(text,t=>t.includes('654'));
    expect(await text()).toContain('未知');expect(await text()).not.toContain('secret-token');
  });
  it('separates saved draft revision from applied version and shows task lifetime guidance',async()=>{
    await mount();expect(await text()).toContain('草稿修订 5');expect(await text()).toContain('rules-2-abcdef123456');
    expect(await text()).toContain('任务开始时');expect(await text()).toContain('关闭此窗口');
    expect(await value('提取指令')).toBe('Saved extraction');
  });
  it('saves edits without applying and applies only the saved revision',async()=>{
    await mount();await edit('提取指令','Local extraction');expect(await disabled('应用已保存草稿')).toBe(true);
    await click('保存草稿');await until(text,t=>t.includes('草稿修订 6'));
    expect(await text()).toContain('草稿已保存，尚未应用');expect(await text()).toContain('rules-2-abcdef123456');
    expect((await calls()).filter(c=>c[0]==='apply')).toHaveLength(0);
    expect((await calls()).find(c=>c[0]==='save')?.[1]).toMatchObject({expectedRevision:5,rules:{extractionInstructions:'Local extraction'}});
    await click('应用已保存草稿');await until(text,t=>t.includes('当前已应用版本：rules-3-abcdef123456'));
    expect((await calls()).find(c=>c[0]==='apply')?.[1]).toEqual({expectedRevision:6});
  });
  it('keeps unsaved local edits through explicit refresh until the user chooses a draft',async()=>{
    await mount();await edit('提取指令','Local survives reload');await click('重新加载并比较');
    await until(text,t=>t.includes('服务器草稿修订 5'));
    expect(await value('提取指令')).toBe('Local survives reload');expect(await disabled('保存草稿')).toBe(true);
    await click('使用服务器草稿替换本地编辑');expect(await value('提取指令')).toBe('Saved extraction');
  });
  it('rejects empty, out of range, fractional integer and overlong instruction input',async()=>{
    await mount();for(const [label,bad] of [['高置信阈值',''],['高置信阈值','1.1'],['相似结果数量','1.5'],['候选节点数量','201'],['新节点最少条目数','0'],['提取指令','x'.repeat(4001)],['分类指令','x'.repeat(4001)]]){
      await mount();await edit(label,bad);expect(await disabled('保存草稿')).toBe(true);await click('保存草稿');expect((await calls()).some(c=>c[0]==='save')).toBe(false);
    }
  });
  it('rolls back by immutable version id and displays a newly applied version',async()=>{
    await mount();await click('回滚到 rules-1-abcdef123456');await until(text,t=>t.includes('当前已应用版本：rules-4-abcdef123456'));
    expect(await value('提取指令')).toBe('Old extraction');expect((await calls()).find(c=>c[0]==='rollback')?.[1]).toEqual({versionId:'rules-1-abcdef123456',expectedRevision:5});
  });
  it('retains edits after conflict and requires explicit reload and comparison before retry',async()=>{
    await mount({stale:true});await edit('提取指令','Keep local');await click('保存草稿');await until(text,t=>t.includes('版本冲突'));
    expect(await value('提取指令')).toBe('Keep local');expect(await disabled('保存草稿')).toBe(true);
    await click('重新加载并比较');await until(text,t=>t.includes('Remote edit'));
    expect(await value('提取指令')).toBe('Keep local');expect(await disabled('保存草稿')).toBe(true);
    await click('保留本地编辑并使用新修订');await click('保存草稿');await until(text,t=>t.includes('草稿修订 8'));
    expect((await calls()).filter(c=>c[0]==='save').map(c=>c[1].expectedRevision)).toEqual([5,7]);
  });
  it('serializes apply and rollback even for immediate repeated clicks',async()=>{
    await mount({delay:true});await evaluate("window.harness.click('应用已保存草稿');window.harness.click('应用已保存草稿');window.harness.click('回滚到 rules-1-abcdef123456')");
    expect((await calls()).filter(c=>['apply','rollback'].includes(c[0]))).toHaveLength(1);
    await evaluate('window.harness.release()');await until(text,t=>t.includes('当前已应用版本：rules-3-abcdef123456'));
    await mount({delay:true});await evaluate("window.harness.click('回滚到 rules-1-abcdef123456');window.harness.click('回滚到 rules-1-abcdef123456');window.harness.click('应用已保存草稿')");
    expect((await calls()).filter(c=>['apply','rollback'].includes(c[0]))).toHaveLength(1);
    await evaluate('window.harness.release()');await until(text,t=>t.includes('当前已应用版本：rules-4-abcdef123456'));
  });
  it('renders allowlisted record metadata without raw captures, images or provider keys',async()=>{
    await mount();await until(text,t=>t.includes('record-one'));const t=await text();
    for(const s of ['task-one','rules-1-abcdef123456','extracting','failed','extraction_failed','2026-11-02T00:01:00Z'])expect(t).toContain(s);
    for(const s of ['raw capture secret','private-image','API key'])expect(t).not.toContain(s);
  });
  it('keeps empty and failed records truthful and refreshes only explicitly',async()=>{
    await mount({empty:true});await until(text,t=>t.includes('暂无处理记录'));expect(await text()).not.toContain('record-one');
    await mount({recordsError:true});await until(text,t=>t.includes('无法加载处理记录'));expect(await text()).not.toContain('API key');
    await click('刷新处理记录');await until(text,t=>t.includes('record-one'));
    expect((await calls()).filter(c=>c[0]==='records')).toHaveLength(2);
  });
  it('retains local edits on save failure and requires reload for uncertain mutation outcome',async()=>{
    await mount({failure:true});await edit('提取指令','Keep failed edit');await click('保存草稿');await until(text,t=>t.includes('操作未能确认'));
    expect(await value('提取指令')).toBe('Keep failed edit');expect(await text()).not.toContain('API key');expect(await disabled('保存草稿')).toBe(true);
  });
  it('recovers initial rule errors through explicit reload',async()=>{
    await mount({loadError:true});expect(await text()).not.toContain('API key');await click('重新加载并比较');await until(text,t=>t.includes('草稿修订 5'));
  });

  it('keeps the inactive threshold read-only while editable rules save its existing value unchanged',async()=>{
    await mount({inactiveThreshold:7});
    expect(await value('新节点最少条目数')).toBe('7');
    expect(await evaluate("document.querySelector('[aria-label=\"新节点最少条目数\"]').readOnly")).toBe(true);
    expect(await text()).toContain('保留配置，当前不参与处理决策');
    await evaluate("document.querySelector('[aria-label=\"新节点最少条目数\"]').focus()");
    await cdp('Input.insertText',{text:'9'},sessionId);
    expect(await value('新节点最少条目数')).toBe('7');
    const changes=[['高置信阈值','0.8'],['中置信阈值','0.6'],['相似归入阈值','0.9'],['相似结果数量','12'],['候选节点数量','45'],['提取指令','Edited extraction'],['分类指令','Edited classification']];
    for(const [label,next] of changes){
      expect(await evaluate(`(()=>{const el=document.querySelector('[aria-label="${label}"]');return el.readOnly||el.disabled;})()`)).toBe(false);
      await edit(label,next);expect(await value(label)).toBe(next);
    }
    await click('保存草稿');await until(text,t=>t.includes('草稿修订 6'));
    expect((await calls()).find(c=>c[0]==='save')?.[1]).toEqual({expectedRevision:5,rules:{thresholds:{highConfidence:.8,mediumConfidence:.6,similarityAttachThreshold:.9,similaritySearchLimit:12,candidateNodeLimit:45,minNewNodeItemCount:7},extractionInstructions:'Edited extraction',classificationInstructions:'Edited classification'}});
    expect((await calls()).filter(c=>c[0]==='apply')).toHaveLength(0);
    await click('应用已保存草稿');await until(text,t=>t.includes('当前已应用版本：rules-3-abcdef123456'));
    expect((await calls()).find(c=>c[0]==='apply')?.[1]).toEqual({expectedRevision:6});
    expect(await value('新节点最少条目数')).toBe('7');
  });

});
