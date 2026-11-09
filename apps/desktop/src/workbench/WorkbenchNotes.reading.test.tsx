import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

// Removing the Graph slot/retention or returning focus without activating text must fail these cases.
const css = ['workbench.css', 'notes-workbench.css', 'mindmap-view.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {WorkbenchNotes} from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchNotes.tsx', import.meta.url)))};
// The shared headless runner uses an 800px viewport; this fixed desktop fixture keeps its sidebar reachable.
const style=document.createElement('style');style.textContent=${JSON.stringify(css)}+'\\n#root{height:660px}.reading-fixture{height:640px;width:1100px;display:grid;grid-template-columns:minmax(0,1fr)280px;min-height:0}.reading-fixture .test-right-rail{display:flex;flex-direction:column;min-height:0;overflow:hidden}.reading-fixture .test-right-relations-graph{height:220px;min-height:120px;border-bottom:1px solid #ddd}';document.head.append(style);
const content='# Synthetic source\\n\\n'+Array.from({length:90},(_,i)=>'Paragraph '+i+' of entirely synthetic text.').join('\\n\\n');
const file=()=>({path:'Synthetic/Reading.md',content,mtime:1,ctime:1,size:content.length,etag:'synthetic-etag',metadata:{frontmatter:{title:'Synthetic reading'},headings:[],tags:[],links:[],blocks:{}}});
let root,props,providerCalls=[],unexpected=[],retainedEditor,retainedGraph,updateSafety=[],holdProvider=false,pendingProvider;
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
function GraphSlot(){const [,force]=useState(0);useEffect(()=>{window.graphMounts++;return()=>{window.graphUnmounts++;};},[]);return <aside className="graph-panel graph-panel-mini"><div className="workbench-graph"><button onClick={()=>{window.graphSelection++;force(n=>n+1);}}>Synthetic graph selection {window.graphSelection}</button></div></aside>;}
function TestApp(){const [right,setRight]=useState({toolPanels:{outline:<p>No outline.</p>,backlinks:<p>No backlinks.</p>,outgoing:<p>No outgoing.</p>,tags:<p>No tags.</p>,properties:<p>No properties.</p>},interpretationPanel:<p>选择一篇笔记以查看解读。</p>});const [section,setSection]=useState('relations');const [tool,setTool]=useState('properties');return <div className="library-shell-notes reading-fixture"><WorkbenchNotes api={controlled} active={props.active} requestedOpen={props.empty?null:{path:file().path,intent:{newTab:false,split:false},id:1}} scopePaths={null} scopeTitle={null} libraryView="all" tagQuery={null} vaultTagCounts={new Map()} onContextChange={()=>{}} onUpdateSafetyChange={reportUpdateSafety} onRightPanelContentChange={setRight}/><aside className="test-right-rail"><nav><button onClick={()=>setSection('relations')}>关系</button><button onClick={()=>setSection('interpretation')}>解读</button></nav>{section==='relations'?<><div className="test-right-relations-graph"><GraphSlot/></div><nav>{['outline','backlinks','outgoing','tags','properties'].map((key)=>{const labels={outline:'大纲',backlinks:'反向链接',outgoing:'出链',tags:'标签',properties:'来源与属性'};return <button key={key} onClick={()=>setTool(key)}>{labels[key]}</button>;})}</nav>{right.toolPanels[tool]}</>:right.interpretationPanel}</aside></div>;}
window.harness={
 mount(empty=false){root?.unmount();localStorage.clear();providerCalls=[];unexpected=[];updateSafety=[];holdProvider=false;pendingProvider=null;retainedEditor=null;retainedGraph=null;window.graphSelection=0;window.graphMounts=0;window.graphUnmounts=0;props={active:true,empty};root=createRoot(document.getElementById('root'));root.render(<TestApp/>);},
 click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label);if(!b)throw Error('Missing control '+label);b.click();},
 prepareDraft(){const el=document.querySelector('.cm-editor');const view=EditorView.findFromDOM(el);retainedEditor=el;view.dispatch({changes:{from:0,insert:'Human draft prefix\\n\\n'},selection:{anchor:12,head:22}});view.scrollDOM.scrollTop=140;},
 editQuestion(value){const el=document.querySelector('textarea[aria-label="原文问题"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 holdProvider(){holdProvider=true;},
 releaseProvider(){holdProvider=false;pendingProvider({text:'Synthetic translation result',model:'synthetic-model'});pendingProvider=null;},
 rememberGraph(){retainedGraph=document.querySelector('.test-right-relations-graph .graph-panel');},
 state(){const el=document.querySelector('.cm-editor');const view=el?EditorView.findFromDOM(el):null;return {sameEditor:el===retainedEditor,text:view?.state.doc.toString(),from:view?.state.selection.main.from,to:view?.state.selection.main.to,scroll:view?.scrollDOM.scrollTop,focused:document.activeElement===view?.contentDOM,body:document.querySelector('.vault-note-view-stack')?.getAttribute('data-current-view'),sameGraph:retainedGraph===document.querySelector('.test-right-relations-graph .graph-panel'),graphHidden:document.querySelector('.test-right-relations-graph')===null,graphInert:document.querySelector('.test-right-relations-graph')?.inert,updateSafe:updateSafety.at(-1),updateSafety:[...updateSafety],providerCalls:[...providerCalls],unexpected:[...unexpected]};},
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
  expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='关系')")).toBe(true);
  await evaluate('window.harness.prepareDraft()');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const before=await state();
  await click('Synthetic graph selection 0');await evaluate('window.harness.rememberGraph()');
  expect((await state()).graphHidden).toBe(false);
  const graphHeight=await evaluate<number>("document.querySelector('.test-right-relations-graph .graph-panel').getBoundingClientRect().height");
  expect(graphHeight).toBeGreaterThan(80);expect(graphHeight).toBeLessThan(640);
  await click('来源与属性');expect((await state()).graphHidden).toBe(false);
  await click('解读');expect((await state()).providerCalls).toEqual([]);
  await click('关系');
  expect(await evaluate("document.body.innerText.includes('Synthetic graph selection 1')")).toBe(true);
  const after=await state();expect(after.sameEditor).toBe(true);expect(after.text).toBe(before.text);expect([after.from,after.to]).toEqual([12,22]);expect(after.scroll).toBe(before.scroll);
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
  expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='关系')")).toBe(true);
  await click('关系');expect(await evaluate("document.body.innerText.includes('Synthetic graph selection 0')")).toBe(true);
  expect((await state()).graphHidden).toBe(false);
 });
});
