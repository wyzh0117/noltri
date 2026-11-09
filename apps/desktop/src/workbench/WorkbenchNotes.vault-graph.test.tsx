import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

const css = ['workbench.css', 'notes-workbench.css', 'mindmap-view.css', 'knowledge-right-panel.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import YAML from 'yaml';
import {WorkbenchNotes} from './WorkbenchNotes';
const style=document.createElement('style');style.textContent=${JSON.stringify(css)}+'\\n#root{height:660px}.graph-host-fixture{height:640px;width:1100px;display:grid;grid-template-columns:minmax(0,1fr) 280px;min-height:0}.graph-host-fixture .test-right-rail{display:flex;flex-direction:column;min-height:0;overflow:hidden}.graph-host-fixture .test-right-graph{height:250px;min-height:120px;border-bottom:1px solid #ddd}.graph-host-fixture .test-right-tool-body{flex:1;min-height:0;overflow:auto}';document.head.append(style);
const content='# Synthetic original\\n\\n'+Array.from({length:70},(_,i)=>'Paragraph '+i+' stays in the original note.').join('\\n\\n');
const topicId='topic-T';
const initialSemanticContent='---\\nid: topic-T\\nnoteType: topic\\ntopicId: topic-T\\nchapterId: null\\ntitle: Topic T\\ncustom: Keep me\\nremoveMe: Remove me\\n---\\n# Topic T\\n\\nSemantic body';
let semanticMode=false,semanticContent=initialSemanticContent,semanticEtag='semantic-etag-0',noteSaveRequests=[];
const file=path=>{if(semanticMode&&path==='Topic.md'){const match=/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?=\\r?\\n|$)/.exec(semanticContent);return{path,content:semanticContent,mtime:1,ctime:1,size:semanticContent.length,etag:semanticEtag,metadata:{frontmatter:match?YAML.parse(match[1]):{},headings:[{heading:'Topic T',level:1,position:{start:{offset:0}}}],tags:[],links:[],blocks:{}}};}return{path,content:content+'\\n'+path,mtime:1,ctime:1,size:content.length,etag:'synthetic-'+path,metadata:{frontmatter:{},headings:[{heading:'Synthetic original',level:1,position:{start:{offset:0}}}],tags:[],links:[],blocks:{}}};};
let root,props,graphCalls,matchCalls,providerCalls,unexpected,fileCalls,revision,changes,retainedEditor,navEvents;
const emptyToolPanels={outline:<p>No outline selected.</p>,backlinks:<p>No backlinks selected.</p>,outgoing:<p>No outgoing links selected.</p>,tags:<p>No tags selected.</p>,properties:<p>No properties selected.</p>};
const api={vaultSnapshot:async()=>({rootPath:'/synthetic-graph-vault',files:[...['A.md','B.md'],...(semanticMode?['Topic.md']:[])].map(path=>({path,name:path,kind:'file',extension:'md',mtime:1,size:100,...(semanticMode&&path==='Topic.md'?{frontmatter:file(path).metadata.frontmatter}:{})})),revision}),vaultFile:async path=>{fileCalls.push(path);return file(path);},vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),vaultMetadata:async path=>({path,metadata:file(path).metadata}),vaultBacklinks:async()=>({revision,backlinks:[{sourcePath:'B.md',count:2,positions:[]}]}),vaultMentions:async()=>({mentions:[]}),vaultHistory:async()=>({versions:[]}),vaultChanges:async()=>{const events=changes;changes=[];return{revision,reset:false,events};},vaultDiagnostics:async()=>({revision,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),vaultGraph:async()=>{graphCalls++;return{revision,nodes:[],edges:[]};},vaultMatch:async()=>{matchCalls++;return{revision,paths:[],attachmentPaths:[],matchingTags:[]};},legacyNotePath:async()=>({path:'Topic.md',exists:true}),saveGraphNote:async(topicId,request)=>{noteSaveRequests.push({topicId,request:structuredClone(request)});const match=/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?=\\r?\\n|$)\\r?\\n?/.exec(semanticContent);if(request.properties===undefined)semanticContent=(match?.[0]??'')+request.content;else{const canonical={...request.properties,id:topicId,noteType:'topic',topicId,chapterId:null,title:'Topic T'};semanticContent='---\\n'+YAML.stringify(canonical)+'---\\n'+request.content;}semanticEtag='semantic-etag-'+noteSaveRequests.length;return{topicId,chapterId:request.chapterId,content:request.content,updatedAt:new Date().toISOString(),etag:semanticEtag,path:'Topic.md'};},saveVaultFile:async()=>{throw Error('Synthetic save offline');},interpretNote:async()=>{providerCalls++;throw Error('No provider requested by this fixture');}};
const controlled=new Proxy(api,{get(t,p){if(p in t)return t[p];if(p==='then')return undefined;return()=>{unexpected.push(String(p));return Promise.reject(Error('Unexpected synthetic API '+String(p)));};}});
function TestRail({right,section,setSection,tool,setTool}){return <aside className="test-right-rail" aria-label="测试右侧栏"><nav role="tablist" aria-label="阅读侧栏分区"><button role="tab" aria-selected={section==='relations'} onClick={()=>setSection('relations')}>关系</button><button role="tab" aria-selected={section==='interpretation'} onClick={()=>setSection('interpretation')}>解读</button></nav>{section==='relations'?<><div className="test-right-graph"><button onClick={()=>{window.graphSelection++;window.graphRenders++;}}>Graph selection {window.graphSelection}</button><button onClick={()=>props.onNavigateRequest?.('B.md',null,{newTab:true,split:false})}>Graph new tab B</button><button onClick={()=>props.onNavigateRequest?.('A.md',null,{newTab:false,split:true})}>Graph split A</button></div><nav role="tablist" aria-label="正文工具">{['outline','backlinks','outgoing','tags','properties'].map((key)=>{const labels={outline:'大纲',backlinks:'反向链接',outgoing:'出链',tags:'标签',properties:'来源与属性'};return <button key={key} role="tab" aria-selected={tool===key} onClick={()=>setTool(key)}>{labels[key]}</button>;})}</nav><div className="test-right-tool-body">{right.toolPanels[tool]}</div></>:<div className="test-right-tool-body">{right.interpretationPanel}</div>}</aside>}
function AppHarness(){const [right,setRight]=useState({toolPanels:emptyToolPanels,interpretationPanel:<p>选择一篇笔记以查看解读。</p>});const [section,setSection]=useState('relations');const [tool,setTool]=useState('properties');return <div className="library-shell-notes graph-host-fixture"><WorkbenchNotes {...props} onRightPanelContentChange={setRight}/><TestRail right={right} section={section} setSection={setSection} tool={tool} setTool={setTool}/></div>;}
function render(patch={}){props={...props,...patch};root.render(<AppHarness/>);}
window.harness={mount(semantic=false){root?.unmount();semanticMode=semantic;semanticContent=initialSemanticContent;semanticEtag='semantic-etag-0';noteSaveRequests=[];localStorage.clear();graphCalls=0;matchCalls=0;providerCalls=0;unexpected=[];fileCalls=[];revision=1;changes=[];retainedEditor=null;navEvents=[];window.graphSelection=0;window.graphRenders=0;root=createRoot(document.getElementById('root'));props={api:controlled,active:true,requestedOpen:semantic?{path:'Topic.md',intent:{newTab:false,split:false},id:1,semanticIdentity:{topicId,chapterId:null}}:{path:'A.md',intent:{newTab:false,split:false},id:1},scopePaths:null,scopeTitle:null,libraryView:'all',tagQuery:null,vaultTagCounts:new Map(),onContextChange:()=>{},onNavigateRequest:(path,subpath,intent)=>navEvents.push([path,subpath,intent??{newTab:false,split:false}])};render();},render,
 click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label||b.querySelector('strong')?.textContent.trim()===label);if(!b)throw Error('Missing control '+label);b.click();},
 draft(){const el=document.querySelector('.cm-editor');const view=EditorView.findFromDOM(el);retainedEditor=el;view.dispatch({changes:{from:0,insert:'Human local draft\\n'},selection:{anchor:8,head:16}});view.scrollDOM.scrollTop=100;},
 editBody(){const view=EditorView.findFromDOM(document.querySelector('.cm-editor'));view.dispatch({changes:{from:view.state.doc.length,insert:'\\n\\nBody edit'}});},
 setProperty(name,value){for(const [selector,next] of [['input[aria-label="新属性名称"]',name],['input[aria-label="新属性值"]',value]]){const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,next);el.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.vault-properties form button').click();},
 deleteProperty(name){document.querySelector('[aria-label="删除属性 '+name+'"]')?.click();},
 remember(){retainedEditor=document.querySelector('.cm-editor');},
 state(){const el=document.querySelector('.cm-editor');const view=el?EditorView.findFromDOM(el):null;return{graphCalls,matchCalls,providerCalls,unexpected:[...unexpected],fileCalls:[...fileCalls],noteSaveRequests:[...noteSaveRequests],graphRenders:window.graphRenders,graphSelection:window.graphSelection,sameEditor:retainedEditor===el,content:view?.state.doc.toString(),editorDomText:document.querySelector('.cm-content')?.innerText??'',propertyRows:[...document.querySelectorAll('.vault-property-row')].map(row=>row.innerText),saveStatus:document.querySelector('.vault-save-indicator')?.textContent,identity:document.querySelector('[data-note-path]')?.getAttribute('data-note-identity'),selection:view?[view.state.selection.main.from,view.state.selection.main.to]:null,scope:document.querySelector('[data-note-path]')?.getAttribute('data-note-path'),navEvents:[...navEvents],tools:[...document.querySelectorAll('[aria-label="正文工具"] button')].map(b=>b.textContent.trim()),text:document.body.textContent};}};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('.', import.meta.url)));
const state = () => browser.evaluate<any>('harness.state()');
const click = (label: string) => browser.evaluate(`harness.click(${JSON.stringify(label)})`);
async function mount(semantic = false) {
  await browser.evaluate(`harness.mount(${String(semantic)})`);
  await browser.until(() => browser.evaluate<boolean>("!!document.querySelector('.cm-editor')"), Boolean);
}

describe('WorkbenchNotes supplies the unified right-panel slots', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('exposes the ordered note tools without owning a second Graph fetch', async () => {
    await mount();
    expect((await state()).graphCalls).toBe(0);
    expect((await state()).tools).toEqual(['大纲', '反向链接', '出链', '标签', '来源与属性']);
    await click('大纲');
    expect((await state()).text).toContain('Synthetic original');
    expect((await state()).graphCalls).toBe(0);
    expect((await state()).unexpected).toEqual([]);
  });

  it('keeps the editor draft across relationship and interpretation sections without implicit provider calls', async () => {
    await mount();
    await browser.evaluate('harness.draft()');
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before = await state();
    await click('Graph selection 0');
    await click('解读');
    expect((await state()).providerCalls).toBe(0);
    await click('关系');
    const after = await state();
    expect(after.sameEditor).toBe(true);
    expect(after.content).toBe(before.content);
    expect(after.selection).toEqual([8, 16]);
    expect(after.graphSelection).toBe(1);
    expect(after.providerCalls).toBe(0);
    expect(after.unexpected).toEqual([]);
  });

  it('routes backlinks and Graph new-tab/split intents through the host navigation handler', async () => {
    await mount();
    await click('反向链接');
    await browser.until(state, value => value.text.includes('2 处链接'));
    await click('B');
    await click('Graph new tab B');
    await click('Graph split A');
    const events = (await state()).navEvents;
    expect(events).toEqual([
      ['B.md', null, { newTab: false, split: false }],
      ['B.md', null, { newTab: true, split: false }],
      ['A.md', null, { newTab: false, split: true }],
    ]);
    expect(browser.errors).toEqual([]);
  });

  it('hides canonical identity fields from live text and editable properties', async () => {
    await mount(true);
    await browser.until(state, value => value.scope === 'Topic.md');
    const current = await state();
    expect(current.identity).toBe('topic-T:overview');
    expect(current.editorDomText).not.toContain('topic-T');
    expect(current.propertyRows.join(' ')).toContain('custom');
    expect(current.propertyRows.join(' ')).toContain('removeMe');
    expect(current.propertyRows.join(' ')).not.toMatch(/\b(id|noteType|topicId|chapterId|title)\b/u);
  });
});
