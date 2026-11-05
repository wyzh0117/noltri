import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import type { WorkbenchApi } from './api';
import { WorkbenchInbox } from './WorkbenchInbox';
import { createReviewBrowser } from './review-headless-test';

it('renders an accessible review inbox with explicit filters before loading', () => {
  const html = renderToStaticMarkup(<WorkbenchInbox api={{} as WorkbenchApi} />);
  expect(html).toContain('aria-label="资料审核"');
  expect(html).toContain('待确认');
  expect(html).toContain('延后');
  expect(html).toContain('已拒绝');
  expect(html).toContain('已确认');
});

// Real React DOM + an isolated headless browser. Only the API boundary is a fake.
// Requires an installed Chrome/Chromium (CHROME_BIN overrides discovery); no user profile is used.
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchInbox } from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchInbox.tsx', import.meta.url)))};
const initial = () => [
 {id:'source-a',userId:'user',rawText:'Immutable original\\nSecond line',surroundingContext:'Context only',sourceType:'manual',sourcePlatform:'fixture',sourceApp:'Synthetic app',sourceTitle:'Source A',sourceUrl:'https://example.com/source',capturedAt:'2026-11-02T00:00:00Z',createdAt:'2026-11-02T00:00:00Z',metadata:{},processingStatus:'failed',errorReason:'Synthetic processing failure',requestId:null,clientId:null,reviewStatus:'needs_review',reviewRevision:0},
 {id:'source-b',userId:'user',rawText:'Deferred original',surroundingContext:null,sourceType:'manual',sourcePlatform:null,sourceApp:null,sourceTitle:'Source B',sourceUrl:null,capturedAt:'2026-11-02T00:00:00Z',createdAt:'2026-11-02T00:00:00Z',metadata:{},processingStatus:'done',errorReason:null,requestId:null,clientId:null,reviewStatus:'deferred',reviewRevision:2},
];
let root, sources, calls, options, uncertain, stale, listError, detailError, delayed, resolveDelayed, pendingOpen, committedReview, heldSources=[];
const confirmation=(source,text='Persisted human confirmation differs from immutable raw.')=>({rawSourceId:source.id,reviewRevision:source.reviewRevision,knowledgeItemId:'knowledge-'+source.id,text,targetNodeId:'audit-leaf',path:[{id:'audit-root',title:'Historical science'},{id:'audit-leaf',title:'Confirmed topic'}]});
const openItem=async id=>{calls.push(['openItem',id]);if(options.delayOpen)await new Promise((resolve,reject)=>{pendingOpen={resolve,reject};});};
const pngBytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII='),char=>char.charCodeAt(0));
const assetRef=id=>({assetId:id,sessionId:'image-session',mimeType:'image/png',byteLength:pngBytes.length,sha256:'1cb7c4f731ab62fbae958cf23a4a945ea1242204ba6a8214954afdd1ecdf82a4',createdAt:'2026-11-02T00:00:00Z'});
const provenance=id=>({kind:'image',batchId:'batch-'+id,sessionId:'image-session',requestId:'request-'+id,originalTextPresent:true,assetRefs:[assetRef('asset-'+id)],derivedAssets:[]});
let imagePhase,processError,recognitionError,assetReadError,pendingAsset,pendingProcess,pendingBatch,safetyReports,createdUrls=[],revokedUrls=[];
const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createUrl(blob);createdUrls.push(url);return url;};
URL.revokeObjectURL=url=>{revokedUrls.push(url);revokeUrl(url);};
function batchFor(id){const s=sources.find(s=>s.id===id);return {batchId:'batch-'+id,sessionId:'image-session',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',items:[{requestId:'request-'+id,kind:'image',userOrder:0,assetIds:['asset-'+id],status:imagePhase==='processing'||imagePhase==='queued'?imagePhase:imagePhase==='ready'?'needs_review':imagePhase==='failed'?'failed':imagePhase==='input_selection_required'?'needs_review':'assets_saved',...(options.oldBatch&&!s.metadata.capture?{}:{rawSourceId:id}),duplicate:false,retryable:imagePhase==='failed',...(imagePhase==='processing'||imagePhase==='queued'?{}:imagePhase==='failed'?{errorReason:'Synthetic image processing failure'}:{processingReason:imagePhase==='ready'?'uncertain_recognition':imagePhase}),updatedAt:'2026-11-02T00:00:00Z'}]};}
function recognitionFor(id){const p=sources.find(s=>s.id===id).metadata.capture;return {rawSourceId:id,provenance:p,snapshot:imagePhase!=='ready'?null:{version:1,inputFingerprint:'0'.repeat(64),inputs:p.assetRefs,results:[{assetId:'asset-'+id,providerId:'synthetic-test-provider',modelId:'synthetic-model',result:{text:'Derived OCR text for '+id,confidence:0.71,blocks:[{kind:'table',text:'Derived table',region:{x:0,y:0,width:1,height:0.5}},{kind:'code',text:'const derived = true'},{kind:'formula',text:'x^2'}],uncertainRegions:[{reason:'Synthetic blurred region',text:'unclear',region:{x:0,y:0.5,width:1,height:0.5}}]},createdAt:'2026-11-02T00:00:00Z'}],createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z'},processingText:imagePhase==='ready'?'Derived processing view':null};}

const api = {
 inbox: async (query={}) => { calls.push(['inbox',query]); if(listError){listError=false;throw Error('Synthetic list offline');} return { entries:sources.filter(s=>!query.reviewStatus||s.reviewStatus===query.reviewStatus).map(s=>({...s,textPreview:s.rawText.slice(0,20),rawTextLength:s.rawText.length})), counts:{pending:0,processing:0,done:1,failed:1},reviewCounts:{needs_review:sources.filter(s=>s.reviewStatus==='needs_review').length,deferred:sources.filter(s=>s.reviewStatus==='deferred').length,rejected:sources.filter(s=>s.reviewStatus==='rejected').length,confirmed:sources.filter(s=>s.reviewStatus==='confirmed').length},limit:50,offset:0}; },
 rawSource: async id=>{calls.push(['rawSource',id]);if(detailError){detailError=false;throw Error('Synthetic detail offline');}const value=structuredClone(sources.find(s=>s.id===id));if(options.holdSourceReads)return new Promise((resolve,reject)=>heldSources.push({value,resolve,reject}));return value;},
 reviewSource: async (id,req)=>{
  calls.push(['reviewSource',id,structuredClone(req)]);
  if(delayed) await new Promise(resolve=>{resolveDelayed=resolve;});
  if(committedReview&&req.actionId===committedReview.request.actionId){
   if(id!==committedReview.id||JSON.stringify(req)!==JSON.stringify(committedReview.request))throw Error('Replay must use the original source and exact request');
   return {...structuredClone(committedReview.result),duplicate:true};
  }
  if(uncertain&&!options.commitBeforeUncertain){uncertain=false;throw Error('Synthetic network uncertainty');}
  const s=sources.find(s=>s.id===id);
  if(stale){stale=false;s.reviewRevision=3;s.reviewStatus='needs_review';throw Object.assign(Error('Synthetic stale revision'),{status:409,code:'review_revision_conflict'});}
  if(req.expectedRevision!==s.reviewRevision)throw Error('Wrong expected revision');
  s.reviewStatus=({confirm:'confirmed',defer:'deferred',reject:'rejected',restore:'needs_review'})[req.action];s.reviewRevision++;
  if(req.action==='confirm')s.reviewConfirmation={...confirmation(s,(req.editedText??s.rawText).trim()),targetNodeId:req.nodeId,path:[{id:req.nodeId,title:'Confirmed target'}]};
  const result={reviewStatus:s.reviewStatus,reviewRevision:s.reviewRevision,duplicate:false,...(req.action==='confirm'?{item:{id:'knowledge-confirmed',rawSourceId:id,userId:'user',normalizedText:(req.editedText??s.rawText).trim(),summary:null,confidence:1,status:'active',isAiDerived:false,createdAt:s.createdAt,updatedAt:s.createdAt}}:{})};
  if(uncertain){uncertain=false;committedReview={id,request:structuredClone(req),result:structuredClone(result)};throw Error('Synthetic network uncertainty');}
  return result;
 },
 retryCapture: async id=>{calls.push(['retryCapture',id]);sources.find(s=>s.id===id).processingStatus='done';return {rawSourceId:id};},
 assignSource: async ()=>{throw Error('Legacy assign should not be used');},
 captureRecognition:async id=>{calls.push(['captureRecognition',id]);if(recognitionError){recognitionError=false;throw Error('Synthetic recognition read offline');}return structuredClone(recognitionFor(id));},
 getCaptureBatchStatus:async id=>{calls.push(['getCaptureBatchStatus',id]);if(options.delayBatch)await new Promise(resolve=>{pendingBatch=resolve;});if(options.batchReadError)throw Error('Synthetic batch status unavailable');const batch=batchFor(id.slice(6));if(options.batchMismatch==='batchId')batch.batchId='different-batch';if(options.batchMismatch==='sessionId')batch.sessionId='different-session';if(options.batchMismatch==='requestId')batch.items[0].requestId='different-request';if(options.batchMismatch==='rawSourceId')batch.items[0].rawSourceId='different-source';return batch;},
 readCaptureAsset:async(batchId,assetId)=>{calls.push(['readCaptureAsset',batchId,assetId]);if(options.delayAsset&&assetId==='asset-source-a')await new Promise(resolve=>{pendingAsset=resolve;});if(assetReadError){assetReadError=false;throw Error('Synthetic original read failed');}return {asset:{...assetRef(assetId),...(options.badAsset?{sessionId:'wrong-session'}:{})},bytes:(()=>{const bytes=pngBytes.slice();if(options.badHash)bytes[bytes.length-1]^=1;return bytes;})()};},
 listCaptureBatches:async input=>{calls.push(['listCaptureBatches',input]);return {batches:options.oldBatch?[batchFor('source-a')]:[]};},
 processCaptureBatch:async(batchId,request)=>{calls.push(['processCaptureBatch',batchId,structuredClone(request)]);if(options.delayProcess)await new Promise(resolve=>{pendingProcess=resolve;});imagePhase=options.returnProcessing?'processing':'ready';sources[0].metadata={entryPoint:'capture-image',capture:provenance('source-a')};if(processError){processError=false;throw Error('Synthetic process response lost');}return batchFor(batchId.slice(6));},
};
window.harness={
 mount(opts={}){root?.unmount();createdUrls=[];revokedUrls=[];safetyReports=[];sources=initial();calls=[];heldSources=[];committedReview=null;options=opts;if(opts.confirmed){sources[0].reviewStatus='confirmed';sources[0].reviewRevision=4;sources[0].reviewConfirmation=confirmation(sources[0]);if(opts.confirmationCase==='missing')delete sources[0].reviewConfirmation;else if(opts.confirmationCase==='null')sources[0].reviewConfirmation=null;else if(opts.confirmationCase==='source')sources[0].reviewConfirmation.rawSourceId='other-source';else if(opts.confirmationCase==='revision')sources[0].reviewConfirmation.reviewRevision=3;else if(opts.confirmationCase==='leaf')sources[0].reviewConfirmation.targetNodeId='other-target';if(opts.twoConfirmed){sources[1].reviewStatus='confirmed';sources[1].reviewConfirmation=confirmation(sources[1],'Human confirmation for source B only.');}}imagePhase=opts.imagePhase??'ready';processError=!!opts.processError;recognitionError=!!opts.recognitionError;assetReadError=!!opts.assetReadError;pendingAsset=undefined;pendingProcess=undefined;if(opts.image){sources[0].metadata={entryPoint:'capture-image',capture:provenance('source-a')};if(opts.twoImages){sources[1].metadata={entryPoint:'capture-image',capture:provenance('source-b')};sources[1].reviewStatus='needs_review';}}uncertain=!!opts.uncertain;stale=!!opts.stale;listError=!!opts.listError;detailError=!!opts.detailError;delayed=!!opts.delayed;resolveDelayed=undefined;root=createRoot(document.getElementById('root'));root.render(<WorkbenchInbox active={options.active ?? true} api={api} selectedNodeId={opts.noNode?null:'node-selected'} targetNodes={opts.targetNodes} onOpenItem={openItem} onUpdateSafetyChange={safe=>safetyReports.push(safe)}/>);},
 settleOpen(outcome){options.delayOpen=false;if(outcome==='reject')pendingOpen.reject(Error('Synthetic detail read failed'));else pendingOpen.resolve();pendingOpen=null;},
 setActive(active){options.active=active;root.render(<WorkbenchInbox active={active} api={api} selectedNodeId={options.noNode?null:'node-selected'} targetNodes={options.targetNodes} onOpenItem={openItem} onUpdateSafetyChange={safe=>safetyReports.push(safe)}/>);},
 unmount(){root?.unmount();},
 externalConfirm(){sources[0].reviewStatus='confirmed';sources[0].reviewRevision++;sources[0].reviewConfirmation=confirmation(sources[0],'Remote canonical confirmation, separate from local changes.');},
 holdSourceReads(){options.holdSourceReads=true;},
 heldSourceCount:()=>heldSources.length,
 releaseSource(index,outcome='resolve'){const read=heldSources[index];if(outcome==='reject')read.reject(Error('Synthetic confirmation GET failure'));else read.resolve(read.value);},
 stopHoldingSources(){options.holdSourceReads=false;},
 releaseBatch(){options.delayBatch=false;pendingBatch?.();pendingBatch=null;},
 batchReadIssue(kind){options.batchReadError=kind==='failure';options.batchMismatch=kind==='failure'?null:kind;},
 fixBatchRead(){options.batchReadError=false;options.batchMismatch=null;},
 releaseAsset(){options.delayAsset=false;pendingAsset?.();},
 fixAsset(){options.badAsset=false;options.badHash=false;},
 setImagePhase(phase){imagePhase=phase;},
 releaseProcess(){options.delayProcess=false;pendingProcess?.();},
 urls:()=>({created:createdUrls,revoked:revokedUrls}),
 safety:()=>safetyReports,
 openSaved(){document.querySelector('summary[aria-label="已存图片批次"]').click();},
 externalUpdate(){sources[0].sourceTitle='Updated Source A';},
 calls:()=>calls, sources:()=>sources, release:()=>{delayed=false;resolveDelayed?.();},
 click(text){const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text);if(!b)throw Error('Missing button: '+text);b.click();},
 edit(value){const el=document.querySelector('textarea');if(!el)throw Error('Missing draft');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 target(value){const el=document.querySelector('select');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},
 text:()=>document.body.innerText, draft:()=>document.querySelector('textarea')?.value,
};
`;

const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
const text = () => evaluate<string>('window.harness.text()');
const calls = () => evaluate<any[]>('window.harness.calls()');
const click = (label: string) => evaluate(`window.harness.click(${JSON.stringify(label)})`);
const edit = (value: string) => evaluate(`window.harness.edit(${JSON.stringify(value)})`);
async function mount(options: object = {}): Promise<void> {
  await evaluate(`window.harness.mount(${JSON.stringify(options)})`);
  await until(text, value => value.includes('Source A') || value.includes('Synthetic list offline') || value.includes('当前筛选下没有资料'));
}
async function openSource(): Promise<void> {
  await click('打开资料 Source A');
  await until(text, value => value.includes('Immutable original\nSecond line') || value.includes('Synthetic detail offline'));
}

describe('WorkbenchInbox real component review flow', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('rehydrates the read-only human confirmation and audited path after a full remount with no catalog', async () => {
    for (let mountIndex = 0; mountIndex < 2; mountIndex++) {
      if (mountIndex) await evaluate('window.harness.unmount();localStorage.clear()');
      await mount({ confirmed: true, targetNodes: [] });
      await click('已确认 1');
      await openSource();
      expect(await evaluate("document.querySelector('.inbox-confirmed-text')?.textContent")).toBe('Persisted human confirmation differs from immutable raw.');
      expect(await evaluate("document.querySelector('.inbox-confirmed-path')?.textContent")).toBe('Historical science / Confirmed topic');
      expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Immutable original\nSecond line');
      expect(await evaluate("document.querySelector('#inbox-review-target')")).toBeNull();
      expect(await evaluate("document.querySelector('#inbox-review-draft')")).toBeNull();
      expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    }
  });

  it.each(['missing', 'null', 'source', 'revision', 'leaf'])('does not invent a human confirmation for %s records', async (confirmationCase) => {
    await mount({ confirmed: true, confirmationCase, targetNodes: [] });
    await click('已确认 1');
    await openSource();
    expect(await text()).toContain('未找到可恢复的人工确认记录');
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')")).toBeNull();
    expect(await evaluate("document.querySelector('#inbox-review-draft')")).toBeNull();
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Immutable original\nSecond line');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
  });

  it('keeps pending edits separate from an external confirmation and lets the user discard only local changes', async () => {
    await mount({ targetNodes: [{ id: 'node-selected', label: 'Current subject' }, { id: 'node-other', label: 'Local destination' }] });
    await openSource();
    await edit('Unsubmitted local draft stays visible');
    await evaluate("window.harness.target('node-other');window.dispatchEvent(new Event('focus'))");
    await until(() => evaluate<boolean>("document.querySelector('.inbox-detail').getAttribute('aria-busy')==='false'"), Boolean);
    expect(await evaluate('window.harness.draft()')).toBe('Unsubmitted local draft stays visible');
    expect(await evaluate("document.querySelector('#inbox-review-target').value")).toBe('node-other');
    await evaluate("window.harness.externalConfirm();window.dispatchEvent(new Event('focus'))");
    await until(text, value => value.includes('审核：已确认'));
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')?.textContent")).toBe('Remote canonical confirmation, separate from local changes.');
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"] #inbox-review-draft')?.value`)).toBe('Unsubmitted local draft stays visible');
    expect(await evaluate("document.querySelector('.inbox-local-target')?.textContent")).toContain('node-other');
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    await click('放弃本地未提交修改');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"]')`)).toBeNull();
    expect(await evaluate("document.querySelector('.inbox-confirmed-text').textContent")).toBe('Remote canonical confirmation, separate from local changes.');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
  });

  it('recovers the original unknown action after confirmed hydration and local discard without creating new dirty state', async () => {
    await mount({ uncertain: true, commitBeforeUncertain: true, targetNodes: [{ id: 'node-selected', label: 'Initial subject' }, { id: 'node-other', label: 'Submitted subject' }] });
    await openSource();
    await edit('Original human payload committed before the response was lost');
    await evaluate("window.harness.target('node-other')");
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    const original = (await calls()).find(call => call[0] === 'reviewSource');
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    await evaluate("window.dispatchEvent(new Event('focus'))");
    await until(text, value => value.includes('审核：已确认'));
    expect(await evaluate("document.querySelector('.inbox-confirmed-text').textContent")).toBe(original[2].editedText);
    await click('放弃本地未提交修改');
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"]')`)).toBeNull();
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='确认归档')")).toBe(false);
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(1);
    expect(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='重试审核操作'&&!b.disabled)")).toBe(true);
    await click('重试审核操作');
    await until(text, value => value.includes('审核结果已存在'));
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([original, original]);
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"]')`)).toBeNull();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(false);
    expect(await evaluate("document.querySelector('.inbox-confirmed-text').textContent")).toBe(original[2].editedText);
    expect((await evaluate<any[]>('window.harness.sources()'))[0].reviewRevision).toBe(1);
  });

  it('hides a previous confirmation while its GET fails and recovers only through a successful read', async () => {
    await mount({ confirmed: true });
    await click('已确认 1');
    await openSource();
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')?.textContent")).toBe('Persisted human confirmation differs from immutable raw.');
    await evaluate("window.harness.holdSourceReads();window.dispatchEvent(new Event('focus'))");
    await until(() => evaluate<number>('window.harness.heldSourceCount()'), value => value === 1);
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')")).toBeNull();
    await evaluate("window.harness.releaseSource(0,'reject')");
    await until(text, value => value.includes('Synthetic confirmation GET failure'));
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')")).toBeNull();
    await evaluate('window.harness.stopHoldingSources()');
    await click('重试加载原文');
    await until(() => evaluate<string>("document.querySelector('.inbox-confirmed-text')?.textContent??''"), value => value === 'Persisted human confirmation differs from immutable raw.');
  });

  it('keeps a hidden source local draft reachable for explicit discard without clearing an unknown review', async () => {
    await mount({ uncertain: true });
    await openSource();
    await edit('Unsubmitted changes for an earlier selection');
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    await click('延后 1');
    await click('打开资料 Source B');
    await until(text, value => value.includes('Deferred original'));
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"] textarea')?.value`)).toBe('Unsubmitted changes for an earlier selection');
    await click('放弃本地未提交修改');
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"]')`)).toBeNull();
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(1);
  });

  it('does not mark the submitted draft dirty when the persisted confirmation normalizes whitespace', async () => {
    await mount();
    await openSource();
    await edit('  Human text retained as the submitted local baseline  ');
    await click('确认归档');
    await until(text, value => value.includes('审核已更新'));
    expect(await evaluate("document.querySelector('.inbox-confirmed-text')?.textContent")).toBe('Human text retained as the submitted local baseline');
    expect(await evaluate(`document.querySelector('[aria-label="未提交的本地修改"]')`)).toBeNull();
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
  });

  it('ignores stale confirmation reads and does not carry an old source result into another selection', async () => {
    await mount({ confirmed: true, twoConfirmed: true });
    await click('已确认 2');
    await openSource();
    await evaluate("window.harness.holdSourceReads();window.dispatchEvent(new Event('focus'))");
    await until(() => evaluate<number>('window.harness.heldSourceCount()'), value => value === 1);
    await evaluate("window.harness.externalConfirm();window.dispatchEvent(new Event('focus'))");
    await until(() => evaluate<number>('window.harness.heldSourceCount()'), value => value === 2);
    await evaluate('window.harness.releaseSource(1)');
    await until(() => evaluate<string>("document.querySelector('.inbox-confirmed-text')?.textContent??''"), value => value === 'Remote canonical confirmation, separate from local changes.');
    await evaluate('window.harness.releaseSource(0)');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect(await evaluate("document.querySelector('.inbox-confirmed-text').textContent")).toBe('Remote canonical confirmation, separate from local changes.');
    await evaluate("window.dispatchEvent(new Event('focus'))");
    await until(() => evaluate<number>('window.harness.heldSourceCount()'), value => value === 3);
    await click('打开资料 Source B');
    await until(() => evaluate<number>('window.harness.heldSourceCount()'), value => value === 4);
    await evaluate('window.harness.releaseSource(3)');
    await until(() => evaluate<string>("document.querySelector('.inbox-confirmed-text')?.textContent??''"), value => value === 'Human confirmation for source B only.');
    await evaluate('window.harness.releaseSource(2)');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect(await evaluate("document.querySelector('.inbox-confirmed-text').textContent")).toBe('Human confirmation for source B only.');
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Deferred original');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
  });

  it('opens the original before confirmation when no destination exists', async () => {
    await mount({ noNode: true, targetNodes: [] });
    await openSource();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    expect(await evaluate("!![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料'&&!b.disabled)")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([['openItem', 'source-a']]);
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
  });

  it.each(['resolve', 'reject'])('locks review while details are loading and releases after %s', async (outcome) => {
    await mount({ delayOpen: true });
    await openSource();
    await edit('Draft retained through a pending detail read');
    await evaluate("window.harness.click('查看原件资料');window.harness.click('确认归档')");
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([['openItem', 'source-a']]);
    await click('确认归档');
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toEqual([]);
    expect((await calls()).filter(call => call[0] === 'openItem')).toHaveLength(1);
    await evaluate(`window.harness.settleOpen(${JSON.stringify(outcome)})`);
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
    expect(await evaluate('window.harness.draft()')).toBe('Draft retained through a pending detail read');
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Immutable original\nSecond line');
    await click('确认归档');
    await until(text, value => value.includes('审核：已确认'));
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(1);
  });

  it('blocks opening details during review and while its outcome remains uncertain across selection', async () => {
    await mount({ delayed: true });
    await openSource();
    await evaluate("window.harness.click('确认归档');window.harness.click('查看原件资料')");
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await evaluate('window.harness.release()');
    await until(text, value => value.includes('审核：已确认'));
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([['openItem', 'source-a']]);

    await mount({ uncertain: true });
    await openSource();
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    await edit('Changed local draft keeps the unresolved source protected');
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('延后 1');
    await until(text, value => value.includes('Source B'));
    await click('打开资料 Source B');
    await until(text, value => value.includes('Deferred original'));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    await click('待确认 1');
    await openSource();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
  });

  it.each(['running', 'processing', 'uncertain'])('blocks opening details while image activity is %s', async (phase) => {
    await mount({ image: true, imagePhase: 'failed', delayProcess: phase === 'running', returnProcessing: phase === 'processing', processError: phase === 'uncertain' });
    await openSource();
    await until(text, value => value.includes('重试图片处理'));
    await click('重试图片处理');
    await until(calls, value => value.some(call => call[0] === 'processCaptureBatch'));
    if (phase === 'processing') await until(text, value => value.includes('图片处理中'));
    if (phase === 'uncertain') await until(text, value => value.includes('Synthetic process response lost'));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    if (phase === 'running') await evaluate('window.harness.releaseProcess()');
  });

  it.each(['processing', 'queued'])('blocks original details for an initially observed %s image until explicit terminal refresh', async (phase) => {
    await mount({ image: true, imagePhase: phase });
    await openSource();
    await until(text, value => value.includes(phase === 'processing' ? '图片处理中' : '图片等待处理'));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    await evaluate("window.harness.setImagePhase('ready')");
    await click('刷新图片识别状态');
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([['openItem', 'source-a']]);
  });

  it('keeps original details locked while the first image status read is unresolved', async () => {
    await mount({ image: true, imagePhase: 'ready', delayBatch: true });
    await openSource();
    await until(calls, value => value.some(call => call[0] === 'getCaptureBatchStatus'));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    await evaluate('window.harness.releaseBatch()');
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
  });

  it.each(['failure', 'batchId', 'sessionId', 'requestId', 'rawSourceId'])('retains pending image protection after %s status read and releases only a matching terminal read', async (issue) => {
    await mount({ image: true, imagePhase: 'processing' });
    await openSource();
    await until(text, value => value.includes('图片处理中'));
    await evaluate(`window.harness.setImagePhase('ready');window.harness.batchReadIssue(${JSON.stringify(issue)})`);
    await click('刷新图片识别状态');
    await until(() => evaluate<boolean>("!document.querySelector('.inbox-image-recognition').getAttribute('aria-busy')||document.querySelector('.inbox-image-recognition').getAttribute('aria-busy')==='false'"), Boolean);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
    await evaluate('window.harness.fixBatchRead()');
    await click('刷新图片识别状态');
    await until(() => evaluate<boolean>("![...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled"), Boolean);
  });

  it('retains observed pending image protection when its source view unmounts', async () => {
    await mount({ image: true, imagePhase: 'processing' });
    await openSource();
    await until(text, value => value.includes('图片处理中'));
    await click('延后 1');
    await until(text, value => value.includes('Source B'));
    await click('打开资料 Source B');
    await until(text, value => value.includes('Deferred original'));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='查看原件资料').disabled")).toBe(true);
    await click('查看原件资料');
    expect((await calls()).filter(call => call[0] === 'openItem')).toEqual([]);
  });

  it('does not downgrade a local running image POST when a background GET observes pending or terminal status', async () => {
    await mount({ image: true, imagePhase: 'failed', delayProcess: true });
    await openSource();
    await until(text, value => value.includes('重试图片处理'));
    await click('重试图片处理');
    await until(calls, value => value.some(call => call[0] === 'processCaptureBatch'));
    for (const phase of ['processing', 'ready']) {
      const before = (await calls()).filter(call => call[0] === 'getCaptureBatchStatus').length;
      await evaluate(`window.harness.setImagePhase(${JSON.stringify(phase)});window.dispatchEvent(new Event('focus'))`);
      await until(calls, value => value.filter(call => call[0] === 'getCaptureBatchStatus').length > before);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
      expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='刷新列表').disabled")).toBe(true);
    }
    await evaluate('window.harness.releaseProcess()');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
  });

  it('loads global review counts, filters on review state, and refreshes on activation', async () => {
    await mount();
    expect(await text()).toContain('待确认 1');
    expect(await text()).toContain('延后 1');
    expect(await text()).toContain('处理失败');
    await click('延后 1');
    await until(text, value => value.includes('Source B'));
    expect(await text()).not.toContain('Source A');
    expect((await calls()).filter(call => call[0] === 'inbox').at(-1)?.[1]).toMatchObject({ reviewStatus: 'deferred' });
    const count = (await calls()).length;
    await evaluate("window.dispatchEvent(new Event('focus'))");
    await until(calls, value => value.length > count);
  });

  it('shows full immutable text and provenance, and confirms a separate edited draft once', async () => {
    await mount({ delayed: true });
    await openSource();
    expect(await text()).toContain('Synthetic app');
    expect(await text()).toContain('https://example.com/source');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(0);
    await edit('Human edited text');
    await evaluate("window.harness.click('确认归档');window.harness.click('确认归档')");
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(1);
    expect((await calls()).find(call => call[0] === 'reviewSource')?.[2]).toMatchObject({ expectedRevision: 0, action: 'confirm', nodeId: 'node-selected', editedText: 'Human edited text' });
    await evaluate('window.harness.release()');
    await until(text, value => value.includes('审核：已确认'));
    expect((await evaluate<any[]>('window.harness.sources()'))[0].rawText).toBe('Immutable original\nSecond line');
    await click('查看原件资料');
    expect((await calls()).at(-1)).toEqual(['openItem', 'source-a']);
  });

  it('refreshes on same-window activation while retaining draft and uncertain intent, and ignores inactive focus', async () => {
    await mount({ uncertain: true });
    await openSource();
    await edit('Retained activation draft');
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    await evaluate('window.harness.setActive(false)');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before = (await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length;
    await evaluate("window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect((await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0]))).toHaveLength(before);
    await evaluate('window.harness.externalUpdate();window.harness.setActive(true)');
    await until(text, value => value.includes('Updated Source A'));
    expect((await calls()).filter(call => ['inbox', 'rawSource'].includes(call[0])).length).toBeGreaterThan(before);
    expect(await evaluate('window.harness.draft()')).toBe('Retained activation draft');
    await click('重试审核操作');
    await until(text, value => value.includes('审核已更新'));
    const actions = (await calls()).filter(call => call[0] === 'reviewSource').map(call => call[2]);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual(actions[0]);
  });

  it('requires a destination before confirmation while allowing defer and recoverable reject', async () => {
    await mount({ noNode: true });
    await openSource();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    await click('延后处理');
    await until(text, value => value.includes('审核：延后'));
    expect((await calls()).find(call => call[0] === 'reviewSource')?.[2]).toMatchObject({ action: 'defer', expectedRevision: 0 });
    await click('恢复待确认');
    await until(text, value => value.includes('审核：待确认'));
    await click('拒绝');
    await until(text, value => value.includes('审核：已拒绝'));
    await click('恢复待确认');
    await until(text, value => value.includes('审核：待确认'));
    const actions = (await calls()).filter(call => call[0] === 'reviewSource').map(call => call[2]);
    expect(actions.map(action => action.action)).toEqual(['defer', 'restore', 'reject', 'restore']);
    expect(actions.every(action => !('nodeId' in action) && !('editedText' in action))).toBe(true);
    expect(new Set(actions.map(action => action.actionId)).size).toBe(4);
    expect((await evaluate<any[]>('window.harness.sources()'))[0].rawText).toBe('Immutable original\nSecond line');
  });

  it('uses an explicit valid target and keeps each source destination separate', async () => {
    const targetNodes = [{ id: 'node-selected', label: 'Current subject' }, { id: 'node-other', label: 'Other subject' }];
    await mount({ targetNodes });
    await openSource();
    expect(await evaluate("!!document.querySelector('select[aria-label=\"归档学科\"]')")).toBe(true);
    expect(await evaluate("document.querySelector('select[aria-label=\"归档学科\"]').value")).toBe('node-selected');
    await evaluate("window.harness.target('node-other')");
    await click('延后 1');
    await until(text, value => value.includes('Source B'));
    await click('打开资料 Source B');
    await until(text, value => value.includes('Deferred original'));
    expect(await evaluate("document.querySelector('select[aria-label=\"归档学科\"]').value")).toBe('node-selected');
    await mount({ noNode: true, targetNodes });
    await openSource();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    await evaluate("window.harness.target('node-other')");
    await click('确认归档');
    await until(text, value => value.includes('审核：已确认'));
    expect((await calls()).find(call => call[0] === 'reviewSource')?.[2].nodeId).toBe('node-other');
    await mount({ targetNodes: [] });
    await openSource();
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    expect(await text()).toContain('请先创建或选择归档学科');
  });

  it('enforces the API draft boundary without trimming the preserved text', async () => {
    await mount();
    await openSource();
    await edit('x'.repeat(4_000));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(false);
    await edit('x' + ' '.repeat(4_000));
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
    await edit('   ');
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认归档').disabled")).toBe(true);
  });

  it('preserves the local draft on stale409 and uses refreshed revision only after explicit retry', async () => {
    await mount({ stale: true });
    await openSource();
    await edit('Draft survives conflict');
    await click('确认归档');
    await until(text, value => value.includes('冲突'));
    expect(await evaluate('window.harness.draft()')).toBe('Draft survives conflict');
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(1);
    await click('确认归档');
    await until(text, value => value.includes('审核：已确认'));
    const actions = (await calls()).filter(call => call[0] === 'reviewSource').map(call => call[2]);
    expect(actions[1]).toMatchObject({ expectedRevision: 3, editedText: 'Draft survives conflict' });
    expect(actions[1].actionId).not.toBe(actions[0].actionId);
  });

  it('reuses the exact uncertain action on retry but gives changed intent a fresh actionId', async () => {
    await mount({ uncertain: true });
    await openSource();
    await edit('First intent');
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    await click('重试审核操作');
    await until(text, value => value.includes('审核：已确认'));
    const actions = (await calls()).filter(call => call[0] === 'reviewSource').map(call => call[2]);
    expect(actions[1]).toEqual(actions[0]);
    await mount({ uncertain: true });
    await openSource();
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    await edit('Changed intent');
    await click('确认归档');
    await until(text, value => value.includes('审核：已确认'));
    const changed = (await calls()).filter(call => call[0] === 'reviewSource').map(call => call[2]);
    expect(changed[1].actionId).not.toBe(changed[0].actionId);
    expect(changed[1].editedText).toBe('Changed intent');
  });

  it('shows an authorized verified original preview separately from the derived recognition snapshot', async () => {
    await mount({ image: true });
    await openSource();
    await until(() => evaluate<boolean>("!!document.querySelector('img[alt=\"已保存原图：asset-source-a\"]')?.naturalWidth"), Boolean);
    expect((await calls()).filter(call => call[0] === 'readCaptureAsset')).toEqual([['readCaptureAsset', 'batch-source-a', 'asset-source-a']]);
    expect(await evaluate("document.querySelector('.inbox-original').textContent")).toBe('Immutable original\nSecond line');
    expect(await evaluate("document.querySelector('.inbox-image-recognition').textContent")).toContain('Derived OCR text for source-a');
    expect(await text()).toContain('Synthetic blurred region');
    expect(await text()).toContain('Derived table');
    expect(await text()).toContain('const derived = true');
    expect(await text()).toContain('x^2');
    expect(await text()).toContain('image/png');
    expect(await evaluate("document.querySelector('.inbox-image-original img').src")).toMatch(/^blob:/);
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([]);
  });

  it('keeps originals available for offline, unsupported and ambiguous inputs without implicit processing', async () => {
    for (const [imagePhase, label] of [['offline', '离线'], ['unsupported', '不支持图片识别'], ['input_selection_required', '需要人工选择识别输入']]) {
      await mount({ image: true, imagePhase });
      await openSource();
      await until(text, value => value.includes(label));
      await until(() => evaluate<boolean>("!!document.querySelector('.inbox-image-original img')?.naturalWidth"), Boolean);
      expect(await text()).toContain('尚无识别快照');
      expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([]);
      if (imagePhase === 'input_selection_required') expect(await evaluate("!![...document.querySelectorAll('button')].find(b=>b.textContent==='处理图片')")).toBe(false);
    }
  });

  it('retries explicit image processing with the same bounded identifiers and preserves the source draft', async () => {
    await mount({ image: true, imagePhase: 'failed', processError: true });
    await openSource();
    await until(text, value => value.includes('重试图片处理'));
    await edit('Local image source draft');
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([]);
    await evaluate("window.harness.click('重试图片处理');window.harness.click('重试图片处理')");
    await until(text, value => value.includes('Synthetic process response lost'));
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toHaveLength(1);
    await click('重试图片处理');
    await until(text, value => value.includes('Derived OCR text for source-a'));
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([
      ['processCaptureBatch', 'batch-source-a', { requestIds: ['request-source-a'] }],
      ['processCaptureBatch', 'batch-source-a', { requestIds: ['request-source-a'] }],
    ]);
    expect(await evaluate('window.harness.draft()')).toBe('Local image source draft');
    expect((await evaluate<any[]>('window.harness.sources()'))[0].rawText).toBe('Immutable original\nSecond line');
  });

  it('retains the original preview when recognition reads fail and supports an explicit read retry', async () => {
    await mount({ image: true, recognitionError: true });
    await openSource();
    await until(text, value => value.includes('Synthetic recognition read offline'));
    await until(() => evaluate<boolean>("!!document.querySelector('.inbox-image-original img')?.naturalWidth"), Boolean);
    await click('刷新图片识别状态');
    await until(text, value => value.includes('Derived OCR text for source-a'));
  });

  it('rejects mismatched metadata or bytes and retries only the authorized provenance asset', async () => {
    for (const [fixture, label] of [[{ badAsset: true }, '图片元数据或内容校验失败'], [{ badHash: true }, '图片校验和不匹配'], [{ assetReadError: true }, 'Synthetic original read failed']] as const) {
      await mount({ image: true, ...fixture });
      await openSource();
      await until(text, value => value.includes(label));
      expect(await evaluate("!!document.querySelector('.inbox-image-original img')")).toBe(false);
      await evaluate('window.harness.fixAsset()');
      await click('重试读取原图');
      await until(() => evaluate<boolean>("!!document.querySelector('.inbox-image-original img')?.naturalWidth"), Boolean);
      expect((await calls()).filter(call => call[0] === 'readCaptureAsset').every(call => call[1] === 'batch-source-a' && call[2] === 'asset-source-a')).toBe(true);
    }
  });

  it('ignores an old image response after source selection changes and revokes all preview URLs', async () => {
    await mount({ image: true, twoImages: true, delayAsset: true });
    await openSource();
    await until(calls, value => value.some(call => call[0] === 'readCaptureAsset' && call[2] === 'asset-source-a'));
    await click('打开资料 Source B');
    await until(() => evaluate<boolean>("!!document.querySelector('img[alt=\"已保存原图：asset-source-b\"]')?.naturalWidth"), Boolean);
    await evaluate('window.harness.releaseAsset()');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect(await evaluate("!!document.querySelector('img[alt=\"已保存原图：asset-source-a\"]')")).toBe(false);
    await evaluate('window.harness.unmount()');
    const urls = await evaluate<{ created: string[]; revoked: string[] }>('window.harness.urls()');
    expect(urls.created.length).toBeGreaterThan(0);
    expect([...urls.revoked].sort()).toEqual([...urls.created].sort());
  });

  it('offers old saved image batches as an explicit bounded process action without resubmitting assets', async () => {
    await mount({ oldBatch: true, imagePhase: 'offline', delayProcess: true });
    await evaluate('window.harness.openSaved()');
    await until(text, value => value.includes('处理已存图片 request-source-a'));
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([]);
    await click('处理已存图片 request-source-a');
    await until(calls, value => value.some(call => call[0] === 'processCaptureBatch'));
    expect((await calls()).find(call => call[0] === 'processCaptureBatch')).toEqual(['processCaptureBatch', 'batch-source-a', { requestIds: ['request-source-a'] }]);
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    await evaluate('window.harness.releaseProcess()');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    expect((await calls()).filter(call => ['createCaptureBatch', 'uploadCaptureAsset'].includes(call[0]))).toEqual([]);
  });

  it('keeps known processing unsafe after HTTP success and requires an explicit later status refresh', async () => {
    for (const terminal of ['ready', 'offline']) {
      await mount({ image: true, imagePhase: 'failed', returnProcessing: true });
      await openSource();
      await until(text, value => value.includes('重试图片处理'));
      await click('重试图片处理');
      await until(text, value => value.includes('图片处理中'));
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
      const reads = (await calls()).filter(call => call[0] === 'getCaptureBatchStatus').length;
      await evaluate(`window.harness.setImagePhase(${JSON.stringify(terminal)});window.dispatchEvent(new Event('focus'))`);
      await until(calls, value => value.filter(call => call[0] === 'getCaptureBatchStatus').length > reads);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
      await click('刷新图片识别状态');
      await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
      expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toEqual([['processCaptureBatch','batch-source-a',{requestIds:['request-source-a']}]]);
    }
  });

  it('preserves a known-processing saved batch marker without freezing its explicit refresh control', async () => {
    await mount({ oldBatch: true, imagePhase: 'offline', returnProcessing: true });
    await evaluate('window.harness.openSaved()');
    await until(text, value => value.includes('处理已存图片 request-source-a'));
    await click('处理已存图片 request-source-a');
    await until(calls, value => value.some(call => call[0] === 'processCaptureBatch'));
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='刷新已存图片').disabled")).toBe(false);
    await evaluate("window.harness.setImagePhase('ready')");
    await click('刷新已存图片');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    expect((await calls()).filter(call => call[0] === 'processCaptureBatch')).toHaveLength(1);
  });

  it('reports update safety for drafts, retained targets, uncertain review intents and in-flight actions', async () => {
    await mount({ delayed: true, targetNodes: [{ id: 'node-selected', label: 'Current' }, { id: 'node-other', label: 'Other' }] });
    await openSource();
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    await edit('Unsaved review draft');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === false);
    await edit('Immutable original\nSecond line');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    await evaluate("window.harness.target('node-other')");
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === false);
    await click('确认归档');
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    await evaluate('window.harness.release()');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
    await mount({ uncertain: true });
    await openSource();
    await click('确认归档');
    await until(text, value => value.includes('Synthetic network uncertainty'));
    expect(await evaluate('window.harness.safety().at(-1)')).toBe(false);
    await click('重试审核操作');
    await until(() => evaluate<boolean>('window.harness.safety().at(-1)'), value => value === true);
  });

  it('recovers list/detail errors, retains edits across refresh, and explicitly retries failed processing', async () => {
    await mount({ listError: true, detailError: true });
    await click('重试加载列表');
    await until(text, value => value.includes('Source A'));
    await openSource();
    await click('重试加载原文');
    await until(text, value => value.includes('Immutable original\nSecond line'));
    await edit('Keep local edit');
    await click('刷新列表');
    expect(await evaluate('window.harness.draft()')).toBe('Keep local edit');
    await click('重试处理');
    await until(text, value => value.includes('处理：已完成'));
    expect((await calls()).filter(call => call[0] === 'retryCapture')).toEqual([['retryCapture', 'source-a']]);
    expect((await calls()).filter(call => call[0] === 'reviewSource')).toHaveLength(0);
    expect(await evaluate('window.harness.draft()')).toBe('Keep local edit');
  });
});
