import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

// Exercise actual Notes and VaultRelationsGraph. Only the renderer is replaced, so no canvas/worker runs.
const notes = readFileSync(new URL('./WorkbenchNotes.tsx', import.meta.url), 'utf8')
  .replace("import { VaultRelationsGraph } from './VaultRelationsGraph';", '');
const graph = readFileSync(new URL('./VaultRelationsGraph.tsx', import.meta.url), 'utf8')
  .replace(/^import .* from 'react';\n/gm, '')
  .replace("import { WorkbenchGraph } from './WorkbenchGraph';", `function WorkbenchGraph(props) {
    const [selection,setSelection]=useState(0); window.graphProps=props;
    useEffect(()=>{window.graphMounts++;return()=>{window.graphUnmounts++;};},[]);
    return <div data-vault-renderer="true"><button onClick={()=>setSelection(n=>n+1)}>View selection {selection}</button><button onClick={()=>props.onNodeOpen(props.nodes.find(n=>n.id==='vault:B.md'),{newTab:true,split:false})}>Graph new tab B</button><button onClick={()=>props.onNodeOpen(props.nodes.find(n=>n.id==='vault:A.md'),{newTab:false,split:true})}>Graph split A</button></div>;
  }`);
const css = ['workbench.css', 'notes-workbench.css', 'mindmap-view.css', 'vault-relations-graph.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = notes + '\n' + graph + `
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
const style=document.createElement('style');style.textContent=${JSON.stringify(css)}+'\\n#root{height:660px}.graph-host-fixture{height:640px;width:1100px;display:block;min-height:0}.graph-host-fixture .vault-editor-layout{grid-template-columns:minmax(0,1fr)224px}.graph-host-fixture .vault-organize-panel{display:flex}';document.head.append(style);
const content='# Synthetic original\\n\\n'+Array.from({length:70},(_,i)=>'Paragraph '+i+' stays in the original note.').join('\\n\\n');
const file=path=>({path,content:content+'\\n'+path,mtime:1,ctime:1,size:content.length,etag:'synthetic-'+path,metadata:{frontmatter:{},headings:[],tags:[],links:[],blocks:{}}});
let root,props,graphCalls,matchCalls,providerCalls,unexpected,fileCalls,revision,changes,retainedEditor,retainedGraph;
const api={vaultSnapshot:async()=>({rootPath:'/synthetic-graph-vault',files:['A.md','B.md'].map(path=>({path,name:path,kind:'file',extension:'md',mtime:1,size:100})),revision}),vaultFile:async path=>{fileCalls.push(path);return file(path);},vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),vaultMetadata:async path=>({path,metadata:file(path).metadata}),vaultBacklinks:async()=>({revision,backlinks:[]}),vaultMentions:async()=>({mentions:[]}),vaultHistory:async()=>({versions:[]}),vaultChanges:async()=>{const events=changes;changes=[];return{revision,reset:false,events};},vaultDiagnostics:async()=>({revision,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),vaultGraph:async()=>{graphCalls++;return{revision,nodes:['A.md','B.md'].map(path=>({path,title:path,basename:path,type:'note',tags:[]})),edges:[]};},vaultMatch:async()=>{matchCalls++;return{revision,paths:[],attachmentPaths:[],matchingTags:[]};},saveVaultFile:async()=>{throw Error('Synthetic save offline');},interpretNote:async()=>{providerCalls++;throw Error('No provider requested by this fixture');}};
const controlled=new Proxy(api,{get(t,p){if(p in t)return t[p];if(p==='then')return undefined;return()=>{unexpected.push(String(p));return Promise.reject(Error('Unexpected synthetic API '+String(p)));};}});
function SemanticSlot(){const [n,setN]=useState(0);return <aside data-semantic="true"><button onClick={()=>setN(n+1)}>Semantic selection {n}</button></aside>;}
const semantic=<SemanticSlot/>;
function render(patch={}){props={...props,...patch};root.render(<div className="library-shell-notes graph-host-fixture"><WorkbenchNotes {...props}/></div>);}
window.harness={mount(hasSemantic=false){root?.unmount();localStorage.clear();graphCalls=0;matchCalls=0;providerCalls=0;unexpected=[];fileCalls=[];revision=1;changes=[];window.graphMounts=0;window.graphUnmounts=0;window.graphProps=null;retainedEditor=null;retainedGraph=null;root=createRoot(document.getElementById('root'));props={api:controlled,active:true,relationsGraph:hasSemantic?semantic:null,requestedOpen:{path:'A.md',intent:{newTab:false,split:false},id:1},scopePaths:null,scopeTitle:null,libraryView:'all',tagQuery:null,vaultTagCounts:new Map(),onContextChange:()=>{}};render();},render,
click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label);if(!b)throw Error('Missing control '+label);b.click();},
draft(){const el=document.querySelector('.cm-editor');const view=EditorView.findFromDOM(el);retainedEditor=el;view.dispatch({changes:{from:0,insert:'Human local draft\\n'},selection:{anchor:8,head:16}});view.scrollDOM.scrollTop=100;},remember(){retainedGraph=document.querySelector('[data-vault-renderer]');},setSemantic(value){render({relationsGraph:value?semantic:null});},invalidate(){revision++;changes=[{kind:'modified',path:'Other.md'}];document.dispatchEvent(new Event('visibilitychange'));},
state(){const el=document.querySelector('.cm-editor');const view=el?EditorView.findFromDOM(el):null;return{graphCalls,matchCalls,providerCalls,unexpected:[...unexpected],fileCalls:[...fileCalls],mounts:window.graphMounts,unmounts:window.graphUnmounts,sameGraph:retainedGraph===document.querySelector('[data-vault-renderer]'),sameEditor:retainedEditor===el,content:view?.state.doc.toString(),selection:view?[view.state.selection.main.from,view.state.selection.main.to]:null,scope:window.graphProps?.scopeIdentity,context:window.graphProps?.contextNodeId,fallbackHidden:document.querySelector('[aria-label="文档链接图"]')?.hidden,semanticPresent:!!document.querySelector('[data-semantic]'),tabs:[...document.querySelectorAll('.vault-note-tabs>div>button:first-child')].map(b=>b.title),split:document.querySelector('.vault-split-indicator')?.textContent,text:document.body.textContent};}};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('.', import.meta.url)));
const state = () => browser.evaluate<any>('harness.state()');
const click = (label: string) => browser.evaluate(`harness.click(${JSON.stringify(label)})`);
async function mount(semantic = false) {
  await browser.evaluate(`harness.mount(${semantic})`);
  await browser.until(() => browser.evaluate<boolean>("!!document.querySelector('.cm-editor')"), Boolean);
}

describe('Notes ordinary Markdown graph fallback host', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());
  it('offers a graph without course context and only fetches after the graph control is clicked', async () => {
    await mount();
    expect((await state()).graphCalls).toBe(0);
    await click('图谱');
    await browser.until(state, value => value.graphCalls === 1 && value.context === 'vault:A.md');
    expect((await state()).scope).toContain('/synthetic-graph-vault');
    expect((await state()).fallbackHidden).toBe(false);
    expect((await state()).unexpected).toEqual([]);
  });
  it('retains the actual graph and source editor/draft across interpretation switches without provider calls', async () => {
    await mount();await browser.evaluate('harness.draft()');
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before = await state();
    await click('图谱');await browser.until(state, value => value.graphCalls === 1);
    await click('View selection 0');await browser.evaluate('harness.remember()');
    await click('解读');await browser.until(state, value => value.fallbackHidden === true);
    expect((await state()).graphCalls).toBe(1);
    await click('关系');await browser.until(state, value => value.graphCalls === 2);
    const after = await state();
    expect(after.sameGraph).toBe(true);expect(after.sameEditor).toBe(true);
    expect(after.content).toBe(before.content);expect(after.selection).toEqual([8,16]);
    expect(after.text).toContain('View selection 1');expect(after.providerCalls).toBe(0);
    expect(after.unexpected).toEqual([]);
  });
  it('keeps a supplied semantic slot exclusive and enables the fallback only after that slot is removed', async () => {
    await mount(true);await click('图谱');await click('Semantic selection 0');
    expect((await state()).graphCalls).toBe(0);expect((await state()).semanticPresent).toBe(true);
    await click('解读');await click('关系');
    expect((await state()).text).toContain('Semantic selection 1');expect((await state()).graphCalls).toBe(0);
    await browser.evaluate('harness.setSemantic(false)');await browser.until(state, value => value.graphCalls === 1);
    expect((await state()).semanticPresent).toBe(false);expect((await state()).fallbackHidden).toBe(false);
    await browser.evaluate('harness.setSemantic(true)');await browser.until(state, value => value.fallbackHidden === true);
    expect((await state()).graphCalls).toBe(1);
  });
  it('passes host activity and Vault invalidations while preserving the mounted view', async () => {
    await mount();await click('图谱');await browser.until(state, value => value.graphCalls === 1);await browser.evaluate('harness.remember()');
    await browser.evaluate('harness.render({active:false})');await browser.until(state, value => value.fallbackHidden === true);
    expect((await state()).graphCalls).toBe(1);
    await browser.evaluate('harness.render({active:true})');await browser.until(state, value => value.graphCalls === 2);
    await browser.evaluate('harness.invalidate()');await browser.until(state, value => value.graphCalls === 3);
    expect((await state()).sameGraph).toBe(true);
  });
  it('routes new-tab and split opens through the existing Notes path handler', async () => {
    await mount();await click('图谱');await browser.until(state, value => value.graphCalls === 1);
    await click('Graph new tab B');await browser.until(state, value => value.context === 'vault:B.md');
    expect((await state()).tabs).toEqual(['A.md','B.md']);
    await click('Graph split A');await browser.until(state, value => Boolean(value.split));
    expect((await state()).context).toBe('vault:B.md');expect((await state()).split).toContain('A');
    expect((await state()).unexpected).toEqual([]);expect((await state()).providerCalls).toBe(0);
    expect(browser.errors).toEqual([]);
  });
});
