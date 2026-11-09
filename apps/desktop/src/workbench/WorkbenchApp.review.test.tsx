import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import WorkbenchApp from './WorkbenchApp';
import type { WorkbenchApi } from './api';
import { createReviewBrowser } from './review-headless-test';

const restoredMarkdownPath = 'Restored/恢复后的笔记.md';
const restoredMarkdownBody = '# 恢复后的笔记\n\n第一段恢复正文。\n\n第二段恢复正文。\n\n';

it('offers a main workspace inbox alongside the preserved notes workspace', () => {
  const markup = renderToStaticMarkup(<WorkbenchApp api={{} as WorkbenchApi} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint="" tokenConfigured={false} outsideTauri />);
  expect(markup).toContain('aria-label="打开待确认资料"');
  expect(markup).toContain('aria-label="笔记工作区"');
  expect(markup).toContain('全部资料');
  expect(markup).toContain('新建 Markdown 笔记');
  expect(markup).toContain('规则与处理记录');
});

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import WorkbenchApp from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchApp.tsx', import.meta.url)))};
let root, calls, source, secondSource, bootstrap, direction, generation, rememberedNotes, holdItem, pendingItem, itemSettled, markdownFiles, confirms;
const markdownBody=${JSON.stringify(restoredMarkdownBody)};
const otherMarkdownBody='# 不同的同名笔记\\n\\n无关正文。\\n';
const restoredPath=${JSON.stringify(restoredMarkdownPath)};
const markdownMetadata={frontmatter:{},headings:[{heading:'恢复后的笔记',level:1,position:{start:{offset:0}}}],tags:[],links:[],blocks:{}};
const markdownFile=path=>{const entry=markdownFiles.find(file=>file.path===path);if(!entry)throw Error('Unknown synthetic Vault path: '+path);return{path:entry.path,content:entry.content,mtime:1,ctime:1,size:new TextEncoder().encode(entry.content).length,etag:'synthetic-'+path,metadata:markdownMetadata};};
window.confirm=message=>{confirms.push(String(message));return true;};
const findSource=id=>[source,secondSource].find(s=>s?.id===id);
let clipboardReads=[];
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
 read:async()=>{clipboardReads.push('read');throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 readText:async()=>{clipboardReads.push('readText');throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 write:async()=>{throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
 writeText:async()=>{throw new DOMException('Synthetic clipboard denial','NotAllowedError');},
}});
const initial = ()=>({id:'source-original',userId:'synthetic-user',rawText:'Original source body for direct detail',surroundingContext:null,sourceType:'manual',sourcePlatform:null,sourceApp:'Synthetic fixture',sourceTitle:'Synthetic source',sourceUrl:null,capturedAt:'2026-11-02T00:00:00Z',metadata:{},processingStatus:'done',errorReason:null,createdAt:'2026-11-02T00:00:00Z',requestId:null,clientId:null,reviewStatus:'needs_review',reviewRevision:0});
const known = {
 tree:async()=>({rootId:null,totalNodes:bootstrap&&!direction?0:1,nodes:bootstrap&&!direction?[]:[{id:'subject-a',title:direction??'Synthetic subject',nodeType:'discipline',summary:null,status:'active',confidence:null,itemCount:0,descendantItemCount:0,childCount:0,children:[]}]}),
 health:async()=>({status:'ok',productId:'synthetic-test',instanceId:'synthetic-test',protocolVersion:'1',version:'0',storageDriver:'memory',storage:{driver:'memory',ok:true,detail:{}},aiProvider:'disabled',embeddingDim:0,requiresAiKey:false}),
 listItems:async()=>({items:[],limit:200,offset:0}),
 vaultSnapshot:async()=>({rootPath:'/synthetic-review-vault',files:markdownFiles.map(file=>({path:file.path,name:file.path.split('/').at(-1),kind:'file',extension:'md',mtime:1,size:file.content.length,frontmatter:{}})),revision:0}),
 vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),
 vaultDiagnostics:async()=>({revision:0,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),
 vaultChanges:async()=>({revision:0,reset:false,events:[]}),
 vaultFile:async path=>markdownFile(path),
 vaultMetadata:async path=>({path,metadata:markdownFile(path).metadata}),
 vaultBacklinks:async()=>({revision:0,backlinks:[]}),
 vaultMentions:async()=>({mentions:[]}),
 vaultHistory:async()=>({versions:[]}),
 deletePreview:async path=>({path,etag:markdownFile(path).etag,backlinkCount:0,kind:'file',descendantCount:1,orphanAttachments:[]}),
 deleteVaultFile:async path=>{markdownFiles=markdownFiles.filter(file=>file.path!==path);return{path,deletedAttachments:[]};},
 inbox:async(query={})=>({entries:[source,secondSource].filter(s=>s&&(!query.reviewStatus||query.reviewStatus===s.reviewStatus)).map(s=>({...s,sourceTitle:bootstrap?s.sourceTitle:'Synthetic source '+generation,textPreview:s.rawText.slice(0,20),rawTextLength:s.rawText.length})),counts:{pending:0,processing:0,done:1,failed:0},reviewCounts:Object.fromEntries(['needs_review','deferred','rejected','confirmed'].map(status=>[status,[source,secondSource].filter(s=>s?.reviewStatus===status).length])),limit:50,offset:0}),
 rawSource:async id=>{const source=findSource(id);if(!source)throw Error('Wrong raw source identity');return structuredClone(source);},
 reviewSource:async(id,request)=>{const source=findSource(id);if(!source||bootstrap&&id==='source-seed')throw Error('Seed classification must not be confirmed again');source.reviewStatus='confirmed';source.reviewRevision++;source.reviewConfirmation={rawSourceId:source.id,reviewRevision:source.reviewRevision,knowledgeItemId:'knowledge-created',text:request.editedText,targetNodeId:request.nodeId,path:[{id:'historical-root',title:'Confirmed at review'},{id:request.nodeId,title:'Durable destination'}]};return {reviewStatus:'confirmed',reviewRevision:source.reviewRevision,duplicate:false,item:{id:'knowledge-created',rawSourceId:source.id,userId:'synthetic-user',normalizedText:request.editedText,summary:null,confidence:1,status:'active',isAiDerived:false,createdAt:source.createdAt,updatedAt:source.createdAt}};},
 item:async id=>{const source=findSource(id);if(!source)throw Error('KnowledgeItem ID must not be sent to LibraryItem detail');if(holdItem){try{await new Promise((resolve,reject)=>{pendingItem={resolve,reject};});}finally{itemSettled=true;}}return {id:source.id,content:source.rawText,summary:null,kind:'knowledge',source:{type:'manual',title:'Original source detail',url:null,platform:null,appName:'Synthetic fixture',capturedAt:source.capturedAt,citation:null,page:null,author:null,doi:null},previewImageUrl:null,subjectPath:direction?[direction]:[],researchPoint:null,tags:[],aiStatus:'ready',createdAt:source.createdAt,archived:false};},
 patchItem:async(id,request)=>{const s=findSource(id);if(!s)throw Error('Wrong classification source identity');if(request.subjectPath){direction=request.subjectPath[0]??null;s.processingStatus='done';}if(request.content!==undefined)s.rawText=request.content;if(request.source?.title!==undefined)s.sourceTitle=request.source.title;return {item:await known.item(id)};},
 listItemRelations:async()=>[],
 listCaptureBatches:async()=>({batches:[]}),
 selectGraph:async()=>({nodes:[],edges:[],scopeGraphNodeId:null}),
};
const api=new Proxy({}, {get(_target,name){return (...args)=>{calls.push([String(name),...structuredClone(args)]);if(!(name in known))return Promise.reject(Error('Unexpected fake API call: '+String(name)));return known[name](...args);};}});
window.harness={
 mount(empty=false,withMarkdown=false){root?.unmount();calls=[];confirms=[];generation=1;bootstrap=empty;direction=null;secondSource=null;markdownFiles=withMarkdown?[{path:'Other/恢复后的笔记.md',content:otherMarkdownBody},{path:restoredPath,content:markdownBody}]:[];source=empty?{...initial(),id:'source-seed',sourceTitle:'Synthetic target seed',rawText:'Synthetic destination seed for manual review.',processingStatus:'failed'}:initial();rememberedNotes=null;holdItem=false;pendingItem=null;itemSettled=false;clipboardReads=[];localStorage.clear();root=createRoot(document.getElementById('root'));root.render(<WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint="" tokenConfigured={false} outsideTauri />);},
 remountEmptyCatalog(){root.unmount();bootstrap=true;direction=null;localStorage.clear();root=createRoot(document.getElementById('root'));root.render(<WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint="" tokenConfigured={false} outsideTauri />);},
 addSecondSource(){secondSource={...initial(),id:'source-second',sourceTitle:'Synthetic second source',rawText:'Independent second original for review.'};},
 input(selector,value){const el=document.querySelector(selector);const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 holdNextItem(){holdItem=true;itemSettled=false;},
 settleItem(outcome){holdItem=false;if(!pendingItem)throw Error('No deferred item request');if(outcome==='reject')pendingItem.reject(Error('Synthetic deferred item failure'));else pendingItem.resolve();pendingItem=null;},
 itemSettled:()=>itemSettled,
 clipboardReads:()=>clipboardReads,
 confirmMessages:()=>[...confirms],
 addIntakeDraft(){const el=document.querySelector('#intake-original-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Unsubmitted synthetic intake draft');el.dispatchEvent(new Event('input',{bubbles:true}));const file=new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII='),x=>x.charCodeAt(0))],'synthetic.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('input[aria-label="添加图片文件"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));},
 calls:()=>calls, text:()=>document.body.innerText,
 click(label){const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.title===label||b.textContent.trim()===label||b.textContent.trim().endsWith(label));if(!b)throw Error('Missing button: '+label);b.click();},
 rememberNotes(){rememberedNotes=document.querySelector('[aria-label="笔记工作区"]');},
 sameNotes:()=>rememberedNotes===document.querySelector('[aria-label="笔记工作区"]'),
 notesActive:()=>!document.querySelector('[aria-label="笔记工作区"]').classList.contains('vault-notes-hidden'),
 inboxActive:()=>document.querySelector('[aria-label="资料审核工作区"]')?.hidden===false,
 externalUpdate(){generation++;source.reviewRevision++;},
 target(value){const el=document.querySelector('#inbox-review-target');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},
 edit(value){const el=document.querySelector('#inbox-review-draft');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 openSearchPath(path){const button=[...document.querySelectorAll('.sidebar-search-results button')].find(button=>button.querySelector('small')?.textContent?.trim()===path);if(!button)throw Error('Missing unified-search path '+path);button.click();},
 state(){
  const main=document.querySelector('.vault-note-main');
  const editor=main?.querySelector('.cm-editor');
  const view=editor?EditorView.findFromDOM(editor):null;
  return {
   calls:[...calls],
   navigationMode:document.querySelector('.library-sidebar')?.getAttribute('data-navigation-mode')??null,
   notePath:main?.getAttribute('data-note-path')??null,
   noteIdentity:main?.getAttribute('data-note-identity')??null,
   toast:document.querySelector('.toast-message')?.textContent?.trim()??null,
   activeLibraryButton:document.querySelector('.library-nav .nav-row-active')?.textContent?.trim()??null,
   editorDoc:view?.state.doc.toString()??null,
   editorLines:view?[...view.contentDOM.children].filter(line=>line.classList.contains('cm-line')).map(line=>line.textContent??''):[],
   searchResultPaths:[...document.querySelectorAll('.sidebar-search-results button small')].map(path=>path.textContent?.trim()??''),
   draftVisible:!!main?.querySelector('.vault-draft-recovery'),
   saveStatus:main?.querySelector('.vault-save-indicator')?.textContent?.trim()??null,
   readerBlocks:[...(main?.querySelectorAll('.vault-reader-markdown h1,.vault-reader-markdown h2,.vault-reader-markdown h3,.vault-reader-markdown p')??[])].map(block=>block.textContent??''),
   text:document.body.innerText,
  };
 },
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
const text = () => evaluate<string>('window.harness.text()');
const calls = () => evaluate<any[]>('window.harness.calls()');
const appState = () => evaluate<any>('window.harness.state()');
const click = (label: string) => evaluate(`window.harness.click(${JSON.stringify(label)})`);
async function mount(empty = false, withMarkdown = false): Promise<void> {
  await evaluate(`window.harness.mount(${empty},${withMarkdown})`);
  await until(calls, value => value.some(call => call[0] === 'vaultSnapshot') && value.some(call => call[0] === 'listItems'));
  await evaluate('window.harness.rememberNotes()');
}
async function openInbox(): Promise<void> {
  await click('打开待确认资料');
  await until(text, value => value.includes('Synthetic source 1') || value.includes('Synthetic source 2'));
}

describe('real App Notes and Inbox navigation', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('opens a restored Markdown search result with exact editor lines and reader paragraphs', async () => {
    await mount(false, true);
    await click('搜索');
    await browser.until(appState, state => state.navigationMode === 'search');
    await evaluate(`window.harness.input('input[aria-label="搜索知识与资料"]','恢复后的笔记')`);
    const results = await browser.until(appState, state => state.searchResultPaths.length === 2);
    expect(results.searchResultPaths).toEqual(['Other/恢复后的笔记.md', restoredMarkdownPath]);

    await evaluate(`window.harness.openSearchPath(${JSON.stringify(restoredMarkdownPath)})`);
    const opened = await browser.until(appState, state => state.notePath === restoredMarkdownPath && state.editorDoc === restoredMarkdownBody);
    expect(opened.noteIdentity).toBe(`file:${restoredMarkdownPath}`);
    expect(opened.editorDoc).toBe(restoredMarkdownBody);
    expect(opened.saveStatus).toBe('已保存');
    expect(opened.draftVisible).toBe(false);
    expect(opened.calls.some((call: any[]) => call[0] === 'vaultFile' && call[1] === restoredMarkdownPath)).toBe(true);

    await click('源码');
    const source = await browser.until(appState, state => state.editorLines.length === restoredMarkdownBody.split('\n').length);
    expect(source.editorLines).toEqual(restoredMarkdownBody.split('\n'));

    await click('阅读');
    const reader = await browser.until(appState, state => state.readerBlocks.length === 3);
    expect(reader.readerBlocks).toEqual(['恢复后的笔记', '第一段恢复正文。', '第二段恢复正文。']);
    await click('删除');
    const deleted = await browser.until(appState, state => state.notePath === null && state.activeLibraryButton === '▦全部资料');
    expect(deleted.toast).toBeNull();
    expect(deleted.calls.some((call: any[]) => call[0] === 'deleteVaultFile' && call[1] === restoredMarkdownPath)).toBe(true);
    expect(await evaluate('window.harness.confirmMessages()')).toEqual([expect.stringContaining(restoredMarkdownPath)]);
    expect(browser.errors).toEqual([]);
  });

  it('reads a persisted human result after the whole App remounts with an empty direction catalog', async () => {
    await mount();
    await openInbox();
    await click('打开资料 Synthetic source 1');
    await until(text, value => value.includes('Original source body for direct detail'));
    await evaluate("window.harness.target('subject-a');window.harness.edit('Persisted human result after a fresh App mount')");
    await click('确认归档');
    await until(text, value => value.includes('审核已更新'));
    const writes = (await calls()).filter(call => call[0] === 'reviewSource').length;
    await evaluate('window.harness.remountEmptyCatalog()');
    await click('打开待确认资料');
    await until(text, value => value.includes('已确认 1'));
    await click('已确认 1');
    await click('打开资料 Synthetic source');
    await until(text, value => value.includes('审核：已确认'));
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')?.textContent")).toBe('Persisted human result after a fresh App mount');
    expect(await evaluate("document.querySelector('.inbox-confirmed-path')?.textContent")).toBe('Confirmed at review / Durable destination');
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Original source body for direct detail');
    expect(await evaluate("document.querySelector('#inbox-review-target')")).toBeNull();
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(writes);
  });

  it('bootstraps a destination through original details before confirming an independent second source', async () => {
    await mount(true);
    await click('打开待确认资料');
    await until(text, value => value.includes('Synthetic target seed'));
    await click('打开资料 Synthetic target seed');
    await until(text, value => value.includes('Synthetic destination seed for manual review.'));
    await evaluate("window.harness.edit('Local seed review draft stays separate')");
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    expect(await evaluate("!![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料'&&!b.disabled)")).toBe(true);
    await click('查看原件资料');
    await until(() => evaluate<boolean>("!!document.querySelector('dialog[open] #detail-new-path')"), Boolean);
    await evaluate("window.harness.input('#detail-new-path','Synthetic destination')");
    await click('保存分类');
    await until(calls, value => value.some(call => call[0] === 'patchItem'));
    expect((await calls()).find(call => call[0] === 'patchItem')).toEqual(['patchItem', 'source-seed', { subjectPath: ['Synthetic destination'], researchPoint: null }]);
    await until(text, value => value.includes('更改已保存'));
    await evaluate("document.querySelector('.detail-content-editor').open=true;window.harness.input('#detail-edit-content','Seed original updated through the normal detail form.');document.querySelector('.detail-content-editor form').requestSubmit()");
    await until(calls, value => value.filter(call => call[0] === 'patchItem').length === 2);
    await until(() => evaluate<string>("document.querySelector('dialog[open] .detail-original')?.textContent??''"), value => value.includes('Seed original updated through the normal detail form.'));
    const reads = (await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length;
    await evaluate("window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect((await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0]))).toHaveLength(reads);
    await click('关闭详情');
    await until(() => evaluate<string>("document.querySelector('.inbox-original')?.textContent??''"), value => value === 'Seed original updated through the normal detail form.');
    expect(await evaluate("document.querySelector('#inbox-review-draft').value")).toBe('Local seed review draft stays separate');
    expect((await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length).toBeGreaterThan(reads);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);

    await evaluate('window.harness.addSecondSource()');
    await click('刷新列表');
    await until(text, value => value.includes('Synthetic second source'));
    await click('打开资料 Synthetic second source');
    await until(text, value => value.includes('Independent second original for review.'));
    await evaluate("window.harness.target('subject-a');window.harness.edit('Human edited independent second draft')");
    await click('确认归档');
    await until(text, value => value.includes('审核已更新'));
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([['reviewSource', 'source-second', expect.objectContaining({ action: 'confirm', expectedRevision: 0, nodeId: 'subject-a', editedText: 'Human edited independent second draft' })]]);
    await click('查看原件资料');
    await until(() => evaluate<string>("document.querySelector('dialog[open] .detail-original')?.textContent??''"), value => value.includes('Independent second original for review.'));
  });

  it.each(['resolve', 'reject', 'cancel'])('keeps review locked during a pending original GET and releases after %s', async (outcome) => {
    await mount();
    await openInbox();
    await click('打开资料 Synthetic source 1');
    await until(text, value => value.includes('Original source body for direct detail'));
    await evaluate("window.harness.target('subject-a');window.harness.edit('Draft protected while loading original details');window.harness.holdNextItem();window.harness.click('查看原件资料');window.harness.click('确认归档')");
    await until(calls, value => value.some(call => call[0] === 'item'));
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    await click('确认归档');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    if (outcome === 'cancel') {
      await click('Provider 管理');
      await until(() => evaluate<string>("document.querySelector('dialog[open]')?.getAttribute('aria-label')??''"), value => value.includes('Provider 管理'));
    }
    await evaluate(`window.harness.settleItem(${JSON.stringify(outcome === 'reject' ? 'reject' : 'resolve')})`);
    await until(() => evaluate<boolean>('window.harness.itemSettled()'), Boolean);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    if (outcome === 'resolve') {
      await until(() => evaluate<boolean>("!!document.querySelector('dialog[open] .detail-original')"), Boolean);
      await click('关闭详情');
    } else if (outcome === 'cancel') {
      expect(await evaluate("!!document.querySelector('dialog[open] .detail-original')")).toBe(false);
      await evaluate("document.querySelector('dialog[open] .dialog-close').click()");
    } else {
      expect(await evaluate("!!document.querySelector('dialog[open]')")).toBe(false);
      expect(await text()).toContain('无法打开原件资料');
    }
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
    expect(await evaluate("document.querySelector('#inbox-review-draft').value")).toBe('Draft protected while loading original details');
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Original source body for direct detail');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    await click('查看原件资料');
    await until(() => evaluate<boolean>("!!document.querySelector('dialog[open] .detail-original')"), Boolean);
  });

  it('returns to the existing Notes DOM from the real all-notes navigation', async () => {
    await mount();
    await openInbox();
    expect(await evaluate('window.harness.notesActive()')).toBe(false);
    await click('全部资料');
    await until(() => evaluate<boolean>('window.harness.notesActive()'), Boolean);
    expect(await evaluate('window.harness.inboxActive()')).toBe(false);
    expect(await evaluate('window.harness.sameNotes()')).toBe(true);
  });

  it('refreshes feed and detail on same-window reentry without losing the mounted draft', async () => {
    await mount();
    await openInbox();
    await click('打开资料 Synthetic source 1');
    await until(text, value => value.includes('Original source body for direct detail'));
    await evaluate("window.harness.edit('Local review draft')");
    const before = (await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length;
    await click('全部资料');
    await evaluate('window.harness.externalUpdate()');
    await click('打开待确认资料');
    await until(text, value => value.includes('Synthetic source 2'));
    expect((await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length).toBeGreaterThan(before);
    expect(await evaluate("document.querySelector('#inbox-review-draft').value")).toBe('Local review draft');
    expect(await evaluate('window.harness.sameNotes()')).toBe(true);
  });

  it('opens the original source directly after edited confirmation even when the filtered library page is empty', async () => {
    await mount();
    await click('待整理');
    await openInbox();
    await click('打开资料 Synthetic source 1');
    await until(text, value => value.includes('Original source body for direct detail'));
    await evaluate("window.harness.target('subject-a');window.harness.edit('Edited knowledge text, separate from the original')");
    await click('确认归档');
    await until(text, value => value.includes('审核已更新'));
    await click('查看原件资料');
    await until(calls, value => value.some(call => call[0] === 'item'));
    expect((await calls()).filter(call => call[0] === 'item')).toEqual([['item', 'source-original']]);
    expect((await calls()).some(call => call[0] === 'listItems' && call[1]?.state === 'organize')).toBe(true);
    try {
      await until(() => evaluate<string>("document.querySelector('dialog[open] .detail-original')?.textContent ?? ''"), value => value.includes('Original source body for direct detail'));
    } catch (cause) {
      throw new Error(JSON.stringify({ cause: String(cause), errors: browser.errors, dialog: await evaluate("document.querySelector('dialog')?.outerHTML"), body: await text(), calls: await calls() }));
    }
    expect(await evaluate("document.querySelector('dialog[open] .detail-original').textContent")).not.toContain('Edited knowledge text');
  });

  it('keeps a later Provider overlay and close intent when a pending source request settles', async () => {
    for (const outcome of ['resolve', 'reject']) {
      await mount();
      await openInbox();
      await click('打开资料 Synthetic source 1');
      await until(text, value => value.includes('Original source body for direct detail'));
      await evaluate("window.harness.target('subject-a')");
      await click('确认归档');
      await until(text, value => value.includes('审核已更新'));
      await evaluate('window.harness.holdNextItem()');
      await click('查看原件资料');
      await until(calls, value => value.some(call => call[0] === 'item'));
      await click('Provider 管理');
      await until(() => evaluate<string>("document.querySelector('dialog[open]')?.getAttribute('aria-label') ?? ''"), value => value.includes('Provider 管理'));
      await evaluate("document.querySelector('dialog[open] .dialog-close').click()");
      await until(() => evaluate<boolean>("!document.querySelector('dialog[open]')"), Boolean);
      await evaluate(`window.harness.settleItem(${JSON.stringify(outcome)})`);
      await until(() => evaluate<boolean>('window.harness.itemSettled()'), Boolean);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      expect(await evaluate("!!document.querySelector('dialog[open]')")).toBe(false);
      expect(await text()).not.toContain('Synthetic deferred item failure');
    }
  });

  it('preserves a later collection and its unsubmitted queue when a pending source request settles', async () => {
    for (const outcome of ['resolve', 'reject']) {
      await mount();
      await openInbox();
      await click('打开资料 Synthetic source 1');
      await until(text, value => value.includes('Original source body for direct detail'));
      await evaluate("window.harness.target('subject-a')");
      await click('确认归档');
      await until(text, value => value.includes('审核已更新'));
      await evaluate('window.harness.holdNextItem()');
      await click('查看原件资料');
      await until(calls, value => value.some(call => call[0] === 'item'));
      await click('快速收集');
      await until(() => evaluate<boolean>("!!document.querySelector('dialog[open] .intake-window')"), Boolean);
      await evaluate('window.harness.addIntakeDraft()');
      await until(() => evaluate<number>("document.querySelectorAll('.intake-image-row').length"), value => value === 1);
      await evaluate('window.retainedIntake=document.querySelector(".intake-window");void 0');
      await evaluate(`window.harness.settleItem(${JSON.stringify(outcome)})`);
      await until(() => evaluate<boolean>('window.harness.itemSettled()'), Boolean);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      expect(await evaluate('window.retainedIntake===document.querySelector("dialog[open] .intake-window")')).toBe(true);
      expect(await evaluate("document.querySelector('#intake-original-text')?.value")).toBe('Unsubmitted synthetic intake draft');
      expect(await evaluate("document.querySelectorAll('.intake-image-row').length")).toBe(1);
      expect(await text()).not.toContain('Synthetic deferred item failure');
    }
  });

  it('does not let a previous asynchronous navigation commit after Inbox takes focus', async () => {
    await mount();
    await evaluate("window.harness.click('已归档');window.harness.click('打开待确认资料')");
    await until(text, value => value.includes('Synthetic source 1'));
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect(await evaluate('window.harness.inboxActive()')).toBe(true);
    expect((await calls()).some(call => call[0] === 'listItems' && call[1]?.state === 'archive')).toBe(false);
    expect((await calls()).filter(call => !(call[0] in {tree:1,health:1,listItems:1,vaultSnapshot:1,vaultSettings:1,vaultDiagnostics:1,vaultChanges:1,inbox:1,rawSource:1,reviewSource:1,item:1,listItemRelations:1,selectGraph:1}))).toEqual([]);
  });
});
