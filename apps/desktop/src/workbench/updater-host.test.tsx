import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';
const harness = String.raw`
import React,{useState} from 'react';
import YAML from 'yaml';
import {EditorView} from '@codemirror/view';
import ModelSettings from ${JSON.stringify(fileURLToPath(new URL('./ModelSettings.tsx', import.meta.url)))};
import {WorkbenchNotes} from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchNotes.tsx', import.meta.url)))};
import { createRoot } from 'react-dom/client';
import WorkbenchApp from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchApp.tsx', import.meta.url)))};
let root,calls,source,generation,rememberedNotes,holdItem,pendingItem,itemSettled,held,pending,files,safety,nativeCalls,holdNative,pendingNative,propertyTypes,emptyProviders;
const provider={id:'synthetic',name:'Synthetic provider',protocol:'openai-completions',baseUrl:'https://example.invalid/v1',hasApiKey:false,models:[{id:'synthetic-model',name:'Synthetic model',contextWindow:null,maxTokens:null,input:{text:true,image:false}}]};
const settings={apiBaseUrl:'http://127.0.0.1:1',apiToken:'synthetic-only',mcpEndpoint:'',providers:[provider],activeProviderId:null,activeModelId:null,runtimeStatus:'managed'};
const content='---\nconfig:\n  answer: 1\n---\n# Synthetic property note\nOriginal body stays\n';
const file=(path,text)=>({path,content:text,mtime:1,ctime:1,size:text.length,etag:'etag-'+text.length,metadata:{frontmatter:YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1]??'')??{},headings:[],links:[],tags:[],blocks:{}}});
let shortcutStatus,shortcutReadError;const shortcutEvents=new Map();
let callbackId=0;const callbacks=new Map();
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{nativeCalls.push(command);if(command==='plugin:event|listen'){shortcutEvents.set(args.event,args.handler);return args.handler;}if(command==='plugin:event|unlisten'||command==='trace_capture_stage')return;if(command==='get_intake_shortcut_status'){if(shortcutReadError)throw Error('/private/profile secret-token');return structuredClone(shortcutStatus);}if(command==='snapshot_system_clipboard')return {status:'empty'};if(command==='save_intake_shortcuts'){if(holdNative)await new Promise(resolve=>pendingNative=resolve);shortcutStatus.bindings=structuredClone(args.bindings);return structuredClone(shortcutStatus);}if(command==='check_native_update')return {status:'available'};if(command==='download_native_update')return {status:'downloaded'};if(command==='install_native_update')return {status:'installed'};if(command==='fetch_available_models'){if(holdNative)await new Promise(resolve=>{pendingNative=resolve;});return [];}throw Error('Unexpected synthetic native command: '+command);},transformCallback:callback=>{callbacks.set(++callbackId,callback);return callbackId;}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
function Host(){const [safe,setSafe]=useState(!emptyProviders);return <WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint="" tokenConfigured={false} outsideTauri={false} modelSettingsUpdateSafe={safe} modelSettings={<ModelSettings settings={emptyProviders?{...settings,providers:[]}:settings} outsideTauri={false} onSaved={()=>{}} onUpdateSafetyChange={setSafe}/>}/>;}

let clipboardReads=[];
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
 read:async()=>{clipboardReads.push('read');throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 readText:async()=>{clipboardReads.push('readText');throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 write:async()=>{throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 writeText:async()=>{throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
}});
const initial = ()=>({id:'source-original',userId:'synthetic-user',rawText:'Original source body for direct detail',surroundingContext:null,sourceType:'manual',sourcePlatform:null,sourceApp:'Synthetic fixture',sourceTitle:'Synthetic source',sourceUrl:null,capturedAt:'2026-11-02T00:00:00Z',metadata:{},processingStatus:'done',errorReason:null,createdAt:'2026-11-02T00:00:00Z',requestId:null,clientId:null,reviewStatus:'needs_review',reviewRevision:0});
const known = {
 tree:async()=>({rootId:null,totalNodes:1,nodes:[{id:'subject-a',title:'Synthetic subject',nodeType:'discipline',summary:null,status:'active',confidence:null,itemCount:0,descendantItemCount:0,childCount:0,children:[]}]}),
 health:async()=>({status:'ok',productId:'synthetic-test',instanceId:'synthetic-test',protocolVersion:'1',version:'0',storageDriver:'memory',storage:{driver:'memory',ok:true,detail:{}},aiProvider:'disabled',embeddingDim:0,requiresAiKey:false}),
 listItems:async()=>({items:[{id:'source-other',content:'Synthetic other original',summary:null,kind:'knowledge',source:{type:'manual',title:'Other synthetic source',url:null,platform:null,appName:null,capturedAt:'2026-11-02T00:00:00Z',citation:null,page:null,author:null,doi:null},previewImageUrl:null,subjectPath:[],researchPoint:null,tags:[],aiStatus:'ready',createdAt:'2026-11-02T00:00:00Z',archived:false}],limit:200,offset:0}),
 vaultSnapshot:async()=>({rootPath:'/synthetic-review-vault',files:Object.values(files).map(f=>({path:f.path,name:f.path.split('/').at(-1),kind:'file',extension:'md',mtime:1,size:f.size})),revision:0}),
 vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:structuredClone(propertyTypes)}),
 updateVaultSettings:async next=>{propertyTypes=structuredClone(next.propertyTypes);return {newLinkFormat:next.newLinkFormat,propertyTypes:structuredClone(propertyTypes)};},
 vaultDiagnostics:async()=>({revision:0,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),
 vaultChanges:async()=>({revision:0,reset:false,events:[]}),
 inbox:async(query={})=>({entries:query.reviewStatus&&query.reviewStatus!==source.reviewStatus?[]:[{...source,sourceTitle:'Synthetic source '+generation,textPreview:source.rawText.slice(0,20),rawTextLength:source.rawText.length}],counts:{pending:0,processing:0,done:1,failed:0},reviewCounts:{needs_review:source.reviewStatus==='needs_review'?1:0,deferred:0,rejected:0,confirmed:source.reviewStatus==='confirmed'?1:0},limit:50,offset:0}),
 rawSource:async id=>{if(id!==source.id)throw Error('Wrong raw source identity');return structuredClone(source);},
 reviewSource:async(id,request)=>{if(id!==source.id)throw Error('Wrong review identity');source.reviewStatus='confirmed';source.reviewRevision++;return {reviewStatus:'confirmed',reviewRevision:source.reviewRevision,duplicate:false,item:{id:'knowledge-created',rawSourceId:source.id,userId:'synthetic-user',normalizedText:request.editedText,summary:null,confidence:1,status:'active',isAiDerived:false,createdAt:source.createdAt,updatedAt:source.createdAt}};},
 item:async id=>{if(id!==source.id)throw Error('KnowledgeItem ID must not be sent to LibraryItem detail');if(holdItem){try{await new Promise((resolve,reject)=>{pendingItem={resolve,reject};});}finally{itemSettled=true;}}return {id:source.id,content:source.rawText,summary:null,kind:'knowledge',source:{type:'manual',title:'Original source detail',url:null,platform:null,appName:'Synthetic fixture',capturedAt:source.capturedAt,citation:null,page:null,author:null,doi:null},previewImageUrl:null,subjectPath:[],researchPoint:null,tags:[],aiStatus:'ready',createdAt:source.createdAt,archived:false};},
 vaultFile:async path=>structuredClone(files[path]),vaultMetadata:async path=>({path,metadata:files[path].metadata}),vaultBacklinks:async()=>({revision:0,backlinks:[]}),vaultMentions:async()=>({mentions:[]}),vaultHistory:async()=>({versions:[]}),
 saveVaultFile:async request=>{files[request.path]=file(request.path,request.content);return structuredClone(files[request.path]);},
 patchItem:async(id,request)=>({item:await known.item(id)}),
 createItemRelation:async()=>({relation:{targetId:'source-other',relation:'related',direction:'outgoing',createdAt:'2026-11-02T00:00:00Z'}}),
 listItemRelations:async()=>[],
 listCaptureBatches:async()=>({batches:[]}),
 selectGraph:async()=>({nodes:[],edges:[],scopeGraphNodeId:null}),
};
const api=new Proxy({}, {get(_target,name){return (...args)=>{calls.push([String(name),...structuredClone(args)]);if(!(name in known))return Promise.reject(Error('Unexpected fake API call: '+String(name)));if(held===String(name)){return new Promise((resolve,reject)=>{pending={resolve:()=>Promise.resolve(known[name](...args)).then(resolve,reject),reject};});}return known[name](...args);};}});
function NotesTestHarness(){const [panelContent,setPanelContent]=useState(null);const [tool,setTool]=useState('properties');const onPanelContentChange=React.useCallback(content=>setPanelContent(content),[]);return <><WorkbenchNotes api={api} active requestedOpen={{path:'Synthetic/Properties.md',intent:{newTab:false,split:false},id:1}} scopePaths={null} scopeTitle={null} libraryView="all" tagQuery={null} vaultTagCounts={new Map()} onContextChange={()=>{}} onUpdateSafetyChange={value=>safety.push(value)} onRightPanelContentChange={onPanelContentChange} onRequestToolChange={setTool}/><nav role="tablist" aria-label="测试正文工具"><button type="button" role="tab" aria-selected={tool==='properties'} onClick={()=>setTool('properties')}>来源与属性</button><button type="button" role="tab" aria-selected={tool==='outline'} onClick={()=>setTool('outline')}>大纲</button></nav><div>{panelContent?.toolPanels[tool]??null}</div></>;}
window.harness={
 mount(kind='host',secondYaml=false){root?.unmount();emptyProviders=kind==='empty-host';calls=[];nativeCalls=[];safety=[];shortcutReadError=false;shortcutEvents.clear();shortcutStatus={screenshot:'registered',openIntake:'registered',bindings:{screenshot:{key:'S',control:true,alt:true,shift:false,meta:true},openIntake:{key:'V',control:true,alt:true,shift:false,meta:true}}};held=null;pending=null;holdNative=false;pendingNative=null;propertyTypes={config:'yaml',other:'yaml'};files=kind==='notes'?{'Synthetic/Properties.md':file('Synthetic/Properties.md',secondYaml?content.replace('---\n#','other:\n  answer: 10\n---\n#'):content)}:{};generation=1;source=initial();rememberedNotes=null;holdItem=false;pendingItem=null;itemSettled=false;clipboardReads=[];localStorage.clear();root=createRoot(document.getElementById('root'));root.render(kind==='notes'?<NotesTestHarness/>:<Host/>);},
 hold(name){held=name;}, release(){held=null;pending.resolve();pending=null;},
 nativeCalls:()=>nativeCalls, preflightHeld:()=>!!pending,
 holdProvider(){holdNative=true;}, releaseProvider(){holdNative=false;pendingNative();pendingNative=null;},
 failShortcutReads(){shortcutReadError=true;},
 shortcutsChanged(){shortcutStatus.bindings.screenshot.key='Q';const handler=shortcutEvents.get('noltri-shortcuts-changed');if(handler===undefined)throw Error('Missing shortcuts changed listener');callbacks.get(handler)({event:'noltri-shortcuts-changed',id:handler,payload:structuredClone(shortcutStatus)});},
 safe:()=>safety.at(-1),
 set(selector,value){const el=document.querySelector(selector);const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 change(selector,value){const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},
 submit(selector){document.querySelector(selector).requestSubmit();},
 dirtyBody(){const view=EditorView.findFromDOM(document.querySelector('.cm-editor'));view.dispatch({changes:{from:view.state.doc.length,insert:'Body draft preserved'}});},
 fileText:()=>files['Synthetic/Properties.md']?.content,

 holdNextItem(){holdItem=true;itemSettled=false;},
 settleItem(outcome){holdItem=false;if(!pendingItem)throw Error('No deferred item request');if(outcome==='reject')pendingItem.reject(Error('Synthetic deferred item failure'));else pendingItem.resolve();pendingItem=null;},
 itemSettled:()=>itemSettled,
 clipboardReads:()=>clipboardReads,
 addIntakeDraft(){const el=document.querySelector('#intake-original-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Unsubmitted synthetic intake draft');el.dispatchEvent(new Event('input',{bubbles:true}));const file=new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII='),x=>x.charCodeAt(0))],'synthetic.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('input[aria-label="添加图片文件"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));},
 calls:()=>calls, text:()=>document.body.innerText,
 click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label||b.textContent.trim().endsWith(label));if(!b)throw Error('Missing button: '+label);b.click();},
 rememberNotes(){rememberedNotes=document.querySelector('[aria-label="笔记工作区"]');},
 sameNotes:()=>rememberedNotes===document.querySelector('[aria-label="笔记工作区"]'),
 notesActive:()=>!document.querySelector('[aria-label="笔记工作区"]').classList.contains('vault-notes-hidden'),
 inboxActive:()=>document.querySelector('[aria-label="资料审核工作区"]')?.hidden===false,
 externalUpdate(){generation++;source.reviewRevision++;},
 target(value){const el=document.querySelector('#inbox-review-target');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},
 edit(value){const el=document.querySelector('#inbox-review-draft');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
};
`;
const browser=createReviewBrowser(harness,fileURLToPath(new URL('../..',import.meta.url)));
const {evaluate,until}=browser;
const text=()=>evaluate<string>('window.harness.text()');
const calls=()=>evaluate<any[]>('window.harness.calls()');
const native=()=>evaluate<string[]>('window.harness.nativeCalls()');
const click=(label:string)=>evaluate(`window.harness.click(${JSON.stringify(label)})`);
async function mount(kind='host',secondYaml=false){await evaluate(`window.harness.mount(${JSON.stringify(kind)},${secondYaml})`);await until(calls,c=>c.some(x=>x[0]==='vaultSnapshot'));if(kind==='notes')await until(()=>evaluate<boolean>("!!document.querySelector('.cm-editor')"),Boolean);}
async function settings(){await click('Provider 管理');await until(()=>evaluate<boolean>("!!document.querySelector('dialog[open] .settings-dialog-content')"),Boolean);}
async function installAttempt(){await click('检查更新');await until(text,t=>t.includes('下载并验证'));await click('下载并验证');await until(text,t=>t.includes('确认安装并替换应用'));await click('确认安装并替换应用');await until(text,t=>t.includes('安装完成')||t.includes('安装未完成')||t.includes('本次未调用安装器'));}
async function detail(){await click('打开待确认资料');await until(text,t=>t.includes('Synthetic source 1'));await click('打开资料 Synthetic source 1');await until(text,t=>t.includes('原始全文'));await evaluate("window.harness.target('subject-a')");await click('确认归档');await until(text,t=>t.includes('查看原件资料'));await click('查看原件资料');await until(()=>evaluate<boolean>("!!document.querySelector('dialog[open] .detail-original')"),Boolean);}

describe('updater host pending work and retained property safety',()=>{
 beforeAll(()=>browser.start(),30_000);afterAll(()=>browser.close());
 it('refreshes actual open intake labels after a successful native shortcut change',async()=>{
  await mount();await click('快速收集');await until(text,t=>t.includes('⌃⌥⌘S'));
  await evaluate('window.harness.shortcutsChanged()');await until(text,t=>t.includes('⌃⌥⌘Q'));
  expect(await text()).not.toContain('⌃⌥⌘S');
 });
 it('uses committed shortcut event bindings even when a later status read is unavailable',async()=>{
  await mount();await click('快速收集');await until(text,t=>t.includes('⌃⌥⌘S'));
  await evaluate('window.harness.failShortcutReads();window.harness.shortcutsChanged()');await until(text,t=>t.includes('⌃⌥⌘Q'));
  expect(await text()).not.toContain('secret-token');
 });
 it('blocks closing settings and update installation while a shortcut draft is unsaved',async()=>{
  await mount('empty-host');await settings();await until(()=>evaluate<boolean>("!document.querySelector('[aria-label=\"截图字母\"]').closest('fieldset').disabled"),Boolean);await evaluate("window.harness.change('[aria-label=\"截图字母\"]','Q')");await until(text,t=>t.includes('有未保存的快捷键更改'));await click('关闭');
  expect(await text()).toContain('请先保存或取消设置草稿');expect(await evaluate("!!document.querySelector('dialog[open] [aria-label=\"截图字母\"]')")).toBe(true);
  await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toEqual([]);
  await click('取消快捷键更改');await click('关闭');expect(await evaluate("!!document.querySelector('dialog[open]')")).toBe(false);
 });
 it('blocks closing settings and installation while an unchanged shortcut retry is pending',async()=>{
  await mount('empty-host');await settings();await evaluate('window.harness.holdProvider()');await click('重新注册当前快捷键');
  await until(native,c=>c.includes('save_intake_shortcuts'));await click('关闭');
  expect(await evaluate("!!document.querySelector('dialog[open] [aria-label=\"截图字母\"]')")).toBe(true);
  await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toEqual([]);
  await evaluate('window.harness.releaseProvider()');await until(text,t=>t.includes('快捷键已保存'));await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toHaveLength(1);
 });
 it('allows the real host with zero providers and no drafts to dispatch install',async()=>{
  await mount('empty-host');await settings();await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toHaveLength(1);
 });
 it('allows a safe install after a genuine asynchronous Core preflight and busy render',async()=>{
  await mount('empty-host');await settings();await click('检查更新');await until(text,t=>t.includes('下载并验证'));await click('下载并验证');await until(text,t=>t.includes('确认安装并替换应用'));await evaluate("window.harness.hold('inbox')");await click('确认安装并替换应用');await until(()=>evaluate<boolean>('window.harness.preflightHeld()'),Boolean);await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');expect((await native()).filter(x=>x==='install_native_update')).toEqual([]);await evaluate('window.harness.release()');await until(text,t=>t.includes('安装完成')||t.includes('安装未完成')||t.includes('本次未调用安装器'));expect((await native()).filter(x=>x==='install_native_update')).toHaveLength(1);
 });
 it('blocks install after cancelling a pending Notes create until its promise settles',async()=>{
  await mount();await click('新建 Markdown 笔记');await evaluate("window.harness.set('.vault-modal input','Synthetic/New.md');window.harness.hold('saveVaultFile')");await click('创建');await until(calls,c=>c.some(x=>x[0]==='saveVaultFile'));await click('取消');await settings();await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toEqual([]);
  await evaluate('window.harness.release()');await until(calls,c=>c.some(x=>x[0]==='vaultFile'));await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toHaveLength(1);
 });
 it('blocks pending Detail patch and relation writes even after closing their child dialog',async()=>{
  for(const method of ['patchItem','createItemRelation']){
   await mount();await detail();await evaluate(`window.harness.hold(${JSON.stringify(method)})`);
   if(method==='patchItem'){await click('保存分类');}else{await evaluate("window.harness.change('#relation-target','source-other')");await click('关联');}
   await until(calls,c=>c.some(x=>x[0]===method));await click('关闭详情');await settings();await installAttempt();expect((await native()).filter(x=>x==='install_native_update')).toEqual([]);await evaluate('window.harness.release()');
  }
 });
 it('keeps an unsafe Provider instance mounted across close, reopen and collection replacement attempts',async()=>{
  await mount();await settings();await click('编辑');await evaluate('window.harness.holdProvider()');await click('获取可用模型');await until(native,c=>c.includes('fetch_available_models'));await evaluate('window.retainedProvider=document.querySelector(".provider-editor");document.querySelector("dialog .dialog-close").click();void 0');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  expect(await evaluate('window.retainedProvider===document.querySelector("dialog[open] .provider-editor")')).toBe(true);
  await click('Provider 管理');await click('快速收集');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');expect(await evaluate('window.retainedProvider===document.querySelector("dialog[open] .provider-editor")')).toBe(true);expect(await evaluate("!!document.querySelector('.intake-window')")).toBe(false);
  await evaluate('window.harness.releaseProvider()');await until(text,t=>!t.includes('正在获取…'));await evaluate('document.querySelector("dialog .dialog-close").click()');await until(()=>evaluate<boolean>("!document.querySelector('dialog[open]')"),Boolean);
 });
 it('blocks unsubmitted property fields and invalid YAML, then acknowledges committed saved YAML',async()=>{
  await mount('notes');await click('来源与属性');await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);await evaluate("window.harness.set('input[aria-label=\"新属性名称\"]','newKey');window.harness.set('input[aria-label=\"新属性值\"]','Unsubmitted value')");await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===false);await evaluate("window.harness.set('input[aria-label=\"新属性名称\"]','');window.harness.set('input[aria-label=\"新属性值\"]','')");await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  await evaluate("window.harness.set('.vault-properties textarea','answer: [')");await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===false);expect(await evaluate("document.querySelector('.vault-properties textarea').value")).toBe('answer: [');expect(await evaluate('window.harness.fileText()')).toContain('answer: 1');
  await evaluate("window.harness.set('.vault-properties textarea','answer: 2')");await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);expect(await evaluate('window.harness.fileText()')).toContain('answer: 2');expect(await evaluate('window.harness.fileText()')).toContain('Original body stays');
 });
 it('releases only explicitly deleted YAML scratch and does not revive it when the property is recreated',async()=>{
  await mount('notes',true);await click('来源与属性');await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  const config='.vault-property-row:has(select[aria-label="config 属性类型"]) textarea';
  const other='.vault-property-row:has(select[aria-label="other 属性类型"]) textarea';
  await evaluate(`window.harness.set(${JSON.stringify(config)},'answer: [');window.harness.set(${JSON.stringify(other)},'keep: [')`);
  await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===false);
  await click('删除属性 config');await until(calls,c=>c.some(x=>x[0]==='saveVaultFile'));
  expect(await evaluate(`document.querySelector(${JSON.stringify(other)}).value`)).toBe('keep: [');
  expect(await evaluate('window.harness.safe()')).toBe(false);
  await evaluate(`window.harness.set(${JSON.stringify(other)},'answer: 10')`);
  await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  expect(await evaluate('window.harness.fileText()')).not.toContain('config:');
  expect(await evaluate('window.harness.fileText()')).toContain('Original body stays');
  await evaluate("window.harness.set('input[aria-label=\"新属性名称\"]','config');window.harness.set('input[aria-label=\"新属性值\"]','Recreated value');window.harness.submit('.vault-properties form')");
  await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  expect(await evaluate(`document.querySelector(${JSON.stringify(config)}).value`)).toContain('Recreated value');
  expect(await evaluate(`document.querySelector(${JSON.stringify(config)}).value`)).not.toBe('answer: [');
  expect(await evaluate('window.harness.fileText()')).toContain('Original body stays');
 });
 it('releases only explicitly converted YAML scratch and does not revive it on conversion back to YAML',async()=>{
  await mount('notes',true);await click('来源与属性');await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  const config='.vault-property-row:has(select[aria-label="config 属性类型"]) textarea';
  const other='.vault-property-row:has(select[aria-label="other 属性类型"]) textarea';
  await evaluate(`window.harness.set(${JSON.stringify(config)},'answer: [');window.harness.set(${JSON.stringify(other)},'keep: [');window.harness.change('select[aria-label="config 属性类型"]','text')`);
  await until(()=>evaluate<boolean>(`document.querySelector(${JSON.stringify(config)})===null`),Boolean);
  expect(await evaluate(`document.querySelector(${JSON.stringify(other)}).value`)).toBe('keep: [');
  expect(await evaluate('window.harness.safe()')).toBe(false);
  await evaluate(`window.harness.set(${JSON.stringify(other)},'answer: 10')`);
  await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  expect(await evaluate('window.harness.fileText()')).toContain('Original body stays');
  await evaluate("window.harness.change('select[aria-label=\"config 属性类型\"]','yaml')");
  await until(()=>evaluate<boolean>(`!!document.querySelector(${JSON.stringify(config)})`),Boolean);
  await until(()=>evaluate<boolean>('window.harness.safe()'),v=>v===true);
  expect(await evaluate(`document.querySelector(${JSON.stringify(config)}).value`)).not.toBe('answer: [');
  expect(await evaluate(`document.querySelector(${JSON.stringify(config)}).getAttribute('aria-invalid')`)).toBe('false');
  expect(await evaluate('window.harness.fileText()')).toContain('Original body stays');
 });
 it('does not override unsaved note safety when a PropertyPanel is explicitly unmounted',async()=>{
  await mount('notes');await click('来源与属性');await evaluate("window.harness.set('input[aria-label=\"新属性值\"]','retained property input');window.harness.hold('saveVaultFile');window.harness.dirtyBody()");await click('大纲');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');expect(await evaluate('window.harness.safe()')).toBe(false);
 });
});
