import { afterAll, beforeAll, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ModelSettings from ${JSON.stringify(fileURLToPath(new URL('./ModelSettings.tsx',import.meta.url)))};
import {WorkbenchNotes} from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchNotes.tsx',import.meta.url)))};
let root,safety=[];
const settings={apiBaseUrl:'http://127.0.0.1:1',apiToken:'synthetic-only',mcpEndpoint:'',providers:[],activeProviderId:null,activeModelId:null,runtimeStatus:'managed'};
const api={vaultSnapshot:async()=>({rootPath:'/synthetic-update-vault',files:[],revision:0}),vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),vaultDiagnostics:async()=>({revision:0,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),vaultChanges:async()=>({revision:0,reset:false,events:[]})};
function mount(kind){root?.unmount();safety=[];root=createRoot(document.getElementById('root'));const report=value=>safety.push(value);root.render(kind==='model'?<ModelSettings settings={settings} outsideTauri={false} onSaved={()=>{throw Error('No native mutation expected');}} onUpdateSafetyChange={report}/>:<WorkbenchNotes api={api} active requestedOpen={null} scopePaths={null} scopeTitle={null} libraryView="all" tagQuery={null} vaultTagCounts={new Map()} onContextChange={()=>{}} onUpdateSafetyChange={report}/>);}
window.harness={mount,safe:()=>safety.at(-1),click(label){const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===label);if(!el)throw Error('Missing '+label);el.click();}};
`;
const browser=createReviewBrowser(harness,fileURLToPath(new URL('../..',import.meta.url)));
beforeAll(()=>browser.start(),30_000);afterAll(()=>browser.close());
const safe=()=>browser.evaluate<boolean>('window.harness.safe()');
it('reports a new provider draft as unsafe without saving or calling native APIs',async()=>{
 await browser.evaluate("window.harness.mount('model')");await browser.until(safe,v=>v===true);
 await browser.evaluate("window.harness.click('＋ 添加 Provider')");
 await browser.evaluate("window.harness.click('Custom model API')");await browser.until(safe,v=>v===false);
 expect(await safe()).toBe(false);
});
it('blocks update while the retained Notes workspace has an unsubmitted note form',async()=>{
 await browser.evaluate("window.harness.mount('notes')");await browser.until(safe,v=>v===true);
 await browser.evaluate("window.harness.click('新建笔记')");await browser.until(safe,v=>v===false);
 await browser.evaluate("window.harness.click('取消')");await browser.until(safe,v=>v===true);
 expect(await safe()).toBe(true);
});
