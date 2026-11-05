import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConsoleBootView,loadDesktopSession} from ${JSON.stringify(fileURLToPath(new URL('./processing-console-boot.tsx',import.meta.url)))};
import {createProcessingConsoleCommands} from ${JSON.stringify(fileURLToPath(new URL('../lib/tauri.ts',import.meta.url)))};
let root,opts,calls,clients,release;
window.fetch=async()=>{calls.push(['http']);throw Error('No HTTP permitted')};
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
 calls.push([command]);
 if(command==='get_native_window_role')return 'processing-console';
 if(command==='get_processing_console_bootstrap')throw Error('/private/profile secret-token');
 if(command==='get_runtime_diagnostics'){
  if(opts.delay)await new Promise(r=>release=r);
  if(opts.failure){opts.failure=false;throw Error('/private/profile secret-token');}
  return {appPid:4455,generation:2,mode:'managed',status:opts.stopped?'stopped':'failed',shutdownConfirmed:!!opts.stopped,children:[{role:'core',pid:7788,generation:2,state:opts.stopped?'terminated':'observationFailed',exitCode:opts.stopped?1:null,killOutcome:'accepted',argv:'private argv secret-token'}],environment:'private environment secret-token'};
 }
 throw Error('Unexpected synthetic native command');
}};
window.harness={
 async mount(o={}){root?.unmount();opts=o;calls=[];clients=0;release=undefined;root=createRoot(document.getElementById('root'));try{const session=await loadDesktopSession(true,createProcessingConsoleCommands(),()=>{clients++;throw Error('No API construction permitted')});if(session.role!=='processing-console')throw Error('Unexpected role');root.render(<ConsoleBootView api={session.api}/>);}catch{root.render(<p>Boot rejected</p>)}},
 click(text){const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button)throw Error('Missing button '+text);button.click()},
 release(){opts.delay=false;release?.()},state:()=>({calls,clients,text:document.body.innerText})
};
`;
const browser=createReviewBrowser(harness,fileURLToPath(new URL('../..',import.meta.url)));
const {evaluate,until}=browser;
const state=()=>evaluate<any>('window.harness.state()');
const click=()=>evaluate("window.harness.click('刷新运行诊断')");
async function mount(options:object={}){await evaluate(`window.harness.mount(${JSON.stringify(options)})`);await until(state,s=>s.text.length>0);}
beforeAll(()=>browser.start(),30_000);afterAll(()=>browser.close());
describe('trusted processing console fallback after failed Core bootstrap',()=>{
 it('makes no API or automatic diagnostics call and lets the user explicitly inspect a failed runtime',async()=>{
  await mount();let s=await state();expect(s.text).toContain('Core 服务尚未就绪');expect(s.text).toContain('运行诊断尚未读取');
  expect(s.clients).toBe(0);expect(s.calls.map((c:string[])=>c[0])).toEqual(['get_native_window_role','get_processing_console_bootstrap']);
  for(const hidden of ['保存草稿','应用已保存草稿','刷新处理记录','重新加载并比较','secret-token','/private/profile'])expect(s.text).not.toContain(hidden);
  await click();await until(state,s=>s.text.includes('4455'));s=await state();expect(s.text).toContain('7788');expect(s.text).toContain('失败');expect(s.text).toContain('无法确认退出');
  for(const hidden of ['secret-token','private argv','private environment'])expect(s.text).not.toContain(hidden);
  expect(s.clients).toBe(0);expect(s.calls.filter((c:string[])=>c[0]==='get_runtime_diagnostics')).toHaveLength(1);expect(s.calls.filter((c:string[])=>c[0]==='get_processing_console_bootstrap')).toHaveLength(1);
 });
 it('keeps stopped runtime diagnostics available and serializes only explicit refreshes',async()=>{
  await mount({stopped:true,delay:true});expect((await state()).text).toContain('Core 服务尚未就绪');
  await evaluate("window.harness.click('刷新运行诊断');window.harness.click('刷新运行诊断')");expect((await state()).calls.filter((c:string[])=>c[0]==='get_runtime_diagnostics')).toHaveLength(1);
  await evaluate('window.harness.release()');await until(state,s=>s.text.includes('4455'));expect((await state()).text).toContain('已确认停止');expect((await state()).text).toContain('已退出');expect((await state()).clients).toBe(0);
 });
 it('shows generic refresh failures and only retries diagnostics on another explicit click',async()=>{
  await mount({failure:true});expect((await state()).text).toContain('Core 服务尚未就绪');await click();await until(state,s=>s.text.includes('无法读取运行诊断'));
  expect((await state()).text).not.toContain('secret-token');expect((await state()).calls.filter((c:string[])=>c[0]==='get_runtime_diagnostics')).toHaveLength(1);
  await click();await until(state,s=>s.text.includes('4455'));const s=await state();expect(s.calls.filter((c:string[])=>c[0]==='get_runtime_diagnostics')).toHaveLength(2);expect(s.calls.filter((c:string[])=>c[0]==='get_processing_console_bootstrap')).toHaveLength(1);expect(s.clients).toBe(0);expect(browser.errors).toEqual([]);
 });
});
