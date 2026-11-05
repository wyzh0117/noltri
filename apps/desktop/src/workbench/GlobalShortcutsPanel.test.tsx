import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ModelSettings from ${JSON.stringify(fileURLToPath(new URL('./ModelSettings.tsx', import.meta.url)))};
let root,opts,calls,safety,status,release,doneCalls;
const defaults=()=>({screenshot:{key:'S',control:true,alt:true,shift:false,meta:true},openIntake:{key:'V',control:true,alt:true,shift:false,meta:true}});
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
 calls.push([command,structuredClone(args)]);
 if(command==='get_intake_shortcut_status'){if(opts.loadDelay)await new Promise(r=>release=r);if(opts.loadError){opts.loadError=false;throw Error('/private/profile secret-token');}return structuredClone(status);}
 if(command==='save_intake_shortcuts'){if(opts.delay)await new Promise(r=>release=r);if(opts.failure){opts.failure=false;throw opts.failureCode??'/private/profile secret-token';}status={screenshot:'registered',openIntake:'registered',bindings:structuredClone(args.bindings),configurationError:null};return structuredClone(status);}
 throw Error('Unexpected synthetic command '+command);
}};
const settings={apiBaseUrl:'http://127.0.0.1:1',apiToken:'synthetic-only',mcpEndpoint:'',providers:[],activeProviderId:null,activeModelId:null,runtimeStatus:'managed'};
const onSaved=()=>{throw Error('No model mutation expected')};
const reportSafety=s=>safety.push(s);
function OnboardingHost(){const [entered,setEntered]=React.useState(false);return entered?<section aria-label="synthetic knowledge workspace">已进入知识库</section>:<ModelSettings settings={settings} outsideTauri={!!opts.outside} welcome onSaved={onSaved} onUpdateSafetyChange={reportSafety} onDone={()=>{doneCalls++;setEntered(true)}}/>;}

window.harness={
 mount(o={}){root?.unmount();opts=o;calls=[];safety=[];doneCalls=0;release=undefined;status={screenshot:'registered',openIntake:'registered',bindings:defaults(),configurationError:o.configurationError??null};root=createRoot(document.getElementById('root'));root.render(o.onboarding?<OnboardingHost/>:<ModelSettings settings={settings} outsideTauri={!!o.outside} onSaved={onSaved} onUpdateSafetyChange={reportSafety}/>);},
 click(t){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);if(!b)throw Error('Missing button '+t);b.click()},
 letter(label,value){const e=document.querySelector('[aria-label="'+label+'"]');if(!e)throw Error('Missing letter '+label);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}))},
 toggle(label){const e=document.querySelector('[aria-label="'+label+'"]');if(!e)throw Error('Missing modifier '+label);e.click()},
 state:()=>({calls,doneCalls,entered:!!document.querySelector('[aria-label="synthetic knowledge workspace"]'),doneDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='进入知识库 →')?.disabled,safe:safety.at(-1),text:document.body.innerText,screenshot:document.querySelector('[aria-label="截图字母"]')?.value,openIntake:document.querySelector('[aria-label="打开收集字母"]')?.value,ready:!document.querySelector('[aria-label="截图字母"]')?.closest('fieldset').disabled,saveDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存快捷键')?.disabled}),
 release(){opts.delay=false;opts.loadDelay=false;release?.()},unmount(){root?.unmount();root=undefined;}
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
const state = () => evaluate<any>('window.harness.state()');
const click = (text: string) => evaluate(`window.harness.click(${JSON.stringify(text)})`);
const letter = (label: string, value: string) => evaluate(`window.harness.letter(${JSON.stringify(label)},${JSON.stringify(value)})`);
const toggle = (label: string) => evaluate(`window.harness.toggle(${JSON.stringify(label)})`);
async function mount(options: object = {}) { await evaluate(`window.harness.mount(${JSON.stringify(options)})`); await until(state,s=>s.text.includes('全局快捷键')); }
beforeAll(()=>browser.start(),30_000); afterAll(()=>browser.close());
describe('global shortcut settings in provider management',()=>{
 it('loads actual bindings and only persists an explicit letter/modifier selection on save',async()=>{
  await mount();await until(state,s=>s.screenshot==='S'&&s.safe===true);
  await letter('截图字母','Q');await toggle('截图 Shift');
  expect((await state()).safe).toBe(false);expect((await state()).calls.filter((c:any[])=>c[0]==='save_intake_shortcuts')).toHaveLength(0);
  expect((await state()).text).toContain('当前截图：⌃⌥⌘S');await click('保存快捷键');
  const saved=await until(state,s=>s.safe===true&&s.text.includes('当前截图：⌃⌥⇧⌘Q'));
  expect(saved.calls.find((c:any[])=>c[0]==='save_intake_shortcuts')[1]).toEqual({bindings:{screenshot:{key:'Q',control:true,alt:true,shift:true,meta:true},openIntake:{key:'V',control:true,alt:true,shift:false,meta:true}}});
 });
 it('requires two modifiers and distinct combinations before sending a native save',async()=>{
  await mount();await until(state,s=>s.screenshot==='S');await toggle('截图 Control');await toggle('截图 Option');
  expect((await state()).text).toContain('至少选择两个修饰键');expect((await state()).saveDisabled).toBe(true);
  await click('保存快捷键');expect((await state()).calls.some((c:any[])=>c[0]==='save_intake_shortcuts')).toBe(false);
  await mount();await until(state,s=>s.screenshot==='S');await letter('截图字母','V');expect((await state()).text).toContain('两个快捷键不能相同');expect((await state()).saveDisabled).toBe(true);
 });
 it('retains draft and actual labels on conflict and retries only explicitly',async()=>{
  await mount({failure:true,failureCode:'shortcut_conflict'});await until(state,s=>s.screenshot==='S');await letter('截图字母','Q');await click('保存快捷键');
  await until(state,s=>s.text.includes('快捷键冲突'));let s=await state();expect(s.screenshot).toBe('Q');expect(s.safe).toBe(false);expect(s.text).toContain('当前截图：⌃⌥⌘S');
  expect(s.calls.filter((c:any[])=>c[0]==='save_intake_shortcuts')).toHaveLength(1);await click('保存快捷键');await until(state,s=>s.safe===true&&s.text.includes('当前截图：⌃⌥⌘Q'));
 });
 it('keeps update safety blocked during save, including unchanged registration retries',async()=>{
  await mount({delay:true});await until(state,s=>s.safe===true);await click('重新注册当前快捷键');await until(state,s=>s.safe===false);
  await evaluate("window.harness.click('重新注册当前快捷键');window.harness.click('保存快捷键')");expect((await state()).calls.filter((c:any[])=>c[0]==='save_intake_shortcuts')).toHaveLength(1);
  await evaluate('window.harness.release()');await until(state,s=>s.safe===true);
 });
 it('maps unknown failures safely and supports explicit load recovery',async()=>{
  await mount({loadError:true});await until(state,s=>s.text.includes('无法读取快捷键'));expect((await state()).text).not.toContain('secret-token');
  await click('重新读取快捷键');await until(state,s=>s.screenshot==='S');await letter('截图字母','Q');await evaluate('window.harness.state()');
  await mount({failure:true});await until(state,s=>s.screenshot==='S');await letter('截图字母','Q');await click('保存快捷键');await until(state,s=>s.text.includes('快捷键未能保存'));
  expect((await state()).text).not.toContain('/private');expect((await state()).text).not.toContain('secret-token');expect((await state()).safe).toBe(false);
 });
 it('keeps a failed unchanged registration retry unsafe until its outcome is confirmed',async()=>{
  await mount({failure:true});await until(state,s=>s.safe===true);await click('重新注册当前快捷键');await until(state,s=>s.text.includes('快捷键未能保存'));expect((await state()).safe).toBe(false);
  await click('重新注册当前快捷键');await until(state,s=>s.safe===true);
 });
 it('explicitly cancels shortcut drafts without changing native bindings',async()=>{
  await mount();await until(state,s=>s.safe===true&&s.ready);await letter('截图字母','Q');await until(state,s=>s.safe===false);
  await click('取消快捷键更改');await until(state,s=>s.safe===true);expect((await state()).screenshot).toBe('S');
  expect((await state()).calls.some((c:any[])=>c[0]==='save_intake_shortcuts')).toBe(false);
 });
 it('keeps a local draft through explicit status refresh and never releases pending safety on unmount',async()=>{
  await mount();await until(state,s=>s.ready&&s.safe===true);await letter('截图字母','Q');await until(state,s=>s.safe===false);
  await click('重新读取快捷键');await until(state,s=>s.ready);expect((await state()).screenshot).toBe('Q');expect((await state()).text).toContain('当前截图：⌃⌥⌘S');expect((await state()).safe).toBe(false);
  await mount({delay:true});await until(state,s=>s.ready&&s.safe===true);await click('重新注册当前快捷键');await until(state,s=>s.safe===false);await evaluate('window.harness.unmount();window.harness.release()');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');expect((await state()).safe).toBe(false);expect(browser.errors).toEqual([]);
 });
 it('does not let a provider draft override shortcut draft safety',async()=>{
  await mount();await until(state,s=>s.safe===true);await letter('截图字母','Q');await click('＋ 添加 Provider');await click('Custom model API');await click('取消添加');expect((await state()).safe).toBe(false);
 });
 it('disables native actions outside the desktop and ignores completion after unmount',async()=>{
  await mount({outside:true});expect((await state()).calls).toEqual([]);expect((await state()).saveDisabled).toBe(true);
  await mount({loadDelay:true});await evaluate('window.harness.unmount();window.harness.release()');await mount();await until(state,s=>s.safe===true);expect(browser.errors).toEqual([]);
 });
});


describe('onboarding respects composed settings safety before onDone unmounts the panel',()=>{
 it('keeps a dirty shortcut draft mounted until explicit cancellation restores safe completion',async()=>{
  await mount({onboarding:true});await until(state,s=>s.ready&&s.safe===true);
  expect((await state()).doneDisabled).toBe(false);await letter('截图字母','Q');await until(state,s=>s.safe===false);
  expect((await state()).doneDisabled).toBe(true);await click('进入知识库 →');expect((await state()).doneCalls).toBe(0);expect((await state()).entered).toBe(false);expect((await state()).screenshot).toBe('Q');
  await click('取消快捷键更改');await until(state,s=>s.safe===true&&s.doneDisabled===false);await click('进入知识库 →');await until(state,s=>s.entered);expect((await state()).doneCalls).toBe(1);
 });
 it.each(['unchanged retry','draft save'])('keeps onboarding mounted while a %s is pending and allows completion after confirmed success',async kind=>{
  await mount({onboarding:true,delay:true});await until(state,s=>s.ready&&s.safe===true);
  if(kind==='draft save'){await letter('截图字母','Q');await click('保存快捷键');}else await click('重新注册当前快捷键');
  await until(state,s=>s.safe===false&&s.calls.some((c:any[])=>c[0]==='save_intake_shortcuts'));
  expect((await state()).doneDisabled).toBe(true);await click('进入知识库 →');expect((await state()).doneCalls).toBe(0);expect((await state()).entered).toBe(false);
  await evaluate('window.harness.release()');await until(state,s=>s.safe===true&&s.doneDisabled===false&&s.text.includes('快捷键已保存'));
  if(kind==='draft save')expect((await state()).text).toContain('当前截图：⌃⌥⌘Q');
  await click('进入知识库 →');await until(state,s=>s.entered);expect((await state()).doneCalls).toBe(1);
 });
 it.each(['unchanged retry','draft save'])('blocks onboarding after an unconfirmed failed %s until an explicit status read confirms recovery',async kind=>{
  await mount({onboarding:true,failure:true});await until(state,s=>s.ready&&s.safe===true);
  if(kind==='draft save'){await letter('截图字母','Q');await click('保存快捷键');}else await click('重新注册当前快捷键');
  await until(state,s=>s.safe===false&&s.text.includes('快捷键未能保存'));
  expect((await state()).doneDisabled).toBe(true);await click('进入知识库 →');expect((await state()).doneCalls).toBe(0);expect((await state()).entered).toBe(false);
  if(kind==='draft save'){await click('取消快捷键更改');await until(state,s=>s.screenshot==='S');expect((await state()).safe).toBe(false);expect((await state()).doneDisabled).toBe(true);}
  await click('重新读取快捷键');await until(state,s=>s.ready&&s.safe===true&&s.doneDisabled===false);await click('进入知识库 →');await until(state,s=>s.entered);expect((await state()).doneCalls).toBe(1);
 });
});
