import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

// Removing the Graph slot/retention or returning focus without activating text must fail these cases.
const css = ['workbench.css', 'notes-workbench.css', 'mindmap-view.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {WorkbenchNotes} from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchNotes.tsx', import.meta.url)))};
// The shared headless runner uses an 800px viewport; this fixed desktop fixture keeps its sidebar reachable.
const style=document.createElement('style');style.textContent=${JSON.stringify(css)}+'\\n#root{height:660px}.reading-fixture{height:640px;width:1100px;display:block;min-height:0}.reading-fixture .vault-editor-layout{grid-template-columns:minmax(0,1fr)224px}.reading-fixture .vault-organize-panel{display:flex}';document.head.append(style);
const content='# Synthetic source\\n\\n'+Array.from({length:90},(_,i)=>'Paragraph '+i+' of entirely synthetic text.').join('\\n\\n');
const file=()=>({path:'Synthetic/Reading.md',content,mtime:1,ctime:1,size:content.length,etag:'synthetic-etag',metadata:{frontmatter:{title:'Synthetic reading'},headings:[],tags:[],links:[],blocks:{}}});
let root,providerCalls=[],unexpected=[],retainedEditor,retainedGraph,updateSafety=[],holdProvider=false,pendingProvider;
const reportUpdateSafety=safe=>updateSafety.push(safe);
const api={
 vaultSnapshot:async()=>({rootPath:'/synthetic-reading-vault',files:[{path:file().path,name:'Reading.md',kind:'file',extension:'md',mtime:1,size:content.length}],revision:1}),
 vaultFile:async()=>file(),vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),
 vaultMetadata:async()=>({path:file().path,metadata:file().metadata}),vaultBacklinks:async()=>({revision:1,backlinks:[]}),vaultMentions:async()=>({mentions:[]}),vaultHistory:async()=>({versions:[]}),
 vaultChanges:async()=>({revision:1,reset:false,events:[]}),vaultDiagnostics:async()=>({revision:1,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),
 saveVaultFile:async()=>{throw Error('Synthetic save offline; local draft remains');},
 interpretNote:request=>{providerCalls.push(structuredClone(request));if(holdProvider)return new Promise(resolve=>{pendingProvider=resolve;});return Promise.resolve({text:'Synthetic translation result',model:'synthetic-model'});},
};
const controlled=new Proxy(api,{get(t,p){if(p in t)return t[p];if(p==='then')return undefined;return (...args)=>{unexpected.push(String(p));return Promise.reject(Error('Unexpected synthetic API: '+String(p)));};}});
function GraphSlot(){const [selected,setSelected]=useState(0);return <aside className="graph-panel graph-panel-mini"><div className="workbench-graph"><button onClick={()=>setSelected(n=>n+1)}>Synthetic graph selection {selected}</button></div></aside>;}
window.harness={
 mount(empty=false){root?.unmount();localStorage.clear();providerCalls=[];unexpected=[];updateSafety=[];holdProvider=false;pendingProvider=null;retainedEditor=null;retainedGraph=null;root=createRoot(document.getElementById('root'));root.render(<div className="library-shell-notes reading-fixture"><WorkbenchNotes api={controlled} active requestedOpen={empty?null:{path:file().path,intent:{newTab:false,split:false},id:1}} scopePaths={null} scopeTitle={null} libraryView="all" tagQuery={null} vaultTagCounts={new Map()} onContextChange={()=>{}} onUpdateSafetyChange={reportUpdateSafety} relationsGraph={<GraphSlot/>}/></div>);},
 click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label);if(!b)throw Error('Missing control '+label);b.click();},
 prepareDraft(){const el=document.querySelector('.cm-editor');const view=EditorView.findFromDOM(el);retainedEditor=el;view.dispatch({changes:{from:0,insert:'Human draft prefix\\n\\n'},selection:{anchor:12,head:22}});view.scrollDOM.scrollTop=140;},
 editQuestion(value){const el=document.querySelector('textarea[aria-label="原文问题"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 holdProvider(){holdProvider=true;},
 releaseProvider(){holdProvider=false;pendingProvider({text:'Synthetic translation result',model:'synthetic-model'});pendingProvider=null;},
 rememberGraph(){retainedGraph=document.querySelector('.vault-relations-graph .graph-panel');},
 state(){const el=document.querySelector('.cm-editor');const view=el?EditorView.findFromDOM(el):null;return {sameEditor:el===retainedEditor,text:view?.state.doc.toString(),from:view?.state.selection.main.from,to:view?.state.selection.main.to,scroll:view?.scrollDOM.scrollTop,focused:document.activeElement===view?.contentDOM,body:document.querySelector('.vault-note-view-stack')?.getAttribute('data-current-view'),sameGraph:retainedGraph===document.querySelector('.vault-relations-graph .graph-panel'),graphHidden:document.querySelector('.vault-relations-graph')?.hidden,graphInert:document.querySelector('.vault-relations-graph')?.inert,updateSafe:updateSafety.at(-1),updateSafety:[...updateSafety],providerCalls:[...providerCalls],unexpected:[...unexpected]};},
 text:()=>document.body.innerText,
};
`;
const browser=createReviewBrowser(harness,fileURLToPath(new URL('../..',import.meta.url)));
const {evaluate,until}=browser;
const click=(label:string)=>evaluate(`window.harness.click(${JSON.stringify(label)})`);
const state=()=>evaluate<any>('window.harness.state()');
async function mount(empty=false){await evaluate(`window.harness.mount(${empty})`);if(empty)await until(()=>evaluate<boolean>("!!document.querySelector('.vault-empty-note')"),Boolean);else await until(()=>evaluate<boolean>("!!document.querySelector('.cm-editor')"),Boolean);}

describe('reading relationship slot and source return',()=>{
 beforeAll(()=>browser.start(),30_000);
 afterAll(()=>browser.close());

 it('keeps the graph subtree and editor while relationship panels and interpretation change',async()=>{
  await mount();
  expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='图谱')")).toBe(true);
  await evaluate('window.harness.prepareDraft()');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const before=await state();
  await click('图谱');await click('Synthetic graph selection 0');await evaluate('window.harness.rememberGraph()');
  expect((await state()).graphHidden).toBe(false);
  const graphHeight=await evaluate<number>("document.querySelector('.vault-relations-graph .graph-panel').getBoundingClientRect().height");
  expect(graphHeight).toBeGreaterThan(80);expect(graphHeight).toBeLessThan(640);
  await click('属性');expect((await state()).graphHidden).toBe(true);expect((await state()).graphInert).toBe(true);
  await click('解读');expect((await state()).providerCalls).toEqual([]);
  await click('关系');await click('图谱');
  expect(await evaluate("document.body.innerText.includes('Synthetic graph selection 1')")).toBe(true);
  const after=await state();expect(after.sameGraph).toBe(true);expect(after.sameEditor).toBe(true);expect(after.text).toBe(before.text);expect([after.from,after.to]).toEqual([12,22]);expect(after.scroll).toBe(before.scroll);
  expect(after.unexpected).toEqual([]);
 });

 it('returns from interpretation over a mindmap to the retained source selection and focus',async()=>{
  await mount();await evaluate('window.harness.prepareDraft()');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const before=await state();expect(before.scroll).toBeGreaterThan(40);
  await click('切换为思维导图视图');await click('解读');expect((await state()).providerCalls).toEqual([]);
  await click('翻译为简体中文');await until(()=>evaluate<string>('window.harness.text()'),text=>text.includes('Synthetic translation result'));
  await click('返回当前原文并保留位置');
  await until(state,s=>s.body==='text'&&s.focused);
  const after=await state();expect(after.sameEditor).toBe(true);expect(after.text).toBe(before.text);expect([after.from,after.to]).toEqual([12,22]);expect(after.scroll).toBe(before.scroll);expect(after.providerCalls).toHaveLength(1);expect(after.providerCalls[0].sourceText).toBe(before.text);
 });

 it('blocks host updates for an unsent question until the interpretation panel is explicitly closed',async()=>{
  await mount();await until(state,s=>s.updateSafe===true);await click('解读');
  await evaluate("window.harness.editQuestion('  ')");await until(state,s=>s.updateSafe===false);
  await evaluate("window.harness.editQuestion('Unsubmitted synthetic question')");await click('切换为思维导图视图');expect((await state()).updateSafe).toBe(false);expect((await state()).providerCalls).toEqual([]);
  await click('关系');await until(state,s=>s.updateSafe===true);
 });

 it('blocks host updates during a real mounted interpretation request and releases after settlement',async()=>{
  await mount();await until(state,s=>s.updateSafe===true);await click('解读');await evaluate('window.harness.holdProvider()');await click('翻译为简体中文');
  await until(state,s=>s.providerCalls.length===1);await until(state,s=>s.updateSafe===false);
  await evaluate('window.harness.releaseProvider()');await until(state,s=>s.updateSafe===true);
 });

 it('keeps the existing unsaved-source update block when interpretation becomes safe again',async()=>{
  await mount();await evaluate('window.harness.prepareDraft()');await until(state,s=>s.updateSafe===false);await click('解读');
  await evaluate("window.harness.editQuestion('Synthetic question over an unsaved note')");await click('关系');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');expect((await state()).updateSafe).toBe(false);
 });

 it('keeps the supplied course graph reachable before a note is opened',async()=>{
  await mount(true);
  expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='图谱')")).toBe(true);
  await click('图谱');expect(await evaluate("document.body.innerText.includes('Synthetic graph selection 0')")).toBe(true);
  expect((await state()).graphHidden).toBe(false);
 });
});
